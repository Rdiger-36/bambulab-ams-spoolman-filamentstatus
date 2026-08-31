import { NEVER_MERGE_IF_TAG } from "./config.js";

/**
 * Normalises the raw `print.ams.ams` payload so the rest of the pipeline sees
 * one consistent shape instead of the printer's mix of empty strings, nulls
 * and placeholder values.
 *
 * Missing material, colour and uuid all become the literal "N/A", which is the
 * marker every later stage tests against. An all zero `tray_uuid` means the
 * printer read no RFID chip and is treated the same as a missing one. Negative
 * or missing `remain` is clamped to 0.
 *
 * PETG Translucent is a special case: it reports a fully transparent colour
 * that would render as invisible in the UI, so it is shown as white instead.
 *
 * @param {object[]} amsData - `print.ams.ams` from an MQTT report
 * @returns {object[]} the same structure with normalised tray entries
 */
export function processData(amsData) {
    return amsData.map(ams => ({
        ...ams,
        tray: ams.tray.map(slot => {
            const isPetgTranslucent = slot.tray_sub_brands === "PETG Translucent" && slot.tray_color === "00000000";
            const updatedTrayColor = isPetgTranslucent ? "FFFFFF00" : (slot.tray_color ?? "N/A");

            if (!slot.remain || slot.remain < 0) slot.remain = 0;

            return {
                ...slot,
                remain: slot.remain,
                tray_color: updatedTrayColor,
                tray_sub_brands: slot.tray_sub_brands === "" ? "N/A" : (slot.tray_sub_brands ?? "N/A"),
                tray_weight: slot.tray_weight ?? 0,
                tray_uuid: /^0+$/.test(slot.tray_uuid) ? "N/A" : (slot.tray_uuid ?? "N/A"),
            };
        }),
    }));
}

/**
 * Reduces normalised AMS data to just the fields that should trigger
 * reprocessing, so two consecutive MQTT reports can be compared as JSON.
 *
 * Everything volatile is dropped: humidity, temperature and the many fields
 * that tick on every message would otherwise make every report look like a
 * change. Units and trays are sorted by id, because the printer does not
 * guarantee an order.
 *
 * @param {object[]} amsArray - output of processData, or an empty array
 * @returns {object[]} a stable, comparable projection
 */
export function extractComparableTrayData(amsArray) {
    return amsArray.map(ams => ({
        id: ams.id,
        tray: ams.tray
            .filter(t => t && Object.keys(t).length > 6)
            .map(t => {
                // A spool the printer cannot identify reports no uuid, material,
                // colour or weight, so the only thing worth comparing is whether
                // it is there at all. Dropping such trays entirely used to hide
                // the arrival of a 3rd party spool from the change detection, so
                // the slot was never reprocessed. `state` itself is deliberately
                // not compared: it varies between loaded-but-unidentified values
                // (10 and 20 both occur) and would cause pointless reprocessing.
                if (t.tray_uuid === "N/A" || t.tray_sub_brands === "N/A") {
                    return { id: t.id, occupied: slotIsOccupied(t) };
                }
                return {
                    id: t.id,
                    tray_uuid: t.tray_uuid,
                    tray_weight: t.tray_weight,
                    tray_sub_brands: t.tray_sub_brands,
                    tray_color: t.tray_color,
                    remain: t.remain,
                };
            })
            .sort((a, b) => a.id - b.id),
    })).sort((a, b) => a.id - b.id);
}

/**
 * Converts the AMS remain percentage into a percentage of the spool's real
 * size.
 *
 * The AMS estimates the remaining filament against a 1 kg reference regardless
 * of the actual spool, so a full 250 g spool reports 25 %. Rescaling to the
 * real `tray_weight` gives the value a user expects to see, clamped to 0 to 100.
 *
 * @param {number|string} remainOn1kgBasis - `remain` as reported by the AMS
 * @param {number|string} trayWeight - the spool's real filament weight in grams
 * @param {string|null} trayType - `tray_type`, needed to spot support material
 * @returns {number} remaining percentage of the real spool, rounded
 */
