import { settings, legacyMode } from "./settings.js";
import { toClientSpool } from "./uispool.js";
import { slotColors, filamentColors } from "./utils.js";
import { consumptionKey, normColor } from "./gcode.js";

/**
 * Normalises the raw `print.ams.ams` payload so the rest of the pipeline sees
 * one consistent shape instead of the printer's mix of empty strings, nulls
 * and placeholder values.
 *
 * Missing material, colour and uuid all become the literal "N/A", which is the
 * marker every later stage tests against. An all zero `tray_uuid` means the
 * printer read no RFID chip and is treated the same as a missing one.
 *
 * `remain` becomes null when the printer does not know it. The AMS reports -1
 * after a spool is inserted, while it has the RFID tag but not yet the
 * remaining percentage, measured on a P2S at anything from 17 seconds to over a
 * minute, and a chipless spool reports -1 for good. That was clamped to 0, which is a real reading meaning "empty",
 * so a spool created inside that window was booked as fully used and came out
 * at 0 g left.
 *
 * PETG Translucent is a special case: it reports a fully transparent colour
 * that would render as invisible in the UI, so it is shown as white instead.
 *
 * `cols` is guaranteed to be an array from here on. A multi colour filament
 * reports every one of its colours there and only the first of them in
 * `tray_color`, so `cols` is the full truth about what is in the slot and
 * three matching functions read it. The printer does not always send it, and
 * those functions used to reach into `undefined.length`, so a slot without it
 * threw instead of falling back to the single colour it does report.
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

            // Not written back onto `slot`: the raw value is what the next
            // report is compared against, and mutating it here desyncs that.
            const rawRemain = Number(slot.remain);
            const remain = Number.isFinite(rawRemain) && rawRemain >= 0 ? rawRemain : null;

            // The PETG Translucent substitution has to reach `cols` as well.
            // It used to be enough to correct `tray_color`, because that was
            // the only colour anything read. `cols` is read first now, so
            // leaving the transparent value in it renders the spool black,
            // which is the invisible colour turned into the wrong one.
            const reportedColors = Array.isArray(slot.cols) ? slot.cols.filter(Boolean) : [];
            const cols = reportedColors.length
                ? reportedColors.map(color => (isPetgTranslucent && color === "00000000") ? "FFFFFF00" : color)
                : (updatedTrayColor === "N/A" ? [] : [updatedTrayColor]);

            return {
                ...slot,
                remain,
                cols,
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
                // A spool the printer cannot identify carries no uuid and no
                // material, but it does carry what the user set on the AMS, so
                // that is compared alongside the bare occupancy. Occupancy alone
                // was not enough: swapping one chipless spool for another, or
                // setting material and colour on the printer, left the
                // projection unchanged and the slot was never reprocessed.
                //
                // `state` is deliberately not compared. It is undocumented, it
                // varies between reports about the same unchanged slot, and it
                // does not separate an empty slot from a loaded one either;
                // `slotIsOccupied` explains what replaced it.
                if (t.tray_uuid === "N/A" || t.tray_sub_brands === "N/A") {
                    return {
                        id: t.id,
                        occupied: slotIsOccupied(t),
                        // An empty slot and one the AMS is reading are the same
                        // two fields, so without this the slot is not
                        // reprocessed while the spool goes in and the "Reading
                        // spool" label never reaches a client. It is a boolean,
                        // so the states the AMS cycles through cost one update
                        // between them, not one each.
                        busy: slotIsBusy(t),
                        tray_type: t.tray_type ?? null,
                        tray_info_idx: t.tray_info_idx ?? null,
                        // `tray_color` alone misses a swap between two multi
                        // colour filaments that share their first colour, so
                        // the slot would keep the old colour set on screen.
                        cols: slotColors(t),
                        tray_color: t.tray_color,
                        tray_weight: t.tray_weight,
                    };
                }
                return {
                    id: t.id,
                    tray_uuid: t.tray_uuid,
                    tray_weight: t.tray_weight,
                    tray_sub_brands: t.tray_sub_brands,
                    cols: slotColors(t),
                    tray_color: t.tray_color,
                    remain: t.remain,
                };
            })
            .sort((a, b) => a.id - b.id),
    })).sort((a, b) => a.id - b.id);
}

/**
 * Whether the tray data changed in a way that should trigger reprocessing.
 *
 * Legacy mode compares the projections as they are: the remaining percentage is
 * what it writes to Spoolman, so every tick of it matters.
 *
 * G-code mode takes the weight from the sliced file instead, so a drifting
 * percentage there would mean endless reprocessing and log output for nothing.
 * The value is dropped, but whether there is one at all is kept. The AMS
 * answers -1, which `processData` turns into null, for anything from 17 seconds
 * to well over a minute after a spool goes in, and that transition has to be
 * noticed: `printer.spoolData` is the snapshot the create and merge actions
 * build their Spoolman payload from, and while it still says "no reading" they
 * fall back to creating a full spool. A spool inserted at 53 % and created from
 * the UI was stored as untouched, because nothing had refreshed the snapshot
 * between the insert and the click.
 *
 * @param {object[]} nextTrayData - output of extractComparableTrayData
 * @param {object[]} lastTrayData - the same projection of the previous report
 * @returns {boolean}
 */
