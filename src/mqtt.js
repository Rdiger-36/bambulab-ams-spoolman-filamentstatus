import mqtt from "async-mqtt";
import got from "got";
import * as net from "node:net";
import {
    SPOOLMAN_URL,
    serverLogFilePath,
    MODE,
    MAX_RETRIES,
    OFFLINE_CHECK_INTERVAL,
    RECONNECT_INTERVAL,
    UPDATE_INTERVAL,
    SET_LOCATION,
    LEGACY_MODE,
} from "./config.js";
import { originalConsoleLog } from "./logger.js";
import { state } from "./state.js";
import { sleep, formatDate, formatInterval, convertAMSandSlot } from "./utils.js";
import {
    getSpoolmanSpools,
    getSpoolmanInternalFilaments,
    getSpoolmanExternalFilaments,
    createSpool,
    createFilamentAndSpool,
    mergeSpool,
    patchSpoolWeight,
    patchSpoolLocation,
    useSpoolWeight,
} from "./spoolman.js";
import { fetchSliceInfo, calcFullConsumption, calcPartialConsumption, consumptionKey, normColor } from "./gcode.js";
import { getMapping, clearMapping } from "./mappings.js";
import {
    processData,
    extractComparableTrayData,
    correctRemainInt,
    slotIsOccupied,
    findExistingSpool,
    findMatchingExternalFilament,
    findMatchingInternalFilament,
    findMergeableSpool,
    haveSpoolDataChanged,
    shouldSendSlotUpdate,
    hasSpoolUiChanged,
} from "./ams.js";

/** Strips server-only fields from a UI spool before it goes out to a client. */
function sanitizeSpoolForClient({ logFilePath, printerName, ...rest }) {
    return rest;
}

/**
 * Sends an event to every connected SSE client. A payload that cannot be
 * serialised is dropped with a log line rather than taking the handler down.
 */
function broadcastSSE(data) {
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
    broadcastSSE({ type: "slot_update", printer: printerId, spool: sanitizeSpoolForClient(spool) });
}

// Print states that signal the end of a print job
const TERMINAL_STATES = new Set(["FINISH", "FAILED", "CANCEL"]);
// Print states that indicate an active or paused job
const ACTIVE_STATES = new Set(["PREPARE", "RUNNING", "PAUSE"]);

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
        printer.consumptionBooked = false;
        printer.sliceFetchDone    = false;
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

    // Update tracked state
    printer.currentGcodeState = newState;

    // Book consumption on transition into a terminal state
    if (TERMINAL_STATES.has(newState) && ACTIVE_STATES.has(prevState) && !printer.consumptionBooked) {
        printer.consumptionBooked = true;

        if (!printer.currentSliceInfo) {
            console.log(printer.name, printer.logFilePath, `[Print] ${newState}, no slice info cached, skipping consumption tracking`);
            return;
        }

        const consumption = newState === "FINISH"
            ? calcFullConsumption(printer.currentSliceInfo)
            : calcPartialConsumption(printer.currentSliceInfo, layerNum);

        console.log(printer.name, printer.logFilePath, `[Print] ${newState}, booking filament consumption:`, JSON.stringify(consumption));
        await bookConsumption(printer, consumption);
    }
}

/**
 * Fallback identity for a filament, used when no tray_info_idx is available.
 * Mirrored client side in public/frontend.js.
 */
function materialKey(type, color) {
    return `${type || "?"}|${normColor(color)}`;
}

/**
 * Books the consumed grams in Spoolman for each filament of a finished print.
 *
 * A slot is only booked when we actually know which physical spool sits in it:
 * either through the Spoolman extra.tag field (= the slot's tray_uuid, Bambu Lab
 * spools only) or through a manual assignment made in the UI. Filament
 * candidates that merely match by type are never touched.
 *
 * Slots are matched to slice filaments in three stages, most specific first:
 *   1. tray_info_idx + color: exact material profile, separates e.g. PLA Black
 *                             from PLA Jade White despite a shared profile
 *   2. material type + color: for 3rd-party spools, which report no usable
 *                             tray_info_idx
 *   3. tray_info_idx alone:   colors did not line up but the profile is unique
 *
 * Within a stage, manually assigned spools win over tag-connected ones: an
 * assignment is the user explicitly resolving what the automatic match cannot,
 * namely two connected spools identical in both profile and color.
 */
