import * as ftp from "basic-ftp";
import AdmZip from "adm-zip";
import { Writable } from "stream";

import { EXTERNAL_SLOT, convertAMSandSlot } from "./utils.js";
import { normColor } from "../public/shared.js";

/**
 * TLS options for BambuLab's self-signed certificate. The printer presents a
 * cert with CN = serial number; we don't validate it (same as the MQTT
 * connection, which also uses rejectUnauthorized:false).
 *
 * Built fresh for every connection on purpose. basic-ftp writes the host into
 * the object it is given, and for implicit TLS that stored host wins over the
 * one passed to access(), so a shared object sends every later connection to
 * the printer that used it first.
 */
export function bambuTlsOptions() {
    return { rejectUnauthorized: false };
}

/**
 * Downloads the .gcode.3mf for the active print via FTPS and extracts only
 * Metadata/slice_info.config (~2-3 KB). The rest of the archive is discarded
 * immediately after extraction.
 *
 * BambuLab printers run vsftpd with implicit TLS on port 990, login bblp /
 * <access code>. The actual sliced files live in /cache/<job>.gcode.3mf. The
 * MQTT `gcode_file` field (e.g. /data/Metadata/plate_1.gcode) is an internal
 * path that is NOT exposed over FTP, so we resolve via the job name instead.
 *
 * @param {object} printer  - printer object with .ip and .code
 * @param {string} jobName  - subtask_name / gcode_file from MQTT
 * @returns {object|null} parsed slice info or null if not found
 */
export async function fetchSliceInfo(printer, jobName) {
    const client = new ftp.Client(20000); // 20 s timeout
    client.ftp.verbose = false;

    try {
        await client.access({
            host: printer.ip,
            port: 990,
            user: "bblp",
            password: printer.code,
            secure: "implicit",
            secureOptions: bambuTlsOptions(),
        });

        const candidates = resolveRemotePaths(jobName);

        let buf = null;
        for (const path of candidates) {
            try {
                const chunks = [];
                const writable = new Writable({
                    write(chunk, _, cb) { chunks.push(chunk); cb(); },
                });
                await client.downloadTo(writable, path);
                buf = Buffer.concat(chunks);
                break;
            } catch {
                // try next candidate path
            }
        }

        if (!buf) return null;

        const zip = new AdmZip(buf);
        const entry = zip.getEntry("Metadata/slice_info.config");
        if (!entry) return null;

        // The whole archive is already in memory, so the second entry costs
        // nothing on the wire. It is the only place the colour set of a multi
        // colour filament appears: slice_info.config keeps one colour per
        // filament, the first of the set. Missing on older slicers, and then
        // the single colour is all there is, exactly as before.
        const settings = zip.getEntry("Metadata/project_settings.config");

        return parseSliceInfo(
            entry.getData().toString("utf8"),
            settings ? settings.getData().toString("utf8") : null,
        );
    } finally {
        client.close();
    }
}

/**
 * Normalises a color to a bare 6-digit uppercase hex (no "#", no alpha) so
 * slice colors ("#000000") and AMS slot colors ("000000FF") compare equal.
 *
 * Defined in `public/shared.js`, because the dashboard normalises the same
 * colors out of the same payloads, and re-exported here so that every caller
 * keeps importing it from where the consumption keys are built.
 */
export { normColor } from "../public/shared.js";

/**
 * Identity of a filament for consumption matching: tray_info_idx alone is the
 * material profile (e.g. "GFA00" = PLA Basic) and does NOT distinguish colors,
 * so we combine it with the normalised color. This separates e.g. PLA Black
 * from PLA Jade White even though both share tray_info_idx.
 *
 * `colors` extends that with the whole colour set of a multi colour filament,
 * which the two fields above cannot separate: a gradient spool is not a profile
 * of its own (Bambu Studio slices PLA Basic Gradient as GFA00, the same as
 * plain PLA Basic) and `color` is only the first colour of the set. Arctic
 * Whisper, Solar Breeze and an ordinary white PLA Basic were one key.
 *
 * The set is sorted, because the sources disagree on order: Bambu Studio writes
 * Cotton Candy Cloud as "#8EC9E9 #E7C1D5" and SpoolmanDB stores it the other
 * way round. Comparing unsorted would match nothing at all rather than match
 * the wrong thing.
 *
 * A single colour produces the key it always did, byte for byte, so nothing
 * changes for the spools that were never ambiguous.
 *
 * @param {string|null} trayInfoIdx - the filament profile
 * @param {string|null} color - the first colour, as either side reports it
 * @param {string[]} [colors] - every colour of the filament, any order
 */
