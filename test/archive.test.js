import test from "node:test";
import assert from "node:assert/strict";

import { spoolIsEmpty } from "../src/utils.js";

// The one decision behind the automatic archiving of an empty spool. It rests
// on what Spoolman holds, never on the AMS remain percentage, which is an
// estimate that reaches 0 while there is still filament on the spool.

test("a spool at or below the threshold is empty", () => {
    assert.equal(spoolIsEmpty(0), true);
    assert.equal(spoolIsEmpty(0, 0), true);
    assert.equal(spoolIsEmpty(5, 10), true);
    assert.equal(spoolIsEmpty(10, 10), true);
});

test("a spool above the threshold is not empty", () => {
    assert.equal(spoolIsEmpty(1), false);
    assert.equal(spoolIsEmpty(11, 10), false);
    assert.equal(spoolIsEmpty(950), false);
});

test("an unknown weight is never empty", () => {
    // Spoolman leaves remaining_weight null for a spool whose filament carries
    // no weight, and "unknown" must not archive a spool that may be full.
    assert.equal(spoolIsEmpty(null), false);
    assert.equal(spoolIsEmpty(undefined), false);
    assert.equal(spoolIsEmpty("", 0), false);
    assert.equal(spoolIsEmpty(NaN), false);
});

test("a negative weight counts as empty", () => {
    // Booking more than the spool held leaves Spoolman below zero, which is as
    // empty as a spool gets.
    assert.equal(spoolIsEmpty(-3), true);
});

test("a missing threshold is treated as zero", () => {
    assert.equal(spoolIsEmpty(0, undefined), true);
    assert.equal(spoolIsEmpty(0, null), true);
    assert.equal(spoolIsEmpty(1, null), false);
});
