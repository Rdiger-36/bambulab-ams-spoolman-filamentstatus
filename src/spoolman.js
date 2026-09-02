import got from "got";
import { serverLogFilePath } from "./config.js";
import { spoolmanUrl } from "./settings.js";
import { state } from "./state.js";
import { correctRemainInt } from "./ams.js";

/**
 * Derives the used weight a newly created Spoolman spool should start at.
 *
 * The AMS RFID chip reports the real remaining percentage of an already
 * partially used spool. New spools should be created reflecting that, not as
 * if they were brand new. Otherwise a spool found at e.g. 32% remaining would
 * be created at 100% (used_weight 0) and immediately drift out of sync.
 *
 * No reading means brand new. For up to a minute after a spool is inserted the
 * AMS knows the tag but not the percentage, and a spool created in that window
 * used to be booked as fully used, ending up at 0 g left with nothing in G-code
 * mode to correct it afterwards. Starting such a spool full
 * is the recoverable direction: a print books what it consumes.
 *
 * @param {object} slot - a normalised AMS slot
 * @returns {number} grams already consumed, never negative
 */
function usedWeightFromSlot(slot) {
    const remainPct = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    if (remainPct === null || !Number.isFinite(remainPct)) return 0;
    const remainingWeight = Math.round((remainPct / 100) * slot.tray_weight);
    return Math.max(0, Math.round(slot.tray_weight - remainingWeight));
}

/**
 * Fetches all spools. Updates the connection status as a side effect and
 * returns an empty list on failure, so a Spoolman outage pauses processing
 * instead of crashing the service.
 */
export async function getSpoolmanSpools() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/spool`);
        state.spoolmanStatus = "Connected";
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching spools from Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

/** Fetches the filaments created in this Spoolman instance, empty on failure. */
export async function getSpoolmanInternalFilaments() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/filament`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching filaments from Spoolman:", error);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

/** How long the catalogue is reused before it is fetched again. */
const EXTERNAL_FILAMENT_TTL_MS = 10 * 60 * 1000;

/**
 * The SpoolmanDB catalogue, from the cache while it is fresh.
 *
 * The create-spool dialog queries the catalogue while the user types, and every
 * miss would otherwise pull several megabytes out of Spoolman again. A failed
 * fetch is not cached, so an outage is retried rather than remembered.
 */
export async function getCachedExternalFilaments() {
    const cache = state.externalFilamentCache;
    const fresh = cache.entries.length && (Date.now() - cache.fetchedAt) < EXTERNAL_FILAMENT_TTL_MS;
    if (fresh) return cache.entries;

    const entries = await getSpoolmanExternalFilaments();
    if (entries.length) {
        cache.entries = entries;
        cache.fetchedAt = Date.now();
    }
    return entries;
}

/** Fetches the SpoolmanDB filament catalogue, empty on failure. */
export async function getSpoolmanExternalFilaments() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/external/filament`);
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

/**
 * Fetches and parses a Spoolman endpoint, rethrowing on failure.
 *
 * Unlike the list getters above, these lookups back an interactive dialog, so a
 * failure has to surface to the user rather than quietly yield an empty list.
 *
 * @param {string} path - path below the Spoolman base URL
 * @param {string} what - noun used in the error message
 */
async function getJson(path, what) {
    try {
        const response = await got(`${spoolmanUrl()}${path}`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, `Error fetching ${what} from Spoolman:`, error.message);
        throw error;
    }
}

/** Fetches the vendors known to this Spoolman instance. */
export const getSpoolmanVendors = () => getJson("/api/v1/vendor", "vendors");

/** Fetches the locations known to this Spoolman instance. */
export const getSpoolmanLocations = () => getJson("/api/v1/location", "locations");

/** Fetches the materials already in use in this Spoolman instance. */
export const getSpoolmanMaterials = () => getJson("/api/v1/material", "materials");

/**
 * Fetches the known material catalogue, which also carries density and
 * temperatures. Density is required when creating a filament and cannot be read
 * off the spool, so this is what the dialog prefills it from.
 */
export const getSpoolmanExternalMaterials = () => getJson("/api/v1/external/material", "external materials");

/** Creates a vendor by name and returns the created record. */
export async function createNamedVendor(name) {
    const response = await got.post(`${spoolmanUrl()}/api/v1/vendor`, {
        json: { name },
        responseType: "json",
    });
    return response.body;
}

/** Creates a filament from an already built payload and returns the record. */
export async function createFilament(payload) {
    const response = await got.post(`${spoolmanUrl()}/api/v1/filament`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/** Creates a spool from an already built payload and returns the record. */
export async function createSpoolRecord(payload) {
    const response = await got.post(`${spoolmanUrl()}/api/v1/spool`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/**
 * Makes sure the "Bambu Lab" vendor exists and caches its id in shared state.
 *
 * Runs once at startup. Every filament this service creates is attached to that
 * vendor, so without it nothing can be created at all.
 *
 * @returns {Promise<boolean>} whether the vendor is available
 */
export async function checkAndSetVendor() {
    console.log("Server", serverLogFilePath, "Checking Vendors...");
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/vendor`);
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