export function hasTrayDataChanged(nextTrayData, lastTrayData) {
    if (legacyMode()) return JSON.stringify(nextTrayData) !== JSON.stringify(lastTrayData);

    const project = data => data.map(ams => ({
        ...ams,
        tray: ams.tray.map(({ remain, ...tray }) => ({ ...tray, remainKnown: remain != null })),
    }));

    return JSON.stringify(project(nextTrayData)) !== JSON.stringify(project(lastTrayData));
}

/**
 * Converts the AMS remain percentage into a percentage of the spool's real
 * size.
 *
 * Defined in `public/shared.js`, because the dashboard shows the same
 * percentage from the same payload, and re-exported here so that `mqtt.js` and
 * `spoolman.js` keep importing it from the AMS module.
 */
export { correctRemainInt } from "../public/shared.js";

/**
 * The fields an empty AMS slot reports. Anything beyond these is filament data.
 *
 * The names are the ones left after `processData`, which fills `cols`,
 * `tray_color`, `tray_sub_brands`, `tray_weight` and `tray_uuid` with
 * placeholders on every tray, so those five say nothing about occupancy.
 * Every field the normalisation adds unconditionally has to be listed here, or
 * it alone makes an empty slot look occupied.
 */
const EMPTY_TRAY_KEYS = new Set(["id", "state", "remain", "cols", "tray_color", "tray_sub_brands", "tray_weight", "tray_uuid"]);

/**
 * Whether the AMS reports something physically sitting in the slot.
 *
 * Occupancy is read from the payload the tray carries, not from `state`.
 *
 * A loaded slot always comes with the full tray record, whether the RFID chip
 * was read or not: the AMS fills `tray_info_idx` (`GFL99` for anything it
 * cannot identify), `tray_type`, `cols`, `tag_uid` and the temperature fields
 * from its own defaults. An empty slot reports `id` and `state` and nothing
 * else, which is the whole difference between the two.
 *
 * `state` used to be the test and it is wrong. It is undocumented, and on a
 * P2S with two AMS 2 Pro units it reads 9 or 10 on an empty slot and 11 or 27
 * on a loaded one, so "non zero means occupied" marked every empty slot as
 * holding an unidentifiable spool. That is what put an "N/A" row with an
 * "Assign Spool" button on every emptied slot, and it also froze change
 * detection: `extractComparableTrayData` reduces an unidentified tray to its
 * occupancy, so with occupancy stuck at true, removing or inserting a chipless
 * spool produced a byte identical projection and was never processed.
 *
 * The trade off runs the other way round now. Firmware that reports a loaded
 * chipless slot with no filament fields at all would read as empty here, where
 * the old heuristic invented a spool on every empty one. Nothing observed so
 * far reports such a tray.
 */
export function slotIsOccupied(slot) {
    if (!slot) return false;
    return Object.keys(slot).some(key => !EMPTY_TRAY_KEYS.has(key));
}

