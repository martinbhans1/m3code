import { describe, expect, it } from "vite-plus/test";

import {
  countStatements,
  formatDuration,
  formatRowCount,
  hasExplicitTransactionControl,
  resolveSqlErrorLocation,
} from "./runSql.logic";
import {
  connectionsForProject,
  isConnectionForProject,
  looksLikePostgresConnectionString,
} from "./databaseConnections";

const connection = (
  overrides: Partial<{ label: string; projectPath: string; connectionString: string }> = {},
) => ({
  label: "Conn",
  projectPath: "",
  connectionString: "",
  ...overrides,
});

describe("resolveSqlErrorLocation", () => {
  const sql = "select 1;\nselect oops;\n";

  it("maps a Postgres offset onto its line and column", () => {
    // 1-based offset of "oops" (line 2, column 8)
    const position = sql.indexOf("oops") + 1;
    expect(resolveSqlErrorLocation(sql, position)).toEqual({
      line: 2,
      column: 8,
      lineText: "select oops;",
    });
  });

  it("returns null for a missing or out-of-range position", () => {
    expect(resolveSqlErrorLocation(sql, undefined)).toBeNull();
    expect(resolveSqlErrorLocation(sql, 0)).toBeNull();
    expect(resolveSqlErrorLocation(sql, sql.length + 5)).toBeNull();
  });
});

describe("countStatements", () => {
  it("counts top-level statements and ignores trailing semicolons", () => {
    expect(countStatements("select 1;")).toBe(1);
    expect(countStatements("select 1; select 2;")).toBe(2);
  });

  it("does not count semicolons inside strings or comments", () => {
    expect(countStatements("select 'a;b';")).toBe(1);
    expect(countStatements("select 1; -- trailing; comment\n")).toBe(1);
  });

  it("never reports zero for non-empty SQL", () => {
    expect(countStatements("select 1")).toBe(1);
  });
});

describe("hasExplicitTransactionControl", () => {
  it("detects a script that drives its own transactions", () => {
    // The classic half-applicable migration: the ALTER commits before the
    // UPDATE runs, so "nothing is applied" would be a lie.
    expect(
      hasExplicitTransactionControl(
        "BEGIN;\nALTER TABLE users ADD COLUMN x text;\nCOMMIT;\nUPDATE users SET x = 'a';",
      ),
    ).toBe(true);
    expect(hasExplicitTransactionControl("start transaction; select 1; rollback;")).toBe(true);
  });

  it("leaves ordinary scripts alone", () => {
    expect(hasExplicitTransactionControl("select 1; insert into t values (1);")).toBe(false);
  });

  it("ignores the keywords inside comments and string literals", () => {
    expect(hasExplicitTransactionControl("-- begin the migration\nselect 1;")).toBe(false);
    expect(hasExplicitTransactionControl("select 'commit';")).toBe(false);
  });
});

describe("formatDuration / formatRowCount", () => {
  it("switches units at a second", () => {
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(1_500)).toBe("1.50 s");
    expect(formatDuration(15_000)).toBe("15.0 s");
  });

  it("pluralizes row counts", () => {
    expect(formatRowCount(0)).toBe("no rows");
    expect(formatRowCount(1)).toBe("1 row");
    expect(formatRowCount(2)).toBe("2 rows");
  });
});

describe("connection scoping", () => {
  it("treats an empty project path as global", () => {
    expect(isConnectionForProject(connection(), "/anything")).toBe(true);
  });

  it("matches paths across separators, case, and trailing slashes", () => {
    const scoped = connection({ projectPath: "C:\\Users\\M\\repo" });
    expect(isConnectionForProject(scoped, "c:/users/m/repo/")).toBe(true);
    expect(isConnectionForProject(scoped, "c:/users/m/other")).toBe(false);
  });

  it("offers ONLY the project's own link once it has one", () => {
    // The safety property: a linked repo can never be pointed at another
    // database by accident, because nothing else is offered.
    const result = connectionsForProject(
      {
        shared: connection({ label: "Shared" }),
        mine: connection({ label: "Mine", projectPath: "/repo" }),
        theirs: connection({ label: "Theirs", projectPath: "/other" }),
      },
      "/repo",
    );
    expect(result.map((entry) => entry.label)).toEqual(["Mine"]);
  });

  it("falls back to shared connections only for an unlinked project", () => {
    const result = connectionsForProject(
      {
        sharedB: connection({ label: "B shared" }),
        sharedA: connection({ label: "A shared" }),
        theirs: connection({ label: "Theirs", projectPath: "/other" }),
      },
      "/unlinked",
    );
    expect(result.map((entry) => entry.label)).toEqual(["A shared", "B shared"]);
  });

  it("offers nothing when every connection belongs to another project", () => {
    const result = connectionsForProject(
      { theirs: connection({ label: "Theirs", projectPath: "/other" }) },
      "/repo",
    );
    expect(result).toEqual([]);
  });
});

describe("looksLikePostgresConnectionString", () => {
  it("accepts what the link form should accept", () => {
    expect(
      looksLikePostgresConnectionString(
        "  postgresql://postgres:pw@db.abc.supabase.co:5432/postgres  ",
      ),
    ).toBe(true);
    expect(looksLikePostgresConnectionString("postgres://u@h/db")).toBe(true);
  });

  it("rejects a mis-paste", () => {
    expect(looksLikePostgresConnectionString("https://supabase.com/dashboard")).toBe(false);
    expect(looksLikePostgresConnectionString("eyJhbGciOi...")).toBe(false);
    expect(looksLikePostgresConnectionString("")).toBe(false);
  });
});
