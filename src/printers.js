import fs from "fs-extra";
import path from "path";
import "./logger.js"; // ensure console overrides are active
import {
    configPath,
    serverLogFilePath,
    PRINTER_ID,
    PRINTER_CODE,
    PRINTER_IP,
    UPDATE_INTERVAL,
} from "./config.js";
import { formatDateLog } from "./utils.js";

export function loadPrintersConfig() {
    const date = new Date();

    try {
        const configData = fs.readFileSync(configPath, "utf-8");
        const printers = JSON.parse(configData);

        printers.forEach(printer => {
            if (!printer.id || !printer.code || !printer.ip || !printer.name) {
                throw new Error(`Invalid printer configuration: ${JSON.stringify(printer)}`);
            }
        });

        console.debug("Server", serverLogFilePath, "Printers loaded successfully:", printers);

        return printers.map(printer => ({
            ...printer,
            mqttStatus: "Disconnected",
            spoolmanStatus: "Disconnected",
            mqttRunning: false,
            update_interval: UPDATE_INTERVAL,
            lastUpdateTime: date,
            first_run: true,
            monitoringEnabled: true,
        }));
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error loading printers configuration:", error.message);
        console.error("Server", serverLogFilePath, "Try to get single printer from ENV...");

        if (PRINTER_ID && PRINTER_CODE && PRINTER_IP) {
            return [{
                name: "Bambu Lab Printer",
                id: PRINTER_ID.toUpperCase(),
                code: PRINTER_CODE,
                ip: PRINTER_IP,
                mqttStatus: "Disconnected",
                spoolmanStatus: "Disconnected",
                mqttRunning: false,
                update_interval: UPDATE_INTERVAL,
                lastUpdateTime: date,
                first_run: true,
                monitoringEnabled: true,
            }];
        } else {
            console.error("Server", serverLogFilePath, "No valid printers found!");
            console.error("Server", serverLogFilePath, "Please check your printers.json or your ENVs!");
        }
    }
}

export const printers = loadPrintersConfig();
