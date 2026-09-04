import fs from "fs-extra";
import path from "path";
import { rotateLogFile } from "./logger.js"; // importing it also activates the console overrides
import { configPath, serverLogFilePath, envPrinterSeed, logsDir } from "./config.js";
import { settings } from "./settings.js";
import { formatDateLog } from "./utils.js";

/** The fields of a printer that live in printers.json. Everything else is runtime state. */
const PERSISTED_FIELDS = ["id", "code", "ip", "name"];

// Whether this start built the printer list from PRINTER_ID, PRINTER_CODE and
// PRINTER_IP. Read by the deprecation notice, which has to tell "the variables
// are seeding the list right now" apart from "they are set but printers.json
// already owns the list" — and cannot do that by looking at the file, because
// the seed is written to it during this very import.
let seededFromEnvironment = false;

/**
 * Builds the mutable runtime object every other module works with from a
 * printers.json entry.
 *
 * Everything beyond the user's four fields is runtime state: connection status,
 * the update interval bookkeeping, and the print consumption tracking that
 * `handlePrintStateChange` in `mqtt.js` advances.
 *
 * @param {object} entry - the stored printer entry
 * @returns {object} the runtime printer object
 */
function createRuntimePrinter(entry) {
    return {
        id: entry.id,
        code: entry.code,
        ip: entry.ip,
        name: entry.name,
        logFilePath: path.join(logsDir, `${entry.id}.log`),
        mqttStatus: "Disconnected",
        spoolmanStatus: "Disconnected",
        mqttRunning: false,
        update_interval: settings.UPDATE_INTERVAL,
        lastUpdateTime: new Date(),
        first_run: true,
        monitoringEnabled: true,
        // The growing wait between two reachability checks of a printer that
        // does not answer. See monitorPrinters() in mqtt.js.
        offlineChecks: 0,
        nextCheckAt: 0,
        offlineWaitLogged: null,
        // print consumption tracking
        currentGcodeState: "IDLE",
        currentJobName: null,
        currentSliceInfo: null,
        // The slots the printer says the running print is taking its filaments
        // from, decoded from print.mapping. Null until a print reports them.
        currentMapping: null,
        currentLayerNum: 0,
        consumptionBooked: false,
        sliceFetchDone: false,
        // When the running print became active, in epoch milliseconds. Measured
        // here because the printer reports no start time of its own: a P2S
        // carries neither `gcode_start_time` nor anything like it in its 98
        // report fields. A restart mid print therefore loses it, and the
        // summary says the duration is unknown rather than inventing one.
        printStartedAt: null,
        // The closing report of the last finished print: what was booked, what
        // was skipped and why. Held in memory only, dropped when the next print
        // starts, and never written anywhere.
        lastPrintSummary: null,
        // Whether the result of the last print has been cleared from the
        // dashboard, by the timer below or by hand. It cannot be derived from
        // the state: the printer keeps repeating its terminal `gcode_state` in
        // every report for as long as it sits there, so without this flag the
        // next report would put the finished print straight back on the card.
        printResultDismissed: false,
        // When the result clears itself, in epoch milliseconds. Null when no
        // timer is running, which is the case before the first print and when
        // PRINT_RESET_MINUTES is 0.
        printResetAt: null,
        // Humidity, temperature and drying state per AMS unit, for the header
        // of each unit's table. Display only: it never reaches Spoolman, and it
        // is refreshed on every report rather than on the slot update interval.
        amsEnv: [],
        // How many AMS updates a slot has been waiting for its remain reading,
        // keyed by slot label. See waitedLongEnoughForRemain() in mqtt.js.
        remainWaits: {},
    };
}

/**
 * Checks one printer entry.
 *
 * @param {object} entry - the entry to check
 * @param {object[]} existing - the printers already known, for the duplicate check
 * @param {string|null} ignoreId - id of the entry being edited, excluded from that check
 * @returns {string|null} an error message, or null when the entry is usable
 */
export function validatePrinterEntry(entry, existing = [], ignoreId = null) {
    if (!entry || typeof entry !== "object") return "Printer must be an object";

    for (const field of PERSISTED_FIELDS) {
        const value = entry[field];
        if (typeof value !== "string" || value.trim() === "") {
            return `Printer field "${field}" is required`;
        }
    }

    const id = entry.id.trim().toUpperCase();
    if (existing.some(p => p.id === id && p.id !== ignoreId)) {
        return `A printer with the serial number ${id} already exists`;
    }

    return null;
}

/** A printer entry without its access code, for log output. */
function redactPrinter({ code, ...rest }) {
    return rest;
}

/** Normalises an entry to the shape stored in printers.json. */
export function normalizePrinterEntry(entry) {
    return {
        id: entry.id.trim().toUpperCase(),
        code: entry.code.trim(),
        ip: entry.ip.trim(),
        name: entry.name.trim(),
    };
}

/**
 * Reads `printers/printers.json`.
 *
 * A single invalid entry rejects the whole file, because a partially loaded
 * printer list is harder to diagnose than none at all. On any failure the
 * PRINTER_ID, PRINTER_CODE and PRINTER_IP environment variables are tried as a
 * single printer seed, which is how the Home Assistant add-on and the simplest
 * Docker setups are configured. That seed is written to printers.json, so the
 * file owns the printer list from then on and the Web UI can edit it.
 *
 * An empty list is a valid result. The service starts anyway so that printers
 * can be added in the Web UI.
 *
 * @returns {object[]} the runtime printer list, possibly empty
 */
