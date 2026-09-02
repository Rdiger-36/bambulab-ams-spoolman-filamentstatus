import { materialFamily } from "../public/materials.js";

/** Resolves after the given number of milliseconds. */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Formats a date for display as `DD.MM.YYYY HH:MM:SS`. */
export function formatDate(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Formats a date for a log line as `YYYY-MM-DD_HH:MM:SS`.
 *
 * Sorts lexicographically, unlike formatDate, which is why log timestamps use
 * this variant and the UI uses the other.
 */
export function formatDateLog(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}_${hours}:${minutes}:${seconds}`;
}

/** Formats a millisecond duration as a readable interval, e.g. "2 minute(s) 5 second(s)". */
export function formatInterval(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0 && seconds > 0) return `${minutes} minute(s) ${seconds} second(s)`;
    if (minutes > 0) return `${minutes} minute(s)`;
    return `${seconds} second(s)`;
}

/**
 * Turns the numeric AMS unit and slot ids from MQTT into the slot label used
 * throughout the UI, the logs and the mapping file.
 *
 * Regular AMS units are 0 to 3 and carry four slots each, giving `A0` to `D3`.
 * The single slot AMS HT units are 128 to 135 and have no slot number of their
 * own, giving `HT-A` to `HT-H`. 255 is the external spool holder, which the
 * printer reports outside the AMS block altogether and which has no slot number
 * either, giving `External`. Anything outside those ranges yields `Z`, which
 * marks a unit this service does not know how to address.
 *
 * The label is not only shown: it is the key an assignment is stored under in
 * `mappings.json`, so changing one orphans the assignments already on disk.
 *
 * @param {number|string} amsID  - AMS unit id from `print.ams.ams[].id`
 * @param {number|string|null} slotID - slot id within the unit, null for none
 * @returns {string} the slot label
 */
export function convertAMSandSlot(amsID, slotID) {
    amsID = Number(amsID);
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];

    if (slotID === null) slotID = "";

    if (amsID >= 0 && amsID <= 3) return letters[amsID] + slotID;
    if (amsID >= 128 && amsID <= 135) return `HT-${letters[amsID - 128]}`;
    if (amsID === EXTERNAL_SPOOL_ID) return EXTERNAL_SLOT;
    return "Z";
}

/**
 * The unit id the external spool holder is addressed under, and the label it
 * produces. The printer reports the holder as `print.vir_slot`, whose entry
 * carries `id` 255, so the number is the printer's rather than an invention.
 */
export const EXTERNAL_SPOOL_ID = 255;
export const EXTERNAL_SLOT = "External";

/**
 * The colour set of an AMS slot as bare six digit lowercase hex, and the colour
 * set of a Spoolman filament in the same shape.
 *
 * Both live in `public/shared.js`, because the dashboard draws the same swatches
 * from the same payloads and used to answer this with a second implementation.
 * Re-exported from here so that the callers in `ams.js`, `mappings.js` and
 * `uispool.js` keep their import: `ams.js` imports `uispool.js`, so an export in
 * `ams.js` itself would close an import cycle between the two.
 */
export { slotColors, filamentColors } from "../public/shared.js";

/**
 * The upper bound for a remaining weight corrected by hand.
 *
 * Also in `public/shared.js`: the detail dialog refuses the same number before
 * it is sent, so the message the user reads and the rule the route enforces
 * cannot drift apart.
 */
export { spoolWeightLimit } from "../public/shared.js";

/**
 * The material family rules the dashboard uses, so the catalogue query answers
 * with what the dialog would consider a fitting material.
 */
export { materialFamily } from "../public/materials.js";

/**
 * The catalogue fields the create-spool dialog reads. The whole record carries
 * pattern, finish, translucency and more that the dialog has no field for, and
 * the catalogue is seven thousand entries long, so what leaves the server is
 * narrowed the way `uispool.js` narrows a slot.
 */
function pickCatalogueEntry(filament) {
    return {
        id: filament.id ?? null,
        manufacturer: filament.manufacturer ?? null,
        name: filament.name ?? null,
        material: filament.material ?? null,
        density: filament.density ?? null,
        diameter: filament.diameter ?? null,
        weight: filament.weight ?? null,
        spool_weight: filament.spool_weight ?? null,
        // Kept because the same filament is listed once per spool it is sold
        // on, and the type is part of what tells those entries apart.
        spool_type: filament.spool_type ?? null,
        extruder_temp: filament.extruder_temp ?? null,
        bed_temp: filament.bed_temp ?? null,
        color_hex: filament.color_hex ?? null,
        color_hexes: filament.color_hexes ?? null,
        multi_color_direction: filament.multi_color_direction ?? null,
    };
}

/**
 * Whether a catalogue entry fits the manufacturer, material and search term of
 * a query. A field the query leaves out does not narrow anything.
 *
 * The material is compared by family, so a slot reporting "PLA" also finds the
 * catalogue's "PLA+" and "PLA Matte" entries, which is where most of the useful
 * suggestions sit.
 */
function catalogueMatches(entry, { manufacturer, material, q } = {}) {
    const text = (value) => String(value ?? "").trim().toLowerCase();
    const byVendor = text(manufacturer);
    const byMaterial = materialFamily(material);
    const term = text(q);

    if (byVendor && text(entry.manufacturer) !== byVendor) return false;
    if (byMaterial && materialFamily(entry.material) !== byMaterial) return false;
    if (term && ![entry.manufacturer, entry.name, entry.material].some(field => text(field).includes(term))) return false;

    return true;
}

/**
 * The catalogue entries that fit a manufacturer, a material and a search term.
 *
 * Filtering happens here rather than in the browser: the catalogue is a few
 * megabytes, and the dialog asks for it again whenever the manufacturer or the
 * material changes.
 *
 * @param {object[]} entries - the catalogue as Spoolman serves it
 * @param {object} query - manufacturer, material, q and limit, all optional
 * @returns {object[]} the narrowed matches, at most `limit` of them
 */
export function filterCatalogue(entries, query = {}) {
    const limit = Math.max(1, Math.min(Number(query.limit) || 100, 500));

    return (entries || [])
        .filter(entry => catalogueMatches(entry, query))
        .slice(0, limit)
        .map(pickCatalogueEntry);
}

/**
 * The distinct manufacturers, or materials, left in the catalogue once the rest
 * of the query has been applied.
 *
 * This is what lets the create-spool dialog narrow down in steps: pick a
 * manufacturer, and the material list holds only what that manufacturer sells.
 * The field being listed does not filter itself, otherwise choosing a value
 * would leave that value as the only remaining choice.
 *
 * @param {object[]} entries - the catalogue as Spoolman serves it
 * @param {"manufacturer"|"material"} field - the field to list
 * @param {object} query - the rest of the query, all parts optional
 * @returns {string[]} the distinct values, sorted
 */
export function catalogueFacet(entries, field, query = {}) {
    const rest = { ...query };
    delete rest[field];
    delete rest.limit;

    const values = (entries || [])
        .filter(entry => catalogueMatches(entry, rest))
        .map(entry => entry[field])
        .filter(Boolean);

    return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}