// The `state` values seen on a sparse tray while the AMS was moving filament in
// or out of the slot, as opposed to 9 and 10, which it reports while a slot sits
// there empty. Undocumented, so this is an observation on a P2S, not a
// specification.
const BUSY_EMPTY_STATES = new Set([1, 5, 17, 21]);

/**
 * Whether an empty looking slot is one the AMS is currently working on.
 *
 * Purely cosmetic, and the one place `state` is still read. It has to be: a
 * spool being read reports `{ id, state }` and nothing else, byte for byte what
 * an empty slot reports, so there is no field to tell them apart. The AMS takes
 * around 20 seconds from the spool going in to the first tray record, and for
 * that whole time the dashboard would otherwise call the slot empty while the
 * user is watching the spool sit in it.
 *
 * Compared by `extractComparableTrayData()`, so the slot is reprocessed when it
 * starts and stops being busy. Without that the label would only ever reach a
 * client when some other slot happened to change in the same update.
 *
 * Deliberately an allow list of values seen while busy, not of values seen at
 * rest. A value nobody has observed yet reads as "at rest", so the slot says
 * "Empty slot", which is what it says today. The other way round an empty slot
 * could claim to be reading a spool for good. Nothing acts on this either way:
 * occupancy comes from `slotIsOccupied()`, which does not look at `state`.
 */
