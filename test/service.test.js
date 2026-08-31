import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// A throwaway data directory, so importing the printer store does not read or
// write a real installation. Set before the first import, the paths are
// resolved once.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-service-"));
process.env.DATA_DIR = path.join(dir, "printers");
process.env.LOG_DIR = path.join(dir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const { restartService } = await import("../src/service.js");
const { RESTART_EXIT_CODE } = await import("../src/supervisor.js");
const { printers, addPrinter } = await import("../src/printers.js");

test("restarting closes the MQTT connections and ends the process", async () => {
    // The exit is injected, otherwise this would take the test runner with it.
    addPrinter({ id: "01p00a000000009", code: "12345678", ip: "127.0.0.1", name: "Test" });

    let ended = false;
    printers[0].mqttClient = { end: () => { ended = true; } };
    printers[0].mqttRunning = true;

    let exitCode = null;
    await restartService({ delay: 0, exit: code => { exitCode = code; } });

    assert.equal(ended, true);
    assert.equal(printers[0].mqttClient, null);
    assert.equal(printers[0].mqttRunning, false);
    // The supervisor restarts on exactly this code, and it is non zero so a
    // container without the supervisor is restarted by its own policy.
    assert.equal(exitCode, RESTART_EXIT_CODE);

    fs.removeSync(dir);
});
