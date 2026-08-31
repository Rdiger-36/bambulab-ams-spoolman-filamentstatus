import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";

import "./src/logger.js"; // must be first, sets up console overrides
import { PORT, serverLogFilePath, version } from "./src/config.js";
import { printers } from "./src/printers.js";
import { registerRoutes } from "./src/routes.js";
import { startService } from "./src/service.js";
import { formatDateLog } from "./src/utils.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public", { maxAge: 0 }));

app.get("/", (req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
});

registerRoutes(app, printers);

app.listen(PORT, "0.0.0.0", () => {
    console.log("Server", serverLogFilePath, `Version: ${version}`);
    console.log("Server", serverLogFilePath, "Setting up configuration...");

    // Create server log file
    fs.writeFile(serverLogFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
        if (err) {
            process.stderr.write(`Failed to create log file: ${err.message}\n`);
        }
    });

    console.log("Server", serverLogFilePath, `Backend running on http://localhost:${PORT}`);

    startService();
});
