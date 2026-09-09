import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

/**
 * Every child process started on Windows opens a console window unless the
 * spawning call passes `windowsHide`. The flag does not inherit: a child
 * started correctly covers its own children, but the next sibling call site
 * flashes a black window over whatever the user is doing, forever, until
 * someone notices and fixes that one line too.
 *
 * That is why this is a lint rule and not a round of repairs. The class has
 * been fixed three times by hand; the only version of the fix that holds is one
 * that fails the build when a new call site appears without the flag.
 *
 * `windowsHide: false` passes. Writing it is a decision - an installer UI has
 * to be visible - and the point of the rule is that the choice is made, not
 * that it is always true.
 */
const CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process"]);

/** Every entry point in the module that ends up creating a process. */
const SPAWNING_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

/**
 * Names distinctive enough to flag even when they arrive as a parameter rather
 * than an import. `exec` and `fork` are left out on purpose: too many ordinary
 * functions are called that.
 */
const INJECTED_SPAWN_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "execSync"]);

const message = (name: string) =>
  `${name}() must pass windowsHide explicitly; without it every call opens a console window on Windows, and the flag is not inherited from the parent process.`;

const getLiteralStringValue = (node: unknown): Option.Option<string> => {
  if (typeof node !== "object" || node === null) return Option.none();
  if (!("type" in node) || node.type !== "Literal") return Option.none();
  if (!("value" in node) || typeof node.value !== "string") return Option.none();
  return Option.some(node.value);
};

/** Does this object literal decide the question one way or the other? */
const declaresWindowsHide = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "ObjectExpression") return false;
  const properties = expression.value.properties;
  if (!Array.isArray(properties)) return false;
  return properties.some((property) => {
    if (typeof property !== "object" || property === null) return false;
    // A spread could carry it, and we cannot see inside; treat that as settled
    // rather than nag at code that builds its options elsewhere.
    if ("type" in property && property.type === "SpreadElement") return true;
    if (!("key" in property)) return false;
    const key = getPropertyName(property.key);
    return Option.isSome(key) && key.value === "windowsHide";
  });
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require windowsHide on every child-process spawn, so no call site can open a console window on Windows.",
    },
  },
  createOnce(context) {
    const namespaces = new Set<string>();
    const spawningLocals = new Map<string, string>();

    const resetBindings = () => {
      namespaces.clear();
      spawningLocals.clear();
    };

    const trackImportDeclaration = (node: unknown) => {
      if (typeof node !== "object" || node === null || !("source" in node)) return;
      const source = getLiteralStringValue(node.source);
      if (Option.isNone(source) || !CHILD_PROCESS_MODULES.has(source.value)) return;
      if (!("specifiers" in node) || !Array.isArray(node.specifiers)) return;

      for (const specifier of node.specifiers) {
        if (typeof specifier !== "object" || specifier === null || !("local" in specifier)) continue;
        const local = unwrapExpression(specifier.local);
        if (Option.isNone(local) || local.value.type !== "Identifier") continue;
        const localName = local.value.name;

        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          specifier.type === "ImportDefaultSpecifier"
        ) {
          namespaces.add(localName);
          continue;
        }
        if (specifier.type !== "ImportSpecifier" || !("imported" in specifier)) continue;
        const imported = getPropertyName(specifier.imported);
        if (Option.isSome(imported) && SPAWNING_FUNCTIONS.has(imported.value)) {
          spawningLocals.set(localName, imported.value);
        }
      }
    };

    /** The spawning function this call resolves to, whatever it is named locally. */
    const getSpawningCall = (callee: unknown): Option.Option<string> => {
      const expression = unwrapExpression(callee);
      if (Option.isNone(expression)) return Option.none();

      if (expression.value.type === "Identifier") {
        const imported = spawningLocals.get(expression.value.name);
        if (imported !== undefined) return Option.some(imported);
        // The one that actually bit: the spawn function injected as a parameter
        // for testability, so the call site never names the import at all. Only
        // the unambiguous names, and only as a bare call - `regex.exec(...)` is
        // a member expression and never reaches here.
        return INJECTED_SPAWN_NAMES.has(expression.value.name)
          ? Option.some(expression.value.name)
          : Option.none();
      }
      if (expression.value.type !== "MemberExpression") return Option.none();

      const object = unwrapExpression(expression.value.object);
      if (Option.isNone(object) || object.value.type !== "Identifier") return Option.none();
      if (!namespaces.has(object.value.name)) return Option.none();

      return Option.filter(getPropertyName(expression.value.property), (property) =>
        SPAWNING_FUNCTIONS.has(property),
      );
    };

    return {
      before: resetBindings,
      ImportDeclaration: trackImportDeclaration,
      CallExpression(node) {
        const name = getSpawningCall(node.callee);
        if (Option.isNone(name)) return;

        const args = Array.isArray(node.arguments) ? node.arguments : [];
        // Options may be the second, third or fourth argument depending on the
        // function; asking "does any argument settle it" avoids re-deriving each
        // signature and cannot miss one.
        if (args.some((argument) => declaresWindowsHide(argument))) return;

        context.report({ node, message: message(name.value) });
      },
    };
  },
});
