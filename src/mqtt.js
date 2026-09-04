import mqtt from "mqtt";
import got from "got";
import * as net from "node:net";
import { serverLogFilePath, RECONNECT_INTERVAL } from "./config.js";
import { settings, spoolmanUrl, legacyMode } from "./settings.js";
import { originalConsoleLog } from "./logger.js";
import { state } from "./state.js";
import { sleep, formatDate, formatInterval, offlineBackoff, convertAMSandSlot, spoolIsEmpty, EXTERNAL_SPOOL_ID, SLOT_OPTIONS, ACTIVE_PRINT_STATES } from "./utils.js";
import {
    getSpoolmanSpools,
    getArchivedSpoolmanSpools,
    getSpoolmanInternalFilaments,
    getSpoolmanExternalFilaments,
    createSpool,
    createFilamentAndSpool,
    mergeSpool,
    patchSpoolWeight,
    useSpoolWeight,
    setSpoolArchived,
    logSpoolmanFailure,
} from "./spoolman.js";
import { fetchSliceInfo, calcFullConsumption, calcPartialConsumption, resolveSliceSlots, orderedAmsSlots, decodePrintMapping } from "./gcode.js";
import { getMapping, clearMapping } from "./mappings.js";
import { createLocationSync, releaseSlotLocation } from "./location.js";
import {
    processData,
    extractAmsEnvironment,
    extractComparableTrayData,
    correctRemainInt,
    slotIsOccupied,
    slotIsBusy,
    findExistingSpool,
    findMatchingExternalFilament,
    findMatchingInternalFilament,
    findMergeableSpool,
    haveSpoolDataChanged,
    hasTrayDataChanged,
    hasSpoolUiChanged,
    consumptionCandidate,
    matchConsumption,
} from "./ams.js";
import { toClientSpool } from "./uispool.js";

/**
 * Sends an event to every connected SSE client. A payload that cannot be
 * serialised is dropped with a log line rather than taking the handler down.
 */
export function broadcastSSE(data) {
    let payload;
    try {
        payload = `data: ${JSON.stringify(data)}\n\n`;
    } catch (err) {
        originalConsoleLog(`[ERROR] broadcastSSE: failed to serialize data - ${err.message}`);
        return;
    }
    state.clients.forEach(client => client.write(payload));
}

/** Pushes one slot's new state to the dashboard. */
export function broadcastSlotUpdate(printerId, spool) {
    broadcastSSE({ type: "slot_update", printer: printerId, spool: toClientSpool(spool) });
}

/**
 * How long two AMS environment broadcasts have to be apart, in milliseconds.
 *
 * Humidity and temperature are the two values the printer reports on every
 * report and that never sit still, which is why they are kept out of the tray
 * comparison entirely (see extractComparableTrayData in ams.js). They are shown
 * now, so they have to travel, but a tenth of a degree is not worth a push to
 * every browser every few seconds.
 */
const AMS_ENV_BROADCAST_INTERVAL = 30_000;

/**
 * Keeps the AMS environment readings current and pushes them to the dashboard.
 *
 * Deliberately outside the slot update interval and outside the tray change
 * detection: the readings are display only, they never touch Spoolman, and a
 * user watching a unit dry wants them sooner than the next spool update. The
 * in-memory value is refreshed on every report, so /api/status answers with what
 * arrived last; only the broadcast is throttled, and only a changed reading is
 * sent at all.
 *
 * @param {object} printer - the printer runtime object
 * @param {object[]} amsUnits - `print.ams.ams` from the report
 * @param {Date} now - the time the report was processed
 */
function broadcastAmsEnvironment(printer, amsUnits, now) {
    const amsEnv = extractAmsEnvironment(amsUnits);
    const serialised = JSON.stringify(amsEnv);
    printer.amsEnv = amsEnv;

    if (serialised === printer.lastAmsEnvBroadcast) return;
    if (now.getTime() - (printer.lastAmsEnvBroadcastTime || 0) < AMS_ENV_BROADCAST_INTERVAL) return;

    printer.lastAmsEnvBroadcast = serialised;
    printer.lastAmsEnvBroadcastTime = now.getTime();
    broadcastSSE({ type: "ams_env", printer: printer.id, amsEnv });
}

// Print states that signal the end of a print job
const TERMINAL_STATES = new Set(["FINISH", "FAILED", "CANCEL"]);
// Print states that indicate an active or paused job. Built from the list in
// public/shared.js, because the dashboard has to answer the same question
// before it offers to correct a weight this side would then overwrite.
export const ACTIVE_STATES = new Set(ACTIVE_PRINT_STATES);

/**
 * Tracks gcode_state transitions and triggers filament consumption tracking.
 * Called on every MQTT message that contains a gcode_state field.
 *
 * The slice info is fetched once, on the transition into RUNNING, because that
 * is the first point at which the sliced file is reliably present in the
 * printer's /cache. Consumption is booked once, on the transition from an
 * active state into a terminal one: the full slicer estimate for FINISH, and a
 * layer proportional share for FAILED and CANCEL.
 *
 * Both steps are guarded by a flag on the printer, since the printer repeats
 * its state in every report. Entering an active state resets those flags, so a
 * reprint of the same file is tracked again.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} print - the `print` object from the MQTT report
 */
async function handlePrintStateChange(printer, print) {
    const newState    = print.gcode_state;
    // subtask_name is the job name used for the FTP file (/cache/<name>.gcode.3mf).
    // gcode_file (e.g. /data/Metadata/plate_1.gcode) is an internal path NOT
    // exposed over FTP, so we only fall back to its basename as a last resort.
    const jobName     = print.subtask_name || printer.currentJobName || null;
    const layerNum    = print.layer_num   ?? printer.currentLayerNum   ?? 0;
    const prevState   = printer.currentGcodeState || "IDLE";

    // Always keep layer_num up to date for partial-print calculation
    if (print.layer_num != null) printer.currentLayerNum = print.layer_num;

    // A fresh print starts when we transition from a non-active state into an
    // active one. Reset tracking here (even on a reprint of the same file) so
    // consumption gets booked again for the new run.
    const freshStart = ACTIVE_STATES.has(newState) && !ACTIVE_STATES.has(prevState);
    if (freshStart) {
        printer.currentJobName    = jobName;
        printer.currentSliceInfo  = null;
        printer.currentMapping    = null;
        printer.consumptionBooked = false;
        printer.sliceFetchDone    = false;

        // The result of the previous print goes here, not on the terminal
        // state: it stays readable for as long as nothing new is printing,
        // which is what makes the summary worth keeping after the card itself
        // has returned to idle.
        printer.printStartedAt         = Date.now();
        printer.lastPrintSummary       = null;
        printer.printResultDismissed   = false;
        printer.printResetAt           = null;
    }

    // Fetch slice info once we reach RUNNING (the .gcode.3mf is reliably present
    // in /cache by then). Guarded so we only attempt it once per print.
    if (newState === "RUNNING" && jobName && !printer.sliceFetchDone) {
        printer.sliceFetchDone = true;
        printer.currentJobName = jobName;

        console.log(printer.name, printer.logFilePath, `[Print] Print running: "${jobName}", fetching slice info via FTPS...`);
        try {
            printer.currentSliceInfo = await fetchSliceInfo(printer, jobName);
            if (printer.currentSliceInfo) {
                console.log(printer.name, printer.logFilePath, `[Print] Slice info loaded: ${printer.currentSliceInfo.filaments.length} filament(s), ${printer.currentSliceInfo.totalLayers} layers`);
            } else {
                console.log(printer.name, printer.logFilePath, "[Print] slice_info.config not found in 3MF, consumption tracking unavailable for this print");
            }
        } catch (err) {
            console.error(printer.name, printer.logFilePath, `[Print] Could not fetch slice info: ${err.message}`);
        }
    }

    // Followed for as long as the print is active rather than read once, and
    // never on a terminal report, which may already describe the next job.
    // Measured on a P2S: the value settles a moment after the print starts, and
    // one report carried the slot the job was configured with before the user
    // changed it. Reading only the first would have booked onto that one. The
    // printer cannot move a filament to another slot mid print, so the last
    // value before the terminal state is the one that ran.
    if (ACTIVE_STATES.has(newState)) {
        const reported = decodePrintMapping(print.mapping);
        if (reported && JSON.stringify(reported) !== JSON.stringify(printer.currentMapping)) {
            printer.currentMapping = reported;
            console.log(printer.name, printer.logFilePath, `[Print] The printer reports its slots as ${JSON.stringify(reported)}`);
        }
    }

    // Update tracked state
    printer.currentGcodeState = newState;

    // Book consumption on transition into a terminal state
    if (TERMINAL_STATES.has(newState) && ACTIVE_STATES.has(prevState) && !printer.consumptionBooked) {
        printer.consumptionBooked = true;

        // Built before the booking so that the run is summarised even when
        // there is nothing to book. A print whose slice info never arrived is
        // exactly the case somebody opens the summary for.
        const summary = {
            state:       newState,
            jobName:     printer.currentJobName || null,
            endedAt:     Date.now(),
            startedAt:   printer.printStartedAt,
            durationMs:  printer.printStartedAt ? Date.now() - printer.printStartedAt : null,
            layerNum,
            totalLayers: printer.currentSliceInfo?.totalLayers ?? null,
            printError:  printErrorText(print),
            rows:        [],
            note:        null,
        };
        printer.lastPrintSummary = summary;
        armPrintResultReset(printer);

        if (!printer.currentSliceInfo) {
            summary.note = "No slice info was cached for this print, so nothing could be booked.";
            console.log(printer.name, printer.logFilePath, `[Print] ${newState}, no slice info cached, skipping consumption tracking`);
            return;
        }

        const consumption = newState === "FINISH"
            ? calcFullConsumption(printer.currentSliceInfo)
            : calcPartialConsumption(printer.currentSliceInfo, layerNum);

        const outcome = await bookConsumption(printer, consumption, newState);
        summary.rows = outcome.rows;
        summary.note = outcome.note;
    }
}

