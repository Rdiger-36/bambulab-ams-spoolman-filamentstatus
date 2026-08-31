import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

config();

const __filename = fileURLToPath(import.meta.url);
export const __rootDir = path.dirname(path.dirname(__filename));

export const serverLogFilePath = path.join(__rootDir, "logs", "server.log");
export const configPath = path.resolve(__rootDir, "printers", "printers.json");
// Manual AMS slot -> Spoolman spool assignments, written by the service itself.
export const mappingsPath = path.resolve(__rootDir, "printers", "mappings.json");
// Runtime configuration edited through the Web UI, see settings.js.
export const settingsPath = path.resolve(__rootDir, "printers", "settings.json");

export const version = "1.3.0-dev";
export const PORT = 4000;
export const RECONNECT_INTERVAL = 60000;

// Raw environment values. They seed settings.json and printers.json on the
// first run only; afterwards those files own the values. This is the only
// module that reads process.env, everything else reads settings.js.
export const envSeed = {
    SPOOLMAN_ENDPOINT: process.env.SPOOLMAN_ENDPOINT,
    SPOOLMAN_IP: process.env.SPOOLMAN_IP,
    SPOOLMAN_PORT: process.env.SPOOLMAN_PORT,
    SPOOLMAN_SUBFOLDER: process.env.SPOOLMAN_SUBFOLDER,
    SPOOLMAN_FQDN: process.env.SPOOLMAN_FQDN,
    MODE: process.env.MODE,
    LEGACY_MODE: process.env.LEGACY_MODE,
    UPDATE_INTERVAL: process.env.UPDATE_INTERVAL,
    OFFLINE_CHECK_INTERVAL: process.env.OFFLINE_CHECK_INTERVAL,
    MAX_RETRIES: process.env.MAX_RETRIES,
    NEVER_MERGE_IF_TAG: process.env.NEVER_MERGE_IF_TAG,
    SET_LOCATION: process.env.SET_LOCATION,
    DEBUG: process.env.DEBUG,
};

// Single printer fallback, used by the Home Assistant add-on and the simplest
// Docker setups. Seeds printers.json when no printer is configured yet.
export const envPrinterSeed = {
    id: process.env.PRINTER_ID,
    code: process.env.PRINTER_CODE,
    ip: process.env.PRINTER_IP,
};
