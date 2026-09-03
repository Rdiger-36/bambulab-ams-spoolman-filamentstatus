import { consumptionKey } from "./gcode.js";
import { orNull, slotColors, SLOT_OPTIONS } from "./utils.js";

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

/**
 * The AMS slot fields the Web UI reads. Everything else stays on the server.
 *
 * `cols` carries every colour of the filament, `tray_color` only the first of
 * them. Both are sent, because both are read: the swatch draws the whole set,
 * and the consumption key is built from the single colour plus the set, in the
 * same order on both sides, so the two have to keep agreeing.
 */
function pickSlot(slot) {
    if (!slot) return null;
    return {
        tray_uuid: orNull(slot.tray_uuid),
        tray_type: orNull(slot.tray_type),
        tray_sub_brands: orNull(slot.tray_sub_brands),
        cols: slotColors(slot),
        tray_color: orNull(slot.tray_color),
        tray_info_idx: orNull(slot.tray_info_idx),
        tray_weight: slot.tray_weight ?? null,
        remain: slot.remain ?? null,
    };
}

/**
 * The Spoolman spool fields the UI shows, for a linked or mergeable spool.
 *
 * A multi colour filament has no `color_hex` at all in Spoolman, it has
 * `multi_color_hexes` instead, so sending only the single field left every
 * multi colour spool in the UI with no colour to draw.
 */
function pickSpool(spool) {
    if (!spool) return null;
    const filament = spool.filament || null;
    return {
        id: spool.id ?? null,
        archived: spool.archived ?? false,
        remaining_weight: spool.remaining_weight ?? null,
        remaining_percentage: spool.remaining_percentage ?? null,
        initial_weight: spool.initial_weight ?? null,
        filament: filament ? {
            id: filament.id ?? null,
            name: filament.name ?? null,
            material: filament.material ?? null,
            weight: filament.weight ?? null,
            color_hex: filament.color_hex ?? null,
            multi_color_hexes: orNull(filament.multi_color_hexes),
            multi_color_direction: orNull(filament.multi_color_direction),
            vendor: filament.vendor ? { name: filament.vendor.name ?? null } : null,
        } : null,
    };
}

/**
 * A filament candidate from the SpoolmanDB catalogue, as the dialogs show it.
 *
 * `multi_color_direction` is carried for a slot that has no Spoolman spool yet:
 * the AMS reports which colours are on the filament but not how they sit on it,
 * and the catalogue is then the only source for that.
 */
function pickExternalFilament(filament) {
    if (!filament) return null;
    return {
        id: filament.id ?? null,
        name: filament.name ?? null,
        manufacturer: filament.manufacturer ?? null,
        material: filament.material ?? null,
        density: filament.density ?? null,
        diameter: filament.diameter ?? null,
        multi_color_direction: orNull(filament.multi_color_direction),
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
    // Derived below from the picked slot, not the runtime one, so the "N/A"
    // placeholder cannot slip back in through a fallback.
    const slot = pickSlot(uiSpool.slot || {});
    const existingSpool = pickSpool(uiSpool.existingSpool);
    const matchingExternalFilament = pickExternalFilament(uiSpool.matchingExternalFilament);
    const filament = existingSpool?.filament || null;

    return {
        amsId: uiSpool.amsId ?? null,
        slotState: uiSpool.slotState ?? null,
        slot,
        existingSpool,
        mergeableSpool: pickSpool(uiSpool.mergeableSpool),
        matchingInternalFilament: pickInternalFilament(uiSpool.matchingInternalFilament),
        matchingExternalFilament,
        connectedViaTag: uiSpool.connectedViaTag ?? false,
        connectedViaMapping: uiSpool.connectedViaMapping ?? false,
        // The slot holds a spool Spoolman has archived. The dashboard says so
        // rather than offering an action, and `hasSpoolUiChanged()` compares
        // this projection, so archiving one reaches the UI as a change.
        archived: uiSpool.archived ?? false,
        correctedRemain: uiSpool.correctedRemain ?? null,
        correctedWeight: uiSpool.correctedWeight ?? null,
        option: uiSpool.option ?? SLOT_OPTIONS.NONE,
        enableButton: uiSpool.enableButton ?? "false",
        error: uiSpool.error ?? false,

        // Derived once here rather than in every consumer: the readable name the
        // dashboard prints, the Spoolman id it links to, and the filament
        // identity, which is what the dashboard counts to find two slots it
        // cannot tell apart. It is no longer what ties a slot to an entry of
        // the sliced file: that is the slot itself wherever the slice names one,
        // and this identity is the fallback for where it does not.
        vendor: filament?.vendor?.name ?? matchingExternalFilament?.manufacturer ?? null,
        material: filament?.material ?? slot.tray_type ?? null,
        filamentName: filament?.name ?? matchingExternalFilament?.name ?? slot.tray_sub_brands ?? null,
        spoolmanId: existingSpool?.id ?? null,
        key: consumptionKey(slot.tray_info_idx, slot.tray_color, slot.cols),
    };
}

/**
 * The labels of the slots that hold something, for `orderedAmsSlots()`.
 *
 * Bambu Studio's filament list skips an empty slot, so passing every slot the
 * printer has would put a position where the slicer has none and shift every
 * filament after it onto the wrong slot. Measured on a P2S with A2 and B1
 * emptied: seven loaded slots, seven filaments, both gaps absent.
 *
 * Takes runtime UI spools or their client projection, because the booking reads
 * one and `/api/print` the other and both ask this same question.
 *
 * @param {object[]} uiSpools - `printer.spoolData` or its `toClientSpool()` map
 * @returns {string[]} the labels, in input order
 */
export function loadedSlotIds(uiSpools) {
    return (uiSpools || [])
        .filter(uiSpool => uiSpool.slotState !== "Empty")
        .map(uiSpool => uiSpool.amsId);
}
