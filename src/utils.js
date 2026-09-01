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
 * The colour set of an AMS slot as bare six digit lowercase hex.
 *
 * AMS colours carry a trailing alpha byte that no Spoolman or SpoolmanDB record
 * has, so every comparison has to drop it first. Reading `cols` rather than
 * `tray_color` is what makes a multi colour filament comparable at all: the
 * single field only ever holds the first colour.
 *
 * Order is the one the printer reported, because it is the order the colours
 * sit on the filament and the order the UI draws them in. Callers comparing
 * colour sets sort a copy; Spoolman and SpoolmanDB do not agree on an order.
 *
 * Lives here rather than in `ams.js` so that `uispool.js` can use it too.
 * `ams.js` imports `uispool.js`, so an export there would close an import
 * cycle between the two.
 *
 * @param {object} slot - an AMS slot, normalised or raw
 * @returns {string[]} the colours, possibly empty
 */
export function slotColors(slot) {
    const raw = Array.isArray(slot?.cols) && slot.cols.length ? slot.cols : [slot?.tray_color];
    return raw
        .filter(color => color && color !== "N/A")
        .map(color => String(color).slice(0, 6).toLowerCase());
}
