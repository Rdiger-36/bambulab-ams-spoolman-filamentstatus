import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

config();

const __filename = fileURLToPath(import.meta.url);
export const __rootDir = path.dirname(path.dirname(__filename));

export const serverLogFilePath = path.join(__rootDir, "logs", "server.log");
export const configPath = path.resolve(__rootDir, "printers", "printers.json");
// Manual AMS slot -> Spoolman spool assignments, written by the service itself.
// Kept separate from printers.json, which is user-maintained and read-only here.
export const mappingsPath = path.resolve(__rootDir, "printers", "mappings.json");

export const version = "1.3.0-dev";
export const PORT = 4000;

export const PRINTER_ID = process.env.PRINTER_ID;
export const PRINTER_CODE = process.env.PRINTER_CODE;
export const PRINTER_IP = process.env.PRINTER_IP;
export const SPOOLMAN_ENDPOINT = process.env.SPOOLMAN_ENDPOINT || null;
export const SPOOLMAN_IP = process.env.SPOOLMAN_IP;
export const SPOOLMAN_PORT = process.env.SPOOLMAN_PORT;
export const SPOOLMAN_SUBFOLDER = process.env.SPOOLMAN_SUBFOLDER || null;
export const SPOOLMAN_FQDN = process.env.SPOOLMAN_FQDN || null;
export const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL
    ? Math.min(Math.max(parseInt(process.env.UPDATE_INTERVAL, 10), 5000), 300000)
    : 120000;
export const OFFLINE_CHECK_INTERVAL = process.env.OFFLINE_CHECK_INTERVAL
    ? Math.min(Math.max(parseInt(process.env.OFFLINE_CHECK_INTERVAL, 10), 20000), 3600000)
    : 20000;
export const MAX_RETRIES = process.env.MAX_RETRIES
    ? Math.max(parseInt(process.env.MAX_RETRIES, 10), 0)
    : 0;
export const NEVER_MERGE_IF_TAG = (process.env.NEVER_MERGE_IF_TAG || "false") === "true";
export const SET_LOCATION = (process.env.SET_LOCATION || "false") === "true";
// Legacy mode: update spool weight from the AMS RFID remain percentage via MQTT.
// Default (false) tracks consumption from the sliced G-code instead, which also
// works for 3rd-party spools without an RFID chip.
export const LEGACY_MODE = (process.env.LEGACY_MODE || "false") === "true";
export const DEBUG = process.env.DEBUG || "false";
/**
 * Normalises the MODE environment variable.
 *
 * "auto" is accepted as a shorthand for "automatic"; anything unrecognised
 * falls back to manual. `valid` is reported separately so startup can warn
 * about a typo instead of silently behaving like manual mode.
 *
 * @param {string|undefined} raw - the raw MODE value
 * @returns {{raw: string, mode: "automatic"|"manual", valid: boolean}}
 */
export function resolveMode(raw) {
    const value = (raw || "manual").trim();
    const normalized = value.toLowerCase();
    return {
        raw: value,
        mode: normalized === "automatic" || normalized === "auto" ? "automatic" : "manual",
        valid: ["automatic", "auto", "manual"].includes(normalized),
    };
}

const resolvedMode = resolveMode(process.env.MODE);
export const MODE = resolvedMode.mode;
export const MODE_RAW = resolvedMode.raw;
export const MODE_IS_VALID = resolvedMode.valid;
export const RECONNECT_INTERVAL = 60000;

const baseURL = SPOOLMAN_ENDPOINT || `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}`;
export const SPOOLMAN_URL = SPOOLMAN_SUBFOLDER ? `${baseURL}${SPOOLMAN_SUBFOLDER}` : baseURL;
