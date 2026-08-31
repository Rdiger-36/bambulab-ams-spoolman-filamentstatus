import { serverLogFilePath } from "./config.js";
import { settingsLoadIssues, spoolmanUrl } from "./settings.js";
import { state } from "./state.js";
import { printers, ensurePrinterLogFile } from "./printers.js";
import { checkAndSetVendor, checkAndSetExtraField } from "./spoolman.js";
import { monitorSpoolman, monitorSpoolmanBackground, monitorPrinters } from "./mqtt.js";

/**
 * Startup sequence and the parts of it that have to run again when the Spoolman
 * endpoint changes at runtime.
 *
 * Kept out of backend.js because the settings API needs the same sequence: a
 * new endpoint means a new health check and a fresh vendor and extra field
 * bootstrap, and it may be the point at which a service that started without a
 * reachable Spoolman becomes usable.
 */

/**
 * Waits for Spoolman, prepares the vendor and the "tag" extra field, then
 * starts the monitor loops.
 *
 * Never runs twice in parallel. Repeatedly changing the endpoint while the
 * health check is still waiting would otherwise stack loops that all keep
 * polling forever.
 */
async function bootstrapSpoolman() {
    if (state.spoolmanBootstrapRunning) return;
    state.spoolmanBootstrapRunning = true;

    try {
        await monitorSpoolman();

        if (!(await checkAndSetVendor()) || !(await checkAndSetExtraField())) {
            console.error("Server", serverLogFilePath, "Error: Vendor or Extra Field 'tag' could not be set!");
            return;
        }

        startMonitors();
    } finally {
        state.spoolmanBootstrapRunning = false;
    }
}

/** Starts the printer and Spoolman monitor loops, at most once per process. */
function startMonitors() {
    if (state.monitorsRunning) return;
    state.monitorsRunning = true;

    monitorPrinters(printers);
    monitorSpoolmanBackground();
}

/**
 * Runs the startup sequence.
 *
 * An empty printer list is not an error any more. The service keeps running so
 * that printers can be added on the settings page, and the monitor loop picks
 * them up as soon as they exist.
 */
export async function startService() {
    console.log("Server", serverLogFilePath, "Starting service...");

    for (const issue of settingsLoadIssues) {
        console.error("Server", serverLogFilePath, issue);
    }

    if (!spoolmanUrl()) {
        console.error("Server", serverLogFilePath, "No Spoolman endpoint configured. Set one under Settings in the Web UI.");
    }

    if (!printers.length) {
        console.error("Server", serverLogFilePath, "No printers configured. Add one under Settings in the Web UI.");
    }

    for (const printer of printers) {
        ensurePrinterLogFile(printer);
    }

    await bootstrapSpoolman();
}

/**
 * Drops everything derived from the old Spoolman instance and reconnects.
 *
 * Called after the endpoint was changed in the Web UI. The vendor id and the
 * cached spool list belong to the previous instance, so keeping them would
 * write spools against ids that do not exist there. Returns immediately; the
 * reconnect runs in the background because the health check waits for as long
 * as it takes.
 */
export function restartSpoolmanConnection() {
    console.log("Server", serverLogFilePath, `Spoolman endpoint changed, reconnecting to ${spoolmanUrl() || "no endpoint"}...`);

    state.spoolmanStatus = "Disconnected";
    state.vendorID = null;
    state.lastSpoolData = null;
    // Force a full rebuild of the slot data, it was matched against spools of
    // the previous instance.
    for (const printer of printers) {
        printer.first_run = true;
    }

    bootstrapSpoolman();
}
