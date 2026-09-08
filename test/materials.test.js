import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    BAMBU_PROFILES,
    bambuProfile,
    materialFamily,
    materialsAgree,
    presetVendor,
    slotMaterial,
    slotPreset,
} from "../public/materials.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---- materialFamily ---- */

test("a filled or finished variant belongs to its base material", () => {
    assert.equal(materialFamily("PETG-CF"), "PETG");
    assert.equal(materialFamily("PLA-AERO"), "PLA");
    assert.equal(materialFamily("ABS-GF"), "ABS");
    assert.equal(materialFamily("TPU-AMS"), "TPU");
});

test("a grade or a trade name belongs to its base material", () => {
    assert.equal(materialFamily("PLA+"), "PLA");
    assert.equal(materialFamily("PLA Basic"), "PLA");
    assert.equal(materialFamily("PLA Silk"), "PLA");
    assert.equal(materialFamily("TPU 95A"), "TPU");
});

test("the polyamides are one family, and PPA is not one of them", () => {
    assert.equal(materialFamily("PA6-CF"), "PA");
    assert.equal(materialFamily("PA12-CF"), "PA");
    assert.equal(materialFamily("PPA-CF"), "PPA");
});

test("materialFamily answers an empty string where nothing is named", () => {
    assert.equal(materialFamily(null), "");
    assert.equal(materialFamily(""), "");
    assert.equal(materialFamily("   "), "");
});

/* ---- materialsAgree ---- */

test("a slot agrees with every variant of its own material", () => {
    assert.equal(materialsAgree("PLA", "PLA Silk"), true);
    assert.equal(materialsAgree("PLA", "PLA-CF"), true);
    assert.equal(materialsAgree("PETG", "PETG-CF"), true);
    assert.equal(materialsAgree("TPU", "TPU 90A"), true);
});

test("a slot disagrees with another material", () => {
    assert.equal(materialsAgree("PLA", "ABS"), false);
    assert.equal(materialsAgree("ABS", "ASA"), false);
    // Different polymers whose names look alike. Catching these is the point.
    assert.equal(materialsAgree("PETG", "PET-CF"), false);
    assert.equal(materialsAgree("PA6-CF", "PPA-CF"), false);
});

test("an unknown material on either side agrees, rather than warning about nothing", () => {
    assert.equal(materialsAgree(null, "ABS"), true);
    assert.equal(materialsAgree("PLA", null), true);
});

/* ---- the profile table ---- */

test("a profile id resolves to the filament Bambu Studio prints it as", () => {
    assert.deepEqual(bambuProfile("GFA05"), { material: "PLA", name: "Bambu PLA Silk" });
    assert.deepEqual(bambuProfile("GFB00"), { material: "ABS", name: "Bambu ABS" });
    assert.equal(bambuProfile("GFG50").material, "PETG-CF");
});

test("a profile id is read whatever case it arrives in, and an unknown one is null", () => {
    assert.equal(bambuProfile("gfa00").name, "Bambu PLA Basic");
    assert.equal(bambuProfile("GFZ42"), null);
    assert.equal(bambuProfile(null), null);
});

test("the table covers the ids the AMS reports for the common filaments", () => {
    // A missing entry costs the profile name and the more precise material, so
    // the ones every AMS sees are worth pinning down.
    for (const id of ["GFA00", "GFA01", "GFA05", "GFB00", "GFB01", "GFG00", "GFU01", "GFL99"]) {
        assert.ok(BAMBU_PROFILES[id], `${id} is missing from the profile table`);
    }
    assert.ok(Object.keys(BAMBU_PROFILES).length > 80);
});

/* ---- slotMaterial ---- */

test("a slot is read as the material of its profile, which is the finer of the two", () => {
    // The AMS reports "PLA" for a carbon filled spool as well.
    assert.equal(slotMaterial({ tray_info_idx: "GFA50", tray_type: "PLA" }), "PLA-CF");
});

test("a slot without a known profile falls back to what the printer calls it", () => {
    assert.equal(slotMaterial({ tray_info_idx: "GFZ42", tray_type: "PLA" }), "PLA");
    assert.equal(slotMaterial({ tray_type: "PETG" }), "PETG");
    assert.equal(slotMaterial({}), null);
});

