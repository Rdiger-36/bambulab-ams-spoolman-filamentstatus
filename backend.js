import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";

import "./src/logger.js"; // must be first — sets up console overrides
import { PORT, serverLogFilePath, __rootDir, version, SPOOLMAN_URL } from "./src/config.js";
import { printers } from "./src/printers.js";
import { checkAndSetVendor, checkAndSetExtraField } from "./src/spoolman.js";
import { monitorSpoolman, monitorSpoolmanBackground, monitorPrinters } from "./src/mqtt.js";
import { registerRoutes } from "./src/routes.js";
import { formatDateLog } from "./src/utils.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public", { maxAge: 0 }));

app.get("/", (req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
});

registerRoutes(app, printers);

async function starting() {
    console.log("Server", serverLogFilePath, "Starting service...");

    await monitorSpoolman();

    if (!printers) {
        console.error("Server", serverLogFilePath, "Error: no printers found in printers.json!");
        return;
    }

    if (!(await checkAndSetVendor()) || !(await checkAndSetExtraField())) {
        console.error("Server", serverLogFilePath, "Error: Vendor or Extra Field 'tag' could not be set!");
        return;
    }

    console.log("Server", serverLogFilePath, `Backend running on http://localhost:${PORT}`);

    for (const printer of printers) {
        printer.logFilePath = path.join(__rootDir, "logs", `${printer.id}.log`);

        if (!fs.existsSync(printer.logFilePath)) {
            fs.writeFile(printer.logFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
                if (err) {
                    console.error(printer.name, printer.logFilePath, `Failed to create log file: ${err.message}`);
                } else {
                    console.log(printer.name, printer.logFilePath, "Log file created");
                }
            });
        }
    }

    monitorPrinters(printers);
    monitorSpoolmanBackground();
}

app.listen(PORT, "0.0.0.0", () => {
    console.log("Server", serverLogFilePath, `Version: ${version}`);
    console.log("Server", serverLogFilePath, "Setting up configuration...");

    // Create server log file
    fs.writeFile(serverLogFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
        if (err) {
            process.stderr.write(`Failed to create log file: ${err.message}\n`);
        }
    });

    starting();
});
