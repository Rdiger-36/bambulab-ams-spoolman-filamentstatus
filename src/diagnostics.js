import AdmZip from "adm-zip";
import fs from "fs-extra";
import os from "os";
import path from "path";

import { version, dataDir, logsDir, serverLogFilePath, mappingsPath, supervised } from "./config.js";
import { deprecatedConfig } from "./deprecation.js";
import { logFileSet } from "./logger.js";
import { printers } from "./printers.js";
import { getSettingsView, legacyMode } from "./settings.js";
import { state } from "./state.js";
import {
    exportPrinters,
    exportSettings,
    maskCodes,
    maskPath,
    maskSerial,
    maskText,
} from "./anonymize.js";

/**
 * The support bundle and the system facts behind it.
 *
 * Every bug report starts with the same four questions: which version, which
 * platform, what does the configuration look like and what do the logs say. The
 * bundle answers all of them in one download, and the anonymised variant does it
 * without publishing the user's network. See `anonymize.js` for what "anonymised"
 * covers and what it deliberately leaves alone.
 */

/**
 * The facts the Service card shows and the bundle carries.
 *
 * @param {boolean} [anonymize] - shorten the data and log paths
 * @returns {object} version, runtime, platform and the state of the service
 */
export function systemInfo(anonymize = false) {
    const view = getSettingsView();
    const notice = deprecatedConfig();

    return {
        version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        os: `${os.type()} ${os.release()}`,
        // Seconds, formatted by whoever displays it
        uptime: Math.round(process.uptime()),
        supervised,
        // What the process is actually doing, which is not always what the
        // stored setting says: legacy mode is frozen at startup
        tracking: legacyMode() ? "legacy (AMS RFID remain %)" : "G-code",
        mode: view.values.MODE,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        printers: printers.length,
        spoolman: state.spoolmanStatus,
        dataDir: anonymize ? maskPath(dataDir) : dataDir,
        logsDir: anonymize ? maskPath(logsDir) : logsDir,
        // Says whether this installation is still driven by the environment,
        // which explains a surprising number of "my change did nothing" reports
        environmentConfigured: notice.active,
        environmentVariables: notice.variables,
    };
}

/** Reads a JSON file, returning null rather than throwing when it is not there. */
function readJsonOrNull(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Everything the masking needs to know about this installation.
 *
 * Exported because the plain log download masks with exactly the same set; the
 * two downloads must not disagree about what counts as identifying.
 *
 * @returns {{codes: string[], serials: string[], hosts: string[]}}
 */
export function knownValues() {
    const view = getSettingsView();
    return {
        codes: printers.map(printer => printer.code),
        serials: printers.map(printer => printer.id),
        hosts: [view.values.SPOOLMAN_ENDPOINT, view.values.SPOOLMAN_FQDN, view.values.SPOOLMAN_IP]
            .filter(Boolean)
            .map(value => {
                try {
                    return new URL(value).hostname;
                } catch {
                    return value;
                }
            }),
    };
}

/**
 * Builds the support bundle.
 *
 * The whole archive is built in memory, the same way the log download already
 * is: its size is bounded by the log settings, and log text compresses well.
 *
 * @param {object} [options]
 * @param {boolean} [options.anonymize] - mask addresses, serials and paths
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function buildDiagnosticsBundle({ anonymize = true } = {}) {
    const zip = new AdmZip();
    const known = knownValues();
    // Even the full bundle loses the access codes. The service does not write
    // them to a log on purpose, and "on purpose" is not a guarantee worth
    // handing out.
    const mask = text => (anonymize ? maskText(text, known) : maskCodes(text, known.codes));

    const info = {
        generated: new Date().toISOString(),
        anonymized: anonymize,
        ...systemInfo(anonymize),
    };
    zip.addFile("info.json", Buffer.from(JSON.stringify(info, null, 4)));

    const view = getSettingsView();
    zip.addFile("settings.json", Buffer.from(JSON.stringify({
        values: exportSettings(view.values, anonymize),
        // Which of them the environment still decides, the single most useful
        // thing to know about a configuration that behaves unexpectedly
        sources: view.sources,
        revision: view.revision,
    }, null, 4)));

    zip.addFile("printers.json", Buffer.from(JSON.stringify(
        exportPrinters(printers.map(({ id, ip, name, code }) => ({ id, ip, name, code })), anonymize),
        null,
        4,
    )));

    const mappings = readJsonOrNull(mappingsPath);
    if (mappings) {
        // Keyed by serial number, so the keys need masking as well
        const exported = anonymize
            ? Object.fromEntries(Object.entries(mappings).map(([serial, value]) => [maskSerial(serial), value]))
            : mappings;
        zip.addFile("mappings.json", Buffer.from(JSON.stringify(exported, null, 4)));
    }

    await addLogFiles(zip, "logs/server", serverLogFilePath, mask);

    for (const printer of printers) {
        const base = `logs/${anonymize ? maskSerial(printer.id) : printer.id}`;
        await addLogFiles(zip, base, printer.logFilePath, mask);
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
    return {
        buffer: zip.toBuffer(),
        filename: `ams-diagnostics_${stamp}${anonymize ? "" : "_full"}.zip`,
    };
}

/**
 * Adds a log file and its rotated history to the archive, oldest last.
 *
 * The numbering matches the download of a single log: the current file first,
 * `.rotated.1` behind it, so a listing that sorts by name keeps the order.
 *
 * @param {AdmZip} zip - the archive
 * @param {string} base - path and base name inside the archive
 * @param {string} filePath - the current log file
 * @param {function(string): string} mask - applied to the contents
 */
async function addLogFiles(zip, base, filePath, mask) {
    const files = await logFileSet(filePath);

    files.forEach((file, index) => {
        const suffix = index === 0 ? "current" : `rotated.${index}`;
        try {
            zip.addFile(`${base}.${suffix}.log`, Buffer.from(mask(fs.readFileSync(file, "utf-8"))));
        } catch {
            // A file that rotated away between the listing and the read is
            // normal and not worth failing the whole bundle for
        }
    });
}
