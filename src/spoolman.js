import got from "got";
import { SPOOLMAN_URL, serverLogFilePath } from "./config.js";
import { state } from "./state.js";
import { correctRemainInt } from "./ams.js";

// The AMS RFID chip reports the real remaining percentage of an already
// partially-used spool. New spools should be created reflecting that, not as
// if they were brand new. Otherwise a spool found at e.g. 32% remaining
// would be created at 100% (used_weight 0) and immediately drift out of sync.
function usedWeightFromSlot(slot) {
    const remainPct = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    if (!Number.isFinite(remainPct)) return 0;
    const remainingWeight = Math.round((remainPct / 100) * slot.tray_weight);
    return Math.max(0, Math.round(slot.tray_weight - remainingWeight));
}

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

// ---------------------------------------------------------------------------
// Lookups and creation used by the "new spool" dialog for 3rd party spools.
// Those spools carry no RFID tag, so nothing about them can be derived: the
// data has to be entered once, and these endpoints feed the dialog's dropdowns.
// ---------------------------------------------------------------------------

async function getJson(path, what) {
    try {
        const response = await got(`${SPOOLMAN_URL}${path}`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, `Error fetching ${what} from Spoolman:`, error.message);
        throw error;
    }
}

export const getSpoolmanVendors = () => getJson("/api/v1/vendor", "vendors");
export const getSpoolmanLocations = () => getJson("/api/v1/location", "locations");
// Materials already in use in this Spoolman instance
export const getSpoolmanMaterials = () => getJson("/api/v1/material", "materials");
// The known material catalogue, which also carries density and temperatures.
// Density is required when creating a filament and cannot be read off the spool.
export const getSpoolmanExternalMaterials = () => getJson("/api/v1/external/material", "external materials");

export async function createNamedVendor(name) {
    const response = await got.post(`${SPOOLMAN_URL}/api/v1/vendor`, {
        json: { name },
        responseType: "json",
    });
    return response.body;
}

export async function createFilament(payload) {
    const response = await got.post(`${SPOOLMAN_URL}/api/v1/filament`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

export async function createSpoolRecord(payload) {
    const response = await got.post(`${SPOOLMAN_URL}/api/v1/spool`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
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
        used_weight: usedWeightFromSlot(spoolData.slot),
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

/**
 * Builds the Spoolman filament payload for a matched SpoolmanDB entry.
 *
 * Every value is read rather than assumed: weight and spool_weight used to be
 * hardcoded to 1000/250, which mislabelled everything not on a 1 kg spool.
 *
 * The filament describes the product, so both weights are the catalogue values.
 * A physical spool may well deviate from them. Bambu Lab sample spools are not
 * sold separately and the Support for PLA sample reports 250 g against a 500 g
 * catalogue entry, but that belongs on the spool as initial_weight, not on the
 * filament shared by every spool of that product.
 *
 * spool_type, finish, pattern, translucent and glow are not part of Spoolman's
 * FilamentParameters (verified against the 0.26.1 OpenAPI schema) and were
 * discarded on arrival, so they are no longer sent.
 */
export function buildFilamentPayload(spoolData) {
    const external = spoolData.matchingExternalFilament;

    return {
        name: external.name,
        material: spoolData.slot.tray_sub_brands,
        density: external.density,
        diameter: external.diameter,
        spool_weight: external.spool_weight,
        weight: external.weight,
        settings_extruder_temp: external.extruder_temp,
        settings_bed_temp: external.bed_temp,
        color_hex: external.color_hex,
        external_id: external.id,
        multi_color_hexes: external.color_hexes ? external.color_hexes.join(",") : "",
        multi_color_direction: external.multi_color_direction,
        vendor_id: state.vendorID,
    };
}

export async function createFilamentAndSpool(spoolData) {
    let filamentId;

    try {
        const filamentPayload = buildFilamentPayload(spoolData);

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
                initial_weight: Number(spoolData.slot.tray_weight),
                used_weight: usedWeightFromSlot(spoolData.slot),
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

export async function useSpoolWeight(spoolId, usedGrams, lastUsed) {
    const result = await got.put(`${SPOOLMAN_URL}/api/v1/spool/${spoolId}/use`, {
        json: { use_weight: usedGrams },
    });

    // The /use endpoint only accepts use_weight and use_length. A last_used sent
    // along with them is silently dropped, so the timestamp has to be patched
    // separately. Failing to stamp it must not lose the booking, which already
    // succeeded above.
    try {
        await got.patch(`${SPOOLMAN_URL}/api/v1/spool/${spoolId}`, { json: { last_used: lastUsed } });
    } catch (error) {
        console.error("Server", serverLogFilePath, `Booked consumption for spool ${spoolId}, but could not set last_used:`, error.message);
    }

    return result;
}