export function consumptionKey(trayInfoIdx, color, colors = null) {
    const set = (colors || []).map(normColor).filter(Boolean);
    const suffix = set.length > 1 ? `|${[...new Set(set)].sort().join("+")}` : "";
    return `${trayInfoIdx || "?"}|${normColor(color)}${suffix}`;
}

/**
 * Names the AMS slot each consumption entry was sliced for, in place.
 *
 * Bambu Studio's filament list is the printer's slot list, so the position in
 * it is the slot: the fifth entry is the fifth slot. Verified against a print
 * sliced for a P2S with two AMS units, where the ids 5, 7 and 8 were B1, B3
 * and B4.
 *
 * The position is resolved against the slots the printer actually reports,
 * never against a computed geometry. A second file settled that: with two AMS
 * units and a spool on the external holder the list holds nine entries, and
 * arithmetic on "four slots per unit" turns the ninth into "C1", a unit that
 * printer does not have. The list length is no help either, it is the project's
 * filament count and not the printer's: the same P2S produced files with six,
 * eight and nine entries.
 *
 * Only the four slot units are passed in by the callers. An AMS HT, an external
 * holder or a second extruder sit somewhere in that list that no observed file
 * pins down, so a filament beyond the known slots is left unnamed rather than
 * placed on a real slot the print never touched.
 *
 * The result is a suggestion, never a conclusion. The printer can remap slots
 * when a job is sent and slice_info.config is written before that, so whoever
 * reads `amsId` has to confirm it against what the slot actually holds.
 *
 * `reportedByPrinter` records where the slots came from, because the answer is
 * trusted differently depending on that: what the printer reports is what it
 * will run, while the list order is an estimate that has to be confirmed
 * against the slot before anything is booked on it.
 *
 * @param {object} consumption - a map from calcFullConsumption or the partial one
 * @param {string[]} amsIds - the printer's slots, in the order the slicer lists them
 * @param {object} [options]
 * @param {boolean} [options.reportedByPrinter] - whether `amsIds` came from `print.mapping`
 * @returns {object} the same map, for chaining
 */
export function resolveSliceSlots(consumption, amsIds, { reportedByPrinter = false } = {}) {
    for (const entry of Object.values(consumption)) {
        entry.amsId = amsIds?.[entry.index] ?? null;
        entry.amsIdFromPrinter = entry.amsId !== null && reportedByPrinter;
    }
    return consumption;
}

/**
 * The value `print.mapping` uses for a filament the plate does not print.
 * Decoding it would otherwise read as unit 255 slot 255 and name the external
 * spool holder, which is unit 255 slot 0.
 */
const MAPPING_UNUSED = 0xFFFF;

/**
 * The slots a printer says a print is actually taking its filaments from.
 *
 * `print.mapping` is the printer's own answer to the question `orderedAmsSlots`
 * can only estimate, and it is the better one twice over: it needs no
 * assumption about how the slicer numbers its list, and it is the assignment
 * after any remapping the printer did when the job was sent, not the slicer's
 * intention before it.
 *
 * One entry per filament of the slicer's project, in the same order, so the
 * result drops straight into `resolveSliceSlots()`. Each is the unit in the
 * high byte and the slot in the low one: 0x0100 is B1, 0x0002 is A3, 0xFF00 is
 * the external holder, and 0xFFFF means the plate does not use that filament.
 * Both bytes count from 0, while the labels count a unit's slots from 1, which
 * is what `convertAMSandSlot()` is doing to the low byte.
 *
 * Read off a P2S across two prints, where all seven entries matched the slots
 * the print was really running from, including the holder and the unused
 * marker.
 *
 * A unit this service cannot address yields null rather than a label, so the
 * caller treats it as unknown instead of booking onto whatever "Z" would name.
 *
 * @param {number[]|undefined} mapping - `print.mapping` from an MQTT report
 * @returns {string[]|null} slot labels by filament index, null when not reported
 */