export function correctRemainInt(remainOn1kgBasis, trayWeight, trayType = null) {
    const remain = parseFloat(remainOn1kgBasis);
    const weight = parseFloat(trayWeight);

    // Support/accessory material (tray_type suffix "-S", e.g. "PLA-S") is sold
    // and measured at its real spool size, not estimated on a 1kg basis like
    // regular color filament <1kg, so its remain% is already relative to the
    // actual tray_weight and must not be rescaled.
    const isSupportMaterial = typeof trayType === "string" && trayType.endsWith("-S");

    if (weight < 1000 && !isSupportMaterial) {
        let grams = (remain / 100) * 1000;
        let percent = (grams / weight) * 100;
        if (percent > 100) percent = 100;
        if (percent < 0) percent = 0;
        return Math.round(percent);
    }
    return Math.round(remain);
}

/**
 * Whether the AMS reports something physically sitting in the slot.
 *
 * A slot holding a spool the printer cannot identify, whether because it has
 * no RFID chip or because reading it failed, comes through with the same
 * sparse payload as an empty slot: tray_uuid "N/A", no tray_type,
 * tray_weight 0. The only field that separates
 * them is `state`, which is 0 for an empty slot and non-zero once something is
 * loaded (11 for a fully read Bambu Lab spool, other values while the printer
 * has filament but no identification for it).
 *
 * Firmware that does not report `state` at all falls back to "not occupied", so
 * such slots keep being treated as empty rather than sprouting phantom spools.
 */
export function slotIsOccupied(slot) {
    if (slot?.state === null || slot?.state === undefined) return false;
    return Number(slot.state) !== 0;
}

/**
 * Finds the Spoolman spool already connected to this slot.
 *
 * The connection is the `extra.tag` field holding the slot's `tray_uuid`, which
 * only Bambu Lab spools have. Material and colour must agree as well, so a tag
 * left over from a previous spool cannot resurface as a match. Multi colour
 * filaments compare the whole sorted colour set instead of a single hex.
 *
 * @param {object} amsSpool - a normalised AMS slot
 * @param {object[]} allSpools - the Spoolman spool list
 * @returns {object|null} the connected spool, or null
 */
