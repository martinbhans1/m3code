// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
import { assert, it } from "@effect/vitest";

import { formatOutages, recordOutage, summariseOutages, type Outage } from "./watchdog-outages.ts";

it("collapses consecutive scans into one stretch, because nights are what matter", () => {
  let outages: readonly Outage[] = [];
  outages = recordOutage(outages, new Date("2026-09-09T01:00:00.000Z"), 0);
  outages = recordOutage(outages, new Date("2026-09-09T01:05:00.000Z"), 3);
  outages = recordOutage(outages, new Date("2026-09-09T01:10:00.000Z"), 2);

  assert.equal(outages.length, 1);
  assert.equal(outages[0]?.scans, 3);
  assert.equal(outages[0]?.startedAt, "2026-09-09T01:00:00.000Z");
  assert.equal(outages[0]?.lastSeenAt, "2026-09-09T01:10:00.000Z");
  // The worst moment is the honest figure: three conversations were waiting.
  assert.equal(outages[0]?.missedRestarts, 3);
});

it("starts a new stretch after a gap, because that is a separate outage", () => {
  let outages: readonly Outage[] = [];
  outages = recordOutage(outages, new Date("2026-09-09T01:00:00.000Z"), 1);
  outages = recordOutage(outages, new Date("2026-09-09T04:00:00.000Z"), 1);
  assert.equal(outages.length, 2);
});

it("sums the cost over the last month", () => {
  const outages: readonly Outage[] = [
    {
      startedAt: "2026-09-08T22:00:00.000Z",
      lastSeenAt: "2026-09-09T04:00:00.000Z",
      scans: 72,
      missedRestarts: 4,
    },
    {
      startedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-08-20T01:00:00.000Z",
      scans: 12,
      missedRestarts: 1,
    },
  ];
  const summary = summariseOutages(outages, new Date("2026-09-09T06:00:00.000Z"));
  assert.equal(summary.stretches, 2);
  assert.equal(summary.totalMinutes, 420);
  assert.equal(summary.missedRestarts, 5);
  assert.include(formatOutages(summary), "7.0 hours");
  assert.include(formatOutages(summary), "5 conversation(s)");
});

it("drops stretches older than the window", () => {
  const summary = summariseOutages(
    [
      {
        startedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T01:00:00.000Z",
        scans: 12,
        missedRestarts: 9,
      },
    ],
    new Date("2026-09-09T06:00:00.000Z"),
  );
  assert.equal(summary.stretches, 0);
  assert.include(formatOutages(summary), "nothing has been lost");
});

it("says plainly when an outage cost nothing", () => {
  const summary = summariseOutages(
    [
      {
        startedAt: "2026-09-09T01:00:00.000Z",
        lastSeenAt: "2026-09-09T02:00:00.000Z",
        scans: 12,
        missedRestarts: 0,
      },
    ],
    new Date("2026-09-09T06:00:00.000Z"),
  );
  assert.include(formatOutages(summary), "nothing was actually lost");
});
