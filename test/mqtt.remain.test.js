import test from "node:test";
import assert from "node:assert/strict";

import { waitedLongEnoughForRemain } from "../src/mqtt.js";

// Creating a Spoolman spool writes its used weight, derived from the AMS remain
// percentage. The AMS reports none for the first seconds after a spool goes in,
// measured between 17 and 74 seconds on a P2S, so a spool created in that
// window is stored as brand new. Creation waits, up to a limit.

const slot = (remain, uuid = "A6A4F33B") => ({ remain, tray_uuid: uuid });

test("a slot with a reading never waits, and clears an earlier wait", () => {
    const printer = { remainWaits: {} };

    assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(null)), false);
    assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(100)), true);
    assert.deepEqual(printer.remainWaits, {}, "the counter is dropped, not left to expire");
});

test("a slot without a reading waits five updates, then gives up", () => {
    const printer = { remainWaits: {} };

    for (let update = 1; update <= 5; update++) {
        assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(null)), false, `update ${update}`);
    }
    // Better a spool stored as full than a spool never created at all, for a
    // chip that reports nothing.
    assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(null)), true);
});

test("a different spool in the same slot starts the wait over", () => {
    const printer = { remainWaits: {} };

    for (let update = 1; update <= 5; update++) waitedLongEnoughForRemain(printer, "A0", slot(null));
    assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(null, "OTHER")), false);
    assert.equal(printer.remainWaits.A0.waits, 1);
});

test("slots are counted apart", () => {
    const printer = { remainWaits: {} };

    for (let update = 1; update <= 6; update++) waitedLongEnoughForRemain(printer, "A0", slot(null));
    assert.equal(waitedLongEnoughForRemain(printer, "A1", slot(null, "B19E8E14")), false);
});

test("a printer created before the counter existed does not crash", () => {
    const printer = {};
    assert.equal(waitedLongEnoughForRemain(printer, "A0", slot(null)), false);
    assert.deepEqual(printer.remainWaits, { A0: { uuid: "A6A4F33B", waits: 1 } });
});