export function decodePrintMapping(mapping) {
    if (!Array.isArray(mapping) || !mapping.length) return null;

    return mapping.map(value => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number === MAPPING_UNUSED) return null;

        const label = convertAMSandSlot(number >> 8, number & 0xFF);
        return label === "Z" ? null : label;
    });
}

/**
 * The printer's slots in the order Bambu Studio lists them, which is by
 * ascending AMS unit id and then by slot within the unit.
 *
 * That order is read off a printer rather than assumed. A P2S with two AMS
 * units and a spool on the external holder produced a nine entry filament list
 * whose colours matched, position for position, the slots the printer reported:
 * unit 0 as positions 0 to 3, unit 1 as 4 to 7, and the holder, which the
 * printer numbers 255, as position 8. Sorting by unit id reproduces exactly
 * that, so an AMS HT, numbered 128 to 135, falls between the four slot units
 * and the holder.
 *
 * The four slot units contribute all four of their positions whether or not a
 * slot reported a spool, because the slicer lists an empty slot too and
 * counting only the occupied ones would shift every position after one onto the
 * wrong spool. An AMS HT and the holder are one position each.
 *
 * Where an AMS HT really sits is inference, not measurement: no observed file
 * has one in it. It costs nothing to be wrong about, because `slotConfirmsSlice`
 * refuses a position whose slot does not hold the expected profile and colours,
 * and the stages below it then decide exactly as they did before positions were
 * used at all.
 *
 * This is the fallback for a printer that does not report `print.mapping`,
 * which answers the same question and is right where this is only sometimes:
 * measured on a P2S, it named the right slots for a project synchronised with
 * the printer and none of them for a project holding fewer filaments than the
 * printer has slots.
 *
 * @param {string[]} amsIds - slot labels as `convertAMSandSlot` produces them
 * @returns {string[]} the positions, ordered
 */
export function orderedAmsSlots(amsIds) {
    const ids = (amsIds || []).filter(id => typeof id === "string");
    const units = ["A", "B", "C", "D"];

    const attached = units.filter(unit => ids.some(id => id[0] === unit && /^[1-4]$/.test(id[1])));
    const fourSlotUnits = attached.flatMap(unit => [1, 2, 3, 4].map(slot => `${unit}${slot}`));

    const highTemperature = ids.filter(id => /^HT-[A-H]$/.test(id)).sort();
    const external = ids.includes(EXTERNAL_SLOT) ? [EXTERNAL_SLOT] : [];

    return [...fourSlotUnits, ...highTemperature, ...external];
}

/**
 * The key one sliced filament is accumulated under, and the entry it seeds.
 *
 * The position in the slicer's filament list, which is one slot, so two
 * filaments never merge. They used to be accumulated under their identity, and
 * two identical black spools in two slots were therefore one number before
 * anything looked at the AMS; the sum could not be split afterwards however the
 * spools were identified. Keeping them apart costs nothing where the printer
 * cannot tell them apart either: both then match the same spool and book
 * separately, which adds up to the same total.
 *
 * The key is deliberately not the slot label. Which slot a position is depends
 * on the printer the print is booked against, and that is not known here.
 */
function consumptionEntry(f) {
    return {
        key: `filament${f.index}`,
        entry: {
            index: f.index,
            tray_info_idx: f.tray_info_idx,
            color: f.color,
            colors: f.colors || null,
            type: f.type,
            // Both filled in by resolveSliceSlots, which needs the printer this
            // is going to be matched against and is therefore not known here.
            amsId: null,
            amsIdFromPrinter: false,
            grams: 0,
        },
    };
}

/**
 * Calculates consumed grams per sliced filament for a complete print. Purge is
 * already included in used_g from the slicer.
 *
 * Run the result through `resolveSliceSlots()` to name the slots before
 * matching it against a printer.
 *
 * @param {object} sliceInfo - result of fetchSliceInfo
 * @returns {{ [key]: { index, tray_info_idx, color, colors, type, amsId, grams } }}
 */
export function calcFullConsumption(sliceInfo) {
    const result = {};
    for (const f of sliceInfo.filaments) {
        if (!f.tray_info_idx) continue;
        const { key, entry } = consumptionEntry(f);
        if (!result[key]) result[key] = entry;
        result[key].grams += f.used_g;
    }
    return roundEntries(result);
}

