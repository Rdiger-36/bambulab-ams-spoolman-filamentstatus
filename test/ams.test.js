import test from "node:test";
import assert from "node:assert/strict";

import { correctRemainInt } from "../src/ams.js";

test("correctRemainInt passes through a full-size spool unchanged", () => {
    assert.equal(correctRemainInt(63, 1000, "PLA"), 63);
});

test("correctRemainInt rescales a sub-1kg spool from the 1kg basis", () => {
    // The AMS reports 25% of 1000g = 250g left, which is all of a 250g spool
    assert.equal(correctRemainInt(25, 250, "PLA"), 100);
    // 10% of 1000g = 100g left on a 500g spool -> 20%
    assert.equal(correctRemainInt(10, 500, "PLA"), 20);
});

test("correctRemainInt leaves support material alone", () => {
    // Support material is already measured against its real spool size, so
    // rescaling it would report far more than is actually left.
    assert.equal(correctRemainInt(40, 250, "PLA-S"), 40);
});

test("correctRemainInt clamps the rescaled value to 100%", () => {
    assert.equal(correctRemainInt(90, 250, "PLA"), 100);
});
