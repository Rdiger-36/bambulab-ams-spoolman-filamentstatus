import fs from "fs-extra";
import { mappingsPath, serverLogFilePath } from "./config.js";
import { normColor } from "./gcode.js";
import { slotColors } from "./utils.js";

/**
 * Manual AMS slot -> Spoolman spool assignments.
 *
 * Bambu Lab spools carry an RFID tag whose tray_uuid is stored in Spoolman as
 * extra.tag, which links slot and spool automatically. 3rd-party spools have no
 * chip (tray_uuid is "N/A"), so the link has to come from the user. The same
 * mechanism also resolves the ambiguous case of two tagged spools that are
 * identical in tray_info_idx and color.
 *
 * Shape:
 *   { "<printerId>": { "A0": { spoolId, fingerprint, updatedAt } } }
 *
 * The fingerprint identifies the physical spool as far as the AMS can describe
 * it. When it stops matching, a different spool was put into that slot and the
 * assignment is dropped rather than silently booking onto the wrong spool.
 */
let mappings = null;

/**
 * Describes a slot's filament as precisely as the AMS allows for a chipless
 * spool: the filament profile the printer reports for the slot, its material
 * type and the normalised colour.
 *
 * `tray_info_idx` is what makes this sharper than material and colour alone.
 * Where the printer reports a per-filament profile, two spools that are
 * identical in material and colour can still differ here, so swapping one for
 * the other invalidates the assignment instead of booking onto the wrong spool.
 * It is added to the material rather than replacing it: a P2S reports the
 * generic `GFL99` for every 3rd party spool, so on its own it would not even
 * tell PLA from PETG.
 *
 * The colour set is added for the same reason, one level further down. A multi
 * colour filament reports only its first colour in `tray_color`, and a gradient
 * spool carries the plain `GFA00` profile, so swapping Arctic Whisper for Solar
 * Breeze changed nothing in the first three parts and the assignment survived a
 * spool it no longer described.
 *
 * A single colour spool produces the three part fingerprint it always did, so
 * nothing already on disk has to be migrated for it.
 */
export function slotFingerprint(slot) {
    // Through normColor like every other part, so the whole fingerprint is one
    // case. slotColors() normalises to lower, the rest of this string is upper.
    const colors = [...new Set(slotColors(slot).map(normColor))];
    const suffix = colors.length > 1 ? `|${colors.sort().join("+")}` : "";
    return `${slot?.tray_info_idx || "?"}|${slot?.tray_type || "?"}|${normColor(slot?.tray_color)}${suffix}`;
}

/**
 * The fingerprint format written before the colour set was part of it, which is
 * only ever different for a multi colour spool.
 */
function preColorSetFingerprint(slot) {
    return `${slot?.tray_info_idx || "?"}|${slot?.tray_type || "?"}|${normColor(slot?.tray_color)}`;
}

/**
 * The fingerprint format written before the filament profile was part of it.
 * Existing installs have these on disk and there is no migration step, so a
 * stored one is still compared in its own format and rewritten on the next
 * lookup that matches.
 */
function legacyFingerprint(slot) {
    return `${slot?.tray_type || "?"}|${normColor(slot?.tray_color)}`;
}

/**
 * Whether a stored fingerprint still describes what is in the slot.
 *
 * @param {string|null} stored - the fingerprint saved with the assignment
 * @param {object} slot - the AMS slot as it reads now
 * @returns {{matches: boolean, legacy: boolean}} whether it matches, and
 *   whether it did so only in the old two part format
 */
function fingerprintMatches(stored, slot) {
    if (stored === slotFingerprint(slot)) return { matches: true, legacy: false };
    // Two parts means it was written before the profile was included
    if (stored.split("|").length === 2 && stored === legacyFingerprint(slot)) {
        return { matches: true, legacy: true };
    }
    // Three parts on a multi colour slot means it was written before the colour
    // set was included. The assignment still describes this spool, it just says
    // less about it than it could, so it is kept and rewritten.
    if (stored.split("|").length === 3 && stored === preColorSetFingerprint(slot)) {
        return { matches: true, legacy: true };
    }
    return { matches: false, legacy: false };
}

