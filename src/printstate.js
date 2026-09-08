import { printStatePath } from "./config.js";
import { readJsonFile, writeJsonFile } from "./jsonfile.js";

/**
 * When the print each printer is running started, kept on disk.
 *
 * No Bambu printer reports when its job began: the P2S, the P1S and the X1E
 * all send the state, the layer and the remaining minutes and nothing else
 * about time, so the service measures the start itself when it sees the state
 * go active. That measurement lived in memory only, and a restart of the
 * service during a print started the clock again: "Running for" on the
 * dashboard and the duration in the report were counted from the restart, not
 * from the print. Seen on a P2S on 2026-09-08 with a restart at layer 3.
 *
 * So the start is written here when a print begins and read back when the
 * service starts up and finds the printer already printing the same job. It is
 * forgotten when the print ends, so a later print of the same name starts its
 * own clock; a stored start older than a week is not trusted either, in case
 * the end was never seen.
 */

const SCHEMA_VERSION = 1;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let state = null;

function load() {
    if (state) return state;
    const parsed = readJsonFile(printStatePath);
    state = parsed && typeof parsed.printers === "object" && parsed.printers !== null ? parsed.printers : {};
    return state;
}

function persist() {
    writeJsonFile(printStatePath, { schemaVersion: SCHEMA_VERSION, printers: state });
}

/**
 * Records that a printer's job began.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` of the job
 * @param {number} startedAt - epoch milliseconds
 */
export function rememberPrintStart(printerId, jobName, startedAt) {
    load()[printerId] = { jobName: jobName ?? null, startedAt };
    persist();
}

/**
 * The start recorded for a printer's job, if it is the same job and recent.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` the printer reports now
 * @returns {number|null} epoch milliseconds, or null when nothing fits
 */
export function recallPrintStart(printerId, jobName) {
    const entry = load()[printerId];
    if (!entry || typeof entry.startedAt !== "number") return null;
    if ((entry.jobName ?? null) !== (jobName ?? null)) return null;
    if (Date.now() - entry.startedAt > STALE_AFTER_MS || entry.startedAt > Date.now()) return null;
    return entry.startedAt;
}

/**
 * Drops the recorded start once the job has ended.
 *
 * @param {string} printerId - the printer's serial
 */
export function forgetPrintStart(printerId) {
    const table = load();
    if (!(printerId in table)) return;
    delete table[printerId];
    persist();
}

/** Test hook: forgets the loaded table so the next call reads the file again. */
export function resetPrintStateForTests() {
    state = null;
}