export function slotIsBusy(slot) {
    if (!slot || slotIsOccupied(slot)) return false;
    return BUSY_EMPTY_STATES.has(Number(slot.state));
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
    const amsColors = slotColors(amsSpool);
    const sortedAmsColors = [...amsColors].sort();

    return allSpools.find(spoolmanSpool => {
        const tag = spoolmanSpool.extra?.tag?.replace(/"/g, "");
        const materialMatches = spoolmanSpool.filament.material === amsSpool.tray_sub_brands;
        const tagMatches = tag === amsSpool.tray_uuid;

        // One comparison for both shapes. A count that differs is what keeps a
        // multi colour record from matching a single colour slot on its first
        // hex, which is the case the two separate branches here used to cover.
        const spoolColors = filamentColors(spoolmanSpool.filament);
        if (spoolColors.length !== amsColors.length) return false;

        return materialMatches && tagMatches
            && JSON.stringify([...spoolColors].sort()) === JSON.stringify(sortedAmsColors);
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

    const amsColors = slotColors(amsSpool).sort();

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
 * the "never merge a tagged spool" setting on, a spool that already carries any tag is skipped
 * outright.
 *
 * @param {object} amsSpool - a normalised AMS slot
 * @param {object[]} allSpools - the Spoolman spool list
 * @returns {object|undefined} the mergeable spool, or undefined
 */
export function findMergeableSpool(amsSpool, allSpools) {
    const amsColors = slotColors(amsSpool);

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
        // Without a remain reading there is nothing to compare the weight
        // against. Treating the missing value as 0 matched every spool that
        // happened to be empty, so the test is skipped instead and the
        // remaining criteria decide on their own.
        const spoolRemainingWeight = amsSpool.remain == null
            ? null
            : (amsSpool.remain / 100) * spoolmanSpool.initial_weight;
        const weightMatches = spoolRemainingWeight !== null &&
            spoolmanSpool.remaining_weight >= spoolRemainingWeight * 0.85 &&
            spoolmanSpool.remaining_weight <= spoolRemainingWeight * 1.15;
        const hasTag = tag && tag !== "" && tag !== '""';

        if (settings.NEVER_MERGE_IF_TAG && hasTag) return false;

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
 * Whether anything the UI actually displays changed between two versions of a
 * slot, used to suppress redundant SSE broadcasts.
 *
 * Compares what the client is sent, not the runtime objects: `toClientSpool()`
 * already drops everything the firmware reports without the UI showing it, so
 * this needs no key list of its own. That list was the trap it replaces, a new
 * displayed field that nobody added to it never reached the UI on its own.
 *
 * @param {object|undefined} next - the freshly built UI spool
 * @param {object|undefined} prev - the previous one for the same slot
 * @returns {boolean} true when unknown or different, so the caller broadcasts
 */
export function hasSpoolUiChanged(next, prev) {
    if (!next || !prev) return true;
    return JSON.stringify(toClientSpool(next)) !== JSON.stringify(toClientSpool(prev));
}

/**
 * Fallback identity for a filament, used where no tray_info_idx is available.
 *
 * Third party spools report the generic profile or none at all, so the material
 * and the colour are all there is to compare them by.
 */
export function materialKey(type, color) {
    return `${type || "?"}|${normColor(color)}`;
}

/**
 * Turns the "N/A" placeholder into a real absence.
 *
 * `processData()` writes that literal into every field the printer left out,
 * while `toClientSpool()` has already turned it back into null by the time the
 * dashboard route builds its candidates. Both call `consumptionCandidate()`,
 * so the two shapes have to produce the same keys: "N/A" normalises to the
 * string "N/A" and null to the empty one, which would be two different keys for
 * one slot depending on which side asked.
 */
function orNull(value) {
    return value === "N/A" || value === "" || value == null ? null : value;
}

/**
 * One slot in the shape `matchConsumption()` compares.
 *
 * Takes either a runtime UI spool or the client projection of one, which is
 * what makes the booking and the dashboard ask the same question: the fields
 * read here carry the same meaning in both.
 *
 * @param {object} uiSpool - a runtime UI spool or its `toClientSpool()` result
 * @returns {object} the candidate record
 */
export function consumptionCandidate(uiSpool) {
    const slot = uiSpool.slot || {};
    const idx = orNull(slot.tray_info_idx);
    const color = orNull(slot.tray_color);
    const colors = slotColors(slot);

    return {
        id:     uiSpool.existingSpool?.id ?? null,
        amsId:  uiSpool.amsId,
        mapped: !!uiSpool.connectedViaMapping,
        idx,
        colors,
        key:    idx ? consumptionKey(idx, color, colors) : null,
        matKey: materialKey(orNull(slot.tray_type), color),
    };
}

/**
 * Whether a slot really holds what the slice expected in it.
 *
 * The gate on stage 0 of `matchConsumption()`. A slot label out of the sliced
 * file is where the slicer meant a filament to come from, and the printer is
 * free to have decided otherwise, so it counts only when the profile and the
 * colours agree with what the AMS reports for that slot right now.
 *
 * Colours are compared as sorted sets, not as the single first colour: Bambu
 * Studio and the RFID chip do not have to agree on which colour of a set comes
 * first, and a comparison that depended on that would reject the very spools
 * this is for. A side that reports one colour is compared as one colour, so an
 * older slicer, which carries no colour set at all, simply does not confirm and
 * the later stages take over.
 *
 * @param {object} candidate - a bookable slot
 * @param {object} info - one entry of the consumption map
 * @returns {boolean}
 */
export function slotConfirmsSlice(candidate, info) {
    if (!candidate.idx || candidate.idx !== info.tray_info_idx) return false;

    const sliceColors = (info.colors?.length ? info.colors : [info.color]).map(normColor).filter(Boolean);
    const slotColorSet = candidate.colors.map(normColor).filter(Boolean);
    if (!sliceColors.length || !slotColorSet.length) return false;

    return JSON.stringify([...sliceColors].sort()) === JSON.stringify([...slotColorSet].sort());
}

/**
 * Decides which slot each filament of a sliced print belongs to.
 *
 * The one implementation of that decision. `bookConsumption()` runs it over the
 * spools it may book on, so a slot that is neither tag linked nor assigned
 * cannot take an amount, and the dashboard route runs it over every loaded slot,
 * so a slot nobody can book on still shows what the print needs from it. It used
 * to exist twice, once here and once in the browser, and the two drifted apart:
 * both defects fixed at the end of PR #89 sat in that copy.
 *
 * Slots are matched to slice filaments in four stages, most specific first:
 *   0. the slot named for the filament: the printer reports which slot each of
 *      them is running from, and where it does not, the position in the
 *      slicer's list is the estimate. It is the one stage that can tell two
 *      identical spools apart, because nothing else can: they differ in nothing
 *      but where they sit
 *   1. tray_info_idx + colours: the filament identity, which separates e.g.
 *      PLA Black from PLA Jade White despite a shared profile, and a gradient
 *      spool from the plain spool it shares both a profile and a first colour
 *      with
 *   2. material type + colour: for 3rd party spools, which report no usable
 *      tray_info_idx
 *   3. tray_info_idx alone: the colours did not line up, and the profile
 *      identifies one filament of this print, so there is nothing else it
 *      could belong to
 *
 * The two sources of that slot are trusted differently, which is the whole of
 * stage 0. What the printer reports is taken as it stands. What the list order
 * estimates has to be confirmed by `slotConfirmsSlice()`, because an unconfirmed
 * guess would book a real amount onto a real spool the print never touched.
 * When it does not confirm, the stages below decide as they did before stage 0
 * existed.
 *
 * Confirming what the printer reports would be wrong, and was: a print
 * configured to take a filament from a slot holding a different colour than the
 * sliced one is not a mistake to correct, it is the substitution the whole field
 * exists to report. Checking it against the sliced colour rejected the one
 * answer that was right and fell through to the colour stages, which found the
 * spool that was sliced instead of the spool that would have been consumed.
 *
 * The last stage speaks only where the profile identifies a single filament of
 * the print. Bambu Studio slices PLA Basic black and PLA Basic white as the
 * same GFA00, so with only the black spool loaded the white filament reached it
 * on the profile alone and its grams were booked onto a spool that never
 * printed it. Where the profile says nothing, the filament stays unplaced and
 * the log asks for an assignment, which is the honest answer.
 *
 * A slot the printer named for one filament is off limits to every other one.
 * The fallback stages compare colours, and a print running from remapped slots
 * has two of them agreeing on a colour: the slot being consumed and the slot
 * that merely holds what the file was sliced with. Without this the second one
 * claimed the same amount, which the dashboard showed on both rows and the
 * booking would have written onto the wrong spool.
 *
 * Within a stage, manually assigned spools win over tag connected ones: an
 * assignment is the user explicitly resolving what the automatic match cannot,
 * namely two connected spools identical in both profile and colour.
 *
 * @param {object[]} entries - the consumption entries, after resolveSliceSlots()
 * @param {object[]} candidates - slots from consumptionCandidate()
 * @returns {Map<object, object[]>} every entry to its matching candidates, best
 *   stage first and possibly empty. More than one means they are truly
 *   indistinguishable; the caller decides what to do about it.
 */
export function matchConsumption(entries, candidates) {
    const claimed = new Set(
        entries.filter(entry => entry.amsIdFromPrinter && entry.amsId).map(entry => entry.amsId),
    );
    const unclaimed = candidates.filter(candidate => !claimed.has(candidate.amsId));

    // How many filaments of this print carry each profile, for the last stage.
    const perProfile = {};
    for (const entry of entries) {
        if (entry.tray_info_idx) perProfile[entry.tray_info_idx] = (perProfile[entry.tray_info_idx] ?? 0) + 1;
    }

    const result = new Map();

    for (const info of entries) {
        const wantedKey    = consumptionKey(info.tray_info_idx, info.color, info.colors);
        const wantedMatKey = materialKey(info.type, info.color);

        let matches = [];
        for (const [pool, predicate] of [
            [candidates, c => !!info.amsId && c.amsId === info.amsId && (info.amsIdFromPrinter || slotConfirmsSlice(c, info))],
            [unclaimed,  c => c.key === wantedKey],
            [unclaimed,  c => c.matKey === wantedMatKey],
            [unclaimed,  c => c.idx && c.idx === info.tray_info_idx && perProfile[info.tray_info_idx] === 1],
        ]) {
            matches = pool.filter(predicate);
            if (matches.length) break;
        }

        const mapped = matches.filter(c => c.mapped);
        result.set(info, mapped.length ? mapped : matches);
    }

    return result;
}
