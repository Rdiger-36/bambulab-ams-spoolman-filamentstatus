/**
 * Which Spoolman spool a chipless slot could be, decided the same way in the
 * assignment picker and on the server.
 *
 * A spool without an RFID tag reports nothing that identifies it: only the
 * material and the colour set for the slot, and the preset somebody chose for
 * it. Two spools of the same material and colour cannot be told apart by
 * anything the printer sends, so the one question both sides ask is whether
 * Spoolman holds exactly one spool that fits. That one is preselected in the
 * picker and, when the user has opted in, assigned without asking. Two or more
 * stay a suggestion, and nothing is ever created.
 *
 * Under `public/` for the same reason as `shared.js`: the browser loads it as
 * it is, and the server imports it from here.
 */

import { filamentColors, normColor, slotColors } from "./shared.js";
import { materialsAgree, slotMaterial } from "./materials.js";

/**
 * How far two colour sets sit apart, 0 for the same colours and Infinity when
 * one of them has no colour at all.
 *
 * Every colour is measured against the closest one on the other side, in both
 * directions: taken one way only, a two colour spool would count as identical
 * to a single colour one as soon as one of its colours matched.
 *
 * @param {string[]} a - colours as `slotColors()` or `filamentColors()` give them
 * @param {string[]} b - the other side
 * @returns {number} the mean distance in RGB space
 */
export function colorSetDistance(a, b) {
    if (!a.length || !b.length) return Infinity;

    const rgb = (color) => {
        const hex = normColor(color).padEnd(6, "0");
        return [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16) || 0);
    };

    const nearest = (color, set) => Math.min(...set.map(other => {
        const [r1, g1, b1] = rgb(color);
        const [r2, g2, b2] = rgb(other);
        return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    }));

    const distances = [...a.map(c => nearest(c, b)), ...b.map(c => nearest(c, a))];
    return distances.reduce((total, one) => total + one, 0) / distances.length;
}

/**
 * Whether a Spoolman spool is the same material and exactly the same colours
 * as a slot reports.
 *
 * The material is compared by family, the way the picker ranks: the printer
 * says "PLA" where Spoolman holds "PLA Silk". The colours have to be identical,
 * a close shade is a suggestion, not a match.
 *
 * @param {object} slot - an AMS slot as the client payload carries it
 * @param {object} spool - a Spoolman spool record
 * @returns {boolean}
 */
export function spoolFitsSlot(slot, spool) {
    const reported = slotMaterial(slot || {});
    const material = spool?.filament?.material;
    if (!reported || !material || !materialsAgree(reported, material)) return false;
    return colorSetDistance(slotColors(slot), filamentColors(spool.filament)) === 0;
}

/**
 * Whether a spool could be the chipless one in a slot at all.
 *
 * A spool that carries a tag in Spoolman is a Bambu spool the service linked
 * by its chip, so it is never the one without a chip, however well its colour
 * fits. An archived spool is one the user put away.
 *
 * @param {object} spool - a Spoolman spool record
 * @returns {boolean}
 */
export function spoolIsChipless(spool) {
    return !spool?.archived && !spool?.extra?.tag;
}

/**
 * The one spool a chipless slot can be assigned without asking, or null.
 *
 * Exactly one chipless spool of the same material and colours, and one that no
 * other slot is assigned to already: a spool sitting in another slot is not in
 * this one. With two candidates the printer has said everything it can, and the
 * choice is the user's.
 *
 * @param {object} slot - an AMS slot as the client payload carries it
 * @param {object[]} spools - the Spoolman spools
 * @param {Set<number>} [taken] - ids assigned to other slots
 * @returns {object|null} the spool, or null when it is not exactly one
 */
export function uniqueSpoolForSlot(slot, spools, taken = new Set()) {
    const fitting = (spools || []).filter(spool =>
        spoolIsChipless(spool) && !taken.has(spool.id) && spoolFitsSlot(slot, spool));
    return fitting.length === 1 ? fitting[0] : null;
}
