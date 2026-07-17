import { describe, assert, it } from "vite-plus/test";
import { formatPercentLabel, isWindowsPlatform } from "./utils";

describe("formatPercentLabel", () => {
  it("keeps one significant decimal below 10%", () => {
    assert.strictEqual(formatPercentLabel(4.25), "4.3%");
    assert.strictEqual(formatPercentLabel(0), "0%");
    // A trailing .0 is noise, not precision.
    assert.strictEqual(formatPercentLabel(3.02), "3%");
  });

  it("rounds to whole percent at 10% and above", () => {
    assert.strictEqual(formatPercentLabel(10), "10%");
    assert.strictEqual(formatPercentLabel(81.4), "81%");
    assert.strictEqual(formatPercentLabel(99.6), "100%");
  });

  it("returns null for absent or non-finite input", () => {
    assert.isNull(formatPercentLabel(null));
    assert.isNull(formatPercentLabel(undefined));
    assert.isNull(formatPercentLabel(Number.NaN));
    assert.isNull(formatPercentLabel(Number.POSITIVE_INFINITY));
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});