/**
 * The printer's own complaint about the print, as text, or null when it is
 * happy.
 *
 * A P2S reports `print_error` as a number and `mc_print_error_code` as the same
 * value in a string, both 0 on a clean run. `fail_reason` is a string that is
 * "0" rather than empty when nothing failed, which is why it is compared
 * against both.
 *
 * The numbers are not translated into Bambu's error catalogue here. That
 * catalogue is large, versioned per firmware and not published in a form this
 * project can carry, so the code is shown as the printer gave it and the user
 * can look it up. Saying "error 131074" is honest; inventing a description for
 * it is not.
 *
 * @param {object} print - the `print` object from the MQTT report
 * @returns {string|null} the error text, or null when there is none
 */
function printErrorText(print) {
    const code = Number(print?.print_error ?? print?.mc_print_error_code ?? 0);
    const reason = print?.fail_reason;
    const failed = reason && reason !== "0" && reason !== 0;

    if (!code && !failed) return null;
    if (code && failed)   return `Printer error ${code}, fail reason ${reason}`;
    if (code)             return `Printer error ${code}`;
    return `Fail reason ${reason}`;
}

/**
 * Starts the countdown after which the finished print leaves the dashboard.
 *
 * `PRINT_RESET_MINUTES` of 0 means the result stays until somebody clears it,
 * so no deadline is set and the Web UI offers the button without a countdown.
 *
 * Nothing is scheduled with a timer: the deadline is a timestamp the dashboard
 * and the API compare against the clock. A timer would have to be cancelled on
 * every printer removal and would fire into a process that may have restarted,
 * while a timestamp survives being read from anywhere and needs no cleanup.
 *
 * @param {object} printer - the runtime printer
 */
function armPrintResultReset(printer) {
    const minutes = Number(settings.PRINT_RESET_MINUTES);
    printer.printResetAt = minutes > 0 ? Date.now() + minutes * 60_000 : null;
}

/**
 * Whether the finished print should no longer be shown on the card.
 *
 * True once it has been cleared by hand, or once its deadline has passed. The
 * deadline is evaluated on read rather than on a timer, so this is the single
 * place that decides it and every reader agrees.
 *
 * @param {object} printer - the runtime printer
 * @returns {boolean} whether the result is cleared
 */
export function printResultCleared(printer) {
    if (printer.printResultDismissed) return true;
    return printer.printResetAt != null && Date.now() >= printer.printResetAt;
}

/**
 * The external spool holder as one more AMS unit, or nothing.
 *
 * The printer reports the holder outside the AMS block, as `print.vir_slot`, an
 * array whose entry is field for field a chipless AMS tray: an all zero
 * `tray_uuid`, empty `tray_sub_brands`, `tray_weight` "0" and `remain` 0. That
 * is why it is handed to the same pipeline as a unit of its own rather than
 * given a branch: `processSlot` then classifies it as the 3rd party spool it
 * is, and it becomes assignable like any other. Measured on a P2S, `vir_slot`
 * was present in all 24 reports that carried AMS data and in none of the ones
 * that carried none, so a missing key needs no memory of the last value.
 *
 * `vt_tray` is the same thing on older firmware, a single object rather than an
 * array. The P2S measured here no longer sends the key at all.
 *
 * Only emitted for a holder that actually carries something. An empty holder is
 * still reported, and reported in full: measured on a P2S with nothing on it,
 * every field is there and only the three that name a material are empty. The
 * whole record would otherwise reach `slotIsOccupied()` carrying its
 * temperature fields and read as a loaded spool nobody can identify.
 *
 * The material is the test and the colour is not. An empty holder reports
 * `cols` as `["FFFFFF00"]`, fully transparent, which is the printer saying
 * there is nothing rather than that the filament is clear. Reading that as a
 * colour put an invisible swatch on a row for a spool that was not there.
 *
 * @param {object} print - `data.print` from an MQTT report
 * @returns {object[]} zero or one unit, shaped like an entry of `print.ams.ams`
 */
export function externalSpoolUnits(print) {
    const reported = Array.isArray(print?.vir_slot)
        ? print.vir_slot
        : (print?.vt_tray ? [print.vt_tray] : []);

    const loaded = reported.filter(tray => tray && (tray.tray_type || tray.tray_info_idx));

    if (!loaded.length) return [];
    return [{ id: String(EXTERNAL_SPOOL_ID), tray: loaded }];
}

/**
 * Archives a spool that has just run empty, when the setting asks for it.
 *
 * Runs on the two places a weight is written: the consumption booking of a
 * finished print and the legacy mode weight patch. Both already know what the
 * spool holds afterwards, so nothing is read back and no AMS percentage is
 * consulted, see `spoolIsEmpty()`.
 *
 * The location is cleared first. An archived spool drops out of
 * `getSpoolmanSpools()`, so no later AMS update sees it in a slot and nothing
 * would ever release the location it was given while it was in one.
 *
 * Failures are logged and swallowed: the weight it archives is already written,
 * and losing the archive flag must not lose the booking.
 *
 * @param {object} printer - the runtime printer, for the log
 * @param {object|null} spool - the Spoolman record as it is after the write
 * @returns {Promise<boolean>} whether the spool was archived
 */
async function archiveWhenEmpty(printer, spool) {
    if (!settings.ARCHIVE_EMPTY_SPOOLS) return false;
    if (!spool?.id || spool.archived) return false;
    if (!spoolIsEmpty(spool.remaining_weight, settings.EMPTY_SPOOL_THRESHOLD)) return false;

    try {
        await releaseSlotLocation(printer, spool);
        await setSpoolArchived(spool.id, true);
        spool.archived = true;
        console.log(printer.name, printer.logFilePath, `    Spool-ID ${spool.id} is empty (${Math.round(spool.remaining_weight)}g left), archived in Spoolman`);
        return true;
    } catch (err) {
        console.error(printer.name, printer.logFilePath, `    Failed to archive empty Spool-ID ${spool.id}:`, err.message);
        return false;
    }
}

/**
 * Books the consumed grams in Spoolman for each filament of a finished print.
 *
 * A slot is only booked when we actually know which physical spool sits in it:
 * either through the Spoolman extra.tag field (= the slot's tray_uuid, Bambu Lab
 * spools only) or through a manual assignment made in the UI. Filament
 * candidates that merely match by type are never touched, which is why only
 * those slots become candidates here.
 *
 * Which filament belongs to which of them is `matchConsumption()` in ams.js,
 * shared with the dashboard route so both answer the question the same way.
 *
 * Returns what it did rather than only logging it, because the same account has
 * to reach the summary dialog in the Web UI. The rows carry the outcome of
 * every filament of the print, the skipped ones included: a filament that was
 * not booked is the thing a user opens that dialog to understand.
 *
 * @param {object} printer - the runtime printer
 * @param {object} consumption - a map from calcFullConsumption or the partial one
 * @param {string} state - the terminal state that triggered this, for the log
 * @returns {Promise<{rows: object[], note: string|null}>} one row per filament,
 *   and a note when nothing could be booked at all
 */
