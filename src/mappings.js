import fs from "fs-extra";
import { mappingsPath, serverLogFilePath } from "./config.js";
import { normColor } from "./gcode.js";

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
 * spool: material type plus normalised color.
 */
export function slotFingerprint(slot) {
    return `${slot?.tray_type || "?"}|${normColor(slot?.tray_color)}`;
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

    if (slot && entry.fingerprint && entry.fingerprint !== slotFingerprint(slot)) {
        console.log("Server", serverLogFilePath, `[Mapping] ${printerId}/${amsId}: filament changed (${entry.fingerprint} -> ${slotFingerprint(slot)}), dropping assignment to spool ${entry.spoolId}`);
        clearMapping(printerId, amsId);
        return null;
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
