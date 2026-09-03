import test from "node:test";
import assert from "node:assert/strict";

import { extractAmsEnvironment } from "../src/ams.js";

// The three unit shapes this service has seen, copied from real reports rather
// than invented: an AMS 2 Pro on a P2S, the AMS HT from issue #40 and the
// original AMS from issue #7. They differ in which fields exist at all, which
// is the whole reason extractAmsEnvironment() exists.
const AMS_2_PRO = {
    id: "0",
    humidity: "1",
    humidity_raw: "47",
    temp: "24.5",
    dry_time: 0,
    dry_sf_reason: [],
    dry_setting: { dry_duration: -1, dry_filament: "", dry_temperature: -1 },
};

const AMS_HT = {
    id: "128",
    humidity: "0",
    humidity_raw: "24",
    info: "2004",
    temp: "26.7",
    dry_time: 0,
};

const AMS_ORIGINAL = { id: "0", humidity: "5", temp: "0.0" };

test("an AMS 2 Pro reports humidity, percentage, temperature and a dryer", () => {
    const [unit] = extractAmsEnvironment([AMS_2_PRO]);

    assert.equal(unit.amsId, "A");
    assert.equal(unit.humidity, 1);
    assert.equal(unit.humidityPercent, 47);
    assert.equal(unit.temperature, 24.5);
    assert.deepEqual(unit.drying, {
        active: false,
        remainingMinutes: null,
        targetTemp: null,
        durationHours: null,
        filament: null,
    });
});

test("a running drying cycle carries its target and the minutes left", () => {
    const [unit] = extractAmsEnvironment([{
        ...AMS_2_PRO,
        dry_time: 214,
        dry_setting: { dry_duration: 8, dry_filament: "PLA", dry_temperature: 55 },
    }]);

    assert.deepEqual(unit.drying, {
        active: true,
        remainingMinutes: 214,
        targetTemp: 55,
        durationHours: 8,
        filament: "PLA",
    });
});

test("an AMS HT reporting level 0 keeps its percentage", () => {
    // Observed on real hardware: the level is 0 while the sensor reads 24%, so
    // 0 is "no level yet" rather than a sixth step below the driest one.
    const [unit] = extractAmsEnvironment([AMS_HT]);

    assert.equal(unit.amsId, "HT-A");
    assert.equal(unit.humidity, null);
    assert.equal(unit.humidityPercent, 24);
    assert.equal(unit.temperature, 26.7);
});

test("the original AMS reports a level, no percentage and no usable temperature", () => {
    // "0.0" is the absence of a sensor, not a freezing AMS, and the unit has no
    // dryer at all, so it must not be offered one.
    const [unit] = extractAmsEnvironment([AMS_ORIGINAL]);

    assert.equal(unit.humidity, 5);
    assert.equal(unit.humidityPercent, null);
    assert.equal(unit.temperature, null);
    assert.equal(unit.drying, null);
});

test("a unit without any reading is left out", () => {
    // The AMS Lite has neither sensor nor dryer, and the external spool holder
    // passes through the same list. Neither should produce an empty header.
    assert.deepEqual(extractAmsEnvironment([{ id: "0", tray: [] }]), []);
    assert.deepEqual(extractAmsEnvironment([{ id: "255", humidity: "", temp: "" }]), []);
});

test("an empty reading is not read as zero", () => {
    const [unit] = extractAmsEnvironment([{ id: "0", humidity: "", humidity_raw: "", temp: "", dry_time: 0 }]);

    assert.equal(unit.humidity, null);
    assert.equal(unit.humidityPercent, null);
    assert.equal(unit.temperature, null);
    assert.equal(unit.drying.active, false);
});

test("every unit keeps its own label", () => {
    const units = extractAmsEnvironment([AMS_2_PRO, { ...AMS_2_PRO, id: "1" }, AMS_HT]);
    assert.deepEqual(units.map(u => u.amsId), ["A", "B", "HT-A"]);
});

test("a payload that is not a list yields nothing", () => {
    assert.deepEqual(extractAmsEnvironment(undefined), []);
    assert.deepEqual(extractAmsEnvironment(null), []);
});