async function bookConsumption(printer, consumption) {
    if (!printer.spoolData?.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No spool data available for consumption booking");
        return;
    }

    const candidates = [];
    for (const uiSpool of printer.spoolData) {
        const mapped = !!uiSpool.connectedViaMapping;
        if (!mapped && !uiSpool.connectedViaTag) continue;

        const id = uiSpool.existingSpool?.id;
        if (!id) continue;

        const idx = uiSpool.slot?.tray_info_idx || null;
        candidates.push({
            id,
            amsId:  uiSpool.amsId,
            mapped,
            idx,
            key:    idx ? consumptionKey(idx, uiSpool.slot?.tray_color) : null,
            matKey: materialKey(uiSpool.slot?.tray_type, uiSpool.slot?.tray_color),
        });
    }

    if (!candidates.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No connected or assigned spools, nothing to book");
        return;
    }

    const lastUsed = new Date().toISOString();

    for (const info of Object.values(consumption)) {
        const { tray_info_idx: idx, color, type, grams } = info;
        if (grams <= 0) continue;

        const wantedKey    = consumptionKey(idx, color);
        const wantedMatKey = materialKey(type, color);

        let matches = [];
        for (const predicate of [
            c => c.key === wantedKey,
            c => c.matKey === wantedMatKey,
            c => c.idx && c.idx === idx,
        ]) {
            matches = candidates.filter(predicate);
            if (matches.length) break;
        }

        if (!matches.length) {
            console.log(printer.name, printer.logFilePath, `[Print] No connected or assigned Spoolman spool for ${idx} ${type} (${color}), skipping ${grams}g (assign the spool in the Web UI to track it)`);
            continue;
        }

        // A manual assignment is the user's explicit answer, so it outranks any
        // automatic match found in the same stage.
        const mapped = matches.filter(c => c.mapped);
        if (mapped.length) matches = mapped;

        if (matches.length > 1) {
            console.warn(printer.name, printer.logFilePath, `[Print] ${matches.length} spools are indistinguishable for ${idx} ${type} (${color}), booking the full ${grams}g to spool ${matches[0].id} (${matches[0].amsId}); assign the spools manually in the Web UI to split correctly`);
        }

        const { id: spoolId } = matches[0];
        try {
            await useSpoolWeight(spoolId, grams, lastUsed);
            console.log(printer.name, printer.logFilePath, `[Print] Booked ${grams}g for spool ${spoolId} (${matches[0].amsId}, ${idx} ${type} ${color}${matches[0].mapped ? ", manually assigned" : ""})`);
        } catch (err) {
            console.error(printer.name, printer.logFilePath, `[Print] Failed to book consumption for spool ${spoolId}: ${err.message}`);
        }
    }
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
            if (!LEGACY_MODE && data?.print?.gcode_state) {
                await handlePrintStateChange(printer, data.print);
            }

            console.debug(printer.name, printer.logFilePath, "Check if message contains AMS Data");

            if (data?.print?.ams?.ams) {
                const currentTime = new Date();
                console.debug(printer.name, printer.logFilePath, "Check next Update Interval");

                const intervalElapsed = currentTime.getTime() - printer.lastUpdateTime.getTime() > printer.update_interval;
                if (intervalElapsed || printer.first_run) {
                    const wasFirstRun = printer.first_run;
                    printer.first_run = false;
                    const isValidAmsData = data.print.ams.humidity !== "" && data.print.ams.temp !== "";

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

                        const spoolsChanged = await haveSpoolDataChanged(spools, state.lastSpoolData);
                        const processedAmsData = processData(data.print.ams.ams);
                        const newTrayData = extractComparableTrayData(processedAmsData);
                        const lastTrayData = extractComparableTrayData(printer.lastAmsData || []);
                        // In G-code mode the AMS remain % is irrelevant (weight is
                        // tracked from the slice), so don't let it trigger reprocessing
                        // and log output. Only react to real identity/weight changes.
                        const stripRemain = (d) => LEGACY_MODE ? d
                            : d.map(a => ({ ...a, tray: a.tray.map(({ remain, ...t }) => t) }));
                        const trayDataChanged =
                            JSON.stringify(stripRemain(newTrayData)) !== JSON.stringify(stripRemain(lastTrayData));

                        if (isValidAmsData && (spoolsChanged || trayDataChanged)) {
                            console.debug(printer.name, printer.logFilePath, "Loaded AMS Spools:");
                            console.debug(printer.name, printer.logFilePath, JSON.stringify(processedAmsData));

                            const prevByAmsId = Object.fromEntries(
                                (printer.spoolData || []).map(s => [s.amsId, s])
                            );
                            printer.spoolData = [];

                            for (const ams of processedAmsData) {
                                if (!Array.isArray(ams.tray)) {
                                    console.debug(printer.name, printer.logFilePath, "Data from Slots are not valid");
                                    continue;
                                }

                                for (const slot of ams.tray) {
                                    const mutated = await processSlot(printer, ams, slot, spools, externalFilaments, internalFilaments, prevByAmsId, currentTime);

                                    // Only refetch when this slot actually created/merged a
                                    // spool or filament in Spoolman. Otherwise the cached
                                    // lists from the top of this AMS update are still valid,
                                    // avoiding redundant HTTP calls for every slot.
                                    if (mutated) {
                                        spools = await getSpoolmanSpools();
                                        externalFilaments = await getSpoolmanExternalFilaments();
                                        internalFilaments = await getSpoolmanInternalFilaments();
                                    }
                                }
                            }

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
                            console.log(printer.name, printer.logFilePath, `No new AMS Data or changes in Spoolman found. Processing AMS Data for this printer will be paused until ${nextUpdate} (${UpdateIntSec} seconds)...`);
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
 * Clears the Spoolman location of the spool that used to sit in this slot when
 * a different one is there now, so a removed spool does not keep claiming an
 * AMS slot as its location. No-op unless SET_LOCATION is on.
 */
async function clearLocationIfSpoolChanged(printer, amsId, currentSpoolId, prevByAmsId) {
    if (!SET_LOCATION) return;
    const prevSpoolId = prevByAmsId[amsId]?.existingSpool?.id ?? null;
    if (prevSpoolId && prevSpoolId !== currentSpoolId) {
        try {
            await patchSpoolLocation(prevSpoolId, "");
            console.log(printer.name, printer.logFilePath, `    Cleared location for Spool-ID ${prevSpoolId} (removed from ${amsId})`);
        } catch (err) {
            console.error(printer.name, printer.logFilePath, `    Failed to clear location for Spool-ID ${prevSpoolId}:`, err.message);
        }
    }
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
 * @param {object[]} externalFilaments - the SpoolmanDB catalogue
 * @param {object[]} internalFilaments - filaments in this Spoolman instance
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {Date} currentTime - timestamp shared across this AMS update
 * @returns {Promise<boolean>} whether Spoolman was mutated, which tells the
 *   caller its cached lists are stale and have to be refetched
 */
async function processSlot(printer, ams, slot, spools, externalFilaments, internalFilaments, prevByAmsId, currentTime) {
    const amsId = await convertAMSandSlot(ams.id, slot.id);
    const validSlot = Object.keys(slot).length > 6;

    if (!validSlot) {
        console.debug(printer.name, printer.logFilePath, "No Data found in Slots");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        await clearLocationIfSpoolChanged(printer, amsId, null, prevByAmsId);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot);
        return false;
    }

    // An unidentified spool looks exactly like an empty slot in every field but
    // `state`, so an occupied slot must not be swallowed by this branch.
    if ((slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") && (slot.tray_weight === 0 || slot.tray_weight === "0") && (!slot.tray_type || slot.tray_type === "") && !slotIsOccupied(slot)) {
        console.debug(printer.name, printer.logFilePath, "No Data found in Slots (empty slot with N/A values)");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        await clearLocationIfSpoolChanged(printer, amsId, null, prevByAmsId);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot);
        return false;
    }

    // Reached by anything the printer could not identify, including a slot whose
    // only sign of life is `state`, which the empty branch above no longer takes.
    if (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") {
        console.debug(printer.name, printer.logFilePath, "Slot is read-only (3rd party spool)");
        // The printer may know the material because the user set it on the AMS;
        // when it does not, leave the placeholder rather than blanking the field.
        if (slot.tray_type) slot.tray_sub_brands = slot.tray_type;

        // No RFID chip means no extra.tag link in Spoolman, so the only way to
        // know which spool sits here is a manual assignment made in the UI.
        const mappedSpool = resolveMappedSpool(printer, amsId, slot, spools);
        const newUiSpool = buildThirdPartySpool(printer, amsId, slot, mappedSpool);
        await clearLocationIfSpoolChanged(printer, amsId, mappedSpool?.id ?? null, prevByAmsId);
        if (shouldSendSlotUpdate(slot, printer.first_run) && hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
            broadcastSlotUpdate(printer.id, newUiSpool);
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_type} ${slot.tray_color} [[ ${slot.tray_uuid} ]]`);
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
    let option = "No actions available";
    let enableButton = "false";
    let error = false;
    let mutated = false;
    const automatic = MODE === "automatic";

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

                if (LEGACY_MODE) {
                    // Legacy: derive remaining weight from the AMS RFID remain %
                    if (!slotChanged) {
                        console.debug(printer.name, printer.logFilePath, " No change for connected spool; skipping PATCH");
                        break;
                    }

                    const remainingWeight = Math.round((currRemain / 100) * slot.tray_weight);
                    const newLocation = SET_LOCATION ? `${printer.name} - ${amsId}` : null;

                    console.debug(printer.name, printer.logFilePath, "    Sending PATCH request to:", `${SPOOLMAN_URL}/api/v1/spool/${spool.id}`);
                    console.debug(printer.name, printer.logFilePath, "    Payload:", JSON.stringify({ remaining_weight: remainingWeight, last_used: currentTime, ...(newLocation && { location: newLocation }) }));

                    try {
                        await patchSpoolWeight(spool.id, remainingWeight, currentTime, newLocation);
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${currRemain}%) [[ ${slot.tray_uuid} ]]`);
                        console.log(printer.name, printer.logFilePath, `    Updated Spool-ID ${spool.id} => ${spool.filament.name}`);
                    } catch (err) {
                        console.error(printer.name, printer.logFilePath, "   #####");
                        console.error(printer.name, printer.logFilePath, "   Spool update failed:", err.message);
                        console.error(printer.name, printer.logFilePath, "   Error details:", err.response?.statusCode, err.response?.body || err.stack);
                        console.error(printer.name, printer.logFilePath, "   #####");
                    }

                    printer.lastUpdateTime = currentTime;
                } else {
                    // Default: weight is tracked from the sliced G-code on print
                    // completion (see handlePrintStateChange). Here we only log /
                    // sync location on real identity changes, not on remain ticks.
                    if (meaningfulChange) {
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} [[ ${slot.tray_uuid} ]] => Spool-ID ${spool.id} (G-code mode)`);

                        if (SET_LOCATION) {
                            try {
                                await patchSpoolLocation(spool.id, `${printer.name} - ${amsId}`);
                            } catch (err) {
                                console.error(printer.name, printer.logFilePath, "   Location update failed:", err.message);
                            }
                        }
                    }
                }

                break;
            }
        }
    }

    if (!found) {
        console.debug(printer.name, printer.logFilePath, " Connected Spool not found, process with merging and creation logic");
        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);

        mergeableSpool = spools.length !== 0 ? findMergeableSpool(slot, spools) : null;

        if (!mergeableSpool) {
            existingSpool = spools.length !== 0 ? findExistingSpool(slot, spools) : null;

            if (!existingSpool) {
                if (matchingInternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament exists, create a Spool with this Data");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingInternalFilament.material}, Color: ${matchingInternalFilament.name}`);
                    if (automatic) {
                        const prev = prevByAmsId[amsId];
                        const preview = { amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, existingSpool, option: "Create Spool", enableButton, slotState: "", error };
                        if (!prev || hasSpoolUiChanged(preview, prev)) {
                            await createSpool({ amsId, slot, matchingInternalFilament, matchingExternalFilament, printerName: printer.name, logFilePath: printer.logFilePath });
                            mutated = true;
                        }
                    }
                    option = "Create Spool";
                } else if (matchingExternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament does not exist. Create a new Filament");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingExternalFilament.material}, Color: ${matchingExternalFilament.name}`);
                    if (automatic) {
                        const prev = prevByAmsId[amsId];
                        const preview = { amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, existingSpool, option: "Create Filament & Spool", enableButton, slotState: "", error };
                        if (!prev || hasSpoolUiChanged(preview, prev)) {
                            await createFilamentAndSpool({ amsId, slot, matchingInternalFilament, matchingExternalFilament, printerName: printer.name, logFilePath: printer.logFilePath });
                            mutated = true;
                        }
                    }
                    option = "Create Filament & Spool";
                } else {
                    console.error(printer.name, printer.logFilePath, "    No matching Filament found in Database, please check manually!");
                    error = true;
                }
            }
        } else {
            console.log(printer.name, printer.logFilePath, `    Found mergeable Spool => Spoolman Spool ID: ${mergeableSpool.id}, Material: ${mergeableSpool.filament.material}, Color: ${mergeableSpool.filament.name}`);
            if (automatic) {
                const prev = prevByAmsId[amsId];
                const preview = { amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, existingSpool, option: "Merge Spool", enableButton, slotState: "", error };
                if (!prev || hasSpoolUiChanged(preview, prev)) {
                    await mergeSpool({ amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, printerName: printer.name, logFilePath: printer.logFilePath });
                    mutated = true;
                }
            }
            option = "Merge Spool";
        }

        if (!automatic) enableButton = "true";
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
                option = "No actions available";
            }
        }
    }

    const correctedRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    const correctedWeight = Math.round((correctedRemain / 100) * slot.tray_weight);

    // A manual assignment wins over the automatic tag match: it is the only way
    // for the user to resolve two tagged spools that are identical in
    // tray_info_idx and color, which the tag match alone cannot tell apart.
    const mappedSpool = resolveMappedSpool(printer, amsId, slot, spools);
    if (mappedSpool) {
        existingSpool = mappedSpool;
        option = "Unassign Spool";
        enableButton = "true";
    } else if (!found && option === "No actions available") {
        // Nothing to create or merge, and no tag link, so offer a manual assignment
        option = "Assign Spool";
        enableButton = "true";
    }

    await clearLocationIfSpoolChanged(printer, amsId, existingSpool?.id ?? null, prevByAmsId);

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
        option,
        enableButton,
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (Bambu Lab)",
        error,
        correctedRemain,
        correctedWeight,
    };

    pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot);
    return mutated;
}