async function bookConsumption(printer, consumption, state) {
    if (!printer.spoolData?.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No spool data available for consumption booking");
        return { rows: [], note: "No spool data was available, so nothing could be booked." };
    }

    // What the printer said its slots were beats working them out from the
    // slicer's list order, which only holds while the project is synchronised
    // with the printer and cannot tell when it is not. Without it, the position
    // in the list is all there is.
    const reported = printer.currentMapping;
    resolveSliceSlots(
        consumption,
        reported ?? orderedAmsSlots(printer.spoolData.map(s => s.amsId)),
        { reportedByPrinter: !!reported },
    );

    // Logged from here rather than from the caller, which ran before the slots
    // were named and therefore printed every `amsId` as null, which is the one
    // field somebody reading this line is looking for.
    console.log(printer.name, printer.logFilePath, `[Print] ${state}, booking filament consumption:`, JSON.stringify(consumption));

    // Only a slot whose physical spool is known can carry a booking, so nothing
    // else is offered to the matcher.
    const candidates = printer.spoolData
        .filter(uiSpool => uiSpool.connectedViaMapping || uiSpool.connectedViaTag)
        .map(consumptionCandidate)
        .filter(candidate => candidate.id);

    if (!candidates.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No connected or assigned spools, nothing to book");
        return {
            rows: Object.values(consumption).map(info => summaryRow(info, "skipped",
                "No spool in this slot is connected by tag or assigned by hand.")),
            note: "No slot held a spool this service could identify, so nothing was booked.",
        };
    }

    const lastUsed = new Date().toISOString();
    const entries = Object.values(consumption);
    const matched = matchConsumption(entries, candidates);
    const rows = [];

    for (const info of entries) {
        const { tray_info_idx: idx, color, type, grams } = info;
        if (grams <= 0) {
            // Zero gram filaments are skipped rather than written as zero, and
            // the summary says so instead of leaving the filament out: a plate
            // that used none of a loaded colour is a result, not an omission.
            rows.push(summaryRow(info, "unused", "The print used none of this filament."));
            continue;
        }

        const matches = matched.get(info) ?? [];

        if (!matches.length) {
            console.log(printer.name, printer.logFilePath, `[Print] No connected or assigned Spoolman spool for ${idx} ${type} (${color}), skipping ${grams}g (assign the spool in the Web UI to track it)`);
            rows.push(summaryRow(info, "skipped",
                "No connected or assigned Spoolman spool. Assign it in the Web UI to track it."));
            continue;
        }

        if (matches.length > 1) {
            // console.error rather than console.warn: logger.js overrides log,
            // error and debug, and a warn call lands on raw stdout with the two
            // routing arguments printed as text, so the one line that admits to
            // a guess never reached the log file it belongs in.
            //
            // Splitting is not on offer here, whatever is assigned. Two spools
            // reach this point only when the sliced file could not separate
            // them either, and their grams were added together before anything
            // looked at the AMS. Assigning one of them decides which spool
            // carries the total instead of leaving it to the slot order.
            console.error(printer.name, printer.logFilePath, `[Print] ${matches.length} spools are indistinguishable for ${idx} ${type} (${color}), booking the full ${grams}g to spool ${matches[0].id} (${matches[0].amsId}); assign one of them in the Web UI to choose which spool carries it`);
        }

        const { id: spoolId } = matches[0];
        const ambiguous = matches.length > 1
            ? `${matches.length} spools were indistinguishable; the full amount went to this one.`
            : null;

        try {
            const booked = await useSpoolWeight(spoolId, grams, lastUsed);
            console.log(printer.name, printer.logFilePath, `[Print] Booked ${grams}g for spool ${spoolId} (${matches[0].amsId}, ${idx} ${type} ${color}${matches[0].mapped ? ", manually assigned" : ""})`);
            rows.push({
                ...summaryRow(info, ambiguous ? "ambiguous" : "booked", ambiguous),
                spoolId,
                // The three fields the dashboard names a filament by. Taken
                // from the record the booking wrote, so the summary keeps
                // saying what was booked even after the spool is edited or
                // taken out of the slot.
                vendor: booked?.filament?.vendor?.name ?? null,
                material: booked?.filament?.material ?? null,
                spoolName: booked?.filament?.name ?? null,
                mapped: !!matches[0].mapped,
                remainingWeight: booked?.remaining_weight ?? null,
            });
            await archiveWhenEmpty(printer, booked);
        } catch (err) {
            console.error(printer.name, printer.logFilePath, `[Print] Failed to book consumption for spool ${spoolId}: ${err.message}`);
            rows.push({
                ...summaryRow(info, "failed", `Spoolman refused the booking: ${err.message}`),
                spoolId,
                mapped: !!matches[0].mapped,
            });
        }
    }

    return { rows, note: null };
}

/**
 * One filament of a print as the summary dialog shows it.
 *
 * `amsId` is set by resolveSliceSlots(), which runs before anything is booked,
 * so the slot is named even for a filament that was never booked at all.
 *
 * @param {object} info - one entry of a consumption map
 * @param {string} status - booked, ambiguous, skipped, unused or failed
 * @param {string|null} note - why, for everything that is not a plain booking
 * @returns {object} the row
 */
function summaryRow(info, status, note = null) {
    return {
        amsId: info.amsId ?? null,
        trayInfoIdx: info.tray_info_idx ?? null,
        type: info.type ?? null,
        color: info.color ?? null,
        // The whole colour set when the slice named one, so a multi colour
        // filament is drawn the way it is everywhere else in this UI rather
        // than as its first colour alone.
        colors: info.colors ?? null,
        grams: info.grams ?? 0,
        status,
        note,
        spoolId: null,
        // Filled in only where a spool was actually booked. A filament that was
        // skipped has no Spoolman record to name it by, so the dialog falls
        // back to what the sliced file said it was.
        vendor: null,
        material: null,
        spoolName: null,
    };
}

/**
 * Handles one MQTT report from a printer.
 *
 * Three things happen here, in order: the reception timestamp is refreshed and
 * throttled out over SSE, print state changes are forwarded to the consumption
 * tracking (G-code mode only), and AMS data is processed against Spoolman.
 *
 * The AMS part is rate limited by the printer's update interval and skipped
 * entirely when neither the Spoolman spools nor the tray data actually changed,
 * because the printer sends a full report every few seconds. Reentry is blocked
 * through printer.blockMqttUpdates, so a report arriving while the previous one
 * is still being processed is dropped rather than queued.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} topic - the MQTT topic, unused
 * @param {Buffer|string} message - the raw report payload
 */
