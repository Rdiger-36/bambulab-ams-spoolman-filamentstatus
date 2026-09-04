import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

import {
    parseSliceInfo,
    calcFullConsumption,
    calcPartialConsumption,
    normColor,
    consumptionKey,
    resolveSliceSlots,
    orderedAmsSlots,
    decodePrintMapping,
    bambuTlsOptions,
} from "../src/gcode.js";

// Real Metadata/slice_info.config files, pulled off a P2S over FTPS:
//   four_colours        4 filaments in one AMS, two sharing the generic GFL99
//                       profile and told apart only by colour
//   sparse_filament_ids 2 filaments across two AMS units, ids 1 and 6. The
//                       project keeps its unused entries, so ids are not
//                       contiguous and id-1 is what indexes the layer lists
//   split_layer_ranges  a filament that prints, stops, and comes back later
//   multi_colour        3 multi colour filaments: one PLA Basic Gradient, one
//                       two colour PLA Silk and one four colour PLA Silk. Sliced
//                       to answer whether the file carries a colour set. It does
//                       not, see the tests at the end of this file
//   external_spool      the same printer with a spool on the external holder,
//                       which makes the slicer's list nine long. Sliced to find
//                       out where that holder sits in it: last, and not on any
//                       AMS slot
const fixturePath = (name) =>
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", `${name}.config`);
const fixtureText = (name) => fs.readFileSync(fixturePath(name), "utf-8");
const fixture = (name) => parseSliceInfo(fixtureText(name));

const fourColours = fixture("four_colours");
const sparseIds   = fixture("sparse_filament_ids");
const splitRanges = fixture("split_layer_ranges");

const sum = (cons) => Math.round(Object.values(cons).reduce((s, e) => s + e.grams, 0) * 100) / 100;

test("normColor strips the leading # and any alpha byte", () => {
    assert.equal(normColor("#00AE42"), "00AE42");   // slice format
    assert.equal(normColor("00ae42ff"), "00AE42");  // AMS format
    assert.equal(normColor(null), "");
});

test("consumptionKey combines profile and colour", () => {
    // Same profile, different colour must not collapse into one key
    assert.notEqual(consumptionKey("GFA00", "#000000"), consumptionKey("GFA00", "#FFFFFF"));
    assert.equal(consumptionKey(null, "#00AE42"), "?|00AE42");
});

test("parseSliceInfo reads every filament of a four colour print", () => {
    assert.equal(fourColours.filaments.length, 4);
    assert.equal(fourColours.totalLayers, 84);
    assert.deepEqual(fourColours.filaments.map(f => [f.id, f.index, f.tray_info_idx, f.color, f.used_g]), [
        [1, 0, "GFA00", "#000000", 5.76],
        [2, 1, "GFL99", "#0ACC38", 3.29],
        [3, 2, "GFL99", "#F98C36", 2.51],
        [4, 3, "GFA00", "#FFFFFF", 3.31],
    ]);
});

test("full consumption matches the total weight the slicer reported", () => {
    // <metadata key="weight" value="14.87"/> in the same file
    assert.equal(sum(calcFullConsumption(fourColours)), 14.87);
    assert.equal(sum(calcFullConsumption(sparseIds)), 15.56);
    assert.equal(sum(calcFullConsumption(splitRanges)), 9.81);
});

test("two filaments sharing a profile are kept apart", () => {
    // Both 3rd party spools report the generic GFL99, so nothing but where they
    // sit separates them from each other. Filament ids 2 and 3 are the second
    // and third entry of the slicer's list, which is A2 and A3.
    const full = resolveSliceSlots(calcFullConsumption(fourColours), twoUnits);
    const bySlot = Object.fromEntries(Object.values(full).map(e => [e.amsId, e]));
    assert.equal(bySlot["A2"].grams, 3.29);
    assert.equal(bySlot["A3"].grams, 2.51);
    assert.equal(bySlot["A2"].tray_info_idx, "GFL99");
    assert.equal(bySlot["A3"].color, "#F98C36");
});