/** Builds the UI entry for an empty slot: nothing matched, no action offered. */
function buildEmptySpool(printer, amsId, slot) {
    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: null,
        option: "No actions available",
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
        correctedWeight,
        option: mappedSpool ? "Unassign Spool" : "Assign Spool",
        enableButton: "true",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (3rd party)",
        error: false,
    };
}

/**
 * Looks up the manually assigned Spoolman spool for a slot. Returns null when
 * nothing is assigned, when the assignment went stale (different filament in
 * the slot now, getMapping drops it), or when the assigned spool no longer
 * exists in Spoolman.
 */
function resolveMappedSpool(printer, amsId, slot, spools) {
    const mapping = getMapping(printer.id, amsId, slot);
    if (!mapping) return null;

    const spool = (spools || []).find(s => s.id === mapping.spoolId);
    if (!spool) {
        console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId}: assigned spool ${mapping.spoolId} no longer exists in Spoolman, dropping assignment`);
        clearMapping(printer.id, amsId);
        return null;
    }

    return spool;
}

/**
 * Records a UI spool for this AMS update and broadcasts it, but only when the
 * slot is worth sending and something the user sees actually changed.
 */
function pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot) {
    if (shouldSendSlotUpdate(slot, printer.first_run) && hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
        broadcastSlotUpdate(printer.id, newUiSpool);
    }
    printer.spoolData.push(newUiSpool);
}

/**
 * Opens the MQTT connection to a printer and subscribes to its report topic.
 *
 * Guarded against concurrent and rapid retries: an attempt is skipped while one
 * is already running, while the connection is up, or within a 30 second
 * cooldown of the last attempt. With MAX_RETRIES set, repeated failures disable
 * monitoring for that printer instead of retrying forever.
 *
 * Neither the close nor the error handler reschedules itself. monitorPrinters
 * is the only place that retries.
 *
 * @param {object} printer - the printer runtime object
 */
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
        await client.subscribe(`device/${printer.id}/report`);

        client.on("message", (topic, message) => {
            handleMqttMessage(printer, topic, message);
        });

        client.on("close", () => {
            printer.mqttStatus = "Disconnected";
            printer.mqttRunning = false;
            printer.mqttClient = null;

            // No self-rescheduling here. monitorPrinters() is the single
            // place driving reconnect attempts (polls every OFFLINE_CHECK_INTERVAL
            // and calls setupMqtt() again once mqttRunning is false). Having
            // both this handler and that loop independently retry used to
            // race and made the actual retry cadence hard to reason about.
            if (printer.monitoringEnabled) {
                console.log(printer.name, printer.logFilePath, ` Connection closed, will retry within ${formatInterval(OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
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

        if (MAX_RETRIES > 0 && printer.reconnectAttempts >= MAX_RETRIES) {
            console.log(printer.name, printer.logFilePath, `Max retries (${MAX_RETRIES}) reached -> disabling monitoring!`);
            printer.monitoringEnabled = false;
            broadcastSSE({ type: "monitoring_update", printer: printer.id, enabled: false });
            printer.mqttRunning = false;
            printer.mqttStatus = "Disabled";
            return;
        }

        // No self-rescheduling here either, see the comment in the "close"
        // handler above. monitorPrinters() will retry within OFFLINE_CHECK_INTERVAL.
        console.log(printer.name, printer.logFilePath, ` Connection failed, will retry within ${formatInterval(OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
    }
}

/**
 * Runs forever, reconnecting printers that are reachable but not connected.
 *
 * This is the single retry driver for MQTT. Every OFFLINE_CHECK_INTERVAL each
 * enabled printer is probed with a plain TCP connect before setupMqtt is
 * attempted, so an unreachable printer costs one short timeout rather than a
 * hanging MQTT handshake. The whole loop idles while Spoolman is down, since
 * there would be nothing to write AMS data to.
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

            try {
                const isAlive = await checkPrinterAvailability(printer.ip, 8883);

                if (isAlive) {
                    if (!printer.mqttRunning && !printer.isReconnecting) {
                        if (MAX_RETRIES > 0 && printer.reconnectAttempts >= MAX_RETRIES) {
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
                    console.error(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is unreachable. Next try in ${formatInterval(OFFLINE_CHECK_INTERVAL)}...`);

                    if (MAX_RETRIES > 0 && printer.reconnectAttempts >= MAX_RETRIES) {
                        printer.monitoringEnabled = false;
                        printer.mqttRunning = false;
                        printer.mqttStatus = "Disabled";
                        console.log(printer.name, printer.logFilePath, "Printer is unreachable and MAX_RETRIES exceeded → Monitoring disabled.");
                        continue;
                    }
                    printer.mqttStatus = "Disconnected";
                    printer.mqttRunning = false;
                }
            } catch (error) {
                console.error(printer.name, printer.logFilePath, `Error monitoring Printer: ${printer.id} - ${error.message}`);
            }
        }
        await sleep(OFFLINE_CHECK_INTERVAL);
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
            const spoolmanHealthApi = await got(`${SPOOLMAN_URL}/api/v1/health`);
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
            const spoolmanHealthApi = await got(`${SPOOLMAN_URL}/api/v1/health`);
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
