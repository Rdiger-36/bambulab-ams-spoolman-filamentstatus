import { consumptionKey } from "./gcode.js";

/**
 * The one projection from an internal UI spool to what a client sees.
 *
 * `printer.spoolData` holds runtime objects: the raw AMS slot exactly as the
 * printer reported it, whole Spoolman records, and two server-only fields. Both
 * the dashboard payloads and the SSE updates used to be hand-picked from that,
 * in two places with different field names, which is how `/api/print` ended up
 * missing `connectedViaMapping`. Everything that leaves the server for a client
 * goes through here instead, so there is one shape to keep correct.
 *
 * Narrowing is deliberate rather than incidental: the payload no longer carries
 * whatever the firmware happened to send, and it holds no field that ticks
 * without the UI showing it, which is what lets `hasSpoolUiChanged()` compare
 * the projection itself instead of a hand-maintained key list.
 */

/** The AMS slot fields the Web UI reads. Everything else stays on the server. */
function pickSlot(slot) {
    if (!slot) return null;
    return {
        tray_uuid: slot.tray_uuid ?? null,
        tray_type: slot.tray_type ?? null,
        tray_sub_brands: slot.tray_sub_brands ?? null,
        tray_color: slot.tray_color ?? null,
        tray_info_idx: slot.tray_info_idx ?? null,
        tray_weight: slot.tray_weight ?? null,
        remain: slot.remain ?? null,
    };
}

/** The Spoolman spool fields the UI shows, for a linked or mergeable spool. */
function pickSpool(spool) {
    if (!spool) return null;
    const filament = spool.filament || null;
    return {
        id: spool.id ?? null,
        remaining_weight: spool.remaining_weight ?? null,
        remaining_percentage: spool.remaining_percentage ?? null,
        initial_weight: spool.initial_weight ?? null,
        filament: filament ? {
            id: filament.id ?? null,
            name: filament.name ?? null,
            material: filament.material ?? null,
            weight: filament.weight ?? null,
            color_hex: filament.color_hex ?? null,
            vendor: filament.vendor ? { name: filament.vendor.name ?? null } : null,
        } : null,
    };
}

/** A filament candidate from the SpoolmanDB catalogue, as the dialogs show it. */
function pickExternalFilament(filament) {
    if (!filament) return null;
    return {
        id: filament.id ?? null,
        name: filament.name ?? null,
        manufacturer: filament.manufacturer ?? null,
        material: filament.material ?? null,
        density: filament.density ?? null,
        diameter: filament.diameter ?? null,
    };
}

/** A filament that already exists in this Spoolman instance. */
function pickInternalFilament(filament) {
    if (!filament) return null;
    return {
        id: filament.id ?? null,
        name: filament.name ?? null,
        material: filament.material ?? null,
    };
}

/**
 * Projects one internal UI spool into the client payload.
 *
 * @param {object} uiSpool - an entry of `printer.spoolData`
 * @returns {object} the payload for `/api/spools`, `/api/print` and SSE
 */
export function toClientSpool(uiSpool) {
    const slot = uiSpool.slot || {};
    const existingSpool = pickSpool(uiSpool.existingSpool);
    const matchingExternalFilament = pickExternalFilament(uiSpool.matchingExternalFilament);
    const filament = existingSpool?.filament || null;

    return {
        amsId: uiSpool.amsId ?? null,
        slotState: uiSpool.slotState ?? null,
        slot: pickSlot(slot),
        existingSpool,
        mergeableSpool: pickSpool(uiSpool.mergeableSpool),
        matchingInternalFilament: pickInternalFilament(uiSpool.matchingInternalFilament),
        matchingExternalFilament,
        connectedViaTag: uiSpool.connectedViaTag ?? false,
        connectedViaMapping: uiSpool.connectedViaMapping ?? false,
        correctedRemain: uiSpool.correctedRemain ?? null,
        correctedWeight: uiSpool.correctedWeight ?? null,
        option: uiSpool.option ?? "No actions available",
        enableButton: uiSpool.enableButton ?? "false",
        error: uiSpool.error ?? false,

        // Derived once here rather than in every consumer: the readable name the
        // dashboard prints, the Spoolman id it links to, and the consumption key
        // that ties a slot to an entry of the sliced file.
        vendor: filament?.vendor?.name ?? matchingExternalFilament?.manufacturer ?? null,
        material: filament?.material ?? slot.tray_type ?? null,
        filamentName: filament?.name ?? matchingExternalFilament?.name ?? slot.tray_sub_brands ?? null,
        spoolmanId: existingSpool?.id ?? null,
        key: consumptionKey(slot.tray_info_idx, slot.tray_color),
    };
}