/**
 * Calculates consumed grams per tray_info_idx up to a given layer (for
 * failed/cancelled prints).
 *
 * Each filament is scaled by the fraction of ITS active layers that were
 * printed. A filament's active layers are the union of all layer_filament_list
 * ranges that reference it. When a filament spans the whole print (the common
 * case) this reduces to completedLayers / totalLayers; when a filament is
 * restricted to certain layers (e.g. a different top color) the estimate is
 * more accurate.
 *
 * Purge is scaled proportionally as part of used_g. Not perfectly accurate
 * (purge happens discretely at tool changes) but a solid best-effort estimate
 * without parsing the full multi-MB G-code.
 *
 * @param {object} sliceInfo  - result of fetchSliceInfo
 * @param {number} upToLayer  - last completed layer number from MQTT (0-based)
 * @returns {{ [key]: { tray_info_idx, color, type, grams } }}
 */
export function calcPartialConsumption(sliceInfo, upToLayer) {
    const result = {};

    for (const f of sliceInfo.filaments) {
        if (!f.tray_info_idx) continue;

        const ranges = sliceInfo.rangesByFilamentIdx[f.index] || [];

        // No layer data → fall back to global progress fraction
        let proportion;
        if (ranges.length === 0) {
            proportion = sliceInfo.totalLayers > 0
                ? Math.min(1, (upToLayer + 1) / (sliceInfo.totalLayers + 1))
                : 0;
        } else {
            const total = ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
            let done = 0;
            for (const [start, end] of ranges) {
                if (upToLayer < start) continue;
                done += Math.min(upToLayer, end) - start + 1;
            }
            proportion = total > 0 ? done / total : 0;
        }

        const { key, entry } = consumptionEntry(f);
        if (!result[key]) result[key] = entry;
        result[key].grams += f.used_g * proportion;
    }

    return roundEntries(result);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds candidate FTPS paths for the sliced 3MF from a MQTT job name.
 *
 * gcode_file from MQTT can be:
 *   /data/Metadata/plate_1.gcode  (internal path, strip to base name)
 *   My Print.gcode.3mf
 *   My Print
 * The real file is /cache/<name>.gcode.3mf, sometimes also in the FTP root.
 */
function resolveRemotePaths(jobName) {
    if (!jobName) return [];

    // Internal /data/Metadata/plate_1.gcode path carries no job name → useless;
    // caller should pass subtask_name in that case. Strip directory anyway.
    let name = jobName.split("/").pop();

    // Normalise to the bare job name without extensions
    name = name.replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "").replace(/\.gcode$/i, "");

    const file = `${name}.gcode.3mf`;
    return [`/cache/${file}`, `/${file}`];
}

/**
 * Parses `Metadata/slice_info.config` into the shape the consumption maths
 * expects.
 *
 * Two things are read out of it: the filament list, where each entry carries
 * the material profile, colour and the grams the slicer predicted, and the
 * layer_filament_list entries, which say over which layer ranges each filament
 * is actually used. Filament ids are 1 based and may be non contiguous, while
 * the layer lists reference a 0 based index, so both are kept.
 *
 * `projectSettings` is the sibling entry of the same archive. It is optional
 * and adds two things this file does not carry: the whole colour set of a
 * multi colour filament, and nothing else. slice_info.config keeps only the
 * first colour of a set, which is why a gradient spool and a plain spool of
 * the same first colour were one filament as far as this service could tell.
 *
 * Exported for tests; fetchSliceInfo is the normal entry point.
 *
 * @param {string} xml - the raw slice_info.config contents
 * @param {string|null} [projectSettings] - raw project_settings.config
 * @returns {{filaments: object[], totalLayers: number, rangesByFilamentIdx: object}}
 */
