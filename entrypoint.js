/**
 * Entrypoint for backend.js
 *
 * Purpose:
 *  - Catches all global Node.js errors (including unhandled Promise rejections)
 *  - Sends all output to stdout/stderr → visible in `docker logs`
 *  - Clearly prefixes all messages with "[Entrypoint]" for easy identification
 *  - Starts backend.js safely
 *  - Handles SIGTERM / SIGINT (Docker stop or Ctrl+C)
 *  - Logs exit codes when the process ends
 */

import path from "path";
import { fileURLToPath } from "url";

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
  logInfo(`Node process exited with code ${code}`);
});

// ---------------------------------------------------------
// Start Backend
// ---------------------------------------------------------
(async () => {
  try {
    logInfo("Starting backend.js ...");

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const backendPath = path.join(__dirname, "backend.js");

    // Dynamic import so startup errors can be caught
    const module = await import(backendPath);

    logInfo("backend.js imported successfully.");

    // If backend.js exports a default() function, execute it
    if (module?.default && typeof module.default === "function") {
      logInfo("Executing backend.js default() function...");
      await module.default();
      logInfo("backend.js default() function finished.");
    }

    logInfo("Backend is now running and waiting for events...");
  } catch (err) {
    logError("STARTUP ERROR", err);
    process.exit(1);
  }
})();
