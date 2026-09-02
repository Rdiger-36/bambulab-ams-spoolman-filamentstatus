/**
 * What a Bambu filament profile is made of, and which materials count as the
 * same stuff.
 *
 * The AMS reports the profile of a slot as `tray_info_idx`, a Bambu Studio
 * filament id such as "GFA05", next to a coarse `tray_type` ("PLA"). Spoolman
 * holds a free text material on the filament ("PLA Silk", "PETG-CF", "TPU 90A").
 * Deciding whether the two describe the same material is what stops a PLA slot
 * from being assigned to an ABS spool by accident, and it cannot be done by
 * comparing the strings: almost every pair differs.
 *
 * The table below is the profile ids Bambu Studio ships, each with the material
 * its profile prints, read out of the installed application by
 * `scripts/extract-bambu-profiles.js`. It is a lookup, not a rule: an id that is
 * not in it simply has no profile name to show, and the comparison falls back to
 * the material names alone.
 *
 * This file is loaded by the browser unbuilt, like `shared.js` next to it, so it
 * stays free of Node built-ins and of the DOM.
 */

/**
 * Bambu Studio filament ids, as the AMS reports them in `tray_info_idx`.
 *
 * Regenerate the entries below with `scripts/extract-bambu-profiles.js`, which
 * prints them in exactly this shape from an installed Bambu Studio.
 */
