import got from "got";
import { SPOOLMAN_URL, serverLogFilePath } from "./config.js";
import { state } from "./state.js";

export async function getSpoolmanSpools() {
    try {
        const response = await got(`${SPOOLMAN_URL}/api/v1/spool`);
        state.spoolmanStatus = "Connected";
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching spools from Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

export async function getSpoolmanInternalFilaments() {
    try {
        const response = await got(`${SPOOLMAN_URL}/api/v1/filament`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching filaments from Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

export async function getSpoolmanExternalFilaments() {
    try {
        const response = await got(`${SPOOLMAN_URL}/api/v1/external/filament`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching external filaments from Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

export async function checkAndSetVendor() {
    console.log("Server", serverLogFilePath, "Checking Vendors...");
    try {
        const response = await got(`${SPOOLMAN_URL}/api/v1/vendor`);
        const vendors = JSON.parse(response.body);

        for (const vendor of vendors) {
            if (vendor.name === "Bambu Lab" || vendor.external_id === "Bambu Lab") {
                state.vendorID = vendor.id;
                break;
            }
        }

        if (!state.vendorID) {
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: false');
            return await createVendor();
        } else {
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: true');
            return true;
        }
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching and setting vendor for Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        throw error;
    }
}

async function createVendor() {
    console.log("Server", serverLogFilePath, 'Creating Vendor "Bambu Lab"...');
    try {
        const manufacturerPayload = {
            name: "Bambu Lab",
            external_id: "Bambu Lab",
            empty_spool_weight: 250,
        };

        const manufacturerResponse = await got.post(`${SPOOLMAN_URL}/api/v1/vendor`, {
            json: manufacturerPayload,
            responseType: "json",
        });

        if (manufacturerResponse.body.id) {
            state.vendorID = manufacturerResponse.body.id;
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" successfully created!');
            return true;
        }
        return false;
    } catch (error) {
        console.error("Server", serverLogFilePath, "#####");
        console.error("Server", serverLogFilePath, "Vendor creation failed:", error.message);
        console.error("Server", serverLogFilePath, "Error details:", error.manufacturerResponse?.statusCode, error.manufacturerResponse?.body || error.stack);
        console.error("Server", serverLogFilePath, "#####");
        throw error;
    }
}

export async function checkAndSetExtraField() {
    console.log("Server", serverLogFilePath, 'Checking Extra Field "tag"...');
    try {
        const response = await got(`${SPOOLMAN_URL}/api/v1/field/spool`);
        const fields = JSON.parse(response.body);
        const extraFieldExists = fields.some(f => f.name === "tag");

        if (!extraFieldExists) {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: false');
            return await createExtraField();
        } else {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: true');
            return true;
        }
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching extra tag from Spoolman:", error);
        throw error;
    }
}

async function createExtraField() {
    console.log("Server", serverLogFilePath, 'Create Extra Field "tag" for Spools in Spoolman');
    try {
        const payload = { name: "tag", field_type: "text" };
        await got.post(`${SPOOLMAN_URL}/api/v1/field/spool/tag`, {
            json: payload,
            responseType: "json",
        });
        console.log("Server", serverLogFilePath, 'Extra Field "tag" successfully created!');
        return true;
    } catch (error) {
        console.error("Server", serverLogFilePath, "#####");
        console.error("Server", serverLogFilePath, 'Extra Field "tag" creation failed:', error.message);
        console.error("Server", serverLogFilePath, "Error details:", error.manufacturerResponse?.statusCode, error.manufacturerResponse?.body || error.stack);
        console.error("Server", serverLogFilePath, "#####");
        throw error;
    }
}

export async function createSpool(spoolData) {
    const postData = {
        filament_id: Number(spoolData.matchingInternalFilament.id),
        initial_weight: Number(spoolData.slot.tray_weight),
        first_used: Date.now(),
        extra: { tag: `\"${spoolData.slot.tray_uuid}\"` },
    };

    console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${SPOOLMAN_URL}/api/v1/spool`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        await got.post(`${SPOOLMAN_URL}/api/v1/spool`, { json: postData });
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully created for AMS Slot => ${spoolData.amsId}!`);
    } catch (error) {
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        console.error(spoolData.printerName, spoolData.logFilePath, "    Spool creation failed:", error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.response?.statusCode, error.response?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
    }
}

export async function createFilamentAndSpool(spoolData) {
    let filamentId;

    try {
        const filamentPayload = {
            name: spoolData.matchingExternalFilament.name,
            material: spoolData.slot.tray_sub_brands,
            density: spoolData.matchingExternalFilament.density,
            diameter: spoolData.matchingExternalFilament.diameter,
            spool_weight: 250,
            weight: 1000,
            settings_extruder_temp: spoolData.matchingExternalFilament.extruder_temp,
            settings_bed_temp: spoolData.matchingExternalFilament.bed_temp,
            color_hex: spoolData.matchingExternalFilament.color_hex,
            external_id: spoolData.matchingExternalFilament.id,
            spool_type: spoolData.matchingExternalFilament.spool_type,
            multi_color_hexes: spoolData.matchingExternalFilament.color_hexes
                ? spoolData.matchingExternalFilament.color_hexes.join(",")
                : "",
            finish: spoolData.matchingExternalFilament.finish,
            multi_color_direction: spoolData.matchingExternalFilament.multi_color_direction,
            pattern: spoolData.matchingExternalFilament.pattern,
            translucent: spoolData.matchingExternalFilament.translucent,
            glow: spoolData.matchingExternalFilament.glow,
            vendor_id: state.vendorID,
        };

        console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${SPOOLMAN_URL}/api/v1/filament`);
        console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(filamentPayload));

        const filamentResponse = await got.post(`${SPOOLMAN_URL}/api/v1/filament`, {
            json: filamentPayload,
            responseType: "json",
        });
        filamentId = filamentResponse.body.id;
    } catch (error) {
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        console.error(spoolData.printerName, spoolData.logFilePath, "    Filament creation failed:", error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.filamentResponse?.statusCode, error.filamentResponse?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
    }

    if (filamentId) {
        try {
            const spoolPayload = {
                filament_id: filamentId,
                initial_weight: spoolData.slot.tray_weight,
                first_used: Date.now(),
                extra: { tag: `\"${spoolData.slot.tray_uuid}\"` },
            };

            console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${SPOOLMAN_URL}/api/v1/spool`);
            console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(spoolPayload));

            await got.post(`${SPOOLMAN_URL}/api/v1/spool`, { json: spoolPayload, responseType: "json" });
            console.log(spoolData.printerName, spoolData.logFilePath, `    Filament and Spool successfully created for AMS Slot => ${spoolData.amsId}!`);
        } catch (error) {
            console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
            console.error(spoolData.printerName, spoolData.logFilePath, "    Spool creation failed:", error.message);
            console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.spoolResponse?.statusCode, error.spoolResponse?.body || error.stack);
            console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        }
    }
}

export async function mergeSpool(spoolData) {
    const postData = { extra: { tag: `\"${spoolData.slot.tray_uuid}\"` } };

    console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending PATCH request to:", `${SPOOLMAN_URL}/api/v1/spool/${spoolData.mergeableSpool.id}`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        await got.patch(`${SPOOLMAN_URL}/api/v1/spool/${spoolData.mergeableSpool.id}`, { json: postData });
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully merged with Spool-ID ${spoolData.mergeableSpool.id} => ${spoolData.mergeableSpool.filament.name}`);
    } catch (error) {
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        console.error(spoolData.printerName, spoolData.logFilePath, "    Spool merge failed:", error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.response?.statusCode, error.response?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
    }
}

export async function patchSpoolWeight(spoolId, remainingWeight, lastUsed, location = null) {
    const payload = { remaining_weight: remainingWeight, last_used: lastUsed };
    if (location !== null) payload.location = location;
    return got.patch(`${SPOOLMAN_URL}/api/v1/spool/${spoolId}`, { json: payload });
}

export async function patchSpoolLocation(spoolId, location) {
    return got.patch(`${SPOOLMAN_URL}/api/v1/spool/${spoolId}`, { json: { location } });
}
