import fs from "fs-extra";
import path from "path";
import { serverLogFilePath } from "./config.js";

/**
 * The two things every small JSON file under `printers/` needs, in one place.
 *
 * Four modules kept a copy each of the same dozen lines: read the file, treat a
 * missing one as empty and any other failure as worth a log line, and write it
 * back through a temporary file and a rename so a crash mid write cannot leave
 * a truncated file behind. The assignments, the learned presets, the print
 * starts and the API keys all go through here now.
 */

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath - the file
 * @param {string} label - how the file is named in the log, "presets.json"
 * @returns {any|null} the parsed content, null when the file is missing or unreadable
 */
export function readJsonFile(filePath, label = path.basename(filePath)) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.error("Server", serverLogFilePath, `Could not read ${label}, starting empty: ${err.message}`);
        }
        return null;
    }
}

/**
 * Writes a JSON file atomically, through a temporary file and a rename.
 *
 * @param {string} filePath - the file
 * @param {any} payload - what to write
 * @param {object} [options]
 * @param {number} [options.indent] - JSON indentation, 2 by default
 * @param {boolean} [options.throwOnError] - rethrow instead of logging, for a caller that answers a request
 * @param {string} [options.label] - how the file is named in the log
 * @returns {boolean} whether the write happened
 */
export function writeJsonFile(filePath, payload, { indent = 2, throwOnError = false, label = path.basename(filePath) } = {}) {
    const tmp = `${filePath}.tmp`;
    try {
        fs.outputFileSync(tmp, JSON.stringify(payload, null, indent));
        fs.renameSync(tmp, filePath);
        return true;
    } catch (err) {
        try { fs.removeSync(tmp); } catch {}
        if (throwOnError) throw err;
        console.error("Server", serverLogFilePath, `Failed to save ${label}:`, err.message);
        return false;
    }
}
