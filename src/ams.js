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
            .filter(t => t && Object.keys(t).length > 6 && t.tray_uuid !== "N/A" && t.tray_sub_brands !== "N/A")
            .map(t => ({
                id: t.id,
                tray_uuid: t.tray_uuid,
                tray_weight: t.tray_weight,
                tray_sub_brands: t.tray_sub_brands,
                tray_color: t.tray_color,
                remain: t.remain,
            }))
            .sort((a, b) => a.id - b.id),
    })).sort((a, b) => a.id - b.id);
}

export function correctRemainInt(remainOn1kgBasis, trayWeight) {
    const remain = parseFloat(remainOn1kgBasis);
    const weight = parseFloat(trayWeight);

    if (weight < 1000) {
        let grams = (remain / 100) * 1000;
        let percent = (grams / weight) * 100;
        if (percent > 100) percent = 100;
        if (percent < 0) percent = 0;
        return Math.round(percent);
    }
    return Math.round(remain);
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

    return !spools.every((spool, index) => {
        const lastSpool = lastSpoolData[index];
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