/** Creates the "Bambu Lab" vendor and stores its id in shared state. */
async function createVendor() {
    console.log("Server", serverLogFilePath, 'Creating Vendor "Bambu Lab"...');
    try {
        const manufacturerPayload = {
            name: "Bambu Lab",
            external_id: "Bambu Lab",
            empty_spool_weight: 250,
        };

        const manufacturerResponse = await got.post(`${spoolmanUrl()}/api/v1/vendor`, {
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

/**
 * Makes sure the spool extra field "tag" exists in Spoolman.
 *
 * That field holds the slot's tray_uuid and is the only link between a physical
 * Bambu Lab spool and its Spoolman record, so the service cannot work without
 * it. Runs once at startup.
 *
 * @returns {Promise<boolean>} whether the field is available
 */
export async function checkAndSetExtraField() {
    console.log("Server", serverLogFilePath, 'Checking Extra Field "tag"...');
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/field/spool`);
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

/** Creates the spool extra field "tag" in Spoolman. */
async function createExtraField() {
    console.log("Server", serverLogFilePath, 'Create Extra Field "tag" for Spools in Spoolman');
    try {
        const payload = { name: "tag", field_type: "text" };
        await got.post(`${spoolmanUrl()}/api/v1/field/spool/tag`, {
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

/**
 * Creates a spool for an AMS slot whose filament already exists in Spoolman,
 * tagged with the slot's tray_uuid so it is recognised from then on.
 *
 * Failures are logged, not thrown: one slot that cannot be created must not
 * abort the remaining slots of the same AMS update.
 *
 * @param {object} spoolData - the UI spool, carrying slot and matched filament
 */
export async function createSpool(spoolData) {
    const postData = buildSpoolPayload(spoolData, spoolData.matchingInternalFilament.id);

    console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/spool`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        await got.post(`${spoolmanUrl()}/api/v1/spool`, { json: postData });
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully created for AMS Slot => ${spoolData.amsId}!`);
    } catch (error) {
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        console.error(spoolData.printerName, spoolData.logFilePath, "    Spool creation failed:", error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.response?.statusCode, error.response?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
    }
}

/**
 * Builds the Spoolman spool payload for an AMS slot.
 *
 * Both creation paths send the same spool, they only differ in where the
 * filament id comes from: an existing Spoolman filament, or one created moments
 * earlier. The tag is the slot's tray_uuid, JSON encoded, because that is what
 * later identifies this spool as the one in the slot.
 *
 * @param {object} spoolData - the UI spool, carrying the slot
 * @param {number|string} filamentId - the Spoolman filament to attach it to
 * @returns {object} the payload for POST /api/v1/spool
 */
export function buildSpoolPayload(spoolData, filamentId) {
    return {
        filament_id: Number(filamentId),
        initial_weight: Number(spoolData.slot.tray_weight),
        used_weight: usedWeightFromSlot(spoolData.slot),
        first_used: Date.now(),
        extra: { tag: `"${spoolData.slot.tray_uuid}"` },
    };
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

/**
 * Creates both the filament and the spool for an AMS slot, for the case where
 * the catalogue entry matched but no filament exists in Spoolman yet.
 *
 * The spool is only attempted once the filament came back with an id. As in
 * createSpool, failures are logged rather than thrown.
 *
 * @param {object} spoolData - the UI spool, carrying slot and catalogue entry
 */
export async function createFilamentAndSpool(spoolData) {
    let filamentId;

    try {
        const filamentPayload = buildFilamentPayload(spoolData);

        console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/filament`);
        console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(filamentPayload));

        const filamentResponse = await got.post(`${spoolmanUrl()}/api/v1/filament`, {
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
            const spoolPayload = buildSpoolPayload(spoolData, filamentId);

            console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/spool`);
            console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(spoolPayload));

            await got.post(`${spoolmanUrl()}/api/v1/spool`, { json: spoolPayload, responseType: "json" });
            console.log(spoolData.printerName, spoolData.logFilePath, `    Filament and Spool successfully created for AMS Slot => ${spoolData.amsId}!`);
        } catch (error) {
            console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
            console.error(spoolData.printerName, spoolData.logFilePath, "    Spool creation failed:", error.message);
            console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.spoolResponse?.statusCode, error.spoolResponse?.body || error.stack);
            console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        }
    }
}

/**
 * Connects an existing untagged Spoolman spool to an AMS slot by patching the
 * slot's tray_uuid into its extra.tag. Nothing else about the spool is touched.
 *
 * @param {object} spoolData - the UI spool, carrying slot and mergeableSpool
 */
export async function mergeSpool(spoolData) {
    const postData = { extra: { tag: `\"${spoolData.slot.tray_uuid}\"` } };

    console.debug(spoolData.printerName, spoolData.logFilePath, "    Sending PATCH request to:", `${spoolmanUrl()}/api/v1/spool/${spoolData.mergeableSpool.id}`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolData.mergeableSpool.id}`, { json: postData });
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully merged with Spool-ID ${spoolData.mergeableSpool.id} => ${spoolData.mergeableSpool.filament.name}`);
    } catch (error) {
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
        console.error(spoolData.printerName, spoolData.logFilePath, "    Spool merge failed:", error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, "    Error details:", error.response?.statusCode, error.response?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, "    #####");
    }
}

/**
 * Sets a spool's remaining weight directly. This is the legacy mode write path,
 * where the weight comes from the AMS RFID remain percentage.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {number} remainingWeight - grams left on the spool
 * @param {string} lastUsed - ISO timestamp
 * @param {string|null} location - AMS slot label, only sent when the location setting is on
 */
export async function patchSpoolWeight(spoolId, remainingWeight, lastUsed, location = null) {
    const payload = { remaining_weight: remainingWeight, last_used: lastUsed };
    if (location !== null) payload.location = location;
    return got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, { json: payload });
}

/**
 * Fetches a single spool with its filament and vendor embedded.
 *
 * Unlike the narrowed payload the dashboard receives, this is the whole record,
 * which is what the spool detail dialog shows. It rethrows rather than answering
 * with an empty result, because it backs an interactive dialog that has to say
 * why it is empty.
 *
 * @param {number} spoolId - Spoolman spool id
 */
export async function getSpoolmanSpool(spoolId) {
    return getJson(`/api/v1/spool/${spoolId}`, `spool ${spoolId}`);
}

/**
 * Writes an already built patch onto a spool and returns the updated record.
 *
 * Separate from `patchSpoolWeight()`, which is the legacy mode write path with
 * its own fixed payload. This one carries whatever the detail dialog corrected
 * by hand, and rethrows so the route can report the failure.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {object} payload - Spoolman spool fields to write
 */
export async function patchSpoolFields(spoolId, payload) {
    const response = await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/** Sets a spool's location, or clears it when passed an empty string. */
export async function patchSpoolLocation(spoolId, location) {
    return got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, { json: { location } });
}

/**
 * Books consumed filament against a spool. This is the G-code mode write path:
 * Spoolman subtracts the grams itself, so concurrent bookings cannot overwrite
 * each other the way a computed remaining weight would.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {number} usedGrams - grams consumed by the finished print
 * @param {string} lastUsed - ISO timestamp, patched separately
 */
export async function useSpoolWeight(spoolId, usedGrams, lastUsed) {
    const result = await got.put(`${spoolmanUrl()}/api/v1/spool/${spoolId}/use`, {
        json: { use_weight: usedGrams },
    });

    // The /use endpoint only accepts use_weight and use_length. A last_used sent
    // along with them is silently dropped, so the timestamp has to be patched
    // separately. Failing to stamp it must not lose the booking, which already
    // succeeded above.
    try {
        await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, { json: { last_used: lastUsed } });
    } catch (error) {
        console.error("Server", serverLogFilePath, `Booked consumption for spool ${spoolId}, but could not set last_used:`, error.message);
    }

    return result;
}

/**
 * Single health check against a Spoolman URL, used by the connection test on
 * the settings page. Takes the URL explicitly so an endpoint can be tried
 * before it is saved.
 *
 * @param {string} url - base URL to check
 * @param {number} [timeout] - milliseconds before the request is given up
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 */
export async function checkSpoolmanHealth(url, timeout = 5000) {
    if (!url) return { ok: false, error: "No endpoint configured" };

    try {
        const response = await got(`${url}/api/v1/health`, { timeout: { request: timeout }, retry: { limit: 0 } });
        const health = JSON.parse(response.body);

        if (health.status === "healthy") return { ok: true, status: health.status };
        return { ok: false, error: `Spoolman reports status "${health.status}"` };
    } catch (err) {
        const message = err?.message || String(err);
        if (/ECONNREFUSED/.test(message)) return { ok: false, error: "The connection was refused" };
        if (/ETIMEDOUT|timeout/i.test(message)) return { ok: false, error: "No answer within the timeout" };
        if (/ENOTFOUND|EAI_AGAIN/.test(message)) return { ok: false, error: "The host name cannot be resolved" };
        if (/404/.test(message)) return { ok: false, error: "Reachable, but there is no Spoolman API at this address" };
        return { ok: false, error: message };
    }
}
