import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// The module reads its path from config.js at import time, so DATA_DIR has to
// point at a throwaway directory before the first import.
let dir, presetsPath, learnPresets, learnedPreset, allLearnedPresets, isCustomPresetId, resetPresetsForTests, parseSliceInfo;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-presets-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    ({ presetsPath } = await import("../src/config.js"));
    ({ learnPresets, learnedPreset, allLearnedPresets, isCustomPresetId, resetPresetsForTests } = await import("../src/presets.js"));
    ({ parseSliceInfo } = await import("../src/gcode.js"));
});

after(() => { fs.removeSync(dir); });

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf-8");

// A plate sliced on a P2S on 2026-09-08 with a Fiberlogy PLA from Bambu
// Studio's cloud library in A3, exported with "Export sliced file". The slot
// reported Pdd34802 for that spool; the file names it.
const cloudPlate = () => parseSliceInfo(read("p2s_cloud_preset.config"), read("p2s_cloud_preset.settings.json"));

test("the sliced file names every preset of the project, id, name and vendor side by side", () => {
    const { presets, filaments } = cloudPlate();
    assert.equal(presets.length, 8);
    assert.deepEqual(presets[7], { id: "Pdd34802", name: "fibrelogy PLA Basic", vendor: "fibrelogy" });
    // The "@BBL P2S 0.6 nozzle" tail names the printer profile and is dropped
    assert.deepEqual(presets[0], { id: "GFA00", name: "Bambu PLA Basic", vendor: "Bambu Lab" });
    assert.deepEqual(presets[2], { id: "GFL99", name: "Generic PLA", vendor: "Generic" });
    // The one filament the plate prints is the eighth, and it carries the hash
    assert.deepEqual(filaments.map(f => f.tray_info_idx), ["Pdd34802"]);
});

test("without project settings there are no presets, and a broken file yields none", () => {
    assert.deepEqual(parseSliceInfo(read("p2s_cloud_preset.config")).presets, []);
    assert.deepEqual(parseSliceInfo(read("p2s_cloud_preset.config"), "not json").presets, []);
    assert.deepEqual(parseSliceInfo(read("p2s_cloud_preset.config"), "{}").presets, []);
});

test("only the hashes are learned, and they are written to disk", () => {
    const learned = learnPresets(cloudPlate(), "Cube-P2S-fibrelogy-A3");
    assert.deepEqual(learned, [{ id: "PDD34802", name: "fibrelogy PLA Basic", vendor: "fibrelogy" }]);

    assert.deepEqual(learnedPreset("Pdd34802"), learnedPreset("PDD34802"));
    assert.equal(learnedPreset("Pdd34802").name, "fibrelogy PLA Basic");
    assert.equal(learnedPreset("Pdd34802").vendor, "fibrelogy");
    assert.equal(learnedPreset("Pdd34802").from, "Cube-P2S-fibrelogy-A3");
    assert.equal(learnedPreset("GFA00"), null);
    assert.equal(learnedPreset(""), null);

    const stored = JSON.parse(fs.readFileSync(presetsPath, "utf-8"));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.presets.PDD34802.name, "fibrelogy PLA Basic");
});

test("a preset already known is not learned again, a renamed one replaces its name", () => {
    assert.deepEqual(learnPresets(cloudPlate(), "again"), []);

    const renamed = { presets: [{ id: "Pdd34802", name: "Fiberlogy Easy PLA", vendor: "Fiberlogy" }] };
    assert.deepEqual(learnPresets(renamed, "later"), [{ id: "PDD34802", name: "Fiberlogy Easy PLA", vendor: "Fiberlogy" }]);
    assert.equal(learnedPreset("Pdd34802").name, "Fiberlogy Easy PLA");

    // A name is required; an id without one teaches nothing
    assert.deepEqual(learnPresets({ presets: [{ id: "P1234567", name: null, vendor: "x" }] }), []);
    assert.equal(learnedPreset("P1234567"), null);
});

test("the table survives a restart, read back from the file", () => {
    resetPresetsForTests();
    assert.equal(learnedPreset("Pdd34802").name, "Fiberlogy Easy PLA");
    assert.deepEqual(Object.keys(allLearnedPresets()), ["PDD34802"]);
});

test("a custom id is a P and seven hex digits", () => {
    assert.equal(isCustomPresetId("Pdd34802"), true);
    assert.equal(isCustomPresetId("P478b216"), true);
    assert.equal(isCustomPresetId("GFA00"), false);
    assert.equal(isCustomPresetId("Pdd3480"), false);
    assert.equal(isCustomPresetId(null), false);
});