test("non-contiguous filament ids still index the right layer ranges", () => {
    // ids 1 and 6 -> indices 0 and 5, which is what layer_filament_list uses
    assert.deepEqual(sparseIds.filaments.map(f => [f.id, f.index]), [[1, 0], [6, 5]]);
    assert.deepEqual(sparseIds.rangesByFilamentIdx[0], [[0, 84]]);
    assert.deepEqual(sparseIds.rangesByFilamentIdx[5], [[85, 169]]);
    assert.equal(sparseIds.totalLayers, 169);
});

test("a cancelled print books only the filaments that already ran", () => {
    // Layer 84 completed: the first filament is done, the second never started
    // ids 1 and 6, so the first slot of the first AMS unit and the second of
    // the next one. Both black, which is exactly the pair a colour key merged.
    const part = resolveSliceSlots(calcPartialConsumption(sparseIds, 84), twoUnits);
    const bySlot = Object.fromEntries(Object.values(part).map(e => [e.amsId, e]));
    assert.equal(bySlot["A1"].grams, 7.76);
    assert.equal(bySlot["B2"].grams, 0);
});

test("a filament that pauses and resumes is scaled over its own layers only", () => {
    // Ranges 0-13 and 86-127, so 56 active layers. At layer 99 exactly half of
    // them are done (14 + 14), which must not be confused with overall progress.
    assert.deepEqual(splitRanges.rangesByFilamentIdx[0], [[0, 13], [86, 127]]);
    const part = calcPartialConsumption(splitRanges, 99);
    assert.equal(part["filament0"].grams, 2.15); // 4.29 * 0.5
});

test("partial consumption at the last layer equals the full print", () => {
    assert.deepEqual(calcPartialConsumption(fourColours, fourColours.totalLayers),
                     calcFullConsumption(fourColours));
});

test("partial consumption falls back to overall progress without layer data", () => {
    const noRanges = { ...fourColours, rangesByFilamentIdx: {} };
    // 43 of 85 layers -> a bit over half of every filament
    const part = calcPartialConsumption(noRanges, 42);
    assert.equal(part["filament0"].grams, 2.91); // 5.76 * 43/85
});

// The zip half of fetchSliceInfo has no coverage of its own, because the
// function is coupled to the FTPS download and only its parsing half can be
// reached directly. These two pin the contract the code relies on, so a future
// adm-zip bump cannot break entry lookup unnoticed.
test("the slice config survives a zip round trip", () => {
    const archive = new AdmZip();
    archive.addFile("Metadata/slice_info.config", Buffer.from(fixtureText("four_colours"), "utf-8"));
    archive.addFile("3D/3dmodel.model", Buffer.from("<model/>", "utf-8"));

    const entry = new AdmZip(archive.toBuffer()).getEntry("Metadata/slice_info.config");
    assert.ok(entry, "Metadata/slice_info.config should be found in the archive");

    const info = parseSliceInfo(entry.getData().toString("utf8"));
    assert.equal(info.filaments.length, 4);
    assert.equal(info.totalLayers, 84);
});

test("a 3MF without slice info yields no entry", () => {
    // fetchSliceInfo returns null on this rather than throwing
    const archive = new AdmZip();
    archive.addFile("3D/3dmodel.model", Buffer.from("<model/>", "utf-8"));

    assert.equal(new AdmZip(archive.toBuffer()).getEntry("Metadata/slice_info.config"), null);
});

test("every FTPS connection gets its own TLS options object", () => {
    // basic-ftp writes the host into the object it is handed, and for implicit
    // TLS that stored host wins over the one passed to access(). Sharing one
    // object sent every later connection to the printer that used it first.
    const first = bambuTlsOptions();
    const second = bambuTlsOptions();

    assert.notEqual(first, second);
    assert.deepEqual(first, { rejectUnauthorized: false });

    first.host = "192.0.2.1";
    assert.equal(second.host, undefined);
});

/* ---- What a multi colour filament looks like in the sliced file ---- */

// Sliced in Bambu Studio 02.08.02.61 with three multi colour filaments loaded,
// to settle a question the other fixtures could not: they all used single
// colour filaments, so "the sliced file carries one colour per filament" was an
// assumption rather than something anybody had read.
const multiColour = fixture("multi_colour");
const externalSpool = fixture("external_spool");

