import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The module reads its path from config.js at import time, so DATA_DIR has to
// point at a throwaway directory before the first import.
let dir, mappingsPath, getMapping, setMapping, slotFingerprint;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-map-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    ({ mappingsPath } = await import("../src/config.js"));
    ({ getMapping, setMapping, slotFingerprint } = await import("../src/mappings.js"));
});
after(() => fs.removeSync(dir));

const slot = (overrides = {}) => ({
    tray_info_idx: "GFA00",
    tray_type: "PLA",
    tray_color: "F98C36FF",
    ...overrides,
});

const stored = () => JSON.parse(fs.readFileSync(mappingsPath, "utf-8"));

test("the fingerprint carries the filament profile as well as material and colour", () => {
    assert.equal(slotFingerprint(slot()), "GFA00|PLA|F98C36");

    // The profile alone would not tell these two apart: a P2S reports the
    // generic GFL99 for every 3rd party spool, whatever is on it
    assert.equal(slotFingerprint(slot({ tray_info_idx: "GFL99" })), "GFL99|PLA|F98C36");
    assert.equal(slotFingerprint(slot({ tray_info_idx: "GFL99", tray_type: "PETG" })), "GFL99|PETG|F98C36");

    // A slot that reports none of it still produces a comparable value
    assert.equal(slotFingerprint({}), "?|?|");
});

test("a spool swap that keeps material and colour is noticed", () => {
    // The case this exists for: two spools that only the filament profile tells
    // apart. Keyed on material and colour alone the assignment survived the
    // swap and the next print was booked onto the wrong spool.
    setMapping("P1", "A0", 42, slot());

    const swapped = getMapping("P1", "A0", slot({ tray_info_idx: "GFA01" }));

    assert.equal(swapped, null);
    assert.equal(stored().P1, undefined);
});

test("the same spool keeps its assignment", () => {
    setMapping("P2", "A0", 7, slot());

    assert.equal(getMapping("P2", "A0", slot()).spoolId, 7);
    // A colour that differs only in the alpha byte is the same spool
    assert.equal(getMapping("P2", "A0", slot({ tray_color: "F98C3600" })).spoolId, 7);
});

test("a fingerprint from before the profile was included still matches, and is rewritten", async () => {
    // Existing installs have these on disk and there is no migration step, so
    // an upgrade must not silently drop every assignment
    fs.outputFileSync(mappingsPath, JSON.stringify({
        P3: { A0: { spoolId: 5, fingerprint: "PLA|F98C36", updatedAt: "2026-08-01T00:00:00.000Z" } },
    }));
    // Drop the module cache so the file above is the state it loads
    const { getMapping: freshGetMapping } = await import(`../src/mappings.js?legacy=${Date.now()}`);

    const entry = freshGetMapping("P3", "A0", slot());

    assert.equal(entry.spoolId, 5);
    assert.equal(entry.fingerprint, "GFA00|PLA|F98C36");
    assert.equal(stored().P3.A0.fingerprint, "GFA00|PLA|F98C36");
});

test("an old fingerprint for a different filament is still dropped", async () => {
    fs.outputFileSync(mappingsPath, JSON.stringify({
        P4: { A0: { spoolId: 9, fingerprint: "PETG|1E88E5", updatedAt: "2026-08-01T00:00:00.000Z" } },
    }));
    const { getMapping: freshGetMapping } = await import(`../src/mappings.js?stale=${Date.now()}`);

    assert.equal(freshGetMapping("P4", "A0", slot()), null);
});

/* ---- Multi colour spools ---- */

const gradient = (colors, overrides = {}) => ({
    tray_info_idx: "GFA00",
    tray_type: "PLA",
    tray_color: `${colors[0]}FF`,
    cols: colors.map(c => `${c}FF`),
    ...overrides,
});

test("the fingerprint carries the colour set of a multi colour spool", () => {
    // A gradient spool is not a profile of its own: Bambu Studio slices PLA
    // Basic Gradient as GFA00, the same as plain PLA Basic. With only the first
    // colour in the fingerprint, Arctic Whisper and Solar Breeze were the same
    // spool as far as an assignment could tell, and so was ordinary white.
    const arctic = slotFingerprint(gradient(["FFFFFF", "9CDBD9"]));
    const solar  = slotFingerprint(gradient(["FFFFFF", "E94B3C"]));
    const plain  = slotFingerprint({ tray_info_idx: "GFA00", tray_type: "PLA", tray_color: "FFFFFFFF" });

    assert.equal(new Set([arctic, solar, plain]).size, 3);
    // The single colour spool keeps the three part fingerprint it always had,
    // so nothing on disk has to be migrated for it
    assert.equal(plain, "GFA00|PLA|FFFFFF");
    assert.equal(arctic, "GFA00|PLA|FFFFFF|9CDBD9+FFFFFF");
});

test("swapping one gradient for another drops the assignment", () => {
    setMapping("P4", "A0", 11, gradient(["FFFFFF", "9CDBD9"]));

    assert.equal(getMapping("P4", "A0", gradient(["FFFFFF", "9CDBD9"])).spoolId, 11);
    assert.equal(getMapping("P4", "A0", gradient(["FFFFFF", "E94B3C"])), null);
});

test("a fingerprint from before the colour set still matches, and is rewritten", async () => {
    // Same reasoning as the two part format above: an upgrade must not drop
    // every assignment that happens to sit on a multi colour spool.
    fs.outputFileSync(mappingsPath, JSON.stringify({
        P5: { A0: { spoolId: 9, fingerprint: "GFA00|PLA|FFFFFF", updatedAt: "2026-08-01T00:00:00.000Z" } },
    }));
    const fresh = await import(`../src/mappings.js?colorset=${Date.now()}`);

    const slot = gradient(["FFFFFF", "9CDBD9"]);
    assert.equal(fresh.getMapping("P5", "A0", slot).spoolId, 9);
    assert.equal(stored().P5.A0.fingerprint, "GFA00|PLA|FFFFFF|9CDBD9+FFFFFF");
});
