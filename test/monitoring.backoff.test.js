import test from "node:test";
import assert from "node:assert/strict";

import { offlineBackoff } from "../src/utils.js";
import { resetOfflineBackoff } from "../src/mqtt.js";

// A printer that is switched off more often than it is on was probed at the
// same pace forever, one failed connection and one log line every interval.
// The wait grows from the check interval up to the configured limit instead.

test("the first failure waits the check interval", () => {
    // A printer that dropped off for a moment has to come back as fast as it
    // did before the backoff existed.
    assert.equal(offlineBackoff(0, 20000, 300000), 20000);
});

test("the wait doubles with every further failure", () => {
    assert.equal(offlineBackoff(1, 20000, 300000), 40000);
    assert.equal(offlineBackoff(2, 20000, 300000), 80000);
    assert.equal(offlineBackoff(3, 20000, 300000), 160000);
});

test("the wait stops at the limit", () => {
    assert.equal(offlineBackoff(4, 20000, 300000), 300000);
    assert.equal(offlineBackoff(50, 20000, 300000), 300000);
    // A printer that has been off for weeks must not overflow into Infinity.
    assert.equal(Number.isFinite(offlineBackoff(2000, 20000, 300000)), true);
});

test("a limit below the check interval keeps the pace constant", () => {
    // Which is how the backoff is switched off: the two values are equal.
    assert.equal(offlineBackoff(0, 60000, 60000), 60000);
    assert.equal(offlineBackoff(5, 60000, 60000), 60000);
    assert.equal(offlineBackoff(5, 60000, 10000), 60000);
});

test("nonsense values fall back to the check interval", () => {
    assert.equal(offlineBackoff(0, 0, 0), 20000);
    assert.equal(offlineBackoff(-3, 30000, 300000), 30000);
    assert.equal(offlineBackoff(Number.NaN, 30000, 300000), 30000);
});

test("a user action clears the wait a printer had built up", () => {
    // Resuming monitoring, reconnecting or editing a printer is not the monitor
    // loop, so it must not wait out a five minute backoff first.
    const printer = { offlineChecks: 7, nextCheckAt: Date.now() + 300000, offlineWaitLogged: 300000 };

    resetOfflineBackoff(printer);

    assert.equal(printer.offlineChecks, 0);
    assert.equal(printer.nextCheckAt, 0);
    assert.equal(printer.offlineWaitLogged, null);
});