test("a multi colour filament is sliced with one colour, the first of its set", () => {
    // Studio does know the whole set. It writes it into
    // Metadata/project_settings.config as `filament_multi_colour`, where the
    // three entries of this print read "#8EC9E9 #E7C1D5",
    // "#0047BB #BB22A3" and "#EC984C #6CD4BC #A66EB9 #D87694".
    // slice_info.config, the only file this service downloads, keeps the first
    // colour of each and nothing else.
    assert.deepEqual(multiColour.filaments.map(f => f.color), ["#8EC9E9", "#0047BB", "#EC984C"]);
});

test("PLA Basic Gradient carries the plain PLA Basic profile id", () => {
    // GFA00 is PLA Basic. A gradient spool is not a profile of its own, which
    // means a consumption key of profile id plus colour cannot separate a
    // gradient filament from the plain spool it shares both with.
    const [gradient] = multiColour.filaments;
    assert.equal(gradient.tray_info_idx, "GFA00");
    assert.equal(gradient.type, "PLA");
});

test("two filaments sharing a first colour and a profile id share a key", () => {
    // The limit this file was sliced to measure. Arctic Whisper and Solar
    // Breeze are both GFA00 and both start on #FFFFFF, so consumption cannot be
    // split between them from the sliced file alone, and the dashboard marks
    // the slots as ambiguous rather than booking onto a guess.
    assert.equal(consumptionKey("GFA00", "#FFFFFF"), consumptionKey("GFA00", "#FFFFFF00"));
});

test("the three multi colour filaments are still told apart", () => {
    // Two of them share the PLA Silk profile and differ only in colour, which
    // is what the key is for. Nothing about this print is ambiguous.
    const keys = multiColour.filaments.map(f => consumptionKey(f.tray_info_idx, f.color));
    assert.deepEqual(keys, ["GFA00|8EC9E9", "GFA05|0047BB", "GFA05|EC984C"]);
    assert.equal(new Set(keys).size, 3);
});

/* ---- The slot a filament was sliced for ---- */

// Two AMS units, which is what both real prints below were sliced against.
const twoUnits = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"];

