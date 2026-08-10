import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const MAIN_ENTRY = "dist-electron/main.cjs";
const ENTRY_WAIT_TIMEOUT_MS = 90_000;
const ENTRY_POLL_INTERVAL_MS = 100;

/**
 * In dev the main-process bundle is emitted by Vite in parallel with this
 * launch, so a cold start can reach Electron before `main.cjs` exists. Electron
 * responds with a modal "Unable to find Electron app" dialog and dies; the
 * watcher then writes the file a moment later, which made the failure look
 * intermittent and harmless. Wait for the entry instead of racing it.
 */
async function waitForMainEntry() {
  const entryPath = join(desktopDir, MAIN_ENTRY);
  if (existsSync(entryPath)) return;

  console.log(`[start-electron] waiting for ${MAIN_ENTRY} to be built…`);
  const deadline = Date.now() + ENTRY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(ENTRY_POLL_INTERVAL_MS);
    if (existsSync(entryPath)) return;
  }
  throw new Error(
    `${MAIN_ENTRY} was not produced within ${ENTRY_WAIT_TIMEOUT_MS / 1000}s. Is the desktop build running?`,
  );
}

await waitForMainEntry();

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand([MAIN_ENTRY]);
const child = spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
