import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  DEFAULT_COLD_THREAD_AFTER_MS,
  isDoneStampSuperseded,
  isThreadCold,
  threadQuietDays,
  type ThreadDispositionInput,
} from "./threadDisposition.ts";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const daysAgo = (days: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - days * 24 * 60 * 60 * 1000));

/** A thread that is cold, so each test can name the one thing it changes. */
const coldThread = (overrides: Partial<ThreadDispositionInput> = {}): ThreadDispositionInput => ({
  archivedAt: null,
  doneAt: null,
  updatedAt: daysAgo(6),
  hasPendingFollowups: true,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  isRunning: false,
  ...overrides,
});

describe("isDoneStampSuperseded", () => {
  it("lifts the stamp once the user writes into the thread again", () => {
    expect(isDoneStampSuperseded(daysAgo(3), daysAgo(1))).toBe(true);
  });

  it("keeps a stamp applied after the last user message", () => {
    expect(isDoneStampSuperseded(daysAgo(1), daysAgo(3))).toBe(false);
  });

  it("treats a message at the same instant as not superseding", () => {
    const at = daysAgo(2);
    expect(isDoneStampSuperseded(at, at)).toBe(false);
  });

  it("has nothing to supersede on an un-stamped thread", () => {
    expect(isDoneStampSuperseded(null, daysAgo(1))).toBe(false);
  });

  it("leaves the stamp alone when the thread has no user messages", () => {
    expect(isDoneStampSuperseded(daysAgo(1), null)).toBe(false);
  });
});

describe("isThreadCold", () => {
  it("flags a quiet thread that still has follow-ups open", () => {
    expect(isThreadCold(coldThread(), NOW)).toBe(true);
  });

  it("does not flag a thread the user has already ruled on", () => {
    expect(isThreadCold(coldThread({ doneAt: daysAgo(5) }), NOW)).toBe(false);
    expect(isThreadCold(coldThread({ archivedAt: daysAgo(5) }), NOW)).toBe(false);
  });

  it("does not flag a thread that is working", () => {
    expect(isThreadCold(coldThread({ isRunning: true }), NOW)).toBe(false);
  });

  it("does not flag a thread that is already blocking the user", () => {
    // These are surfaced loudly elsewhere; listing them here as well would make
    // both lists worth less.
    expect(isThreadCold(coldThread({ hasPendingApprovals: true }), NOW)).toBe(false);
    expect(isThreadCold(coldThread({ hasPendingUserInput: true }), NOW)).toBe(false);
  });

  it("requires an open follow-up, so 'cold' cannot decay into 'old'", () => {
    expect(isThreadCold(coldThread({ hasPendingFollowups: false }), NOW)).toBe(false);
  });

  it("waits out the threshold before calling a thread cold", () => {
    expect(isThreadCold(coldThread({ updatedAt: daysAgo(1) }), NOW)).toBe(false);
    expect(isThreadCold(coldThread({ updatedAt: daysAgo(2.9) }), NOW)).toBe(false);
    expect(isThreadCold(coldThread({ updatedAt: daysAgo(3.1) }), NOW)).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(isThreadCold(coldThread({ updatedAt: daysAgo(6) }), NOW, week)).toBe(false);
    expect(isThreadCold(coldThread({ updatedAt: daysAgo(8) }), NOW, week)).toBe(true);
  });

  it("defaults to three days", () => {
    expect(DEFAULT_COLD_THREAD_AFTER_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("treats an unreadable timestamp as not cold rather than guessing", () => {
    expect(isThreadCold(coldThread({ updatedAt: "not a date" }), NOW)).toBe(false);
  });
});

describe("threadQuietDays", () => {
  it("counts whole days since the thread last moved", () => {
    expect(threadQuietDays(daysAgo(6), NOW)).toBe(6);
    expect(threadQuietDays(daysAgo(0.5), NOW)).toBe(0);
  });

  it("never reports negative days for a clock skewed into the future", () => {
    expect(threadQuietDays(daysAgo(-2), NOW)).toBe(0);
  });

  it("returns null when the timestamp cannot be read", () => {
    expect(threadQuietDays("not a date", NOW)).toBe(null);
  });
});
