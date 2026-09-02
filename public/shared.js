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