export const BAMBU_PROFILES = {
    GFA00: { material: "PLA", name: "Bambu PLA Basic" },
    GFA01: { material: "PLA", name: "Bambu PLA Matte" },
    GFA02: { material: "PLA", name: "Bambu PLA Metal" },
    GFA05: { material: "PLA", name: "Bambu PLA Silk" },
    GFA06: { material: "PLA", name: "Bambu PLA Silk+" },
    GFA07: { material: "PLA", name: "Bambu PLA Marble" },
    GFA08: { material: "PLA", name: "Bambu PLA Sparkle" },
    GFA09: { material: "PLA", name: "Bambu PLA Tough" },
    GFA10: { material: "PLA", name: "Bambu PLA Tough+" },
    GFA11: { material: "PLA-AERO", name: "Bambu PLA Aero" },
    GFA12: { material: "PLA", name: "Bambu PLA Glow" },
    GFA13: { material: "PLA", name: "Bambu PLA Dynamic" },
    GFA15: { material: "PLA", name: "Bambu PLA Galaxy" },
    GFA16: { material: "PLA", name: "Bambu PLA Wood" },
    GFA17: { material: "PLA", name: "Bambu PLA Translucent" },
    GFA18: { material: "PLA", name: "Bambu PLA Lite" },
    GFA19: { material: "PLA", name: "Bambu PLA Pure" },
    GFA50: { material: "PLA-CF", name: "Bambu PLA-CF" },
    GFB00: { material: "ABS", name: "Bambu ABS" },
    GFB01: { material: "ASA", name: "Bambu ASA" },
    GFB02: { material: "ASA-AERO", name: "Bambu ASA-Aero" },
    GFB50: { material: "ABS-GF", name: "Bambu ABS-GF" },
    GFB51: { material: "ASA-CF", name: "Bambu ASA-CF" },
    GFB60: { material: "ABS", name: "PolyLite ABS" },
    GFB61: { material: "ASA", name: "PolyLite ASA" },
    GFB98: { material: "ASA", name: "Generic ASA" },
    GFB99: { material: "ABS", name: "Generic ABS" },
    GFC00: { material: "PC", name: "Bambu PC" },
    GFC01: { material: "PC", name: "Bambu PC FR" },
    GFC99: { material: "PC", name: "Generic PC" },
    GFG00: { material: "PETG", name: "Bambu PETG Basic" },
    GFG01: { material: "PETG", name: "Bambu PETG Translucent" },
    GFG02: { material: "PETG", name: "Bambu PETG HF" },
    GFG03: { material: "PETG", name: "Bambu PETG Matte" },
    GFG50: { material: "PETG-CF", name: "Bambu PETG-CF" },
    GFG60: { material: "PETG", name: "PolyLite PETG" },
    GFG96: { material: "PETG", name: "Generic PETG HF" },
    GFG97: { material: "PCTG", name: "Generic PCTG" },
    GFG98: { material: "PETG-CF", name: "Generic PETG-CF" },
    GFG99: { material: "PETG", name: "Generic PETG" },
    GFL00: { material: "PLA", name: "PolyLite PLA" },
    GFL01: { material: "PLA", name: "PolyTerra PLA" },
    GFL03: { material: "PLA", name: "eSUN PLA+" },
    GFL04: { material: "PLA", name: "Overture PLA" },
    GFL05: { material: "PLA", name: "Overture Matte PLA" },
    GFL06: { material: "PETG", name: "Fiberon PETG-ESD" },
    GFL50: { material: "PA6-CF", name: "Fiberon PA6-CF" },
    GFL51: { material: "PA-GF", name: "Fiberon PA6-GF" },
    GFL52: { material: "PA-CF", name: "Fiberon PA12-CF" },
    GFL53: { material: "PA", name: "Fiberon PA612-CF" },
    GFL54: { material: "PET-CF", name: "Fiberon PET-CF" },
    GFL55: { material: "PETG-CF", name: "Fiberon PETG-rCF" },
    GFL95: { material: "PLA", name: "Generic PLA High Speed" },
    GFL96: { material: "PLA", name: "Generic PLA Silk" },
    GFL98: { material: "PLA-CF", name: "Generic PLA-CF" },
    GFL99: { material: "PLA", name: "Generic PLA" },
    GFN03: { material: "PA-CF", name: "Bambu PA-CF" },
    GFN04: { material: "PA-CF", name: "Bambu PAHT-CF" },
    GFN05: { material: "PA6-CF", name: "Bambu PA6-CF" },
    GFN06: { material: "PPA-CF", name: "Bambu PPA-CF" },
    GFN08: { material: "PA-GF", name: "Bambu PA6-GF" },
    GFN96: { material: "PPA-GF", name: "Generic PPA-GF" },
    GFN97: { material: "PPA-CF", name: "Generic PPA-CF" },
    GFN98: { material: "PA-CF", name: "Generic PA-CF" },
    GFN99: { material: "PA", name: "Generic PA" },
    GFP95: { material: "PP-GF", name: "Generic PP-GF" },
    GFP96: { material: "PP-CF", name: "Generic PP-CF" },
    GFP97: { material: "PP", name: "Generic PP" },
    GFP98: { material: "PE-CF", name: "Generic PE-CF" },
    GFP99: { material: "PE", name: "Generic PE" },
    GFR98: { material: "PHA", name: "Generic PHA" },
    GFR99: { material: "EVA", name: "Generic EVA" },
    GFS00: { material: "PLA", name: "Bambu Support W" },
    GFS01: { material: "PA", name: "Bambu Support G" },
    GFS02: { material: "PLA", name: "Bambu Support For PLA" },
    GFS03: { material: "PA", name: "Bambu Support For PA/PET" },
    GFS04: { material: "PVA", name: "Bambu PVA" },
    GFS05: { material: "PLA", name: "Bambu Support For PLA/PETG" },
    GFS06: { material: "ABS", name: "Bambu Support for ABS" },
    GFS97: { material: "BVOH", name: "Generic BVOH" },
    GFS98: { material: "HIPS", name: "Generic HIPS" },
    GFS99: { material: "PVA", name: "Generic PVA" },
    GFSNL02: { material: "PLA", name: "SUNLU PLA Matte" },
    GFSNL03: { material: "PLA", name: "SUNLU PLA+" },
    GFSNL04: { material: "PLA", name: "SUNLU PLA+ 2.0" },
    GFSNL05: { material: "PLA", name: "SUNLU Silk PLA+" },
    GFSNL06: { material: "PLA", name: "SUNLU PLA Marble" },
    GFSNL07: { material: "PLA", name: "SUNLU Wood PLA" },
    GFSNL08: { material: "PETG", name: "SUNLU PETG" },
    GFT01: { material: "PET-CF", name: "Bambu PET-CF" },
    GFT02: { material: "PPS-CF", name: "Bambu PPS-CF" },
    GFT97: { material: "PPS", name: "Generic PPS" },
    GFT98: { material: "PPS-CF", name: "Generic PPS-CF" },
    GFU00: { material: "TPU", name: "Bambu TPU 95A HF" },
    GFU01: { material: "TPU", name: "Bambu TPU 95A" },
    GFU02: { material: "TPU-AMS", name: "Bambu TPU for AMS" },
    GFU03: { material: "TPU", name: "Bambu TPU 90A" },
    GFU04: { material: "TPU", name: "Bambu TPU 85A" },
    GFU98: { material: "TPU-AMS", name: "Generic TPU for AMS" },
    GFU99: { material: "TPU", name: "Generic TPU" },
};

