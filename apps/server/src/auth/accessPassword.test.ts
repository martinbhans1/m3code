import { describe, expect, it } from "vite-plus/test";

import { hashAccessPassword, verifyAccessPasswordHash } from "./accessPassword.ts";

describe("accessPassword", () => {
  it("verifies the password it hashed", () => {
    const stored = hashAccessPassword("correct horse battery staple");

    expect(verifyAccessPasswordHash("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashAccessPassword("correct horse battery staple");

    expect(verifyAccessPasswordHash("Correct horse battery staple", stored)).toBe(false);
    expect(verifyAccessPasswordHash("", stored)).toBe(false);
  });

  it("salts each hash so identical passwords encode differently", () => {
    const first = hashAccessPassword("same-password");
    const second = hashAccessPassword("same-password");

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(verifyAccessPasswordHash("same-password", first)).toBe(true);
    expect(verifyAccessPasswordHash("same-password", second)).toBe(true);
  });

  it("accepts unicode passwords across equivalent normalisations", () => {
    // Composed "å" vs decomposed "a" + combining ring (U+0061 U+030A).
    // NFKC folds them together, so a password typed either way must verify.
    const composed = "blåbær";
    const decomposed = "blåbær";
    expect(composed).not.toBe(decomposed);

    const stored = hashAccessPassword(composed);

    expect(verifyAccessPasswordHash(composed, stored)).toBe(true);
    expect(verifyAccessPasswordHash(decomposed, stored)).toBe(true);
  });

  it("rejects malformed or truncated stored secrets", () => {
    const stored = hashAccessPassword("password");

    expect(verifyAccessPasswordHash("password", stored.subarray(0, 20))).toBe(false);
    expect(verifyAccessPasswordHash("password", new Uint8Array(0))).toBe(false);

    const wrongVersion = Uint8Array.from(stored);
    wrongVersion[0] = 2;
    expect(verifyAccessPasswordHash("password", wrongVersion)).toBe(false);
  });
});
