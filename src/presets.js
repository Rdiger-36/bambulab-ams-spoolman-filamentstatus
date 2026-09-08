import { presetsPath } from "./config.js";
import { readJsonFile, writeJsonFile } from "./jsonfile.js";

/**
 * The slicer presets this service has learned the names of.
 *
 * A chipless slot reports the preset chosen for it as `tray_info_idx`. For a
 * preset Bambu Studio ships that is a "GF" id whose name `public/materials.js`
 * knows. For a preset from Studio's cloud library, or one of the user's own, it
 * is "P" and seven hex digits, and the name behind the hash is in the slicer
 * and nowhere the printer reports. It is in the sliced file, though: the
 * `project_settings.config` of every print names each filament's id, preset and
 * vendor side by side, and the service downloads that file for every print it
 * books. So a hash is learned the first time a plate is printed with it, and
 * from then on the slot reads "fibrelogy PLA Basic preset" rather than
 * "PLA · custom preset", and the create dialog knows the manufacturer.
 *
 * Read off a P2S on 2026-09-08: a Fiberlogy PLA from the cloud library was
 * `Pdd34802` on the slot, and the sliced file carried `Pdd34802`, "fibrelogy
 * PLA Basic @Bambu Lab P2S 0.6 nozzle" and "fibrelogy" at the same index.
 *
 * Kept in `printers/presets.json` next to the assignments, keyed by the hash in
 * upper case, and read once at start. The file is small and grows by one entry
 * per new preset, so it is rewritten whole.
 */

const PRESETS_SCHEMA_VERSION = 1;

/** A learnable id: the hash of a preset Bambu Studio does not ship. */
const CUSTOM_ID = /^P[0-9A-F]{7}$/i;

let presets = null;

function load() {
    if (presets) return presets;
    const parsed = readJsonFile(presetsPath);
    presets = parsed && typeof parsed.presets === "object" && parsed.presets !== null ? parsed.presets : {};
    return presets;
}

function persist() {
    writeJsonFile(presetsPath, { schemaVersion: PRESETS_SCHEMA_VERSION, presets });
}

/** Whether an id is a preset hash whose name can only come from a sliced file. */
export function isCustomPresetId(id) {
    return CUSTOM_ID.test(String(id ?? "").trim());
}

/**
 * What is known about a preset hash, or null.
 *
 * @param {string} id - `tray_info_idx` of a slot
 * @returns {{name: string, vendor: string|null, learnedAt: string, from: string|null}|null}
 */
export function learnedPreset(id) {
    const key = String(id ?? "").trim().toUpperCase();
    if (!CUSTOM_ID.test(key)) return null;
    return load()[key] ?? null;
}

/**
 * Learns the presets a sliced file names, and says which were new.
 *
 * Only the hashes are kept: a "GF" id is Bambu Studio's own and its name is in
 * `materials.js` already. A name that changed since it was learned replaces
 * the old one, because the user renamed the preset in the slicer and the slot
 * should say what the slicer says.
 *
 * @param {{presets?: {id: string, name: string|null, vendor: string|null}[]}} sliceInfo - as `parseSliceInfo()` returns it
 * @param {string|null} [jobName] - the print the file belongs to, for the record
 * @returns {{id: string, name: string, vendor: string|null}[]} the presets learned or changed by this call
 */
export function learnPresets(sliceInfo, jobName = null) {
    const table = load();
    const learned = [];

    for (const preset of sliceInfo?.presets ?? []) {
        const key = String(preset?.id ?? "").trim().toUpperCase();
        if (!CUSTOM_ID.test(key) || !preset.name) continue;

        const known = table[key];
        if (known && known.name === preset.name && (known.vendor ?? null) === (preset.vendor ?? null)) continue;

        table[key] = {
            name: preset.name,
            vendor: preset.vendor ?? null,
            learnedAt: new Date().toISOString(),
            from: jobName ?? null,
        };
        learned.push({ id: key, name: preset.name, vendor: preset.vendor ?? null });
    }

    if (learned.length) persist();
    return learned;
}

/** Every learned preset, by hash, for the diagnostics bundle. */
export function allLearnedPresets() {
    return { ...load() };
}

/** Test hook: forgets the loaded table so the next call reads the file again. */
export function resetPresetsForTests() {
    presets = null;
}