async function handleMqttMessage(printer, topic, message) {
    if (printer.blockMqttUpdates || state.spoolmanStatus === "Disconnected") return;
    printer.blockMqttUpdates = true;

    if (printer.monitoringEnabled) {
        try {
            printer.mqttStatus = "Connected";
            const data = JSON.parse(message);
            console.debug(printer.name, printer.logFilePath, `Processing MQTT message for Printer: ${printer.id}`);

            // Reception freshness: every received message proves the connection is
            // live, regardless of the AMS processing interval below. Update the
            // timestamp in-memory always, but throttle the SSE broadcast to ~1/s.
            printer.lastMqttUpdate = new Date();
            if (printer.lastMqttUpdate.getTime() - (printer.lastMqttBroadcast || 0) > 1000) {
                printer.lastMqttBroadcast = printer.lastMqttUpdate.getTime();
                broadcastSSE({
                    type: "status",
                    printer: printer.id,
                    lastMqttUpdate: printer.lastMqttUpdate.toISOString(),
                    lastMqttAmsUpdate: printer.lastMqttAmsUpdate
                        ? printer.lastMqttAmsUpdate.toISOString()
                        : null,
                });
            }

            // Legacy mode derives the weight from the RFID remain percentage, so
            // the G-code tracking must stay out of it entirely. Running both
            // would download the sliced file on every print and book consumption
            // that the next AMS update then overwrites again.
            if (!legacyMode() && data?.print?.gcode_state) {
                await handlePrintStateChange(printer, data.print);
            }

            console.debug(printer.name, printer.logFilePath, "Check if message contains AMS Data");

            if (data?.print?.ams?.ams) {
                const currentTime = new Date();
                broadcastAmsEnvironment(printer, data.print.ams.ams, currentTime);
                console.debug(printer.name, printer.logFilePath, "Check next Update Interval");

                const intervalElapsed = currentTime.getTime() - printer.lastUpdateTime.getTime() > printer.update_interval;
                if (intervalElapsed || printer.first_run) {
                    const wasFirstRun = printer.first_run;
                    printer.first_run = false;
                    // An incomplete report, which the firmware signals by sending
                    // the environment fields as empty strings. They used to be
                    // read off the AMS block, where a P2S never puts them: the
                    // check compared undefined against "" and passed every time.
                    // They sit on the units, and a unit that reports none at all
                    // is an AMS Lite rather than an incomplete report, so a
                    // missing field still counts as valid.
                    const isValidAmsData = data.print.ams.ams.every(unit =>
                        unit?.humidity !== "" && unit?.temp !== ""
                    );

                    console.debug(printer.name, printer.logFilePath, "Fetch Data from Spoolman");
                    let spools = await getSpoolmanSpools();

                    if (state.spoolmanStatus !== "Disconnected") {
                        console.debug(printer.name, printer.logFilePath, "Registered Spools:");
                        console.debug(printer.name, printer.logFilePath, JSON.stringify(spools));

                        // Seed the baseline on the very first pass only. Testing for an
                        // empty array here re-seeded it on every pass for as long as
                        // Spoolman held no spools, so the first spool ever created was
                        // compared against itself and never registered as a change,
                        // exactly what happens on a fresh Spoolman install.
                        if (state.lastSpoolData === null) state.lastSpoolData = spools;

                        let externalFilaments = await getSpoolmanExternalFilaments();
                        let internalFilaments = await getSpoolmanInternalFilaments();
                        // Only fetched when the setting can produce archived
                        // spools in the first place, so an install that does not
                        // archive pays nothing for the guard.
                        let archivedSpools = settings.ARCHIVE_EMPTY_SPOOLS ? await getArchivedSpoolmanSpools() : [];

                        const spoolsChanged = await haveSpoolDataChanged(spools, state.lastSpoolData);
                        // Legacy mode leaves the holder out. Its weight comes
                        // from the RFID remain percentage and the holder has no
                        // chip, so there would be nothing to write, which is the
                        // same reason a 3rd party slot is read-only there.
                        const externalUnits = legacyMode() ? [] : externalSpoolUnits(data.print);
                        const processedAmsData = processData([...data.print.ams.ams, ...externalUnits]);
                        const newTrayData = extractComparableTrayData(processedAmsData);
                        const lastTrayData = extractComparableTrayData(printer.lastAmsData || []);
                        const trayDataChanged = hasTrayDataChanged(newTrayData, lastTrayData);

                        if (isValidAmsData && (spoolsChanged || trayDataChanged)) {
                            console.debug(printer.name, printer.logFilePath, "Loaded AMS Spools:");
                            console.debug(printer.name, printer.logFilePath, JSON.stringify(processedAmsData));

                            const prevByAmsId = Object.fromEntries(
                                (printer.spoolData || []).map(s => [s.amsId, s])
                            );
                            printer.spoolData = [];

                            // Collected across every slot and applied below, so a
                            // spool moved between two slots is not cleared by the
                            // slot it left after the slot it entered claimed it.
                            const locationSync = createLocationSync(printer);

                            for (const ams of processedAmsData) {
                                if (!Array.isArray(ams.tray)) {
                                    console.debug(printer.name, printer.logFilePath, "Data from Slots are not valid");
                                    continue;
                                }

                                for (const slot of ams.tray) {
                                    const mutated = await processSlot(printer, ams, slot, spools, archivedSpools, externalFilaments, internalFilaments, prevByAmsId, currentTime, locationSync);

                                    // Only refetch when this slot actually created/merged a
                                    // spool or filament in Spoolman. Otherwise the cached
                                    // lists from the top of this AMS update are still valid,
                                    // avoiding redundant HTTP calls for every slot.
                                    if (mutated) {
                                        spools = await getSpoolmanSpools();
                                        externalFilaments = await getSpoolmanExternalFilaments();
                                        internalFilaments = await getSpoolmanInternalFilaments();
                                        if (settings.ARCHIVE_EMPTY_SPOOLS) archivedSpools = await getArchivedSpoolmanSpools();
                                    }
                                }
                            }

                            releaseVanishedSlots(locationSync, prevByAmsId, printer.spoolData, spools);

                            await locationSync.flush();

                            state.lastSpoolData = spools;
                            printer.lastMqttAmsUpdate = new Date();
                            printer.lastAmsData = processedAmsData;
                            console.log(printer.name, printer.logFilePath, "");

                            broadcastSSE({
                                type: "status",
                                printer: printer.id,
                                lastMqttUpdate: new Date().toISOString(),
                                lastMqttAmsUpdate: printer.lastMqttAmsUpdate.toISOString(),
                            });

                            if (wasFirstRun) {
                                broadcastSSE({ type: "refresh", printer: printer.id });
                            }
                        } else {
                            const UpdateIntSec = printer.update_interval / 1000;
                            const nextUpdateTime = new Date(currentTime.getTime() + printer.update_interval);
                            const nextUpdate = formatDate(nextUpdateTime);
                            console.log(printer.name, printer.logFilePath, `No new slot data or changes in Spoolman found. Processing slot data for this printer will be paused until ${nextUpdate} (${UpdateIntSec} seconds)...`);
                            printer.lastUpdateTime = new Date();
                        }

                        printer.lastMqttUpdate = new Date();
                        broadcastSSE({
                            type: "status",
                            printer: printer.id,
                            lastMqttUpdate: printer.lastMqttUpdate.toISOString(),
                            lastMqttAmsUpdate: printer.lastMqttAmsUpdate
                                ? printer.lastMqttAmsUpdate.toISOString()
                                : null,
                        });
                    } else {
                        console.error("Server", serverLogFilePath, "Spoolman is currently unreachable. A background check will automatically attempt to reconnect...");
                    }
                } else {
                    console.debug(printer.name, printer.logFilePath, "Data will not be processed because of manually set interval");
                }
            } else {
                console.debug(printer.name, printer.logFilePath, `No processable Data found for JSON filter data.printer.ams.ams`);
            }
        } catch (error) {
            console.error(printer.name, printer.logFilePath, `Error processing message for Printer: ${printer.id} - ${error.message}`);
        }
    }

    printer.blockMqttUpdates = false;
}

/**
 * Hands the location sync the spool a slot used to hold, so it is released
 * unless some slot of this AMS update claims it again.
 *
 * The cached record is only used for its id: its `location` is whatever
 * Spoolman said when the record was fetched, and the ownership check that
 * decides whether the location may be cleared has to read the current one.
 *
 * @param {object} locationSync - the collector for this AMS update
 * @param {string} amsId - slot label
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 */
function releasePreviousSpool(locationSync, amsId, prevByAmsId, spools) {
    const prevSpoolId = prevByAmsId[amsId]?.existingSpool?.id ?? null;
    if (!prevSpoolId) return;

    const current = (spools || []).find(s => s.id === prevSpoolId);
    locationSync.release(current ?? prevByAmsId[amsId].existingSpool);
}

/**
 * Releases the spools of slots the report no longer contains at all.
 *
 * `releasePreviousSpool()` only runs from inside `processSlot()`, so it can
 * only clear a location when the slot it belonged to is still in the report. A
 * slot can also disappear outright: taking the spool off the external holder
 * makes `externalSpoolUnits()` emit no unit, and an unplugged AMS drops out of
 * `print.ams.ams` the same way. Nothing then walked that slot, nothing released
 * it, and the spool kept "Printer - External" in Spoolman forever.
 *
 * Compared against the slots this update actually built, not against the
 * report, so a slot that was skipped as invalid counts as gone as well.
 *
 * @param {object} locationSync - the collector for this AMS update
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {object[]} spoolData - the UI spools this update built
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 */
export function releaseVanishedSlots(locationSync, prevByAmsId, spoolData, spools) {
    const seen = new Set((spoolData || []).map(s => s.amsId));

    for (const amsId of Object.keys(prevByAmsId)) {
        if (seen.has(amsId)) continue;
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
    }
}

// How many AMS updates a slot may wait for its remain reading before a spool is
// created without one. The reading arrived between 17 and 74 seconds after the
// spool went in across every insert captured on a P2S, so at the default 15
// second interval five updates cover that with room to spare, and a spool whose
// chip never reports still ends up in Spoolman rather than being skipped in
// silence.
const MAX_REMAIN_WAITS = 5;

/**
 * Whether a slot has waited long enough to be created without a remain reading.
 *
 * Counts consecutive AMS updates in which the printer reported no percentage
 * for this slot. The count is kept per slot and reset as soon as a reading
 * arrives or a different spool shows up, so it measures this spool in this
 * slot and nothing else.
 *
 * Creating without a reading is not free: `usedWeightFromSlot()` then treats
 * the spool as brand new, which is wrong for a partly used one. Waiting is the
 * better default, giving up eventually is better than never creating the spool
 * at all.
 *
 * @param {object} printer - the printer runtime object, holding the counters
 * @param {string} amsId - the slot label
 * @param {object} slot - the normalised slot
 * @returns {boolean} true once the wait is over, so the caller stops holding back
 */
export function waitedLongEnoughForRemain(printer, amsId, slot) {
    if (!printer.remainWaits) printer.remainWaits = {};

    if (slot.remain != null) {
        delete printer.remainWaits[amsId];
        return true;
    }

    const previous = printer.remainWaits[amsId];
    const waits = previous?.uuid === slot.tray_uuid ? previous.waits + 1 : 1;
    printer.remainWaits[amsId] = { uuid: slot.tray_uuid, waits };

    return waits > MAX_REMAIN_WAITS;
}

/**
 * Classifies one AMS slot, acts on it in Spoolman, and records the result for
 * the UI.
 *
 * The branches are tried in order and the order matters: an invalid slot, then
 * a genuinely empty one, then a slot the printer could not identify (a 3rd
 * party spool, which can only be linked by a manual assignment), and finally a
 * fully identified Bambu Lab spool.
 *
 * For that last case the slot is connected to an existing tagged spool, or
 * offered for merge or creation depending on what Spoolman already holds. In
 * automatic mode the offered action is carried out right away; in manual mode
 * it is only surfaced in the UI. Legacy mode additionally patches the remaining
 * weight from the AMS remain percentage here, which G-code mode leaves to the
 * consumption booking after a print.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} ams - the AMS unit the slot belongs to
 * @param {object} slot - the normalised slot
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 * @param {object[]} archivedSpools - the archived spools, empty unless the
 *     archive setting is on
 * @param {object[]} externalFilaments - the SpoolmanDB catalogue
 * @param {object[]} internalFilaments - filaments in this Spoolman instance
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {Date} currentTime - timestamp shared across this AMS update
 * @param {object} locationSync - collects the location changes of this update,
 *   which are applied once every slot has been seen
 * @returns {Promise<boolean>} whether Spoolman was mutated, which tells the
 *   caller its cached lists are stale and have to be refetched
 */
