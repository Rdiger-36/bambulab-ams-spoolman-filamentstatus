import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { processData, extractComparableTrayData, hasTrayDataChanged, extractAmsEnvironment, slotIsOccupied } from "../src/ams.js";
import { externalSpoolUnits } from "../src/mqtt.js";
import { decodePrintMapping, orderedAmsSlots, printStageName, isPreparingStage } from "../src/gcode.js";
import { slotFingerprint } from "../src/mappings.js";
import { convertAMSandSlot, EXTERNAL_SLOT } from "../src/utils.js";

/**
 * Every report under test/fixtures/reports through the pure half of the
 * ingest pipeline, the way `handleMqttMessage()` in src/mqtt.js runs it.
 *
 * The fixtures are what real printers sent, see the README next to them, and
 * most of them come from hardware nobody working on this repo owns. The
 * assertions are therefore invariants rather than expected values: nothing
 * throws, every unit and slot gets a label this service can address, and what
 * `print.mapping` names is a slot the same report carries. A fixture that
 * breaks one of these is a printer this service would misread, which is the
 * whole point of carrying them.
 *
 * A known gap is listed in KNOWN_GAPS and runs as a todo, so the suite says
 * what is still open without failing on it and without carving the gap out of
 * the assertion. Fixing the gap makes the todo pass, which is when its entry
 * is removed.
 */

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reports");

/**
 * What the fixtures found that this service does not handle yet, keyed by
 * fixture name, then by the test that shows it.
 */
const KNOWN_GAPS = {
    "a2l": {
        "every slot has a label this service can address":
            "the A2L reports its four slot AMS as unit 16, which is outside the 0 to 3 and 128 to 135 ranges convertAMSandSlot() knows",
        "slot labels are unique within the report":
            "same cause: every slot of unit 16 is labelled Z",
    },
    "h2d-external-active": {
        "slot labels are unique within the report":
            "a dual nozzle printer carries two external holders, vir_slot 254 and 255, and both are labelled External",
    },
    "p1p-no-ams": {
        "the stage is named or is no stage at all":
            "a P1 reports stg_cur 255 outside a print, where an X1 and a P2S report -1",
    },
};

const fixtures = fs.readdirSync(REPORTS_DIR)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => ({
        name: name.replace(/\.json$/, ""),
        report: JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, name), "utf8")),
    }));

/** The `print` block of a fixture, which is what the message handler reads. */
const printOf = ({ report }) => report.pushall.print;

/** The unit list the service builds: the AMS block plus the external holder. */
const unitsOf = fixture => {
    const print = printOf(fixture);
    return processData([...(print.ams?.ams ?? []), ...externalSpoolUnits(print)]);
};

/** The label of one slot, the way the service addresses it. */
const labelOf = (unit, slot) => unit.id === "255" ? EXTERNAL_SLOT : convertAMSandSlot(unit.id, slot.id);

/** Every slot label the report can be addressed by. */
const labelsOf = fixture => unitsOf(fixture).flatMap(unit => unit.tray.map(slot => labelOf(unit, slot)));

/** Registers one test per fixture, as a todo where KNOWN_GAPS says so. */
function forEachFixture(name, run) {
    for (const fixture of fixtures) {
        const gap = KNOWN_GAPS[fixture.name]?.[name];
        test(`${fixture.name}: ${name}`, gap ? { todo: gap } : {}, () => run(fixture, printOf(fixture)));
    }
}

test("there are fixtures to run against", () => {
    assert.ok(fixtures.length >= 10, `found ${fixtures.length}`);
});

test("every known gap names a fixture and a test that exist", () => {
    const names = new Set(fixtures.map(fixture => fixture.name));
    for (const name of Object.keys(KNOWN_GAPS)) assert.ok(names.has(name), name);
});

forEachFixture("the report is a push_status with an AMS block", (fixture, print) => {
    assert.equal(print.command, "push_status");
    assert.ok(typeof print.gcode_state === "string");
});

forEachFixture("the ingest pipeline runs without throwing", fixture => {
    const units = unitsOf(fixture);
    const comparable = extractComparableTrayData(units);
    assert.equal(hasTrayDataChanged(comparable, comparable), false);
    assert.equal(hasTrayDataChanged(comparable, extractComparableTrayData([])), true);
    extractAmsEnvironment(units);
    for (const unit of units) {
        for (const slot of unit.tray) {
            slotIsOccupied(slot);
            slotFingerprint(slot);
        }
    }
});

forEachFixture("every slot has a label this service can address", fixture => {
    for (const unit of unitsOf(fixture)) {
        for (const slot of unit.tray) {
            assert.notEqual(labelOf(unit, slot), "Z", `unit ${unit.id} slot ${slot.id}`);
        }
    }
});

forEachFixture("slot labels are unique within the report", fixture => {
    const labels = labelsOf(fixture);
    assert.deepEqual([...new Set(labels)], labels);
});

forEachFixture("what print.mapping names is a slot the report carries", (fixture, print) => {
    const decoded = decodePrintMapping(print.mapping);
    if (decoded === null) return;
    const labels = new Set(labelsOf(fixture));
    for (const [index, label] of decoded.entries()) {
        const raw = print.mapping[index];
        if (raw === 0xFFFF) {
            assert.equal(label, null, `entry ${index} is the unused marker`);
            continue;
        }
        // A slot the print runs from is a slot the report shows as loaded, so
        // a null here would be a unit this service cannot address.
        assert.notEqual(label, null, `entry ${index} (${raw}) has no label`);
        assert.ok(labels.has(label), `entry ${index} (${raw}) names ${label}, which the report does not carry`);
    }
});

forEachFixture("the slicer order covers every four slot unit in full", fixture => {
    const ordered = orderedAmsSlots(labelsOf(fixture));
    for (const label of labelsOf(fixture).filter(label => /^[A-D][1-4]$/.test(label))) {
        assert.ok(ordered.includes(label), label);
    }
});

forEachFixture("the stage is named or is no stage at all", (fixture, print) => {
    const name = printStageName(print.stg_cur);
    if (name === null) return;
    assert.doesNotMatch(name, /^Stage \d+$/, `stg_cur ${print.stg_cur} falls back to its number`);
    isPreparingStage(print.stg_cur);
});
