import test from "node:test";
import assert from "node:assert/strict";

import { correctRemainInt, haveSpoolDataChanged } from "../src/ams.js";

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

const spool = (id, tag, remaining) => ({
    id,
    extra: { tag: `"${tag}"` },
    remaining_weight: remaining,
    used_weight: 1000 - remaining,
    filament: { id, name: "Black", material: "PLA" },
});

test("haveSpoolDataChanged treats an unseeded baseline as changed", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], null), true);
});

test("haveSpoolDataChanged detects the first spool on a previously empty Spoolman", async () => {
    // The fresh-install case: the baseline is genuinely empty and the first
    // created spool has to register as a change.
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], []), true);
});

test("haveSpoolDataChanged ignores the order of the Spoolman response", async () => {
    const a = spool(1, "AAA", 800);
    const b = spool(2, "BBB", 500);
    assert.equal(await haveSpoolDataChanged([a, b], [b, a]), false);
});

test("haveSpoolDataChanged detects a changed remaining weight", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 700)], [spool(1, "AAA", 800)]), true);
});
