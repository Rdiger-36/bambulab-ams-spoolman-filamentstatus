/**
 * The handful of pure decisions the dashboard and the server both have to make.
 *
 * It lives under `public/` because that is the half that cannot import from
 * anywhere else: the directory is served straight from disk, has no build step
 * and no dependencies, so a browser has to be able to load this file as it is.
 * The server has no such constraint and imports it from here, which is why the
 * arrow points this way rather than the other.
 *
 * Everything in here is a pure function of its arguments. Nothing touches the
 * DOM, the filesystem or the network, so `test/shared.test.js` can cover it
 * with plain `node:test` and both sides inherit the same cases.
 *
 * Whatever is added here has to keep working in both places: no Node built-ins,
 * no DOM, ES module syntax only.
 */

/**
 * A colour reduced to the six hex digits every side can compare.
 *
 * Slice colours arrive as "#000000", AMS colours as "000000FF" with a trailing
 * alpha byte, and Spoolman stores bare hex. Dropping the "#" and everything
 * past the sixth digit is what makes the three comparable at all. Case is left
 * to the caller, because the two sides settled on different ones long before
 * this file existed: see `normColor` and `slotColors` below.
 */
function bareHex(color) {
    return String(color).replace(/^#/, "").slice(0, 6);
}

/**
 * Normalises a colour to a bare 6-digit uppercase hex (no "#", no alpha) so
 * slice colours ("#000000") and AMS slot colours ("000000FF") compare equal.
 *
 * Uppercase because the consumption keys built from it are compared against
 * each other, never against a colour set from `slotColors()`.
 *
 * @param {*} c - anything a colour may arrive as
 * @returns {string} the normalised colour, or "" when there was none
 */
export function normColor(c) {
    if (!c) return "";
    return bareHex(c).toUpperCase();
}

/**
 * Every colour of an AMS slot, in the order the printer reported them.
 *
 * AMS colours carry a trailing alpha byte that no Spoolman or SpoolmanDB record
 * has, so every comparison has to drop it first. Reading `cols` rather than
 * `tray_color` is what makes a multi colour filament comparable at all: the
 * single field only ever holds the first colour, so it is the fallback for a
 * payload that predates `cols` rather than the value to read.
 *
 * "N/A" is the placeholder an unidentified slot reports, not a colour, and is
 * dropped rather than normalised into the string "N/A".
 *
 * Order is the one the printer reported, because it is the order the colours
 * sit on the filament and the order the UI draws them in. Callers comparing
 * colour sets sort a copy; Spoolman and SpoolmanDB do not agree on an order.
 *
 * Lowercase, because the sets it produces are compared against Spoolman and
 * SpoolmanDB records, which are lowercased to meet it. `normColor()` above is
 * the uppercase one and the two are never compared with each other.
 *
 * @param {object} slot - an AMS slot, normalised or raw
 * @returns {string[]} the colours, possibly empty
 */
export function slotColors(slot) {
    const raw = Array.isArray(slot?.cols) && slot.cols.length ? slot.cols : [slot?.tray_color];
    return raw
        .filter(color => color && color !== "N/A")
        .map(color => bareHex(color).toLowerCase());
}

/**
 * Every colour of a Spoolman filament, in the same shape and case as
 * `slotColors()` so the two can be compared directly.
 *
 * Single and multi colour records are mutually exclusive in Spoolman: a multi
 * colour filament carries its set in `multi_color_hexes` and no `color_hex` at
 * all. A trailing separator in that field yields an empty entry, which is
 * dropped rather than compared as a colour.
 *
 * @param {object} filament - a Spoolman filament record
 * @returns {string[]} the colours, possibly empty
 */
export function filamentColors(filament) {
    const raw = filament?.multi_color_hexes
        ? String(filament.multi_color_hexes).split(",")
        : [filament?.color_hex];
    return raw
        .filter(Boolean)
        .map(color => bareHex(color).toLowerCase());
}

/**
 * The remaining percentage of the spool that is actually in the slot.
 *
 * Bambu reports `remain` on a 1kg basis for regular colour filament, so a 500 g
 * spool that is half empty reports 25%. Support and accessory material
 * (`tray_type` suffix "-S", e.g. "PLA-S") is sold and measured at its real
 * spool size and is already relative to `tray_weight`, so rescaling it would be
 * wrong twice over.
 *
 * @param {number|string} remainOn1kgBasis - `remain` as the printer reports it
 * @param {number|string} trayWeight - the spool's real filament weight in grams
 * @param {string|null} trayType - `tray_type`, needed to spot support material
 * @returns {number|null} remaining percentage of the real spool, rounded, or
 *   null when the printer reported no usable value
 */
export function correctRemainInt(remainOn1kgBasis, trayWeight, trayType = null) {
    const remain = parseFloat(remainOn1kgBasis);
    // Unknown in, unknown out. The AMS reports no percentage for the first
    // seconds after a spool goes in, and every caller has to decide for itself
    // what to do without a reading; none of them may treat it as 0.
    if (!Number.isFinite(remain)) return null;

    const weight = parseFloat(trayWeight);
    const isSupportMaterial = typeof trayType === "string" && trayType.endsWith("-S");

    if (weight < 1000 && !isSupportMaterial) {
        const grams = (remain / 100) * 1000;
        let percent = (grams / weight) * 100;
        if (percent > 100) percent = 100;
        if (percent < 0) percent = 0;
        return Math.round(percent);
    }
    return Math.round(remain);
}

/**
 * The most filament a spool can hold, in grams, or null when nothing says.
 *
 * A remaining weight corrected by hand has to stay inside it: a spool cannot
 * hold more than its filament's full weight, and a number above that quietly
 * turns every percentage the dashboard shows into nonsense.
 *
 * The larger of the two candidates wins rather than the filament's alone. A
 * spool that was registered with more than the catalogue's full weight really
 * did hold that much, and refusing to write back a number the spool itself
 * reports would be the wrong way round.
 *
 * @param {object} spool - a whole Spoolman spool, with its filament embedded
 * @returns {number|null} the limit in grams, or null when neither is known
 */
export function spoolWeightLimit(spool) {
    const candidates = [spool?.filament?.weight, spool?.initial_weight]
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);

    return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Formats a date for display as `DD.MM.YYYY HH:MM:SS`.
 *
 * The dashboard prints the timestamps the server sends and used to carry its
 * own copy of this, character for character the same as the one in `utils.js`.
 * Both read it from here now, so the two cannot drift into two formats for one
 * value.
 *
 * @param {Date} date - the date to format
 * @returns {string} the formatted timestamp
 */
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
 * A duration for a label that is redrawn every second.
 *
 * Clock shape rather than prose, because prose changes width as it counts:
 * "10 min" to "9 min" to "59s" moved everything after it along the line on
 * every step. Always HH:mm:ss, every field padded, so the width is the same
 * from the first second to the twenty-third hour and nothing after it moves.
 *
 * A print can run for days, so days come out in front rather than being
 * added into the hours: "02 Days 05:13:44" says at a glance what "53:13:44"
 * makes you work out. Always "Days", never "Day", because the singular is a
 * character shorter and would move the clock behind it on the second day.
 */
export function formatCounter(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const pad = value => String(value).padStart(2, "0");

    const clock = `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
    const days = Math.floor(total / 86400);

    return days ? `${pad(days)} Days ${clock}` : clock;
}

/**
 * The unit id the external spool holder is addressed under, and the label it
 * produces. The printer reports the holder as `print.vir_slot`, whose entry
 * carries `id` 255, so the number is the printer's rather than an invention.
 *
 * The label is not only shown: it is the key an assignment is stored under in
 * `mappings.json`, and it is what tells the dashboard that this slot belongs to
 * no four slot unit and needs a table of its own. Changing it orphans what is
 * on disk, which is why both sides read the same constant.
 */
export const EXTERNAL_SPOOL_ID = 255;
export const EXTERNAL_SLOT = "External";

/**
 * The print states in which a job is in flight.
 *
 * Its consumption is booked only when it ends, so both sides have to know them:
 * the server refuses to reconnect, restart or take a corrected weight while one
 * of these is on, and the detail dialog does not offer the correction in the
 * first place. Two lists would let the dialog offer what the route then refuses.
 */
export const ACTIVE_PRINT_STATES = ["PREPARE", "RUNNING", "PAUSE"];

/**
 * The layer counter as a person reads it, from two numbers that do not count
 * the same way.
 *
 * `totalLayers` comes out of the sliced file, where parseSliceInfo() takes it
 * from the highest index in `layer_ranges`: a 25 there means the layers 0 to
 * 25, so 26 of them. `layerNum` comes from MQTT and is 0-based while the print
 * runs, which is what makes calcPartialConsumption() line up with those same
 * ranges.
 *
 * The one place the two part company is the end of a print. A P2S sets
 * `layer_num` to the layer count when it finishes, and 26 on a plate whose
 * highest index is 25 is one past the last layer. Adding one to it gave
 * "Layer 27 / 26" and 104%, so neither is allowed past the total: a layer after
 * the last one does not exist under either reading of the field.
 *
 * Lives here rather than in the dashboard because it is the same convention the
 * server's consumption maths rests on, and it was nowhere written down when it
 * broke.
 *
 * @param {number|null|undefined} layerNum - `layer_num` from MQTT, 0-based
 * @param {number|null|undefined} totalLayers - `totalLayers` from the slice, a
 *   highest index rather than a count
 * @returns {{layer: number, total: number|null, percent: number|null}}
 */
export function humanLayers(layerNum, totalLayers) {
    const total = totalLayers != null ? totalLayers + 1 : null;
    const counted = (layerNum ?? 0) + 1;
    const layer = total != null ? Math.min(counted, total) : counted;

    return { layer, total, percent: total ? Math.round((layer / total) * 100) : null };
}

/**
 * The actions a slot can offer, as `option` on the UI spool.
 *
 * The server decides which one a slot gets and the dashboard turns it into a
 * button label, so the string is a contract between the two rather than a piece
 * of UI copy. It was spelled out at nine places across both sides, where a typo
 * on either one silently produces a dead button.
 */
export const SLOT_OPTIONS = {
    NONE: "No actions available",
    WAITING: "Waiting for data",
    CREATE: "Create Spool",
    CREATE_WITH_FILAMENT: "Create Filament & Spool",
    MERGE: "Merge Spool",
    ASSIGN: "Assign Spool",
    UNASSIGN: "Unassign Spool",
    SHOW_INFO: "Show Info!",
};
