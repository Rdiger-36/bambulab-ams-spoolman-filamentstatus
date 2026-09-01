import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

config();

const __filename = fileURLToPath(import.meta.url);
export const __rootDir = path.dirname(path.dirname(__filename));

// Where the persistent files and the logs live. The container mounts both, so
// they are overridable separately. Tests point them at a temporary directory,
// which is the only way to exercise the write paths without touching a real
// installation.
export const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__rootDir, "printers");
export const logsDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(__rootDir, "logs");

export const serverLogFilePath = path.join(logsDir, "server.log");
export const configPath = path.join(dataDir, "printers.json");
// Manual AMS slot -> Spoolman spool assignments, written by the service itself.
export const mappingsPath = path.join(dataDir, "mappings.json");
// Runtime configuration edited through the Web UI, see settings.js.
export const settingsPath = path.join(dataDir, "settings.json");

// Set by the supervisor in entrypoint.js. Tells the Web UI whether a restart
// brings the service back on its own or depends on the container policy.
export const supervised = process.env.SUPERVISED === "1";

export const version = "1.3.0-dev.3";
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
    LOG_MAX_SIZE_MB: process.env.LOG_MAX_SIZE_MB,
    LOG_KEEP_SERVER: process.env.LOG_KEEP_SERVER,
    LOG_KEEP_PRINTER: process.env.LOG_KEEP_PRINTER,
};

// Single printer fallback, used by the Home Assistant add-on and the simplest
// Docker setups. Seeds printers.json when no printer is configured yet.
export const envPrinterSeed = {
    id: process.env.PRINTER_ID,
    code: process.env.PRINTER_CODE,
    ip: process.env.PRINTER_IP,
};