test("the slots are ordered by ascending AMS unit id", () => {
    // Reported in whatever order the printer sends its units, and the slicer
    // lists them unit by unit and slot by slot.
    assert.deepEqual(orderedAmsSlots(["B2", "A1", "B1", "A3"]),
                     ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"]);

    // Every attached four slot unit contributes all four positions even when
    // only some of them reported. The slicer lists a slot whether or not it
    // holds anything, so counting the reported ones would shift everything
    // after an empty slot.
    assert.deepEqual(orderedAmsSlots(["A1"]), ["A1", "A2", "A3", "A4"]);

    // The printer numbers the four slot units 0 to 3, an AMS HT 128 to 135 and
    // the external holder 255, so both sit after them and the holder last.
    assert.deepEqual(orderedAmsSlots(["A1", "External", "HT-B", "HT-A"]),
                     ["A1", "A2", "A3", "A4", "HT-A", "HT-B", "External"]);
    assert.deepEqual(orderedAmsSlots([]), []);
});

test("the real multi colour print resolves to the slots it was printed from", () => {
    // Verified against the printer: ids 5, 7 and 8 were B1, B3 and B4.
    const full = resolveSliceSlots(calcFullConsumption(multiColour), twoUnits);
    assert.deepEqual(Object.values(full).map(e => [e.amsId, e.grams]), [
        ["B1", 156.24], ["B3", 49.64], ["B4", 66.27],
    ]);
});

test("a spool on the external holder gets the position after the AMS units", () => {
    // The file that settled the ordering: the same printer with a spool on the
    // external holder lists nine filaments, and its ninth colour is the one the
    // printer reports for the holder. Arithmetic on four slots per unit turned
    // that into "C1", a unit this printer does not have.
    const full = resolveSliceSlots(calcFullConsumption(externalSpool),
                                   orderedAmsSlots([...twoUnits, "External"]));
    assert.deepEqual(Object.values(full).map(e => [e.index, e.amsId, e.grams]), [
        [3, "A4", 30.49],
        [4, "B1", 67.29],
        [8, "External", 80.92],
    ]);
});

test("an empty holder leaves the position after the AMS units unfilled", () => {
    // The holder is only reported as a slot while it carries something, so the
    // ninth filament of that same file has nowhere to go and falls through to
    // the stages that match on profile and colour.
    const full = resolveSliceSlots(calcFullConsumption(externalSpool), orderedAmsSlots(twoUnits));
    assert.deepEqual(Object.values(full).map(e => e.amsId), ["A4", "B1", null]);
});

test("the list length says nothing about the printer's layout", () => {
    // The same P2S produced files with six, eight and nine filaments, so the
    // count is the project's and not the printer's. Resolving against six slots
    // simply leaves everything past them unplaced.
    const full = resolveSliceSlots(calcFullConsumption(externalSpool), twoUnits.slice(0, 6));
    assert.deepEqual(Object.values(full).map(e => e.amsId), ["A4", "B1", null]);
});

/* ---- The colour set out of project_settings.config ---- */

// The sibling entry of the same archive, which is where the whole colour set
// of a multi colour filament lives. Only the one key is read out of it.
const multiColourSettings = JSON.stringify({
    filament_colour: ["#F55A74", "#F98C36", "#FFFFFF", "#000000", "#8EC9E9", "#0ACC38", "#0047BB", "#EC984C"],
    filament_multi_colour: [
        "#F55A74", "#F98C36", "#FFFFFF", "#000000",
        "#8EC9E9 #E7C1D5", "#0ACC38", "#0047BB #BB22A3", "#EC984C #6CD4BC #A66EB9 #D87694",
    ],
});

test("the colour set is read for the filaments that have one", () => {
    const info = parseSliceInfo(fixtureText("multi_colour"), multiColourSettings);
    assert.deepEqual(info.filaments.map(f => f.colors), [
        ["8EC9E9", "E7C1D5"],
        ["0047BB", "BB22A3"],
        ["EC984C", "6CD4BC", "A66EB9", "D87694"],
    ]);
});

test("a single colour filament reports no set at all", () => {
    // One colour is not a set, and treating it as one would put a redundant
    // suffix on a key that has been stable since the first release.
    const info = parseSliceInfo(fixtureText("four_colours"), multiColourSettings);
    assert.deepEqual(info.filaments.map(f => f.colors), [null, null, null, null]);
});

test("a slicer that writes no project settings simply carries no set", () => {
    const info = parseSliceInfo(fixtureText("multi_colour"), null);
    assert.deepEqual(info.filaments.map(f => f.colors), [null, null, null]);
    // The position in the list is in the file itself, so it survives either way
    assert.deepEqual(info.filaments.map(f => f.index), [4, 6, 7]);
});

/* ---- What the extended key and the slot key fix ---- */

test("the colour set separates a gradient from the plain spool it hides behind", () => {
    // Arctic Whisper, Solar Breeze and an ordinary white PLA Basic all report
    // GFA00 and a first colour of FFFFFF, so all three were one key.
    const arctic = consumptionKey("GFA00", "#FFFFFF", ["FFFFFF", "9CDBD9"]);
    const solar  = consumptionKey("GFA00", "#FFFFFF", ["FFFFFF", "E94B3C"]);
    const plain  = consumptionKey("GFA00", "#FFFFFF");

    assert.equal(new Set([arctic, solar, plain]).size, 3);
    // The plain spool keeps exactly the key it had before the set existed
    assert.equal(plain, "GFA00|FFFFFF");
});

test("the colour set is compared sorted, because the sources disagree on order", () => {
    // Bambu Studio writes Cotton Candy Cloud as "#8EC9E9 #E7C1D5" and SpoolmanDB
    // stores it the other way round. Comparing unsorted would match nothing.
    assert.equal(
        consumptionKey("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"]),
        consumptionKey("GFA00", "#8EC9E9", ["e7c1d5", "8ec9e9"]),
    );
});

test("two identical spools in different slots are no longer added together", () => {
    // The defect this whole change is about. Both entries are the same profile
    // and the same colour, so a key built from the filament identity merged
    // them into one number before anything looked at the AMS, and the sum could
    // not be split afterwards however the spools were identified.
    const twoBlacks = {
        filaments: [
            { id: 1, index: 0, tray_info_idx: "GFA00", type: "PLA", color: "#000000", colors: null, used_g: 120 },
            { id: 2, index: 1, tray_info_idx: "GFA00", type: "PLA", color: "#000000", colors: null, used_g: 45 },
        ],
        totalLayers: 100,
        rangesByFilamentIdx: {},
    };

    const full = resolveSliceSlots(calcFullConsumption(twoBlacks), twoUnits);
    const bySlot = Object.fromEntries(Object.values(full).map(e => [e.amsId, e]));
    assert.equal(bySlot["A1"].grams, 120);
    assert.equal(bySlot["A2"].grams, 45);
});

