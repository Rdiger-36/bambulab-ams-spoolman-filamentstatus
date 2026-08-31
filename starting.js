/**
 * The service process.
 *
 * Purpose:
 *  - Catches all global Node.js errors (including unhandled Promise rejections)
 *  - Sends all output to stdout/stderr → visible in `docker logs`
 *  - Clearly prefixes its own messages with "[Service]" for easy identification
 *  - Starts backend.js safely
 *  - Handles SIGTERM / SIGINT, which the supervisor forwards on a Docker stop
 *
 * This is what `entrypoint.js` forks. It runs in its own process so that the
 * supervisor can start it again after a requested restart; the error handlers
 * have to live here for the same reason, they only see the process they are in.
 */

import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------
// Logging Utilities
// ---------------------------------------------------------
function logInfo(message) {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[Service] [${timestamp}] ${message}\n`);
}

function logError(label, err) {
  const timestamp = new Date().toISOString();
  const details = err?.stack || err?.message || String(err);
  process.stderr.write(`[Service] [${timestamp}] [${label}] ${details}\n`);
}

// ---------------------------------------------------------
// Global Error Handling
// ---------------------------------------------------------
process.on("uncaughtException", (err) => {
  logError("UNCAUGHT EXCEPTION", err);
  process.exit(1); // crash visibly so Docker logs show the reason
});

process.on("unhandledRejection", (reason) => {
  logError("UNHANDLED REJECTION", reason);
  process.exit(1);
});

// ---------------------------------------------------------
// Graceful Shutdown for Docker Stop / Ctrl+C
// ---------------------------------------------------------
process.on("SIGTERM", () => {
  logInfo("SIGTERM received – shutting down backend...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logInfo("SIGINT (Ctrl+C) received – shutting down backend...");
  process.exit(0);
});

process.on("exit", (code) => {
  logInfo(`Service process exited with code ${code}`);
});

// ---------------------------------------------------------
// Start Backend
// ---------------------------------------------------------
(async () => {
  try {
    logInfo("Starting backend.js ...");

    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // Dynamic import so startup errors can be caught
    await import(path.join(__dirname, "backend.js"));

    logInfo("Backend is now running and waiting for events...");
  } catch (err) {
    logError("STARTUP ERROR", err);
    process.exit(1);
  }
})();
