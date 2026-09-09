// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
// @effect-diagnostics nodeBuiltinImport:off - Exercises the watchdog's own plain-node IO.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, it } from "@effect/vitest";

import { decide } from "./watchdog-decide.ts";
import { observe } from "./watchdog-observe.ts";
import { watchdogPaths } from "./watchdog-store.ts";

/**
 * The columns the watchdog reads, exactly as the app's migrations create them.
 * Pinning them here is the point: the queries are the one part of the watchdog
 * that fails silently if a projection is renamed out from under it.
 */
const SCHEMA = [
  `create table projection_threads (
     thread_id text primary key, project_id text not null, title text not null,
     runtime_mode text not null default 'full-access', interaction_mode text not null default 'default',
     model_selection_json text, archived_at text, done_at text, latest_user_message_at text,
     updated_at text not null, deleted_at text)`,
  `create table projection_projects (
     project_id text primary key, title text not null, workspace_root text not null)`,
  `create table projection_thread_sessions (
     thread_id text primary key, status text not null, provider_name text,
     provider_instance_id text, last_error text, updated_at text not null)`,
  `create table projection_turns (
     row_id integer primary key autoincrement, thread_id text not null, turn_id text,
     state text not null, requested_at text not null, started_at text, completed_at text)`,
  `create table projection_thread_activities (
     activity_id text primary key, thread_id text not null, turn_id text, tone text not null,
     kind text not null, summary text not null, payload_json text not null, created_at text not null)`,
];

const LIMIT_MESSAGE = "You've hit your session limit \u00b7 resets 3:40am (Europe/Oslo)";
const STOPPED_AT = "2026-09-09T01:15:00.000Z";

function buildFixture(): ReturnType<typeof watchdogPaths> {
  const baseDir = mkdtempSync(join(tmpdir(), "watchdog-observe-"));
  const paths = watchdogPaths(baseDir);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(
    paths.serverRuntimeFile,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 3773,
      origin: "http://127.0.0.1:3773",
    }),
  );
  writeFileSync(paths.settingsFile, JSON.stringify({ orchestratorProjectId: "project-orch" }));

  const database = new DatabaseSync(paths.databaseFile);
  for (const statement of SCHEMA) database.exec(statement);
  database.exec(
    `insert into projection_projects values ('project-1', 'dealjourney', 'C:/repo'),
                                            ('project-orch', 'Orchestrator', 'C:/repo')`,
  );
  const addThread = (
    threadId: string,
    projectId: string,
    turnState: string,
    errorMessage: string | null,
  ) => {
    database
      .prepare(
        `insert into projection_threads (thread_id, project_id, title, updated_at, latest_user_message_at)
         values (?, ?, ?, ?, '2026-09-08T22:00:00.000Z')`,
      )
      .run(threadId, projectId, `Thread ${threadId}`, STOPPED_AT);
    database
      .prepare(
        `insert into projection_turns (thread_id, turn_id, state, requested_at, started_at, completed_at)
         values (?, ?, ?, '2026-09-09T00:50:00.000Z', '2026-09-09T00:50:00.000Z', ?)`,
      )
      .run(threadId, `${threadId}-turn`, turnState, STOPPED_AT);
    database
      .prepare(
        `insert into projection_thread_sessions (thread_id, status, provider_name, provider_instance_id, last_error, updated_at)
         values (?, 'stopped', 'claudeAgent', 'claudeAgent', ?, ?)`,
      )
      .run(threadId, errorMessage, STOPPED_AT);
    if (errorMessage !== null) {
      database
        .prepare(
          `insert into projection_thread_activities
             (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
           values (?, ?, ?, 'error', 'runtime.error', 'Runtime error', ?, ?)`,
        )
        .run(
          `${threadId}-activity`,
          threadId,
          `${threadId}-turn`,
          JSON.stringify({ message: errorMessage }),
          STOPPED_AT,
        );
    }
  };
  addThread("limited-worker", "project-1", "error", LIMIT_MESSAGE);
  addThread("limited-orchestrator", "project-orch", "error", LIMIT_MESSAGE);
  addThread("crashed", "project-1", "error", "API Error: 529 Overloaded.");
  addThread("finished", "project-1", "completed", null);
  database.close();
  return paths;
}

it("reads stopped conversations out of the app's own projections", () => {
  const paths = buildFixture();
  const snapshot = observe(paths, new Date("2026-09-09T01:45:00.000Z"));

  assert.isTrue(snapshot.serverRunning);
  assert.equal(snapshot.threadsWithFailedLatestTurn, 3);
  assert.notInclude(
    snapshot.threads.map((thread) => thread.threadId),
    "finished",
  );

  const worker = snapshot.threads.find((thread) => thread.threadId === "limited-worker");
  assert.equal(worker?.runtimeErrorMessage, LIMIT_MESSAGE);
  assert.equal(worker?.runtimeErrorAt, STOPPED_AT);
  assert.equal(worker?.projectTitle, "dealjourney");
  assert.equal(worker?.sessionStatus, "stopped");
  assert.isFalse(worker?.isOrchestrator);

  const orchestrator = snapshot.threads.find(
    (thread) => thread.threadId === "limited-orchestrator",
  );
  assert.isTrue(orchestrator?.isOrchestrator);
});

it("feeds the decision, which picks the supervisor and leaves the crash alone", () => {
  const paths = buildFixture();
  const now = new Date("2026-09-09T01:45:00.000Z");
  const decision = decide(observe(paths, now), [], now);

  assert.equal(decision.action.kind, "nudge");
  if (decision.action.kind !== "nudge") return;
  assert.equal(decision.action.threadId, "limited-orchestrator");
  assert.equal(
    decision.verdicts.find((verdict) => verdict.threadId === "crashed")?.verdict,
    "ignore",
  );
});
