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
    bambuTlsOptions,
} from "../src/gcode.js";

// Real Metadata/slice_info.config files, pulled off a P2S over FTPS:
//   four_colours        4 filaments in one AMS, two sharing the generic GFL99
//                       profile and told apart only by colour
//   sparse_filament_ids 2 filaments across two AMS units, ids 1 and 6. The
//                       project keeps its unused entries, so ids are not
//                       contiguous and id-1 is what indexes the layer lists
//   split_layer_ranges  a filament that prints, stops, and comes back later
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

test("two filaments sharing a profile are kept apart by colour", () => {
    // Both 3rd party spools report the generic GFL99; without the colour in the
    // key their consumption would be booked onto a single spool.
    const full = calcFullConsumption(fourColours);
    assert.equal(full["GFL99|0ACC38"].grams, 3.29);
    assert.equal(full["GFL99|F98C36"].grams, 2.51);
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
    const part = calcPartialConsumption(sparseIds, 84);
    assert.equal(part["GFA00|000000"].grams, 7.76);
    assert.equal(part["GFG02|000000"].grams, 0);
});

test("a filament that pauses and resumes is scaled over its own layers only", () => {
    // Ranges 0-13 and 86-127, so 56 active layers. At layer 99 exactly half of
    // them are done (14 + 14), which must not be confused with overall progress.
    assert.deepEqual(splitRanges.rangesByFilamentIdx[0], [[0, 13], [86, 127]]);
    const part = calcPartialConsumption(splitRanges, 99);
    assert.equal(part["GFA00|000000"].grams, 2.15); // 4.29 * 0.5
});

test("partial consumption at the last layer equals the full print", () => {
    assert.deepEqual(calcPartialConsumption(fourColours, fourColours.totalLayers),
                     calcFullConsumption(fourColours));
});

test("partial consumption falls back to overall progress without layer data", () => {
    const noRanges = { ...fourColours, rangesByFilamentIdx: {} };
    // 43 of 85 layers -> a bit over half of every filament
    const part = calcPartialConsumption(noRanges, 42);
    assert.equal(part["GFA00|000000"].grams, 2.91); // 5.76 * 43/85
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