async function processSlot(printer, ams, slot, spools, archivedSpools, externalFilaments, internalFilaments, prevByAmsId, currentTime, locationSync) {
    const amsId = convertAMSandSlot(ams.id, slot.id);
    const validSlot = Object.keys(slot).length > 6;

    // Two ways for a slot to be empty: a payload too short to carry a tray
    // record at all, and a full record whose fields are all placeholders. An
    // unidentified spool shares every placeholder field with the second one, so
    // an occupied slot must not be swallowed by it. Only `slotIsOccupied()`
    // tells the two apart.
    const emptyWithPlaceholders = (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A")
        && (slot.tray_weight === 0 || slot.tray_weight === "0")
        && (!slot.tray_type || slot.tray_type === "")
        && !slotIsOccupied(slot);

    if (!validSlot || emptyWithPlaceholders) {
        console.debug(printer.name, printer.logFilePath, validSlot
            ? "No Data found in Slots (empty slot with N/A values)"
            : "No Data found in Slots");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId);
        return false;
    }

    // Reached by anything the printer could not identify, including a slot whose
    // only sign of life is `state`, which the empty branch above no longer takes.
    if (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") {
        console.debug(printer.name, printer.logFilePath, "Slot is read-only (3rd party spool)");
        // `tray_sub_brands` used to be overwritten with the material here, so
        // the slot had a name at all. The projection now drops the "N/A"
        // placeholder on its own, and the dashboard builds the name from the
        // material anyway, so copying it produced "PLA . PLA". It also wrote
        // into the record kept as `printer.lastAmsData`, which is the baseline
        // the next report is compared against.

        // No RFID chip means no extra.tag link in Spoolman, so the only way to
        // know which spool sits here is a manual assignment made in the UI.
        // Legacy mode has no use for one: it takes the weight from the RFID
        // percentage, which a chipless spool does not report, so the slot stays
        // read-only exactly as it was before assignments existed.
        const mappedSpool = legacyMode() ? null : resolveMappedSpool(printer, amsId, slot, spools, archivedSpools);
        const newUiSpool = buildThirdPartySpool(printer, amsId, slot, mappedSpool);
        // The assignment is the only link a chipless spool has, so it is also
        // the only thing that can give it a location. Nothing did before, which
        // is why an assigned 3rd party spool never got one at all. An archived
        // spool is left without one on purpose: archiving cleared it, and no
        // later update would clear it a second time.
        if (!mappedSpool?.archived) locationSync.claim(amsId, mappedSpool);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        if (hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
            broadcastSlotUpdate(printer.id, newUiSpool);
            // No uuid to print, so the line says what the slot is instead: the
            // material and colour set on the printer, and the assignment that
            // decides whether consumption can be booked onto it.
            const assignment = mappedSpool ? `=> Spool-ID ${mappedSpool.id} (assigned)` : "(3rd party, not assigned)";
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_type || "Unknown material"} ${slot.tray_color} ${assignment}`);
        }
        printer.spoolData.push(newUiSpool);
        return false;
    }

    // Valid Bambu Lab spool
    let found = false;
    let mergeableSpool = null;
    let matchingExternalFilament = null;
    let matchingInternalFilament = null;
    let existingSpool = null;
    let option = SLOT_OPTIONS.NONE;
    let enableButton = "false";
    let error = false;
    let mutated = false;
    const automatic = settings.MODE === "automatic";

    matchingExternalFilament = findMatchingExternalFilament(slot, externalFilaments);
    matchingInternalFilament = findMatchingInternalFilament(matchingExternalFilament, internalFilaments);

    if (spools.length !== 0) {
        for (const spool of spools) {
            if (spool.extra?.tag && JSON.parse(spool.extra.tag) === slot.tray_uuid) {
                console.debug(printer.name, printer.logFilePath, " Connected Spool found: " + JSON.stringify(spool));
                found = true;

                // Normalize remain for comparison; slot.remain itself is left
                // untouched (raw, as received from MQTT) so it stays comparable
                // with the next message's raw value in the outer change-detection
                // (extractComparableTrayData / printer.lastAmsData). Mutating it in
                // place here used to desync that comparison for any spool whose
                // tray_weight != 1000g (e.g. 250g support spools), causing the AMS
                // data to look "changed" on every single message forever.
                const prevSlot = prevByAmsId[amsId]?.slot;
                const prevRemain = prevSlot ? correctRemainInt(prevSlot.remain, prevSlot.tray_weight, prevSlot.tray_type) : null;
                const currRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
                // slotChanged includes remain (relevant for legacy weight patching);
                // meaningfulChange ignores remain (spool identity only) and gates
                // logging/location in G-code mode so remain ticks don't spam.
                const meaningfulChange = !prevSlot ||
                    slot.tray_uuid       !== prevSlot?.tray_uuid ||
                    slot.tray_info_idx   !== prevSlot?.tray_info_idx ||
                    slot.tray_color      !== prevSlot?.tray_color ||
                    slot.tray_sub_brands !== prevSlot?.tray_sub_brands ||
                    slot.tray_weight     !== prevSlot?.tray_weight;
                const slotChanged = meaningfulChange || currRemain !== prevRemain;

                existingSpool = spool;

                if (legacyMode()) {
                    // Legacy: derive remaining weight from the AMS RFID remain %
                    if (!slotChanged) {
                        console.debug(printer.name, printer.logFilePath, " No change for connected spool; skipping PATCH");
                        break;
                    }

                    // The whole mode rests on the percentage, so there is
                    // nothing to patch until the AMS has read one. It arrives
                    // within about 20 seconds of the spool going in.
                    if (currRemain === null) {
                        console.debug(printer.name, printer.logFilePath, " Remain not reported yet; skipping PATCH until the AMS has read it");
                        break;
                    }

                    const remainingWeight = Math.round((currRemain / 100) * slot.tray_weight);

                    console.debug(printer.name, printer.logFilePath, "    Sending PATCH request to:", `${spoolmanUrl()}/api/v1/spool/${spool.id}`);
                    console.debug(printer.name, printer.logFilePath, "    Payload:", JSON.stringify({ remaining_weight: remainingWeight, last_used: currentTime }));

                    try {
                        await patchSpoolWeight(spool.id, remainingWeight, currentTime);
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${currRemain}%) [[ ${slot.tray_uuid} ]]`);
                        console.log(printer.name, printer.logFilePath, `    Updated Spool-ID ${spool.id} => ${spool.filament.name}`);
                        // The record is the one this pass keeps working with, so
                        // what was just written has to be on it before anything
                        // decides whether the spool is empty.
                        spool.remaining_weight = remainingWeight;
                        await archiveWhenEmpty(printer, spool);
                    } catch (err) {
                        logSpoolmanFailure({ printerName: printer.name, logFilePath: printer.logFilePath }, "Spool update", err);
                    }

                    printer.lastUpdateTime = currentTime;
                } else {
                    // Default: weight is tracked from the sliced G-code on print
                    // completion (see handlePrintStateChange). Nothing is written
                    // here, and the line is held back on remain ticks so a spool
                    // that only reports a new percentage does not repeat itself.
                    // The location is claimed once for the whole update below.
                    if (meaningfulChange) {
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} [[ ${slot.tray_uuid} ]] => Spool-ID ${spool.id} (G-code mode)`);
                    }
                }

                break;
            }
        }
    }

    // An archived spool is gone from `spools`, which is what archiving is for,
    // and the slot it still sits in would therefore look like a spool Spoolman
    // has never seen: automatic mode would create a second record for the same
    // tag on the very next update. The archived list is checked before any of
    // that, and the slot is left alone.
    const archivedSpool = found ? null : spoolWithTag(archivedSpools, slot.tray_uuid);

    if (archivedSpool) {
        const newUiSpool = buildArchivedSpool(printer, amsId, slot, archivedSpool);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        if (hasSpoolUiChanged(newUiSpool, prevByAmsId[amsId])) {
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} [[ ${slot.tray_uuid} ]] => Spool-ID ${archivedSpool.id} (archived, empty)`);
        }
        pushSlotUpdate(printer, newUiSpool, prevByAmsId);
        return false;
    }

    if (!found) {
        console.debug(printer.name, printer.logFilePath, " Connected Spool not found, process with merging and creation logic");
        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain == null ? "remain unknown" : `${slot.remain}%`}) [[ ${slot.tray_uuid} ]]`);

        // The three automatic actions differ only in the option they stand for
        // and the Spoolman call they make, so they are run through one place.
        // The preview is what the slot would look like once the action has run:
        // a slot that has not changed since the last pass must not be written a
        // second time, which is what would create the same spool twice.
        //
        // Answers whether Spoolman was mutated, which is what tells the caller
        // its cached lists are stale.
        const runAutomatically = async (chosen, action) => {
            if (!automatic) return false;

            const prev = prevByAmsId[amsId];
            const preview = { amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, existingSpool, option: chosen, enableButton, slotState: "", error };
            if (prev && !hasSpoolUiChanged(preview, prev)) return false;

            const result = await action({ amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, printerName: printer.name, logFilePath: printer.logFilePath });

            // Only a write that happened makes the cached Spoolman lists stale.
            // A failed one used to count as one, which sent the caller off to
            // refetch a list that had not changed and let this slot look up a
            // spool that was never created.
            return result?.ok !== false;
        };

        mergeableSpool = spools.length !== 0 ? findMergeableSpool(slot, spools) : null;

        if (!mergeableSpool) {
            existingSpool = spools.length !== 0 ? findExistingSpool(slot, spools) : null;

            // Creating a spool writes its used weight, and that comes from the
            // AMS remain percentage, which is not there for the first seconds
            // after a spool goes in. Creating in that window stores a brand new
            // spool for a partly used one, and in G-code mode nothing corrects
            // the weight afterwards. Merging is deliberately not held back: it
            // only writes the tag, never a weight.
            const waitingForRemain = !existingSpool && !waitedLongEnoughForRemain(printer, amsId, slot);

            if (!existingSpool && waitingForRemain) {
                // Logged rather than debugged, and in both modes: in automatic
                // nobody is looking at the button, so without this line the
                // service just appears to ignore the slot for a minute.
                const waits = printer.remainWaits?.[amsId]?.waits ?? 0;
                console.log(printer.name, printer.logFilePath, `    Waiting for the AMS to report how much is left before creating a spool (${waits}/${MAX_REMAIN_WAITS})`);
                option = SLOT_OPTIONS.WAITING;
                enableButton = "false";
            } else if (!existingSpool) {
                if (matchingInternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament exists, create a Spool with this Data");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingInternalFilament.material}, Color: ${matchingInternalFilament.name}`);
                    if (await runAutomatically(SLOT_OPTIONS.CREATE, createSpool)) mutated = true;
                    option = SLOT_OPTIONS.CREATE;
                } else if (matchingExternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament does not exist. Create a new Filament");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingExternalFilament.material}, Color: ${matchingExternalFilament.name}`);
                    if (await runAutomatically(SLOT_OPTIONS.CREATE_WITH_FILAMENT, createFilamentAndSpool)) mutated = true;
                    option = SLOT_OPTIONS.CREATE_WITH_FILAMENT;
                } else {
                    console.error(printer.name, printer.logFilePath, "    No matching Filament found in Database, please check manually!");
                    error = true;
                }
            }
        } else {
            console.log(printer.name, printer.logFilePath, `    Found mergeable Spool => Spoolman Spool ID: ${mergeableSpool.id}, Material: ${mergeableSpool.filament.material}, Color: ${mergeableSpool.filament.name}`);
            if (await runAutomatically(SLOT_OPTIONS.MERGE, mergeSpool)) mutated = true;
            option = SLOT_OPTIONS.MERGE;
        }

        if (!automatic && option !== SLOT_OPTIONS.WAITING) enableButton = "true";
        printer.lastUpdateTime = new Date();

        // A create/merge just happened, so look the spool back up right away so
        // the UI reflects the real connection immediately. Without this, the
        // overview would stay on the pending "Create Spool" state until some
        // unrelated change happens to trigger reprocessing of this slot (the
        // creation itself doesn't count as a change once state.lastSpoolData
        // has already been refreshed to include it).
        if (mutated) {
            const freshSpools = await getSpoolmanSpools();
            const linked = freshSpools.find(
                s => s.extra?.tag && JSON.parse(s.extra.tag) === slot.tray_uuid
            );
            if (linked) {
                existingSpool = linked;
                found = true;
                option = SLOT_OPTIONS.NONE;
            }
        }
    }

    // Both stay null while the AMS has not reported a percentage yet, so the
    // dashboard shows a dash instead of a confident "0 g".
    const correctedRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    const correctedWeight = correctedRemain === null
        ? null
        : Math.round((correctedRemain / 100) * slot.tray_weight);

    // A manual assignment wins over the automatic tag match: it is the only way
    // for the user to resolve two tagged spools that are identical in
    // tray_info_idx and color, which the tag match alone cannot tell apart.
    //
    // Legacy mode skips this entirely. An assignment exists to tell the G-code
    // booking which spool to charge, and legacy books nothing: it writes the
    // weight straight onto the tag-connected spool. Offering it there would be
    // a button that changes nothing.
    const mappedSpool = legacyMode() ? null : resolveMappedSpool(printer, amsId, slot, spools, archivedSpools);
    if (mappedSpool) {
        existingSpool = mappedSpool;
        option = SLOT_OPTIONS.UNASSIGN;
        enableButton = "true";
    } else if (!legacyMode() && !found && option === SLOT_OPTIONS.NONE) {
        // Nothing to create or merge, and no tag link, so offer a manual assignment
        option = SLOT_OPTIONS.ASSIGN;
        enableButton = "true";
    }

    // Only a spool this slot is really connected to may claim it. `existingSpool`
    // can also be a mere merge/creation candidate found by filament match, which
    // is not in the AMS at all and must not be given its location.
    if ((found || mappedSpool) && !existingSpool?.archived) locationSync.claim(amsId, existingSpool);
    releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);

    const newUiSpool = {
        amsId,
        slot,
        mergeableSpool,
        matchingInternalFilament,
        matchingExternalFilament,
        existingSpool,
        // True only when the spool is physically connected to this slot via the
        // Spoolman extra.tag (= tray_uuid) match. Consumption is only booked to
        // these spools and to manually assigned ones, never to mere filament
        // candidates (findExistingSpool).
        connectedViaTag: found,
        connectedViaMapping: !!mappedSpool,
        archived: !!existingSpool?.archived,
        option,
        enableButton,
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (Bambu Lab)",
        error,
        correctedRemain,
        correctedWeight,
    };

    pushSlotUpdate(printer, newUiSpool, prevByAmsId);
    return mutated;
}

