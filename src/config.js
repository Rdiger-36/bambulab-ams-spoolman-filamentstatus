import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

config();

const __filename = fileURLToPath(import.meta.url);
export const __rootDir = path.dirname(path.dirname(__filename));

export const serverLogFilePath = path.join(__rootDir, "logs", "server.log");
export const configPath = path.resolve(__rootDir, "printers", "printers.json");

export const version = "1.2.1";
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
export const DEBUG = process.env.DEBUG || "false";
export const MODE = process.env.MODE || "manual";
export const RECONNECT_INTERVAL = 60000;

const baseURL = SPOOLMAN_ENDPOINT || `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}`;
export const SPOOLMAN_URL = SPOOLMAN_SUBFOLDER ? `${baseURL}${SPOOLMAN_SUBFOLDER}` : baseURL;