test("a filament beyond the printer's slots keeps its figures and no slot", () => {
    const beyondTheUnits = {
        filaments: [
            { id: 17, index: 16, tray_info_idx: "GFA00", type: "PLA", color: "#000000", colors: null, used_g: 30 },
        ],
        totalLayers: 100,
        rangesByFilamentIdx: {},
    };

    const full = resolveSliceSlots(calcFullConsumption(beyondTheUnits), twoUnits);
    assert.equal(full["filament16"].grams, 30);
    assert.equal(full["filament16"].amsId, null);
});

/* ---- The slots the printer says it is printing from ---- */

// Both values are copied from live P2S reports, and both were checked against
// the slots the print was really running from.

test("the printer's own mapping names the slots it is printing from", () => {
    // A project of three filaments on a printer with two AMS units. The slicer
    // list order would have said A1, A2 and A3, and none of those was right.
    assert.deepEqual(decodePrintMapping([256, 2, 259]), ["B1", "A3", "B4"]);
});

test("the mapping carries the external holder and the filaments left unused", () => {
    // 0xFF00 is unit 255, which is the holder. 0xFFFF is the marker for a
    // filament of the project that this plate does not print, and decoding it
    // as a unit and a slot would read as the holder too.
    assert.deepEqual(decodePrintMapping([256, 2, 65535, 65280]), ["B1", "A3", null, "External"]);
});

test("a printer that reports no mapping says so", () => {
    // Then the position in the slicer's list is all there is, which is what
    // orderedAmsSlots estimates.
    assert.equal(decodePrintMapping(undefined), null);
    assert.equal(decodePrintMapping([]), null);
    assert.equal(decodePrintMapping(null), null);
});

test("a unit this service cannot address is unknown, not a slot", () => {
    // "Z" is the label for a unit outside the known ranges. Passing it on would
    // put several slots under one name and book onto whichever came first.
    assert.deepEqual(decodePrintMapping([0x0707, -1, Number.NaN]), [null, null, null]);
});

test("where the slots came from is recorded, because it decides the trust", () => {
    // A slot the printer reported is taken as it stands. One estimated from the
    // list order is confirmed against the slot first.
    const reported = resolveSliceSlots(calcFullConsumption(externalSpool),
                                       decodePrintMapping([65535, 65535, 65535, 256, 2, 65535, 65535, 65535, 65280]),
                                       { reportedByPrinter: true });
    assert.deepEqual(Object.values(reported).map(e => e.amsIdFromPrinter), [true, true, true]);

    const estimated = resolveSliceSlots(calcFullConsumption(externalSpool), orderedAmsSlots(twoUnits));
    assert.deepEqual(Object.values(estimated).map(e => e.amsIdFromPrinter), [false, false, false]);
});

test("a filament the printer placed nowhere is never treated as reported", () => {
    // 0xFFFF decodes to no slot at all, and a null slot carries no trust.
    const full = resolveSliceSlots(calcFullConsumption(externalSpool),
                                   decodePrintMapping([65535, 65535, 65535, 256, 2, 65535, 65535, 65535, 65535]),
                                   { reportedByPrinter: true });
    const holder = Object.values(full).find(e => e.index === 8);
    assert.equal(holder.amsId, null);
    assert.equal(holder.amsIdFromPrinter, false);
});

test("the mapping drops into the same resolution as the list order", () => {
    // Same shape as orderedAmsSlots, one slot per filament index, so the
    // booking path takes either without knowing which it got.
    const full = resolveSliceSlots(calcFullConsumption(externalSpool),
                                   decodePrintMapping([65535, 65535, 65535, 256, 2, 65535, 65535, 65535, 65280]));
    assert.deepEqual(Object.values(full).map(e => [e.index, e.amsId]), [
        [3, "B1"], [4, "A3"], [8, "External"],
    ]);
});