/**
 * Builds the UI entry for an empty slot: nothing matched, no action offered.
 *
 * A slot the AMS is currently reading looks exactly like an empty one until the
 * tray record arrives, so it is still built here, but it says "Waiting for
 * data" rather than claiming there is nothing to do. See `slotIsBusy()`.
 */
function buildEmptySpool(printer, amsId, slot) {
    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: null,
        option: slotIsBusy(slot) ? SLOT_OPTIONS.WAITING : SLOT_OPTIONS.NONE,
        enableButton: "false",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Empty",
        error: false,
    };
}

/**
 * Builds the UI entry for a slot holding a spool the printer could not
 * identify. Nothing about it can be matched automatically, so the only action
 * offered is assigning a Spoolman spool by hand, and the displayed weight comes
 * from that assignment rather than from the AMS.
 */
function buildThirdPartySpool(printer, amsId, slot, mappedSpool = null) {
    const correctedWeight = mappedSpool?.remaining_weight ?? null;

    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: mappedSpool,
        // Never true for a chipless spool. The link comes from the manual
        // assignment below, not from an RFID tag.
        connectedViaTag: false,
        connectedViaMapping: !!mappedSpool,
        archived: !!mappedSpool?.archived,
        correctedWeight,
        // Legacy mode offers nothing here. Its weight comes from the RFID
        // percentage, which this spool does not report, so there is no action
        // that would do anything.
        option: legacyMode() ? SLOT_OPTIONS.NONE : (mappedSpool ? SLOT_OPTIONS.UNASSIGN : SLOT_OPTIONS.ASSIGN),
        enableButton: legacyMode() ? "false" : "true",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (3rd party)",
        error: false,
    };
}

/**
 * The spool in `list` whose Spoolman `extra.tag` holds this slot's `tray_uuid`.
 *
 * The tag is stored JSON encoded, and a hand edited one that is not decodes to
 * nothing rather than throwing here, which would otherwise take down the whole
 * AMS update for one bad record.
 *
 * @param {object[]} list - Spoolman spools to search
 * @param {string} trayUuid - the slot's tag
 * @returns {object|null}
 */
function spoolWithTag(list, trayUuid) {
    if (!trayUuid) return null;

    return (list || []).find(spool => {
        if (!spool?.extra?.tag) return false;
        try {
            return JSON.parse(spool.extra.tag) === trayUuid;
        } catch {
            return false;
        }
    }) || null;
}

/**
 * Builds the UI entry for a slot still holding a spool that was archived
 * because it ran empty.
 *
 * No action is offered: creating or merging would give the same physical spool
 * a second record, and assigning another spool to a slot that reports its own
 * tag is not what the mapping is for. Taking the spool out is the answer, and
 * restoring it in Spoolman is what brings the slot back to normal.
 */
