import { NEVER_MERGE_IF_TAG } from "./config.js";

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

export function correctRemainInt(remainOn1kgBasis, trayWeight, trayType = null) {
    const remain = parseFloat(remainOn1kgBasis);
    const weight = parseFloat(trayWeight);

    // Support/accessory material (tray_type suffix "-S", e.g. "PLA-S") is sold
    // and measured at its real spool size, not estimated on a 1kg basis like
    // regular color filament <1kg — so its remain% is already relative to the
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
 * A slot holding a spool the printer cannot identify — no RFID chip, or one it
 * failed to read — comes through with the same sparse payload as an empty slot:
 * tray_uuid "N/A", no tray_type, tray_weight 0. The only field that separates
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

export function findMatchingInternalFilament(externalFilament, internalFilaments) {
    if (!externalFilament) return null;
    return internalFilaments.find(f => f.external_id === externalFilament.id) || null;
}

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

export function shouldSendSlotUpdate(slot, isFirstRun) {
    const isValidBambu =
        slot &&
        Object.keys(slot).length > 6 &&
        slot.tray_uuid !== "N/A" &&
        slot.tray_sub_brands !== "N/A";
    return isFirstRun || isValidBambu;
}

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