export function parseSliceInfo(xml, projectSettings = null) {
    const colorSets = parseMultiColours(projectSettings);

    // --- filaments ---
    const filaments = [];
    const filamentRe = /<filament\s+([^>]+?)\/>/g;
    let m;
    while ((m = filamentRe.exec(xml)) !== null) {
        const a = parseAttrs(m[1]);
        const id = parseInt(a.id, 10);
        if (!Number.isFinite(id)) continue;
        filaments.push({
            id,                       // 1-based, may be non-contiguous
            index: id - 1,            // 0-based index used in layer_filament_list
            tray_info_idx: a.tray_info_idx || null,
            type: a.type || null,
            color: a.color || null,
            colors: colorSets[id - 1] || null,
            used_m: parseFloat(a.used_m) || 0,
            used_g: parseFloat(a.used_g) || 0,
        });
    }

    // --- layer_filament_list: each entry lists the filament indices used over
    //     one or more layer ranges. Build per-filament-index merged ranges. ---
    const rangesByFilamentIdx = {};
    let totalLayers = 0;

    const listRe = /<layer_filament_list\s+([^>]+?)\/>/g;
    while ((m = listRe.exec(xml)) !== null) {
        const a = parseAttrs(m[1]);
        const indices = (a.filament_list || "")
            .trim().split(/\s+/).filter(s => s !== "").map(Number);
        const ranges = parseLayerRanges(a.layer_ranges || "");

        for (const [, end] of ranges) {
            if (end > totalLayers) totalLayers = end;
        }
        for (const idx of indices) {
            (rangesByFilamentIdx[idx] ||= []).push(...ranges);
        }
    }

    return { filaments, totalLayers, rangesByFilamentIdx };
}

/**
 * Reads `filament_multi_colour` out of project_settings.config, indexed the way
 * the slicer indexes its filament list, so entry `id - 1` belongs to filament
 * `id`.
 *
 * The file is JSON, but it is parsed with a regular expression on purpose: it
 * is the slicer's whole configuration, tens of thousands of characters of
 * gcode templates and per filament arrays, and one key out of it does not
 * justify holding all of that as objects. A file that cannot be read at all
 * yields nothing, and the single colour each filament also carries stays the
 * only thing known about it.
 *
 * Studio writes a set as one space separated string, "#8EC9E9 #E7C1D5", and a
 * single colour filament as its one colour, so a set of one is not a set.
 *
 * @param {string|null} json - raw project_settings.config
 * @returns {string[][]} colour sets by filament index, sparse
 */
function parseMultiColours(json) {
    if (!json) return [];

    const match = /"filament_multi_colour"\s*:\s*\[([^\]]*)\]/.exec(json);
    if (!match) return [];

    return match[1]
        .split(",")
        .map(entry => {
            const colors = (entry.match(/"([^"]*)"/)?.[1] || "")
                .trim()
                .split(/\s+/)
                .map(normColor)
                .filter(Boolean);
            return colors.length > 1 ? colors : null;
        });
}

/**
 * Parses the `key="value"` attributes of one XML tag into an object. The slice
 * info file is small and machine generated, so this is used instead of pulling
 * in an XML parser.
 */
function parseAttrs(str) {
    const result = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) result[m[1]] = m[2];
    return result;
}

/**
 * Parses a `layer_ranges` attribute into inclusive layer pairs.
 *
 * "0 127" yields [[0, 127]], "0 50,60 127" yields [[0, 50], [60, 127]].
 * Malformed pairs are dropped rather than producing NaN ranges.
 */
function parseLayerRanges(str) {
    // "0 127" → [[0,127]];  "0 50,60 127" → [[0,50],[60,127]]
    return str.split(",")
        .map(pair => pair.trim().split(/\s+/).map(Number))
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
        .map(([s, e]) => [s, e]);
}

/** Rounds every consumption entry to two decimals, in place. */
function roundEntries(result) {
    for (const k of Object.keys(result)) {
        result[k].grams = Math.round(result[k].grams * 100) / 100;
    }
    return result;
}

/**
 * Checks whether the FTPS server of a printer accepts the access code.
 *
 * Same connection the consumption tracking uses, so a green result here means
 * the sliced file can actually be downloaded. Nothing is transferred beyond the
 * login itself.
 *
 * @param {{ip: string, code: string}} printer - address and access code to try
 * @param {number} [timeout] - milliseconds before the attempt is given up
 * @returns {Promise<{ok: boolean, error?: string, detail?: string}>}
 */
