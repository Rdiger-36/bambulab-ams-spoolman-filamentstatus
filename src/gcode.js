import * as ftp from "basic-ftp";
import AdmZip from "adm-zip";
import { Writable } from "stream";

// TLS options for BambuLab's self-signed certificate. The printer presents a
// cert with CN = serial number; we don't validate it (same as the MQTT
// connection, which also uses rejectUnauthorized:false).
const BAMBU_TLS = { rejectUnauthorized: false };

/**
 * Downloads the .gcode.3mf for the active print via FTPS and extracts only
 * Metadata/slice_info.config (~2-3 KB). The rest of the archive is discarded
 * immediately after extraction.
 *
 * BambuLab printers run vsftpd with implicit TLS on port 990, login bblp /
 * <access code>. The actual sliced files live in /cache/<job>.gcode.3mf — the
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
            secureOptions: BAMBU_TLS,
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

        return parseSliceInfo(entry.getData().toString("utf8"));
    } finally {
        client.close();
    }
}

/**
 * Normalises a color to a bare 6-digit uppercase hex (no "#", no alpha) so
 * slice colors ("#000000") and AMS slot colors ("000000FF") compare equal.
 */
export function normColor(c) {
    if (!c) return "";
    return String(c).replace(/^#/, "").slice(0, 6).toUpperCase();
}

/**
 * Identity of a filament for consumption matching: tray_info_idx alone is the
 * material profile (e.g. "GFA00" = PLA Basic) and does NOT distinguish colors,
 * so we combine it with the normalised color. This separates e.g. PLA Black
 * from PLA Jade White even though both share tray_info_idx.
 */
export function consumptionKey(trayInfoIdx, color) {
    return `${trayInfoIdx || "?"}|${normColor(color)}`;
}

/**
 * Calculates consumed grams per (tray_info_idx + color) for a complete print.
 * Purge is already included in used_g from the slicer.
 *
 * @param {object} sliceInfo - result of fetchSliceInfo
 * @returns {{ [key]: { tray_info_idx, color, type, grams } }}
 */
export function calcFullConsumption(sliceInfo) {
    const result = {};
    for (const f of sliceInfo.filaments) {
        if (!f.tray_info_idx) continue;
        const key = consumptionKey(f.tray_info_idx, f.color);
        if (!result[key]) result[key] = { tray_info_idx: f.tray_info_idx, color: f.color, type: f.type, grams: 0 };
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
 * Purge is scaled proportionally as part of used_g — not perfectly accurate
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

        const key = consumptionKey(f.tray_info_idx, f.color);
        if (!result[key]) result[key] = { tray_info_idx: f.tray_info_idx, color: f.color, type: f.type, grams: 0 };
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
 *   /data/Metadata/plate_1.gcode  (internal path — strip to base name)
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

// Exported for tests; fetchSliceInfo is the normal entry point.
export function parseSliceInfo(xml) {
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

function parseAttrs(str) {
    const result = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) result[m[1]] = m[2];
    return result;
}

function parseLayerRanges(str) {
    // "0 127" → [[0,127]];  "0 50,60 127" → [[0,50],[60,127]]
    return str.split(",")
        .map(pair => pair.trim().split(/\s+/).map(Number))
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
        .map(([s, e]) => [s, e]);
}

function roundEntries(result) {
    for (const k of Object.keys(result)) {
        result[k].grams = Math.round(result[k].grams * 100) / 100;
    }
    return result;
}
