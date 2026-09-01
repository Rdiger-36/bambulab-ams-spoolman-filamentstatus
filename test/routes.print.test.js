import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { startTestApp, call } from "./helpers/app.js";

// GET /api/print is where the dashboard learns which slot each sliced filament
// will be consumed from. It runs the same match the booking runs and writes the
// answer onto every entry as matchedAmsId, which is the only thing the Web UI
// reads about it. This covers that wiring over HTTP.
//
// No FTPS is involved: the route only downloads the sliced file when the print
// state has not cached one yet, so seeding printer.currentSliceInfo the way the
// MQTT handler does is enough, and the fixture is real slicer output.

let app;
let printer;
let sliceInfo;

const SERIAL = "01P00A000000009";

/** One loaded slot, shaped like the runtime UI spools mqtt.js keeps. */
const loadedSlot = (amsId, { id, idx, type, color, cols = null, tag = true, mapped = false, state = "Loaded (Bambu Lab)" } = {}) => ({
    amsId,
    slotState: state,
    connectedViaTag: tag,
    connectedViaMapping: mapped,
    existingSpool: id ? { id, remaining_weight: 500, initial_weight: 1000, filament: { name: `spool ${id}` } } : null,
    slot: {
        tray_uuid: `uuid-${amsId}`,
        tray_type: type,
        tray_info_idx: idx,
        tray_color: color,
        cols: cols ?? [color],
        tray_weight: "1000",
        remain: 50,
    },
});

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { parseSliceInfo } = await import("../src/gcode.js");
    const { printers } = await import("../src/printers.js");

    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "four_colours.config");
    sliceInfo = parseSliceInfo(fs.readFileSync(fixture, "utf-8"));

    printer = printers.find(p => p.id === SERIAL);
    printer.currentJobName    = "four colours";
    printer.currentGcodeState = "RUNNING";
    printer.currentLayerNum   = 40;
    printer.currentSliceInfo  = sliceInfo;
});

after(async () => { await app.close(); });

/** The four filaments of the fixture, in the order the slicer lists them. */
const fixtureFilaments = () => sliceInfo.filaments.map(f => ({ idx: f.tray_info_idx, color: f.color.replace("#", "") }));

test("every consumption entry carries the slot it will be consumed from", async () => {
    const [f0, f1, f2, f3] = fixtureFilaments();
    printer.currentMapping = null;
    printer.spoolData = [
        loadedSlot("A0", { id: 101, idx: f0.idx, type: "PLA", color: f0.color }),
        loadedSlot("A1", { id: 102, idx: f1.idx, type: "PLA", color: f1.color }),
        loadedSlot("A2", { id: 103, idx: f2.idx, type: "PLA", color: f2.color }),
        loadedSlot("A3", { id: 104, idx: f3.idx, type: "PLA", color: f3.color }),
    ];

    const { status, body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(status, 200);
    const entries = Object.values(body.fullConsumption);
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map(e => e.matchedAmsId), ["A0", "A1", "A2", "A3"]);

    // The partial map is annotated as well, or the "printed" figure would land
    // on no row at all.
    assert.deepEqual(Object.values(body.consumption).map(e => e.matchedAmsId), ["A0", "A1", "A2", "A3"]);
});

test("what the printer reports beats the colours the file was sliced with", async () => {
    const [f0, f1, f2, f3] = fixtureFilaments();
    // The printer runs filament 0 from A3 and filament 3 from A0, which is the
    // remap it reports and the sliced colours cannot know about.
    const { decodePrintMapping } = await import("../src/gcode.js");
    printer.currentMapping = decodePrintMapping([0x0003, 0x0001, 0x0002, 0x0000]);
    printer.spoolData = [
        loadedSlot("A0", { id: 101, idx: f0.idx, type: "PLA", color: f0.color }),
        loadedSlot("A1", { id: 102, idx: f1.idx, type: "PLA", color: f1.color }),
        loadedSlot("A2", { id: 103, idx: f2.idx, type: "PLA", color: f2.color }),
        loadedSlot("A3", { id: 104, idx: f3.idx, type: "PLA", color: f3.color }),
    ];

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    const entries = Object.values(body.fullConsumption);

    assert.deepEqual(entries.map(e => e.matchedAmsId), ["A3", "A1", "A2", "A0"]);
    // The slot the slice named stays next to it, because the two differ exactly
    // where the printer remapped the job and both are worth reading.
    assert.deepEqual(entries.map(e => e.amsId), ["A3", "A1", "A2", "A0"]);
    assert.ok(entries.every(e => e.amsIdFromPrinter));

    // No slot carries two filaments here, which is what the claim on a reported
    // slot is for: the colours of A0 and A3 both appear in the file.
    const claimed = entries.map(e => e.matchedAmsId);
    assert.equal(new Set(claimed).size, claimed.length);
});

test("a filament nothing loaded can serve stays unplaced", async () => {
    // Only the two generic ones here: the fixture's other filament shares its
    // profile with the loaded slot and is covered by the test below.
    const [f0] = fixtureFilaments();
    printer.currentMapping = null;
    printer.spoolData = [loadedSlot("A0", { id: 101, idx: f0.idx, type: "PLA", color: f0.color })];

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    const unplaced = Object.values(body.fullConsumption).filter(e => e.matchedAmsId === null);

    // Both GFL99 filaments: neither the profile nor the colour is in the slot,
    // so this is what the dashboard lists as required but not loaded.
    assert.equal(unplaced.length, 2);
    assert.ok(unplaced.every(e => e.tray_info_idx === "GFL99"));
});

test("two filaments of one profile land on the one slot that carries it", async () => {
    // The last stage matches on tray_info_idx alone, so the white PLA Basic
    // reaches the black PLA Basic slot once the colour stages have failed. Both
    // amounts are then booked onto that spool, and the dashboard shows their
    // sum for the same reason: it reads the answer the booking will act on.
    const [f0] = fixtureFilaments();
    printer.currentMapping = null;
    printer.spoolData = [loadedSlot("A0", { id: 101, idx: f0.idx, type: "PLA", color: f0.color })];

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    const onA0 = Object.values(body.fullConsumption).filter(e => e.matchedAmsId === "A0");

    assert.equal(onA0.length, 2);
    assert.ok(onA0.every(e => e.tray_info_idx === f0.idx));
});

test("an empty slot is not offered to the match", async () => {
    const [f0] = fixtureFilaments();
    printer.currentMapping = null;
    // An empty slot whose last reported payload still looks like the filament.
    // Nothing may be booked or shown on it, so it must not become a candidate.
    printer.spoolData = [loadedSlot("A0", { id: 101, idx: f0.idx, type: "PLA", color: f0.color, state: "Empty" })];

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.ok(Object.values(body.fullConsumption).every(e => e.matchedAmsId === null));
});

test("an unassigned 3rd party slot still shows what the print needs from it", async () => {
    // It cannot be booked, and the dashboard has to show the amount anyway,
    // which is why the route matches over every loaded slot and the booking
    // over the bookable ones alone.
    const [, f1] = fixtureFilaments();
    printer.currentMapping = null;
    printer.spoolData = [
        loadedSlot("External", { id: null, idx: null, type: "PLA", color: f1.color, tag: false, state: "Loaded (3rd party)" }),
    ];

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    const matched = Object.values(body.fullConsumption).filter(e => e.matchedAmsId === "External");

    assert.equal(matched.length, 1);
    assert.equal(matched[0].color.replace("#", "").toUpperCase(), f1.color.toUpperCase());
});