export async function testFtpsConnection(printer, timeout = 8000) {
    const client = new ftp.Client(timeout);
    client.ftp.verbose = false;

    try {
        await client.access({
            host: printer.ip,
            port: 990,
            user: "bblp",
            password: printer.code,
            secure: "implicit",
            secureOptions: bambuTlsOptions(),
        });
        return { ok: true };
    } catch (err) {
        const detail = err?.message || String(err);
        return { ok: false, error: describeFtpsError(err), detail };
    } finally {
        client.close();
    }
}

/**
 * Turns an FTPS failure into something a user can act on. The library reports
 * a rejected login as a 530 reply code and an unreachable host as a socket
 * error, which are two very different things to fix.
 */
function describeFtpsError(err) {
    const message = err?.message || String(err);

    if (err?.code === 530 || /530/.test(message)) return "The printer rejected the access code";
    if (/ECONNREFUSED/.test(message)) return "Port 990 refused the connection. Is FTP access enabled on the printer?";
    if (/ETIMEDOUT|timeout|Timeout/.test(message)) return "No answer on port 990 within the timeout";
    if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(message)) return "The address cannot be reached";

    return message;
}

/**
 * What the printer is doing inside a running print, by the number it reports
 * as `print.stg_cur`.
 *
 * These names are not published by Bambu Lab in a form this project can carry.
 * The table is the one the community has settled on, and it is treated as a
 * lead rather than a fact: an unknown number is shown as the number, so a
 * firmware that adds a stage says "Stage 54" instead of a wrong name or an
 * empty field. A P2S was seen announcing stages 51 and 54 for an ordinary
 * plate, so the gaps are real and not hypothetical.
 *
 * -1 is what the printer reports when it is in no stage at all, which is every
 * report outside a print and most reports during one: the stage is only set
 * while something other than plain printing is going on.
 */
const PRINT_STAGES = {
    1:  "Auto bed levelling",
    2:  "Heatbed preheating",
    3:  "Sweeping XY mech mode",
    4:  "Changing filament",
    5:  "M400 pause",
    6:  "Paused, filament runout",
    7:  "Heating hotend",
    8:  "Calibrating extrusion",
    9:  "Scanning bed surface",
    10: "Inspecting first layer",
    11: "Identifying build plate",
    12: "Calibrating micro lidar",
    13: "Homing toolhead",
    14: "Cleaning nozzle tip",
    15: "Checking extruder temperature",
    16: "Paused by user",
    17: "Paused, front cover falling",
    18: "Calibrating lidar response",
    19: "Calibrating extrusion flow",
    20: "Paused, nozzle temperature malfunction",
    21: "Paused, heatbed temperature malfunction",
    22: "Unloading filament",
    23: "Paused, skipped step",
    24: "Loading filament",
    25: "Calibrating motor noise",
    26: "Paused, AMS lost",
    27: "Paused, heat break fan too slow",
    28: "Paused, chamber temperature control error",
    29: "Cooling chamber",
    30: "Paused by user G-code",
    31: "Motor noise showoff",
    32: "Paused, filament on nozzle detected",
    33: "Paused, cutter error",
    34: "Paused, first layer error",
    35: "Paused, nozzle clog",
};

/**
 * The stage of a running print as text, or null when the printer is in none.
 *
 * @param {number|null|undefined} code - `print.stg_cur` from an MQTT report
 * @returns {string|null} the stage, or null when there is no stage to name
 */
export function printStageName(code) {
    // 0 is the printer laying down filament, which the state badge next to this
    // one already says. Measured on a P2S: it sits on 0 for the whole body of a
    // print, so naming it would put "RUNNING" and "Printing" side by side for
    // almost the entire job. -1 is the same answer from the other end, no stage
    // at all, which is what it reports outside a print.
    if (code == null || code <= 0) return null;
    return PRINT_STAGES[code] ?? `Stage ${code}`;
}

/**
 * Whether a stage means the printer is getting ready rather than laying down
 * filament.
 *
 * Used for the badge that says a print has started but is not printing yet.
 * Everything that heats, homes, levels, calibrates, cleans or loads counts;
 * the paused stages do not, because a pause is its own state the printer
 * already reports as PAUSE.
 *
 * @param {number|null|undefined} code - `print.stg_cur` from an MQTT report
 * @returns {boolean} whether this stage is preparation
 */
export function isPreparingStage(code) {
    return [1, 2, 3, 7, 8, 9, 11, 12, 13, 14, 15, 18, 19, 24, 25].includes(Number(code));
}
