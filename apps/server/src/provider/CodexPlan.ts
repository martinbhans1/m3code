/**
 * CodexPlan — single mapping from a Codex `planType` to a human label.
 *
 * Two callers need this and must not drift apart:
 *  - `CodexProvider.codexAccountAuthLabel`, for the auth badge built from
 *    `account/read`.
 *  - `CodexUsage.normalizeCodexUsage`, for `ServerProviderUsage.planLabel`
 *    built from `account/rateLimits/read`.
 *
 * The two responses declare structurally identical but nominally distinct
 * `PlanType` enums (`V2GetAccountResponse__PlanType` vs
 * `V2GetAccountRateLimitsResponse__PlanType`), so this takes the widened
 * string union both satisfy.
 *
 * @module provider/CodexPlan
 */

/**
 * ChatGPT plan tiers. Kept as an explicit union — not `string` — so that a
 * new tier in a regenerated Codex schema fails the `satisfies never`
 * exhaustiveness check at `codexAccountAuthLabel`'s call site instead of
 * silently rendering as a raw slug.
 */
export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

/**
 * Short plan name, e.g. `"ChatGPT Plus"`.
 *
 * Callers that want the auth-badge phrasing append their own suffix — see
 * `codexAccountAuthLabel`, which renders `"ChatGPT Plus Subscription"`.
 */
export function codexPlanTypeLabel(planType: CodexPlanType): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free";
    case "go":
      return "ChatGPT Go";
    case "plus":
      return "ChatGPT Plus";
    case "pro":
      return "ChatGPT Pro 20x";
    case "prolite":
      return "ChatGPT Pro 5x";
    case "team":
      return "ChatGPT Team";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise";
    case "edu":
      return "ChatGPT Edu";
    case "unknown":
      return "ChatGPT";
    default:
      planType satisfies never;
      return undefined;
  }
}

const CODEX_PLAN_TYPES: ReadonlySet<string> = new Set<CodexPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

/**
 * Narrow an untrusted `planType` off the wire. Needed because usage payloads
 * arrive as `Schema.Unknown` and an unrecognized tier must degrade to "no
 * plan label" rather than reaching the exhaustiveness check.
 */
export const readCodexPlanType = (value: unknown): CodexPlanType | undefined =>
  typeof value === "string" && CODEX_PLAN_TYPES.has(value) ? (value as CodexPlanType) : undefined;