/* ---- one implementation, not two ---- */

/* ---- slotPreset ---- */

test("a shipped id is named and sorted into Bambu, Generic or a vendor", () => {
    assert.deepEqual(slotPreset({ tray_info_idx: "GFA00" }), { id: "GFA00", name: "Bambu PLA Basic", kind: "bambu" });
    assert.deepEqual(slotPreset({ tray_info_idx: "GFL99" }), { id: "GFL99", name: "Generic PLA", kind: "generic" });
    assert.deepEqual(slotPreset({ tray_info_idx: "GFSNL08" }), { id: "GFSNL08", name: "SUNLU PETG", kind: "vendor" });
});

test("a slicer hash is a custom preset without a name, as a P2S reported a library vendor", () => {
    assert.deepEqual(slotPreset({ tray_info_idx: "Pdd34802" }), { id: "Pdd34802", name: null, kind: "custom", vendor: null });
    assert.deepEqual(slotPreset({ tray_info_idx: "P8d19ba6" }), { id: "P8d19ba6", name: null, kind: "custom", vendor: null });
});

test("an id the table does not know keeps its id, and no id is no preset", () => {
    assert.deepEqual(slotPreset({ tray_info_idx: "GFZ42" }), { id: "GFZ42", name: null, kind: "unknown" });
    assert.equal(slotPreset({ tray_info_idx: "" }), null);
    assert.equal(slotPreset({}), null);
    assert.equal(slotPreset(null), null);
});

test("the dashboard imports the table rather than keeping its own", () => {
    const frontend = fs.readFileSync(path.join(root, "public", "frontend.js"), "utf8");
    assert.match(frontend, /import\s*\{[^}]*materialsAgree[^}]*\}\s*from\s*"\.\/materials\.js"/);
});

/* ---- presetVendor ---- */

test("a vendor preset names its manufacturer as SpoolmanDB spells it", () => {
    // SUNLU PETG and PolyLite PETG chosen in Bambu Studio, read off an X1E's
    // external holder on 2026-09-08 as GFSNL08 and GFG60
    assert.deepEqual(presetVendor(slotPreset({ tray_info_idx: "GFSNL08" })), { vendor: "Sunlu", line: null });
    assert.deepEqual(presetVendor(slotPreset({ tray_info_idx: "GFG60" })), { vendor: "Polymaker", line: "PolyLite" });
    assert.deepEqual(presetVendor(slotPreset({ tray_info_idx: "GFL01" })), { vendor: "Polymaker", line: "PolyTerra" });
    assert.deepEqual(presetVendor(slotPreset({ tray_info_idx: "GFL03" })), { vendor: "eSUN", line: null });
});

test("a Bambu, a generic or a custom preset names no manufacturer", () => {
    assert.equal(presetVendor(slotPreset({ tray_info_idx: "GFA00" })), null);
    assert.equal(presetVendor(slotPreset({ tray_info_idx: "GFL99" })), null);
    assert.equal(presetVendor(slotPreset({ tray_info_idx: "Pdd34802" })), null);
    assert.equal(presetVendor(slotPreset({ tray_info_idx: "" })), null);
    assert.equal(presetVendor(null), null);
});

/* ---- learned presets ---- */

test("a learned name and vendor travel on the slot for a custom preset", () => {
    const slot = { tray_info_idx: "Pdd34802", tray_type: "PLA", preset_name: "fibrelogy PLA Basic", preset_vendor: "fibrelogy" };
    assert.deepEqual(slotPreset(slot), { id: "Pdd34802", name: "fibrelogy PLA Basic", kind: "custom", vendor: "fibrelogy" });
    assert.deepEqual(presetVendor(slotPreset(slot)), { vendor: "fibrelogy", line: null });

    // Not learned yet: a hash without a name, and no manufacturer to propose
    const bare = slotPreset({ tray_info_idx: "Pdd34802", tray_type: "PLA" });
    assert.deepEqual(bare, { id: "Pdd34802", name: null, kind: "custom", vendor: null });
    assert.equal(presetVendor(bare), null);
});