function buildArchivedSpool(printer, amsId, slot, archivedSpool) {
    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: archivedSpool,
        // Deliberately not a connection: a booking onto an archived spool would
        // bring it back into the numbers the user just archived away, and the
        // location sync would hand it the slot it is sitting in again.
        connectedViaTag: false,
        connectedViaMapping: false,
        archived: true,
        correctedWeight: archivedSpool.remaining_weight ?? null,
        option: SLOT_OPTIONS.NONE,
        enableButton: "false",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (archived)",
        error: false,
    };
}

/**
 * Looks up the manually assigned Spoolman spool for a slot. Returns null when
 * nothing is assigned, when the assignment went stale (different filament in
 * the slot now, getMapping drops it), or when the assigned spool no longer
 * exists in Spoolman.
 */
function resolveMappedSpool(printer, amsId, slot, spools, archivedSpools) {
    const mapping = getMapping(printer.id, amsId, slot);
    if (!mapping) return null;

    // The archived list is searched as well, or archiving an assigned spool
    // would read as "the spool is gone from Spoolman" and throw the assignment
    // away, which is not something the user asked for and cannot be undone by
    // restoring the spool.
    const spool = [...(spools || []), ...(archivedSpools || [])].find(s => s.id === mapping.spoolId);
    if (!spool) {
        console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId}: assigned spool ${mapping.spoolId} no longer exists in Spoolman, dropping assignment`);
        clearMapping(printer.id, amsId);
        return null;
    }

    return spool;
}

/**
 * Records a UI spool for this AMS update and broadcasts it, but only when
 * something the user sees actually changed.
 *
 * A slot with no previous entry counts as changed, so the first pass sends
 * everything. There used to be a second condition, holding back every slot the
 * printer had not fully identified, which meant an emptied slot never reached
 * the UI and its row kept showing the spool that had been taken out. It was
 * guarding against sparse payloads overwriting a populated row, which was the
 * old occupancy bug rather than a real case, and `hasSpoolUiChanged` already
 * suppresses everything that would not change the display.
 */
function pushSlotUpdate(printer, newUiSpool, prevByAmsId) {
    if (hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
        broadcastSlotUpdate(printer.id, newUiSpool);
    }
    printer.spoolData.push(newUiSpool);
}

/**
 * Opens the MQTT connection to a printer and subscribes to its report topic.
 *
 * Guarded against concurrent and rapid retries: an attempt is skipped while one
 * is already running, while the connection is up, or within a 30 second
 * cooldown of the last attempt. With a retry limit set, repeated failures disable
 * monitoring for that printer instead of retrying forever.
 *
 * Neither the close nor the error handler reschedules itself. monitorPrinters
 * is the only place that retries.
 *
 * @param {object} printer - the printer runtime object
 */
/**
 * Closes the MQTT connection of a printer on purpose.
 *
 * Every deliberate disconnect goes through here, so that the "close" handler can
 * tell one from a connection the printer or the network dropped. Without that it
 * announced that the monitor loop would retry within the offline check interval,
 * which is wrong whenever a reconnect has already been started or the process is
 * shutting down, and the line then sits in the log directly above the successful
 * reconnect reading as though nothing had happened.
 *
 * @param {object} printer - the runtime printer
 * @param {string} reason - completes "Connection closed, ..." in the log
 * @param {boolean} [force] - end the client without waiting for the broker
 */
export function closeMqtt(printer, reason, force = false) {
    printer.closingReason = reason;

    if (printer.mqttClient) {
        printer.mqttClient.end(force);
        printer.mqttClient = null;
    }

    printer.mqttRunning = false;
}

export async function setupMqtt(printer) {
    const now = Date.now();
    const COOLDOWN_PERIOD = 30000;

    printer.lastReconnectAttempt = printer.lastReconnectAttempt || 0;
    printer.reconnectAttempts = printer.reconnectAttempts || 0;

    if (printer.mqttRunning || printer.isReconnecting || (now - printer.lastReconnectAttempt < COOLDOWN_PERIOD)) {
        return;
    }

    printer.isReconnecting = true;
    printer.lastReconnectAttempt = now;

    try {
        console.log(printer.name, printer.logFilePath, `Setting up MQTT connection for Printer: ${printer.id}...`);

        const client = await mqtt.connectAsync(`tls://bblp:${printer.code}@${printer.ip}:8883`, {
            rejectUnauthorized: false,
        });

        printer.mqttStatus = "Connected";
        printer.mqttRunning = true;
        printer.mqttClient = client;
        printer.reconnectAttempts = 0;
        printer.isReconnecting = false;

        console.log(printer.name, printer.logFilePath, `MQTT client connected for Printer: ${printer.id}`);
        await client.subscribeAsync(`device/${printer.id}/report`);

        client.on("message", (topic, message) => {
            handleMqttMessage(printer, topic, message);
        });

        client.on("close", () => {
            // A deliberate reconnect ends this client and builds a new one right
            // away, so this can arrive when the printer already has a newer
            // connection. Resetting the state then would tear down the live one
            // and leave the monitor loop to pick the printer up again.
            if (printer.mqttClient && printer.mqttClient !== client) return;

            printer.mqttStatus = "Disconnected";
            printer.mqttRunning = false;
            printer.mqttClient = null;

            // Set by closeMqtt() when this close was asked for. Saying the
            // monitor loop will retry is wrong then: either something is already
            // reconnecting, or the process is on its way out.
            const reason = printer.closingReason;
            printer.closingReason = null;

            if (reason) {
                console.log(printer.name, printer.logFilePath, ` Connection closed, ${reason}`);
                return;
            }

            // No self-rescheduling here. monitorPrinters() is the single
            // place driving reconnect attempts (polls every offline check interval
            // and calls setupMqtt() again once mqttRunning is false). Having
            // both this handler and that loop independently retry used to
            // race and made the actual retry cadence hard to reason about.
            if (printer.monitoringEnabled) {
                console.log(printer.name, printer.logFilePath, ` Connection closed, will retry within ${formatInterval(settings.OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
            }
        });

        client.on("error", async (error) => {
            console.error(printer.name, printer.logFilePath, `MQTT error for Printer: ${printer.id} - ${error.message}`);
            client.end();
        });

        console.log(printer.name, printer.logFilePath, `Waiting for MQTT messages for Printer: ${printer.id}...`);
    } catch (error) {
        printer.mqttStatus = "Error";
        printer.mqttRunning = false;
        printer.reconnectAttempts++;
        printer.isReconnecting = false;

        if (!printer.monitoringEnabled) return;

        console.error(printer.name, printer.logFilePath, `Error in setupMqtt for Printer: ${printer.id} - ${error.message}`);

        if (settings.MAX_RETRIES > 0 && printer.reconnectAttempts >= settings.MAX_RETRIES) {
            console.log(printer.name, printer.logFilePath, `Max retries (${settings.MAX_RETRIES}) reached -> disabling monitoring!`);
            printer.monitoringEnabled = false;
            broadcastSSE({ type: "monitoring_update", printer: printer.id, enabled: false });
            printer.mqttRunning = false;
            printer.mqttStatus = "Disabled";
            return;
        }

        // No self-rescheduling here either, see the comment in the "close"
        // handler above. monitorPrinters() will retry within the offline check interval.
        console.log(printer.name, printer.logFilePath, ` Connection failed, will retry within ${formatInterval(settings.OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
    }
}

/**
 * Checks whether a printer accepts an MQTT connection and actually reports on
 * the topic of the configured serial number, without touching the connection
 * the monitor loop maintains.
 *
 * Uses its own short lived client, so a printer that is already being monitored
 * keeps running while the test is made. Subscribing alone proves nothing: the
 * printer accepts a subscription to any topic, including the one of a serial
 * number that is not its own. Only an arriving report does, which is why the
 * test waits for one. A connection without a report is reported as a warning
 * rather than a failure, because a printer really can stay silent for a moment.
 *
 * @param {{id: string, ip: string, code: string}} printer - what to try
 * @param {number} [timeout] - milliseconds before the connection is given up
 * @param {number} [listenTimeout] - milliseconds to wait for the first report
 * @returns {Promise<{ok: boolean, error?: string, warning?: string, detail?: string}>}
 */
export async function testMqttConnection(printer, timeout = 8000, listenTimeout = 6000) {
    let client = null;

    try {
        client = await mqtt.connectAsync(`tls://bblp:${printer.code}@${printer.ip}:8883`, {
            rejectUnauthorized: false,
            connectTimeout: timeout,
            reconnectPeriod: 0,
        });

        const topic = `device/${printer.id}/report`;
        await client.subscribeAsync(topic);

        const reported = await waitForFirstMessage(client, listenTimeout);
        if (reported) return { ok: true };

        return {
            ok: true,
            warning: `Connected, but nothing arrived on ${topic}. Check the serial number if this stays empty.`,
        };
    } catch (err) {
        const detail = err?.message || String(err);
        return { ok: false, error: describeMqttError(err), detail };
    } finally {
        // force close, the test must not linger as a second session
        client?.end(true);
    }
}

/**
 * Resolves true on the first message the client receives, false when the wait
 * runs out. Always removes its listener, so the client can be closed cleanly.
 *
 * @returns {Promise<boolean>} whether a message arrived in time
 */
function waitForFirstMessage(client, timeout) {
    return new Promise(resolve => {
        const done = (result) => {
            clearTimeout(timer);
            client.removeListener("message", onMessage);
            resolve(result);
        };
        const onMessage = () => done(true);
        const timer = setTimeout(() => done(false), timeout);

        client.on("message", onMessage);
    });
}

/**
 * Turns an MQTT failure into something a user can act on. A rejected access
 * code and an unreachable address both surface as a connection error, but they
 * need completely different fixes.
 */
function describeMqttError(err) {
    const message = err?.message || String(err);

    if (/Not authorized|Bad username or password|code: [45]/.test(message)) return "The printer rejected the access code";
    if (/ECONNREFUSED/.test(message)) return "Port 8883 refused the connection";
    if (/ETIMEDOUT|timeout|Timeout/.test(message)) return "No answer on port 8883 within the timeout. Is LAN mode enabled?";
    if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(message)) return "The address cannot be reached";

    return message;
}

/**
 * Drops the growing wait between the reachability checks of an offline printer.
 *
 * The backoff exists to stop the monitor loop asking a printer that is switched
 * off every twenty seconds. A user who pressed a button is not the monitor loop,
 * so resuming monitoring, reconnecting or editing a printer clears it, exactly
 * as they clear the reconnect cooldown of `setupMqtt()`. Without this, a printer
 * switched back on would wait out a five minute backoff before anything tried.
 *
 * @param {object} printer - the runtime printer
 */
export function resetOfflineBackoff(printer) {
    printer.offlineChecks = 0;
    printer.nextCheckAt = 0;
    printer.offlineWaitLogged = null;
}

/**
 * Records that a printer answered, and says whether it had been away.
 *
 * @param {object} printer - the runtime printer
 * @returns {boolean} whether this is the first answer after failed checks
 */
function printerIsBack(printer) {
    const wasOffline = (printer.offlineChecks || 0) > 0;
    resetOfflineBackoff(printer);
    return wasOffline;
}

/**
 * Records a failed reachability check and schedules the next one.
 *
 * The wait grows with every failure, up to the configured limit, which is what
 * keeps a printer that is switched off most of the time from being asked every
 * twenty seconds for hours. It also decides whether this failure is worth a log
 * line: only a wait that differs from the one already announced is, so a printer
 * that stays off produces one line per backoff step and then nothing, instead of
 * the same line forever.
 *
 * @param {object} printer - the runtime printer
 * @param {number} now - the current timestamp
 */
function printerStillOffline(printer, now) {
    const wait = offlineBackoff(printer.offlineChecks || 0, settings.OFFLINE_CHECK_INTERVAL, settings.OFFLINE_MAX_INTERVAL);

    printer.offlineChecks = (printer.offlineChecks || 0) + 1;
    printer.nextCheckAt = now + wait;
    printer.mqttStatus = "Disconnected";
    printer.mqttRunning = false;

    if (printer.offlineWaitLogged === wait) {
        console.debug(printer.name, printer.logFilePath, `Printer ${printer.id} is still unreachable, next try in ${formatInterval(wait)}`);
        return;
    }

    printer.offlineWaitLogged = wait;
    console.error(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is unreachable. Next try in ${formatInterval(wait)}...`);
}

/**
 * Runs forever, reconnecting printers that are reachable but not connected.
 *
 * This is the single retry driver for MQTT. On every offline check interval each
 * enabled printer is probed with a plain TCP connect before setupMqtt is
 * attempted, so an unreachable printer costs one short timeout rather than a
 * hanging MQTT handshake. The whole loop idles while Spoolman is down, since
 * there would be nothing to write AMS data to.
 *
 * A printer that does not answer is asked again on a growing interval rather
 * than on every tick, see `printerStillOffline()`. The loop keeps ticking at the
 * check interval, because the printers are on their own schedules and a printer
 * added or re-enabled in the Web UI has to be picked up quickly.
 *
 * @param {object[]} printers - the printer list
 */
export async function monitorPrinters(printers) {
    while (true) {
        if (state.spoolmanStatus === "Disconnected") {
            await sleep(RECONNECT_INTERVAL);
            continue;
        }

        for (const printer of printers) {
            if (!printer.monitoringEnabled) {
                printer.mqttRunning = false;
                printer.mqttStatus = "Disabled";
                continue;
            }

            const now = Date.now();
            // Not yet due: this printer failed its last check and is waiting out
            // its backoff. A connected one has no wait, so it is never skipped.
            if (printer.nextCheckAt && now < printer.nextCheckAt) continue;

            try {
                const isAlive = await checkPrinterAvailability(printer.ip, 8883);

                if (isAlive) {
                    if (printerIsBack(printer)) {
                        console.log(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is reachable again`);
                    }

                    if (!printer.mqttRunning && !printer.isReconnecting) {
                        if (settings.MAX_RETRIES > 0 && printer.reconnectAttempts >= settings.MAX_RETRIES) {
                            printer.monitoringEnabled = false;
                            printer.mqttRunning = false;
                            printer.mqttStatus = "Disabled";
                            console.log(printer.name, printer.logFilePath, "Monitoring disabled (max retries reached).");
                            continue;
                        }
                        console.log(printer.name, printer.logFilePath, `MQTT not running for Printer: ${printer.id}, attempting to reconnect...`);
                        setupMqtt(printer);
                    }
                } else {
                    if (settings.MAX_RETRIES > 0 && printer.reconnectAttempts >= settings.MAX_RETRIES) {
                        printer.monitoringEnabled = false;
                        printer.mqttRunning = false;
                        printer.mqttStatus = "Disabled";
                        console.log(printer.name, printer.logFilePath, "Printer is unreachable and the retry limit is exceeded, monitoring disabled.");
                        continue;
                    }
                    printerStillOffline(printer, now);
                }
            } catch (error) {
                console.error(printer.name, printer.logFilePath, `Error monitoring Printer: ${printer.id} - ${error.message}`);
            }
        }
        await sleep(settings.OFFLINE_CHECK_INTERVAL);
    }
}

