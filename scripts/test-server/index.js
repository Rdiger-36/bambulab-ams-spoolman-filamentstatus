import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMockSpoolman } from "./mock-spoolman.js";
import { startMockPrinter } from "./mock-printer.js";
import { AMS_UNITS } from "./scenario.js";

/**
 * A whole environment for this service in one process: a mock printer, a mock
 * Spoolman, and the service itself pointed at both.
 *
 * It exists for the parts that cannot be reached from a unit test and that
 * nobody has the hardware for. Multi colour filaments are the case it was
 * written for: the AMS reports every colour of a spool in `cols` and only the
 * first of them in `tray_color`, and there is no way to see whether that
 * survives to the browser without a printer holding one. The scenario fills all
 * 24 addressable AMS slots from the three Bambu Lab hex code tables.
 *
 * Nothing here is part of the running service. It writes to a temporary
 * directory, never to `printers/`, and starting it twice starts from the same
 * state both times.
 *
 * Usage:
 *   node scripts/test-server/index.js [--spoolman-port 7912] [--printer-port 8883]
 *                                     [--interval 3000] [--no-service]
 *
 * Then open http://localhost:4000. `--no-service` runs only the two mocks, for
 * pointing an already running container at them.
 *
 * This file runs outside the service, so `src/logger.js` and its three argument
 * console signature are not in play here. The plain console is correct.
 */

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const PRINTER_SERIAL = "01P00A000000000";
const PRINTER_CODE = "00000000";

/** Reads `--name value` pairs and `--flag` switches off the command line. */
function readOptions(argv) {
    const options = {
        spoolmanPort: 7912,
        printerPort: 8883,
        interval: 3000,
        service: true,
    };

    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        switch (argv[i]) {
            case "--spoolman-port": options.spoolmanPort = Number(value); i++; break;
            case "--printer-port": options.printerPort = Number(value); i++; break;
            case "--interval": options.interval = Number(value); i++; break;
            case "--no-service": options.service = false; break;
            default:
                console.error(`Unknown option: ${argv[i]}`);
                process.exit(2);
        }
    }

    return options;
}

/** Prefixes every line of a mock so two of them can share one terminal. */
const prefixed = name => line => console.log(`[${name}] ${line}`);

/** Counts what the scenario holds, so a run says what it is showing. */
function describeScenario() {
    const trays = AMS_UNITS.flatMap(ams => ams.tray);
    const loaded = trays.filter(tray => Array.isArray(tray.cols));

    return {
        units: AMS_UNITS.length,
        slots: trays.length,
        multiColour: loaded.filter(tray => tray.cols.length > 1).length,
        singleColour: loaded.filter(tray => tray.cols.length === 1).length,
        other: trays.length - loaded.length,
    };
}

async function main() {
    const options = readOptions(process.argv.slice(2));

    const { app, store } = createMockSpoolman(prefixed("spoolman"));
    const spoolman = http.createServer(app);
    await new Promise((resolve, reject) => {
        spoolman.once("error", reject);
        spoolman.listen(options.spoolmanPort, () => {
            console.log(`[spoolman] listening on ${options.spoolmanPort}`);
            resolve();
        });
    });

    const printer = await startMockPrinter({
        serial: PRINTER_SERIAL,
        port: options.printerPort,
        interval: options.interval,
        log: prefixed("printer"),
    });

    const scenario = describeScenario();
    console.log(`[scenario] ${scenario.units} AMS units, ${scenario.slots} slots: ` +
        `${scenario.multiColour} multi colour, ${scenario.singleColour} single colour, ` +
        `${scenario.other} empty, being read or 3rd party`);

    let service = null;
    let dataDir = null;

    if (options.service) {
        // A directory of its own, so a run cannot touch the printers.json,
        // settings.json or mappings.json of a real installation.
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-test-server-"));
        fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });

        service = spawn(process.execPath, ["entrypoint.js"], {
            cwd: rootDir,
            stdio: "inherit",
            env: {
                ...process.env,
                DATA_DIR: dataDir,
                LOG_DIR: path.join(dataDir, "logs"),
                SPOOLMAN_ENDPOINT: `http://127.0.0.1:${options.spoolmanPort}`,
                PRINTER_ID: PRINTER_SERIAL,
                PRINTER_CODE,
                PRINTER_IP: "127.0.0.1",
                // Manual, so that nothing is created in the mock Spoolman until
                // a button is pressed and every slot keeps showing its state.
                MODE: "manual",
                // The default of two minutes would mean one processed report per
                // run. This is a scenario nobody is waiting on.
                UPDATE_INTERVAL: "5000",
                OFFLINE_CHECK_INTERVAL: "5000",
                DEBUG: process.env.DEBUG ?? "false",
            },
        });

        console.log(`[service] started, state in ${dataDir}`);
        console.log("[service] open http://localhost:4000");

        service.on("exit", code => {
            console.log(`[service] exited with code ${code}`);
            shutdown(0);
        });
    } else {
        console.log("[service] not started, point one at " +
            `http://127.0.0.1:${options.spoolmanPort} and at 127.0.0.1:${options.printerPort} ` +
            `with serial ${PRINTER_SERIAL} and access code ${PRINTER_CODE}`);
    }

    let shuttingDown = false;

    async function shutdown(code) {
        if (shuttingDown) return;
        shuttingDown = true;

        if (service && service.exitCode === null) service.kill("SIGTERM");
        await printer.close();
        await new Promise(done => spoolman.close(() => done()));

        console.log(`[spoolman] ${store.writes.length} write(s) received:`);
        for (const write of store.writes) console.log(`[spoolman]   ${write}`);
        console.log(`[printer] published ${printer.reports()} report(s)`);
        if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });

        process.exit(code);
    }

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
