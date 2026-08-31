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
 * own, giving `HT-A` to `HT-H`. Anything outside both ranges yields `Z`, which
 * marks a unit this service does not know how to address.
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
    return "Z";
}