/**
 * Loads the mapping file once and caches it for the process lifetime.
 *
 * A missing file is the normal first run case and yields an empty map. So does
 * a corrupt one, because refusing to start over an unreadable convenience cache
 * would be worse than losing the assignments in it.
 *
 * @returns {object} the whole mapping structure, keyed by printer id
 */
function load() {
    if (mappings) return mappings;

    try {
        mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf-8"));
        if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
            throw new Error("mappings.json must contain an object");
        }
        console.debug("Server", serverLogFilePath, "Spool mappings loaded:", JSON.stringify(mappings));
    } catch (err) {
        // Missing file is the normal first-run case; anything else is worth a log
        if (err.code !== "ENOENT") {
            console.error("Server", serverLogFilePath, "Could not read mappings.json, starting empty:", err.message);
        }
        mappings = {};
    }

    return mappings;
}

/** Writes the in-memory mappings back to disk atomically. */
function persist() {
    // Write to a temp file and rename, so a crash mid-write cannot leave a
    // truncated mappings.json behind.
    const tmp = `${mappingsPath}.tmp`;
    try {
        fs.outputFileSync(tmp, JSON.stringify(mappings, null, 2));
        fs.renameSync(tmp, mappingsPath);
    } catch (err) {
        console.error("Server", serverLogFilePath, "Failed to save mappings.json:", err.message);
        try { fs.removeSync(tmp); } catch {}
    }
}

/** Returns all slot assignments for a printer, or an empty object. */
export function getMappings(printerId) {
    return load()[printerId] || {};
}

/**
 * Returns the assignment for a slot, or null. When a slot is given, the stored
 * fingerprint is checked against it and a stale assignment is dropped (the
 * spool in that slot was swapped).
 */
export function getMapping(printerId, amsId, slot = null) {
    const entry = load()[printerId]?.[amsId];
    if (!entry) return null;

    if (slot && entry.fingerprint) {
        const { matches, legacy } = fingerprintMatches(entry.fingerprint, slot);
        if (!matches) {
            console.log("Server", serverLogFilePath, `[Mapping] ${printerId}/${amsId}: filament changed (${entry.fingerprint} -> ${slotFingerprint(slot)}), dropping assignment to spool ${entry.spoolId}`);
            clearMapping(printerId, amsId);
            return null;
        }

        // Upgrade the stored format in place, so this comparison only has to
        // fall back to the old one once per assignment
        if (legacy) {
            entry.fingerprint = slotFingerprint(slot);
            persist();
        }
    }

    return entry;
}

/**
 * Assigns a Spoolman spool to an AMS slot and persists it immediately.
 *
 * The slot is stored as a fingerprint alongside the id, so a later lookup can
 * tell whether the same physical spool is still in place. Passing no slot
 * stores an assignment that is never invalidated by a filament change.
 *
 * @param {string} printerId - printer serial
 * @param {string} amsId - slot label, e.g. "A0"
 * @param {number|string} spoolId - Spoolman spool id
 * @param {object|null} slot - the AMS slot the assignment was made from
 * @returns {object} the stored entry
 */
export function setMapping(printerId, amsId, spoolId, slot = null) {
    const all = load();
    (all[printerId] ||= {})[amsId] = {
        spoolId: Number(spoolId),
        fingerprint: slot ? slotFingerprint(slot) : null,
        updatedAt: new Date().toISOString(),
    };
    persist();
    return all[printerId][amsId];
}

/**
 * Removes every assignment of a printer, used when the printer itself is
 * deleted. Returns false when there was nothing to remove.
 *
 * @param {string} printerId - printer serial
 * @returns {boolean} whether anything was removed
 */
export function clearPrinterMappings(printerId) {
    const all = load();
    if (!all[printerId]) return false;

    delete all[printerId];
    persist();
    return true;
}

/**
 * Removes a slot assignment and persists the change. Returns false when there
 * was nothing to remove.
 */
export function clearMapping(printerId, amsId) {
    const all = load();
    if (!all[printerId]?.[amsId]) return false;

    delete all[printerId][amsId];
    if (Object.keys(all[printerId]).length === 0) delete all[printerId];
    persist();
    return true;
}