/**
 * The material family a name belongs to, uppercase, or "" when there is none.
 *
 * A family is the base polymer without the variants sold on top of it: the
 * fillers and finishes ("PETG-CF", "PLA-AERO", "ABS-GF"), the grades ("PLA+",
 * "PLA Basic", "TPU 95A") and the AMS specific editions ("TPU-AMS") all reduce
 * to the material they are made of. What survives is the part that decides
 * whether two spools print alike.
 *
 * The polyamides are the one case that needs a list: PA6, PA12 and PA612 are the
 * same family, while PPA is a different polymer whose name merely looks like
 * one. PET and PETG are kept apart for the same reason.
 *
 * @param {string|null} material - a material as either side writes it
 * @returns {string} the family, or "" when nothing could be read
 */
export function materialFamily(material) {
    const base = String(material ?? "")
        .toUpperCase()
        .trim()
        // Everything after the first separator is a variant of what precedes it:
        // "PETG-CF" is PETG, "TPU 95A" is TPU, "PLA+" is PLA.
        .split(/[\s\-_/+(]/)[0]
        .replace(/[^A-Z0-9]/g, "");

    if (!base) return "";

    // PA6-CF and PA12 are polyamides, PPA-CF is not one.
    if (/^PA[0-9]+$/.test(base)) return "PA";

    return base;
}

/**
 * Whether the material the printer reports for a slot and the one on a Spoolman
 * spool are the same stuff.
 *
 * An unknown material on either side agrees with everything: a warning nobody
 * can act on is worse than no warning at all.
 *
 * @param {string|null} slotMaterial - `tray_type`, or the profile's material
 * @param {string|null} spoolMaterial - the material on the Spoolman filament
 * @returns {boolean} true when they belong to the same family
 */
export function materialsAgree(slotMaterial, spoolMaterial) {
    const slot = materialFamily(slotMaterial);
    const spool = materialFamily(spoolMaterial);

    if (!slot || !spool) return true;
    return slot === spool;
}

/**
 * The profile behind a `tray_info_idx`, or null when Bambu Studio ships none.
 *
 * @param {string|null} trayInfoIdx - the profile id the AMS reports
 * @returns {{material: string, name: string}|null}
 */
export function bambuProfile(trayInfoIdx) {
    const id = String(trayInfoIdx ?? "").toUpperCase().trim();
    return BAMBU_PROFILES[id] ?? null;
}

/**
 * The material of a slot: the profile's where the id is a known one, and the
 * coarse `tray_type` the AMS reports next to it otherwise.
 *
 * The profile is the more precise of the two. The AMS reports "PLA" for a
 * carbon filled spool as well, whose profile says "PLA-CF".
 *
 * @param {object} slot - an AMS slot as the client payload carries it
 * @returns {string|null} the material, or null when neither side names one
 */
export function slotMaterial(slot) {
    return bambuProfile(slot?.tray_info_idx)?.material ?? slot?.tray_type ?? null;
}