/**
 * Blocks until Spoolman reports healthy, polling every 30 seconds.
 *
 * Called once during startup: without Spoolman there is nothing to sync to, so
 * the service waits here rather than starting up half working.
 */
export async function monitorSpoolman() {
    while (true) {
        try {
            const spoolmanHealthApi = await got(`${spoolmanUrl()}/api/v1/health`);
            const spoolmanHealth = JSON.parse(spoolmanHealthApi.body);

            if (spoolmanHealth.status === "healthy") {
                if (state.spoolmanStatus !== "Connected") {
                    console.log("Server", serverLogFilePath, "Spoolman connected successfully!");
                }
                state.spoolmanStatus = "Connected";
                return;
            } else {
                console.error("Server", serverLogFilePath, "Spoolman reported an unhealthy status, retrying...");
            }
        } catch {
            console.error("Server", serverLogFilePath, "Spoolman is unreachable. Retrying in 30 seconds...");
        }
        await sleep(30000);
    }
}

/**
 * Runs forever, keeping the Spoolman connection status current.
 *
 * Unlike monitorSpoolman this never blocks anything; it only flips the shared
 * status, which the MQTT handler checks before processing AMS data.
 */
export async function monitorSpoolmanBackground() {
    while (true) {
        try {
            const spoolmanHealthApi = await got(`${spoolmanUrl()}/api/v1/health`);
            const spoolmanHealth = JSON.parse(spoolmanHealthApi.body);

            if (spoolmanHealth.status === "healthy") {
                if (state.spoolmanStatus !== "Connected") {
                    console.log("Server", serverLogFilePath, "Spoolman reconnected successfully!");
                }
                state.spoolmanStatus = "Connected";
            } else {
                console.error("Server", serverLogFilePath, "Spoolman reported an unhealthy status!");
                state.spoolmanStatus = "Disconnected";
            }
        } catch {
            console.error("Server", serverLogFilePath, "Spoolman is unreachable. Retrying in 60 seconds...");
            state.spoolmanStatus = "Disconnected";
        }
        await sleep(60000);
    }
}

/**
 * Whether a plain TCP connection to the printer succeeds within the timeout.
 * Used as a cheap reachability probe before attempting an MQTT handshake.
 *
 * @returns {Promise<boolean>} always resolves, never rejects
 */
function checkPrinterAvailability(host, port, timeout = 5000) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;

        socket.setTimeout(timeout);
        socket.on("connect", () => { done = true; socket.destroy(); resolve(true); });
        socket.on("timeout", () => { if (!done) { done = true; socket.destroy(); resolve(false); } });
        socket.on("error", () => { if (!done) { done = true; resolve(false); } });
        socket.connect(port, host);
    });
}
