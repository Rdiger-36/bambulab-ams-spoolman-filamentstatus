import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { shouldRestart, RESTART_EXIT_CODE, MAX_RESTARTS, RESTART_WINDOW_MS } from "../src/supervisor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/* ---- The decision, without a process ---- */

test("only the restart code restarts the service", () => {
    assert.equal(shouldRestart(RESTART_EXIT_CODE, []).restart, true);
    assert.equal(shouldRestart(0, []).restart, false);
    assert.equal(shouldRestart(1, []).restart, false);
    // A signalled exit reports no code and must not be treated as a request
    assert.equal(shouldRestart(null, []).restart, false);
});

test("too many restarts in a short time give up", () => {
    const now = 100000;
    const recent = Array(MAX_RESTARTS).fill(now - 1000);

    const givenUp = shouldRestart(RESTART_EXIT_CODE, recent, now);
    assert.equal(givenUp.restart, false);
    assert.match(givenUp.reason, /giving up/);

    // Outside the window they no longer count
    const old = recent.map(at => at - RESTART_WINDOW_MS);
    assert.equal(shouldRestart(RESTART_EXIT_CODE, old, now).restart, true);
});

/* ---- The supervisor as a process ---- */

/**
 * Runs entrypoint.js with the fixture in place of starting.js and resolves with
 * what it printed and the code it ended with.
 */
function runSupervisor(env, { signalAfterMs } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-sup-"));
    fs.copySync(path.join(root, "entrypoint.js"), path.join(dir, "entrypoint.js"));
    fs.copySync(path.join(here, "fixtures", "exiting-service.js"), path.join(dir, "starting.js"));
    // The whole src directory, so this does not break every time entrypoint.js
    // imports one more module from it.
    fs.copySync(path.join(root, "src"), path.join(dir, "src"));

    return new Promise(resolve => {
        const child = fork(path.join(dir, "entrypoint.js"), [], {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });

        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });

        if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);

        child.on("exit", code => {
            fs.removeSync(dir);
            resolve({ code, output });
        });
    });
}

test("the supervisor starts the service again on a restart request", async () => {
    // The fixture asks for a restart every time, so the loop guard is what ends
    // it: MAX_RESTARTS starts after the first one, then the code is passed on.
    const { code, output } = await runSupervisor({ EXIT_CODE: String(RESTART_EXIT_CODE) });

    assert.equal(code, RESTART_EXIT_CODE);
    assert.equal(output.match(/\[fixture\] up/g).length, MAX_RESTARTS + 1);
    assert.match(output, /giving up/);
});

test("the supervisor passes on any other exit code and tells the service it is supervised", async () => {
    const { code, output } = await runSupervisor({ EXIT_CODE: "3" });

    assert.equal(code, 3);
    assert.match(output, /supervised=1/);
    assert.match(output, /not a restart request/);
    assert.equal(output.match(/\[fixture\] up/g).length, 1);
});

test("SIGTERM reaches the service and stops the supervisor with it", async () => {
    const { code, output } = await runSupervisor(
        { EXIT_CODE: "0", EXIT_AFTER_MS: "10000" },
        { signalAfterMs: 400 },
    );

    assert.equal(code, 0);
    assert.match(output, /\[fixture\] SIGTERM/);
    assert.match(output, /Service stopped/);
});
