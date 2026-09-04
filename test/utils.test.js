import test from "node:test";
import assert from "node:assert/strict";

import { convertAMSandSlot, EXTERNAL_SLOT } from "../src/utils.js";

test("a unit's slots are labelled the way the printer counts them", () => {
    // MQTT counts a unit's slots from 0, the printer's display and Bambu Studio
    // from 1. The label is read next to that hardware, so it says the same.
    assert.deepEqual([0, 1, 2, 3].map(slot => convertAMSandSlot(0, slot)), ["A1", "A2", "A3", "A4"]);
    assert.equal(convertAMSandSlot(3, 3), "D4");
    // The ids arrive as strings in some reports and as numbers in others
    assert.equal(convertAMSandSlot("1", "0"), "B1");
});

test("a unit without a slot is the unit's own label", () => {
    // What the AMS environment readings are keyed by: the unit, not a slot in it
    assert.equal(convertAMSandSlot(0, null), "A");
    assert.equal(convertAMSandSlot(1, null), "B");
});

test("the single slot units carry no slot number", () => {
    assert.equal(convertAMSandSlot(128, 0), "HT-A");
    assert.equal(convertAMSandSlot(135, 0), "HT-H");
    assert.equal(convertAMSandSlot(255, 0), EXTERNAL_SLOT);
});

test("a unit outside the known ranges is marked as unaddressable", () => {
    assert.equal(convertAMSandSlot(4, 0), "Z");
    assert.equal(convertAMSandSlot(127, 0), "Z");
});
