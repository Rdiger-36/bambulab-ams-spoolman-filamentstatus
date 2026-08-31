/**
 * Container entrypoint and supervisor for starting.js
 *
 * Purpose:
 *  - Runs the service (starting.js) as a child process and starts it again when
 *    it asks for a restart, which is what the restart button in the Web UI does
 *  - Passes every other exit code on, so a crash keeps meaning a crash and the
 *    Docker restart policy stays in charge of it
 *  - Forwards SIGTERM / SIGINT to the service and waits for it, so `docker stop`
 *    ends in a clean shutdown rather than in a SIGKILL after the grace period
 *  - Clearly prefixes all messages with "[Entrypoint]" for easy identification
 *
 * Set SUPERVISOR=false to run the service inside this process instead, without
 * the second Node process. Restarting from the Web UI then depends on the
 * container being restarted from the outside, which the UI says.
 *
 * Never put application logic here. It belongs in backend.js and src/.
 */

import path from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";

import { RESTART_EXIT_CODE, shouldRestart } from "./src/supervisor.js";

// How long the service may take to shut down before it is killed. Below the ten
// seconds Docker waits after SIGTERM, so the kill still happens in here.
const SHUTDOWN_TIMEOUT_MS = 8000;

// ---------------------------------------------------------
// Logging Utilities
// ---------------------------------------------------------
function logInfo(message) {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[Entrypoint] [${timestamp}] ${message}\n`);
}

function logError(label, err) {
  const timestamp = new Date().toISOString();
  const details = err?.stack || err?.message || String(err);
  process.stderr.write(`[Entrypoint] [${timestamp}] [${label}] ${details}\n`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const servicePath = path.join(__dirname, "starting.js");

// ---------------------------------------------------------
// Supervised mode
// ---------------------------------------------------------
function supervise() {
  const restarts = [];
  let child = null;
  let stopping = false;

  const start = () => {
    // SUPERVISED tells the service that a restart really brings it back, so the
    // Web UI can say what will happen rather than list conditions.
    child = fork(servicePath, [], {
      stdio: "inherit",
      env: { ...process.env, SUPERVISED: "1" },
    });

    child.on("exit", (code, signal) => {
      child = null;

      if (stopping) {
        logInfo("Service stopped.");
        process.exit(0);
      }

      // A signalled exit reports no code. It was not requested through the
      // restart code, so it is passed on like any other unexpected end.
      const status = code === null ? 1 : code;
      const decision = shouldRestart(status, restarts);

      if (!decision.restart) {
        logInfo(`Service ended (${signal ? `signal ${signal}` : `code ${status}`}), ${decision.reason}.`);
        process.exit(status);
      }

      restarts.push(Date.now());
      logInfo(`Service asked for a restart, starting it again (${restarts.length}).`);
      start();
    });

    child.on("error", (err) => logError("SERVICE ERROR", err));
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      logInfo(`${signal} received – stopping the service...`);

      if (!child) process.exit(0);

      child.kill(signal);
      // Docker sends SIGKILL after its grace period anyway; doing it here first
      // keeps the shutdown inside this process where it can be logged.
      setTimeout(() => {
        if (child) {
          logInfo("Service did not stop in time, killing it.");
          child.kill("SIGKILL");
        }
      }, SHUTDOWN_TIMEOUT_MS).unref();
    });
  }

  logInfo(`Supervising ${path.basename(servicePath)}, restart exit code is ${RESTART_EXIT_CODE}.`);
  start();
}

// ---------------------------------------------------------
// Single process mode
// ---------------------------------------------------------
async function runInProcess() {
  logInfo("SUPERVISOR=false, running the service in this process.");

  try {
    await import(servicePath);
  } catch (err) {
    logError("STARTUP ERROR", err);
    process.exit(1);
  }
}

if (process.env.SUPERVISOR === "false") {
  runInProcess();
} else {
  supervise();
}