export function loadPrintersConfig() {
    let entries = null;

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (!Array.isArray(parsed)) throw new Error("printers.json must contain an array");

        parsed.forEach(printer => {
            const error = validatePrinterEntry(printer, []);
            if (error) throw new Error(`Invalid printer configuration: ${JSON.stringify(printer)} (${error})`);
        });

        entries = parsed.map(normalizePrinterEntry);
        // Never log the access code. The log files are downloadable from the Web
        // UI and end up attached to bug reports.
        console.debug("Server", serverLogFilePath, "Printers loaded successfully:", entries.map(redactPrinter));
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Server", serverLogFilePath, "Error loading printers configuration:", error.message);
        }

        if (envPrinterSeed.id && envPrinterSeed.code && envPrinterSeed.ip) {
            console.log("Server", serverLogFilePath, "Seeding the printer list from the PRINTER_ID, PRINTER_CODE and PRINTER_IP variables...");
            seededFromEnvironment = true;
            entries = [normalizePrinterEntry({
                id: envPrinterSeed.id,
                code: envPrinterSeed.code,
                ip: envPrinterSeed.ip,
                name: "Bambu Lab Printer",
            })];
        } else {
            console.debug("Server", serverLogFilePath, "No printers.json and no printer environment variables, starting with an empty list.");
            entries = [];
        }
    }

    const runtime = entries.map(createRuntimePrinter);

    // Persist the seeded list so that printers.json is the source of truth from
    // the first start on, which is what makes the Web UI able to edit it.
    if (entries.length && !fs.existsSync(configPath)) {
        savePrinters(runtime);
    }

    return runtime;
}

/** Whether the printer list of this run came from the PRINTER_* variables. */
export function printerListSeededFromEnv() {
    return seededFromEnvironment;
}

/**
 * Writes the printer list back to `printers/printers.json` atomically, so a
 * crash mid write cannot truncate it. Only the persisted fields are written;
 * runtime state never reaches the file.
 *
 * @param {object[]} list - the runtime printer list to persist
 */
export function savePrinters(list = printers) {
    const entries = list.map(printer => ({
        id: printer.id,
        code: printer.code,
        ip: printer.ip,
        name: printer.name,
    }));

    const tmp = `${configPath}.tmp`;
    fs.ensureDirSync(path.dirname(configPath));
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 4));
    fs.renameSync(tmp, configPath);
}

/**
 * Creates the log file of a printer, or rotates it when it has grown too large.
 *
 * Nothing ever truncated these files: they were created once and appended to
 * from then on. Called on every start, and the append path checks the size
 * while the service runs.
 *
 * @param {object} printer - the runtime printer object
 */
export function ensurePrinterLogFile(printer) {
    if (fs.existsSync(printer.logFilePath)) {
        rotateLogFile(printer.logFilePath);
        return;
    }

    fs.writeFile(printer.logFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
        if (err) {
            console.error(printer.name, printer.logFilePath, `Failed to create log file: ${err.message}`);
        } else {
            console.log(printer.name, printer.logFilePath, "Log file created");
        }
    });
}

/**
 * Adds a printer and persists the list.
 *
 * @param {object} entry - id, code, ip and name
 * @returns {{ok: true, printer: object}|{ok: false, error: string}}
 */
export function addPrinter(entry) {
    const error = validatePrinterEntry(entry, printers);
    if (error) return { ok: false, error };

    const printer = createRuntimePrinter(normalizePrinterEntry(entry));
    printers.push(printer);
    savePrinters();
    ensurePrinterLogFile(printer);

    return { ok: true, printer };
}

/**
 * Updates name, address or access code of a printer and persists the list.
 *
 * The serial number is immutable: it keys the MQTT topic, the log file and the
 * spool assignments, so changing it would describe a different printer. Pass an
 * empty access code to keep the stored one, which is what the Web UI sends
 * because it never displays the code it already has.
 *
 * @param {string} printerId - serial number of the printer to change
 * @param {object} patch - name, ip and code
 * @returns {{ok: true, printer: object, reconnect: boolean}|{ok: false, error: string}}
 */
export function updatePrinter(printerId, patch) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return { ok: false, error: "Printer not found" };

    const merged = {
        id: printer.id,
        name: patch?.name ?? printer.name,
        ip: patch?.ip ?? printer.ip,
        code: patch?.code?.trim() ? patch.code : printer.code,
    };

    const error = validatePrinterEntry(merged, printers, printer.id);
    if (error) return { ok: false, error };

    const normalized = normalizePrinterEntry(merged);
    // Only an address or credential change needs the MQTT connection rebuilt.
    const reconnect = normalized.ip !== printer.ip || normalized.code !== printer.code;

    printer.name = normalized.name;
    printer.ip = normalized.ip;
    printer.code = normalized.code;
    savePrinters();

    return { ok: true, printer, reconnect };
}

/**
 * Removes a printer from the list and persists it. The log file is kept.
 *
 * @param {string} printerId - serial number of the printer to remove
 * @returns {{ok: true, printer: object}|{ok: false, error: string}}
 */
export function removePrinter(printerId) {
    const index = printers.findIndex(p => p.id === printerId);
    if (index === -1) return { ok: false, error: "Printer not found" };

    const [printer] = printers.splice(index, 1);
    savePrinters();

    return { ok: true, printer };
}

/**
 * Applies a changed slot update interval to every printer.
 *
 * The interval is copied onto the printer object when it is created, so a
 * settings change has to be pushed into the existing objects as well.
 */
export function syncPrinterIntervals() {
    for (const printer of printers) {
        printer.update_interval = settings.UPDATE_INTERVAL;
    }
}

export const printers = loadPrintersConfig();
