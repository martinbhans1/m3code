import { describe, expect, it } from "vite-plus/test";

import {
  capRows,
  describeConnectionTarget,
  isProbablyPostgresConnectionString,
  resolveSslOption,
  sanitizeConnectionStringForDriver,
  stringifyCell,
} from "./sqlConnection.ts";

describe("resolveSslOption", () => {
  it("encrypts without verification for hosted databases", () => {
    expect(resolveSslOption("postgresql://u:p@db.abc.supabase.co:5432/postgres")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("skips TLS for local databases", () => {
    expect(resolveSslOption("postgresql://u:p@localhost:5432/app")).toBe(false);
    expect(resolveSslOption("postgres://u:p@127.0.0.1:5432/app")).toBe(false);
  });

  it("honours an explicit sslmode over the host heuristic", () => {
    expect(resolveSslOption("postgresql://u:p@localhost:5432/app?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolveSslOption("postgresql://u:p@db.example.com/app?sslmode=disable")).toBe(false);
    expect(resolveSslOption("postgresql://u:p@db.example.com/app?sslmode=verify-full")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("falls back to encrypted when the string is unparseable", () => {
    expect(resolveSslOption("not a url")).toEqual({ rejectUnauthorized: false });
  });
});

describe("sanitizeConnectionStringForDriver", () => {
  it("strips TLS params so pg cannot override our ssl decision", () => {
    expect(
      sanitizeConnectionStringForDriver(
        "postgresql://u:p@db.abc.supabase.co:5432/postgres?sslmode=require",
      ),
    ).toBe("postgresql://u:p@db.abc.supabase.co:5432/postgres");
  });

  it("keeps non-TLS params and leaves untouched strings identical", () => {
    expect(
      sanitizeConnectionStringForDriver(
        "postgresql://u:p@h:5432/db?sslmode=verify-full&application_name=x",
      ),
    ).toBe("postgresql://u:p@h:5432/db?application_name=x");
    const plain = "postgresql://u:p@h:5432/db";
    expect(sanitizeConnectionStringForDriver(plain)).toBe(plain);
    expect(sanitizeConnectionStringForDriver("not a url")).toBe("not a url");
  });

  it("still lets sslmode decide the posture via resolveSslOption", () => {
    const withMode = "postgresql://u:p@h:5432/db?sslmode=verify-full";
    // The stripped string goes to pg; the ORIGINAL drives the ssl option.
    expect(sanitizeConnectionStringForDriver(withMode)).not.toContain("sslmode");
    expect(resolveSslOption(withMode)).toEqual({ rejectUnauthorized: true });
  });
});

describe("describeConnectionTarget", () => {
  it("names host and database without leaking credentials", () => {
    expect(
      describeConnectionTarget("postgresql://user:secret@db.abc.supabase.co:5432/postgres"),
    ).toBe("db.abc.supabase.co:5432/postgres");
    expect(describeConnectionTarget("garbage")).toBe("the database");
  });
});

describe("isProbablyPostgresConnectionString", () => {
  it("accepts both postgres schemes and rejects others", () => {
    expect(isProbablyPostgresConnectionString(" postgresql://u@h/db ")).toBe(true);
    expect(isProbablyPostgresConnectionString("postgres://u@h/db")).toBe(true);
    expect(isProbablyPostgresConnectionString("mysql://u@h/db")).toBe(false);
    expect(isProbablyPostgresConnectionString("")).toBe(false);
  });
});

describe("stringifyCell", () => {
  it("preserves null rather than rendering it as text", () => {
    expect(stringifyCell(null)).toBeNull();
    expect(stringifyCell(undefined)).toBeNull();
  });

  it("renders scalars, dates, json, and bytea", () => {
    expect(stringifyCell(42)).toBe("42");
    expect(stringifyCell(true)).toBe("true");
    // @effect-diagnostics-next-line globalDate:off
    expect(stringifyCell(new Date("2026-07-19T10:00:00.000Z"))).toBe("2026-07-19T10:00:00.000Z");
    expect(stringifyCell({ a: 1 })).toBe('{"a":1}');
    expect(stringifyCell(new Uint8Array([0xde, 0xad]))).toBe("\\xdead");
  });

  it("elides very long values", () => {
    const rendered = stringifyCell("x".repeat(5_000));
    expect(rendered).toHaveLength(2_001);
    expect(rendered?.endsWith("…")).toBe(true);
  });
});

describe("capRows", () => {
  it("flags truncation only past the limit", () => {
    expect(capRows([1, 2, 3])).toEqual({ rows: [1, 2, 3], rowsTruncated: false });
    const many = capRows(Array.from({ length: 501 }, (_, index) => index));
    expect(many.rows).toHaveLength(500);
    expect(many.rowsTruncated).toBe(true);
  });
});
