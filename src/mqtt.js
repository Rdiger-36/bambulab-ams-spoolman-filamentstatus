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
} from "./spoolman.js";
import {
    processData,
    extractComparableTrayData,
    correctRemainInt,
    findExistingSpool,
    findMatchingExternalFilament,
    findMatchingInternalFilament,
    findMergeableSpool,
    haveSpoolDataChanged,
    shouldSendSlotUpdate,
    hasSpoolUiChanged,
} from "./ams.js";

function sanitizeSpoolForClient({ logFilePath, printerName, ...rest }) {
    return rest;
}

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

function broadcastSlotUpdate(printerId, spool) {
    broadcastSSE({ type: "slot_update", printer: printerId, spool: sanitizeSpoolForClient(spool) });
}

async function handleMqttMessage(printer, topic, message) {
    if (printer.blockMqttUpdates || state.spoolmanStatus === "Disconnected") return;
    printer.blockMqttUpdates = true;

    if (printer.monitoringEnabled) {
        try {
            printer.mqttStatus = "Connected";
            const data = JSON.parse(message);
            console.debug(printer.name, printer.logFilePath, `Processing MQTT message for Printer: ${printer.id}`);
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

                        if (state.lastSpoolData.length === 0) state.lastSpoolData = spools;

                        let externalFilaments = await getSpoolmanExternalFilaments();
                        let internalFilaments = await getSpoolmanInternalFilaments();

                        const spoolsChanged = await haveSpoolDataChanged(spools, state.lastSpoolData);
                        const processedAmsData = processData(data.print.ams.ams);
                        const newTrayData = extractComparableTrayData(processedAmsData);
                        const lastTrayData = extractComparableTrayData(printer.lastAmsData || []);
                        const trayDataChanged = JSON.stringify(newTrayData) !== JSON.stringify(lastTrayData);

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
                                    spools = await getSpoolmanSpools();
                                    externalFilaments = await getSpoolmanExternalFilaments();
                                    internalFilaments = await getSpoolmanInternalFilaments();

                                    await processSlot(printer, ams, slot, spools, externalFilaments, internalFilaments, prevByAmsId, currentTime);
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

async function processSlot(printer, ams, slot, spools, externalFilaments, internalFilaments, prevByAmsId, currentTime) {
    const amsId = await convertAMSandSlot(ams.id, slot.id);
    const validSlot = Object.keys(slot).length > 6;

    if (!validSlot) {
        console.debug(printer.name, printer.logFilePath, "No Data found in Slots");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        await clearLocationIfSpoolChanged(printer, amsId, null, prevByAmsId);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot);
        return;
    }

    if ((slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") && (slot.tray_weight === 0 || slot.tray_weight === "0")) {
        console.debug(printer.name, printer.logFilePath, "No Data found in Slots (empty slot with N/A values)");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        await clearLocationIfSpoolChanged(printer, amsId, null, prevByAmsId);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot);
        return;
    }

    if (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") {
        console.debug(printer.name, printer.logFilePath, "Slot is read-only (3rd party spool)");
        slot.tray_sub_brands = slot.tray_type;
        const newUiSpool = buildThirdPartySpool(printer, amsId, slot);
        await clearLocationIfSpoolChanged(printer, amsId, null, prevByAmsId);
        if (shouldSendSlotUpdate(slot, printer.first_run) && hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
            broadcastSlotUpdate(printer.id, newUiSpool);
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_type} ${slot.tray_color} [[ ${slot.tray_uuid} ]]`);
        }
        printer.spoolData.push(newUiSpool);
        return;
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
    const automatic = MODE === "automatic";

    matchingExternalFilament = findMatchingExternalFilament(slot, externalFilaments);
    matchingInternalFilament = findMatchingInternalFilament(matchingExternalFilament, internalFilaments);

    if (spools.length !== 0) {
        for (const spool of spools) {
            if (spool.extra?.tag && JSON.parse(spool.extra.tag) === slot.tray_uuid) {
                console.debug(printer.name, printer.logFilePath, " Connected Spool found: " + JSON.stringify(spool));
                found = true;

                try {
                    const prevSlot = prevByAmsId[amsId]?.slot;
                    const prevRemain = prevSlot ? Math.round(prevSlot.remain) : null;
                    const currRemain = correctRemainInt(slot.remain, slot.tray_weight);
                    const slotChanged = !prevSlot ||
                        currRemain !== prevRemain ||
                        slot.tray_weight !== prevSlot?.tray_weight ||
                        slot.tray_uuid !== prevSlot?.tray_uuid;

                    if (!slotChanged) {
                        console.debug(printer.name, printer.logFilePath, " No change for connected spool; skipping PATCH");
                        existingSpool = spool;
                        break;
                    }
                } catch {}

                slot.remain = correctRemainInt(slot.remain, slot.tray_weight);
                const remainingWeight = Math.round((slot.remain / 100) * slot.tray_weight);
                const newLocation = SET_LOCATION ? `${printer.name} - ${amsId}` : null;

                console.debug(printer.name, printer.logFilePath, "    Sending PATCH request to:", `${SPOOLMAN_URL}/api/v1/spool/${spool.id}`);
                console.debug(printer.name, printer.logFilePath, "    Payload:", JSON.stringify({ remaining_weight: remainingWeight, last_used: currentTime, ...(newLocation && { location: newLocation }) }));

                try {
                    await patchSpoolWeight(spool.id, remainingWeight, currentTime, newLocation);
                    console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);
                    console.log(printer.name, printer.logFilePath, `    Updated Spool-ID ${spool.id} => ${spool.filament.name}`);
                } catch (err) {
                    console.error(printer.name, printer.logFilePath, "   #####");
                    console.error(printer.name, printer.logFilePath, "   Spool update failed:", err.message);
                    console.error(printer.name, printer.logFilePath, "   Error details:", err.response?.statusCode, err.response?.body || err.stack);
                    console.error(printer.name, printer.logFilePath, "   #####");
                }

                printer.lastUpdateTime = currentTime;
                existingSpool = spool;
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
                }
            }
            option = "Merge Spool";
        }

        if (!automatic) enableButton = "true";
        printer.lastUpdateTime = new Date();
    }

    const correctedRemain = correctRemainInt(slot.remain, slot.tray_weight);
    const correctedWeight = Math.round((correctedRemain / 100) * slot.tray_weight);

    await clearLocationIfSpoolChanged(printer, amsId, existingSpool?.id ?? null, prevByAmsId);

    const newUiSpool = {
        amsId,
        slot,
        mergeableSpool,
        matchingInternalFilament,
        matchingExternalFilament,
        existingSpool,
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
}

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

function buildThirdPartySpool(printer, amsId, slot) {
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
        slotState: "Loaded (3rd party)",
        error: false,
    };
}

function pushSlotUpdate(printer, newUiSpool, prevByAmsId, slot) {
    if (shouldSendSlotUpdate(slot, printer.first_run) && hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
        broadcastSlotUpdate(printer.id, newUiSpool);
    }
    printer.spoolData.push(newUiSpool);
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
        await client.subscribe(`device/${printer.id}/report`);

        client.on("message", (topic, message) => {
            handleMqttMessage(printer, topic, message);
        });

        client.on("close", async () => {
            printer.mqttStatus = "Disconnected";
            printer.mqttRunning = false;
            printer.mqttClient = null;

            if (printer.monitoringEnabled) {
                console.log(printer.name, printer.logFilePath, ` Retrying connection in ${formatInterval(OFFLINE_CHECK_INTERVAL)}...`);
                await sleep(OFFLINE_CHECK_INTERVAL);
                setupMqtt(printer);
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

        console.log(printer.name, printer.logFilePath, ` Retrying connection in ${formatInterval(OFFLINE_CHECK_INTERVAL)}...`);
        await sleep(OFFLINE_CHECK_INTERVAL);

        if (!printer.monitoringEnabled) return;
        setupMqtt(printer);
    }
}

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
