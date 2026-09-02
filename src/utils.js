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