export function findExistingSpool(amsSpool, allSpools) {
    return allSpools.find(spoolmanSpool => {
        const tag = spoolmanSpool.extra?.tag?.replace(/"/g, "");
        const materialMatches = spoolmanSpool.filament.material === amsSpool.tray_sub_brands;
        const tagMatches = tag === amsSpool.tray_uuid;

        if (amsSpool.cols.length > 1) {
            if (!spoolmanSpool.filament.multi_color_hexes) return false;
            const amsColors = amsSpool.cols.map(c => c.slice(0, 6).toLowerCase()).sort();
            const filamentColors = spoolmanSpool.filament.multi_color_hexes.split(",").map(c => c.toLowerCase()).sort();
            return materialMatches && JSON.stringify(filamentColors) === JSON.stringify(amsColors) && tagMatches;
        }

        const colorHex = spoolmanSpool.filament.color_hex?.toLowerCase();
        const amsColor = amsSpool.tray_color.slice(0, 6).toLowerCase();
        return materialMatches && colorHex === amsColor && tagMatches;
    }) || null;
}

/**
 * Finds the SpoolmanDB catalogue entry for a slot, which is what supplies the
 * density, diameter and temperatures needed to create a filament.
 *
 * Catalogue ids look like `bambulab_pla_basic`, built from the material name,
 * but the AMS reports that name in a shape that does not always match. Three
 * transformations are tried in order, from strictest to loosest: lowercase,
 * lowercase with spaces turned into underscores, and finally the first word
 * stripped to letters only. Support material is keyed differently and needs the
 * base material from `tray_type` in the id as well.
 *
 * The colour set must match exactly in every attempt, so a looser material
 * match can never pull in the wrong colour.
 *
 * @param {object|null} amsSpool - a normalised AMS slot
 * @param {object[]} externalFilaments - the SpoolmanDB catalogue
 * @returns {object|null} the catalogue entry, or null
 */
export function findMatchingExternalFilament(amsSpool, externalFilaments) {
    if (!amsSpool) return null;

    const transformations = [
        material => material.toLowerCase(),
        material => material.replace(/\s+/g, "_").toLowerCase(),
        material => material.split(" ")[0].replace(/[^A-Za-z]/g, "").toLowerCase(),
    ];

    const amsColors = amsSpool.cols.map(c => c.slice(0, 6).toLowerCase()).sort();

    for (const transform of transformations) {
        const transformedMaterial = transform(amsSpool.tray_sub_brands || "");

        const matchingFilament = externalFilaments.find(filament => {
            const filamentColors = filament.color_hex
                ? [filament.color_hex.toLowerCase()]
                : (filament.color_hexes || []).map(c => c.toLowerCase()).sort();

            let idMatches;
            if (amsSpool.tray_sub_brands.toLowerCase().includes("support")) {
                idMatches = filament.id.startsWith(`bambulab_${amsSpool.tray_type.split("-")[0].toLowerCase()}_${transformedMaterial}`);
            } else {
                idMatches = filament.id.startsWith(`bambulab_${transformedMaterial}`);
            }

            return idMatches && JSON.stringify(filamentColors) === JSON.stringify(amsColors);
        });

        if (matchingFilament) return matchingFilament;
    }
    return null;
}

/**
 * Finds the filament already created in this Spoolman instance for a catalogue
 * entry, matched on `external_id`. A null result means the filament still has
 * to be created before a spool can reference it.
 */
export function findMatchingInternalFilament(externalFilament, internalFilaments) {
    if (!externalFilament) return null;
    return internalFilaments.find(f => f.external_id === externalFilament.id) || null;
}

/**
 * Finds an untagged Spoolman spool that plausibly is the spool now sitting in
 * this slot, so the two can be merged instead of creating a duplicate.
 *
 * This is the path for users who tracked their spools in Spoolman by hand
 * before connecting this service. Matching is deliberately looser than
 * findExistingSpool, since there is no tag to confirm the guess: material is
 * compared as a substring in either direction, so "PLA" matches "PLA Basic",
 * and a single colour hit is enough for a multi colour filament.
 *
 * Among those candidates, one is accepted when its weight is within 15 % of
 * what the AMS reports, or when it is empty, or when it was never used. With
 * NEVER_MERGE_IF_TAG set, a spool that already carries any tag is skipped
 * outright.
 *
 * @param {object} amsSpool - a normalised AMS slot
 * @param {object[]} allSpools - the Spoolman spool list
 * @returns {object|undefined} the mergeable spool, or undefined
 */
export function findMergeableSpool(amsSpool, allSpools) {
    // Use tray_color as fallback when cols is missing or empty
    const rawColors = amsSpool.cols?.length ? amsSpool.cols : (amsSpool.tray_color ? [amsSpool.tray_color] : []);
    const amsColors = rawColors.map(c => (c || "").slice(0, 6).toLowerCase());

    const matchingSpools = allSpools.filter(spoolmanSpool => {
        const materialA = (spoolmanSpool.filament?.material || "").toLowerCase();
        const materialB = (amsSpool.tray_sub_brands || "").toLowerCase();
        // Allow partial match to handle naming differences (e.g. "PLA" vs "PLA Basic")
        const materialMatches = materialA === materialB || materialA.includes(materialB) || materialB.includes(materialA);
        if (!materialMatches) return false;

        if (amsColors.length > 1) {
            const multiColorHexes = spoolmanSpool.filament?.multi_color_hexes
                ? spoolmanSpool.filament.multi_color_hexes.split(",").map(h => (h || "").toLowerCase())
                : [];
            return amsColors.some(c => multiColorHexes.includes(c));
        }

        const colorHex = (spoolmanSpool.filament?.color_hex || "").toLowerCase();
        return amsColors.some(c => colorHex === c);
    });

    return matchingSpools.find(spoolmanSpool => {
        const tag = (spoolmanSpool.extra?.tag || "").trim();
        const spoolRemainingWeight = (amsSpool.remain / 100) * spoolmanSpool.initial_weight;
        const lowerTolerance = spoolRemainingWeight * 0.85;
        const upperTolerance = spoolRemainingWeight * 1.15;
        const weightMatches =
            spoolmanSpool.remaining_weight >= lowerTolerance &&
            spoolmanSpool.remaining_weight <= upperTolerance;
        const hasTag = tag && tag !== "" && tag !== '""';

        if (NEVER_MERGE_IF_TAG && hasTag) return false;

        const neverUsed = spoolmanSpool.used_weight === 0 || spoolmanSpool.used_weight == null;

        return (
            (spoolmanSpool.remaining_weight === 0 && hasTag) ||
            spoolmanSpool.remaining_weight === 0 ||
            weightMatches ||
            neverUsed
        );
    });
}

/**
 * Whether the Spoolman side changed in a way that should trigger reprocessing.
 *
 * Only the three fields this service reacts to are compared: the tag link, the
 * remaining weight and the filament record. A null or non-array baseline counts
 * as changed, which is how the very first pass is forced to process everything.
 *
 * @param {object[]} spools - the current Spoolman spool list
 * @param {object[]|null} lastSpoolData - the previous list, null when unseeded
 * @returns {Promise<boolean>}
 */
export async function haveSpoolDataChanged(spools, lastSpoolData) {
    if (!Array.isArray(spools) || !Array.isArray(lastSpoolData)) return true;
    if (spools.length !== lastSpoolData.length) return true;

    // Compare by spool id rather than array position: Spoolman may return the
    // list in a different order between calls (e.g. sorted by last_used),
    // which would otherwise look like a content change on every PATCH.
    const lastById = new Map(lastSpoolData.map(s => [s.id, s]));

    return !spools.every((spool) => {
        const lastSpool = lastById.get(spool.id);
        if (!spool || !lastSpool) return false;
        return (
            spool?.extra?.tag === lastSpool?.extra?.tag &&
            spool.remaining_weight === lastSpool.remaining_weight &&
            JSON.stringify(spool.filament) === JSON.stringify(lastSpool.filament)
        );
    });
}

/**
 * Whether a slot is worth pushing to the UI over SSE.
 *
 * On the first run everything is sent, so the client starts from a complete
 * picture. Afterwards only slots the printer fully identified are sent, which
 * keeps the sparse payloads of empty and unidentified slots from overwriting a
 * populated row on every message.
 */
export function shouldSendSlotUpdate(slot, isFirstRun) {
    const isValidBambu =
        slot &&
        Object.keys(slot).length > 6 &&
        slot.tray_uuid !== "N/A" &&
        slot.tray_sub_brands !== "N/A";
    return isFirstRun || isValidBambu;
}

/**
 * Whether anything the UI actually displays changed between two versions of a
 * slot, used to suppress redundant SSE broadcasts.
 *
 * The comparison is an explicit key list rather than a deep equality check,
 * because the slot object carries plenty of fields that tick without meaning
 * anything to the user. A new displayed field must be added to that list, or it
 * will never reach the UI on its own.
 *
 * @param {object|undefined} next - the freshly built UI spool
 * @param {object|undefined} prev - the previous one for the same slot
 * @returns {boolean} true when unknown or different, so the caller broadcasts
 */
export function hasSpoolUiChanged(next, prev) {
    if (!next || !prev) return true;
    const keys = [
        "slot.tray_uuid", "slot.tray_weight", "slot.remain", "slot.tray_sub_brands",
        "slot.tray_color", "slotState", "option", "enableButton",
        "existingSpool.id", "matchingInternalFilament.id",
        "matchingExternalFilament.id", "mergeableSpool.id", "error",
    ];
    const _get = (obj, path) =>
        path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    return keys.some(k => JSON.stringify(_get(next, k)) !== JSON.stringify(_get(prev, k)));
}
