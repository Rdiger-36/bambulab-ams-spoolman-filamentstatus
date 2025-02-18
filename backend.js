import express from "express";
import mqtt from "async-mqtt";
import got from "got";
import { config } from "dotenv";
import cors from "cors";
import path from "path";
import ping from "ping";
import fs from "fs-extra";
import { fileURLToPath } from 'url';

// loading .env
config();

const version = "1.0.2";
const app = express();
const PORT = 4000; // Port for backend --> also used by frontend for Web UI

// Configuration variables for Printer and Spoolman communictaion
const PRINTER_ID = process.env.PRINTER_ID;
const PRINTER_CODE = process.env.PRINTER_CODE;
const PRINTER_IP = process.env.PRINTER_IP;
const SPOOLMAN_IP = process.env.SPOOLMAN_IP;
const SPOOLMAN_PORT = process.env.SPOOLMAN_PORT;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL
  ? Math.min(Math.max(parseInt(process.env.UPDATE_INTERVAL, 10), 5000), 300000)
  : 120000;
const DEBUG = process.env.DEBUG || "false";

/**
 * Set mode for Spool Management:
 *         automatic: automatically merge and create new Spools from the AMS in Spoolman incl. Filament
 *         manual: you can do this by your own with a button klick in the Web UI
 */
const MODE = process.env.MODE || "manual";

const RECONNECT_INTERVAL = 60000; // Intervall for try to reconnect once in a minute

// save original console.log
const originalConsoleLog = console.log;

// save original console.error
const originalConsoleError = console.error;

// Array for save last Spool Data from Spoolman to check for changes
let lastSpoolData = [];

// This vars contains stats for frontend
let spoolmanStatus = "Disconnected";

// This vars load Data for processing
let vendorID = null;

// frontend connection for push updates
let clients = [];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverLogFilePath = path.join(__dirname, "logs", "server.log");
const configPath = path.resolve(__dirname, "printers", "printers.json");

const printers = loadPrintersConfig();

// Creating server log
fs.writeFile(serverLogFilePath, `Log started at: ${formatDateLog(new Date())}\n`, (err) => {
  if (err) {
    originalConsoleError("Server", `Failed to create log file: ${err.message}`);
  } else {
    originalConsoleLog("Server", `Server Log file created`);
  }
});

// Enable Cross-Origin Resource Sharing (CORS) to allow requests from other domains, for reverse proxys
app.use(cors());

// Enable parsing of JSON request bodies
app.use(express.json());

app.use(express.static("public", { maxAge: 0 })); // disable caching

// Configure path for frontend
app.get("/", (req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
});

// override von console.log for logs and frontend
console.log = (device, logFilePath, ...args) => {
    const logMessage = `[LOG] ${formatDateLog(new Date())} - ${device} - ${args.join(" ")}`;
    originalConsoleLog(logMessage); // logs for origin console
    
    fs.appendFile(logFilePath, logMessage + '\n', (err) => {
      if (err) {
        originalConsoleLog(`[ERROR] Failed to write log: ${err.message}`);
      }
    });
};

// override of console.error for logs and frontend
console.error = (device, logFilePath, ...args) => {
    const errorMessage = `[ERROR] ${formatDateLog(new Date())} - ${device} - ${args.join(" ")}`;
    originalConsoleError(errorMessage); // logs for origin console

    fs.appendFile(logFilePath, errorMessage + '\n', (err) => {
      if (err) {
        originalConsoleLog(`[ERROR] Failed to write log: ${err.message}`);
      }
    });
};

// override of console.debug for logs and frontend
console.debug = (device, logFilePath, ...args) => {
    if (DEBUG === "true") {
        const debugMessage = `[DEBUG] ${formatDateLog(new Date())} - ${device} - ${args.join(" ")}`;
        originalConsoleLog(debugMessage);
        
        fs.appendFile(logFilePath, debugMessage + '\n', (err) => {
          if (err) {
            originalConsoleLog(`[ERROR] Failed to write log: ${err.message}`);
          }
        });
    }
};

// initialize all printers. If there is no printer.json or it is faulty check if there is valifd printer in ENVs and use it
function loadPrintersConfig() {
    try {
        const configData = fs.readFileSync(configPath, "utf-8");
        const printers = JSON.parse(configData);

        const date = new Date();
        
        // check if printers are valid
        printers.forEach(printer => {
            if (!printer.id || !printer.code || !printer.ip || !printer.name) {
                throw new Error(`Invalid printer configuration: ${JSON.stringify(printer)}`);
            }
        });

        console.debug("Server", serverLogFilePath, "Printers loaded successfully:", printers);
        
        // return printer array
        return printers.map(printer => ({
            ...printer,
            mqttStatus: "Disconnected",
            spoolmanStatus: "Disconnected",
            mqttRunning: false,
            update_interval: UPDATE_INTERVAL,
            lastUpdateTime: date,
            first_run: true,
        }));
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error loading printers configuration:", error.message);
        console.error("Server", serverLogFilePath, "Try to get single printer from ENV...")
        
        const date = new Date();
        
        // check ENVs for valid printer info
        
        if(PRINTER_ID && PRINTER_CODE && PRINTER_IP) {
            let printers = {
                name: "Bambu Lab Printer",
                id: PRINTER_ID.toUpperCase(),
                code: PRINTER_CODE,
                ip: PRINTER_IP,
                mqttStatus: "Disconnected",
                spoolmanStatus: "Disconnected",
                mqttRunning: false,
                update_interval: UPDATE_INTERVAL,
                lastUpdateTime: date,
                first_run: true,
            };
            printers = [printers];
            return printers;
        } else {
            console.error("Server", serverLogFilePath, "No valid printers found!")
            console.error("Server", serverLogFilePath, "Please check your printers.json or your ENVs!")
        }
    }
}

// Convert numbers in alphabetical letters
async function num2letter(num) {
    return String.fromCharCode("A".charCodeAt(0) + Number(num));
}

// Fetching actual Spolls from Spoolman
async function getSpoolmanSpools() {
    try {
        const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
        return JSON.parse(response.body);
      } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching spools from Spoolman:", error);
        return [];
      }
}

// Fetching actual internal Filaments from Spoolman
async function getSpoolmanInternalFilaments() {
    try {
           const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/filament`);
           return JSON.parse(response.body);
      } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching filaments from Spoolman:", error);
        return [];
      }
}

// Fetching actual external Filaments from Spoolman
async function getSpoolmanExternalFilaments() {
      try {
        const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/external/filament`);
        return JSON.parse(response.body);
      } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching filaments from Spoolman:", error);
        return [];
      }
}

// Fetching actual Vendor from Spoolman, if Bambu Lab not exists as a Vendor, it will be created
async function checkAndSetVendor() {
    console.log("Server", serverLogFilePath, 'Checking Vendors...');
    
    
    // Check if there is a vendor called "Bambu Lab"
    try {
        const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/vendor`);
        const vendors = JSON.parse(response.body);

        for (const vendor of vendors) {
            if (vendor.name === "Bambu Lab" || vendor.external_id === "Bambu Lab") {
                vendorID = vendor.id;
                break;
               }
         }

         // if not, create new vendor
        if (!vendorID) {
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: false');
            return await createVendor(); // Return the new vendor ID
         } else {
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: true');
            return true; // Return the existing vendor ID
        }
     } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching and setting vendor for Spoolman:", error);
         throw error;
     }
}

// Create new Vendor Bambu Lab
async function createVendor() {
    
    console.log("Server", serverLogFilePath, 'Creating Vendor "Bambu Lab"...');
    
    
    // send post request to spoolman to create vendor "Bambu Lab""
    try {
        const manufacturerPayload = {
            name: "Bambu Lab",
            external_id: "Bambu Lab",
            empty_spool_weight: 250
        };

        const manufacturerResponse = await got.post(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/vendor`, {
            json: manufacturerPayload,
            responseType: 'json'
        });

        // Check if Vendor creation was successfull
        if (manufacturerResponse.body.id) {
            vendorID = manufacturerResponse.body.id;
            console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" successfully created!')
            return true;
        } else {
            return false;
        }
        
    } catch (error) {
        console.error("Server", serverLogFilePath, '#####');
        console.error("Server", serverLogFilePath, 'Vendor creation failed: ', error.message);
        console.error("Server", serverLogFilePath, 'Error details:', error.manufacturerResponse?.statusCode, error.manufacturerResponse?.body || error.stack);
        console.error("Server", serverLogFilePath, '#####');
        throw error;
    }
}

// Fetching actual Extra Field Setting for Spools from Spoolman, if Extra Filed "tag" not exists, it will be created
async function checkAndSetExtraField() {
    console.log("Server", serverLogFilePath, 'Checking Extra Field "tag"...');
    
    // check if there is the extra field called "tag"
    try {
        const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/field/spool`);
        const fields = JSON.parse(response.body);
        let extraFieldExists = false;

        for (const field of fields) {
            if (field.name === "tag") {
                extraFieldExists = true;
                break;
            }
        }

        // if no, create the extra field "tag"
        if (!extraFieldExists) {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: false');
            const exists = await createExtraField(); // Await the result of creating the extra field
            return exists;
        } else {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: true');
            return true; // Return true if the field already exists
        }
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching extra tag from Spoolman:", error);
        throw error;
    }
}

// Create a new Extra Field "tag" for Spools in Spoolman
async function createExtraField() {
    
    console.log("Server", serverLogFilePath, 'Create Extra Filed "tag" for Spools in Spoolman');
    
    
    // send post request to create extra filed "tag"
    try {
        const payload = {
            name: "tag",
            field_type: "text"
        };

        const manufacturerResponse = await got.post(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/field/spool/tag`, {
            json: payload,
            responseType: 'json'
        });
        
        // if no error from response, the tag creation was successfull
        console.log("Server", serverLogFilePath, 'Extra Field "tag" successfully created!');
        return true;
        
    } catch (error) {
        console.error("Server", serverLogFilePath, '#####');
        console.error("Server", serverLogFilePath, 'Extra Field "tag" creation failed: ', error.message);
        console.error("Server", serverLogFilePath, 'Error details:', error.manufacturerResponse?.statusCode, error.manufacturerResponse?.body || error.stack);
        console.error("Server", serverLogFilePath, '#####');
        throw error;
    }
}

// Check if Spool with exact Data exists in Spoolman
function findExistingSpool(amsSpool, allSpools) {
    return allSpools.find(spoolmanSpool => {
        const tag = spoolmanSpool.extra?.tag?.replace(/"/g, ''); // Remove quotes from the "tag"
        const colorHex = spoolmanSpool.filament.color_hex;
        const truncatedColor = amsSpool.tray_color.slice(0, 6);
        
        // Return matching spool if material, color, and tag match
        return (
            spoolmanSpool.filament.material === amsSpool.tray_sub_brands &&
            colorHex.toLowerCase() === truncatedColor.toLowerCase() &&
            tag === amsSpool.tray_uuid
        );
    }) || null; // Return null if no matching spool is found
}

// Find matching external Filament from Spoolman to create one if necessary
function findMatchingExternalFilament(amsSpool, externalFilaments) {
    if (!amsSpool) return null;

    // Transformations for material name comparison
    const transformations = [
        (material) => material.toLowerCase(),
        (material) => material.replace(/\s+/g, '_').toLowerCase(),
        (material) => material.split(' ')[0].replace(/[^A-Za-z]/g, '').toLowerCase()
    ];

    // Try each transformation to find a matching filament
    for (const transform of transformations) {
        const transformedMaterial = transform(amsSpool.tray_sub_brands || '');
        const matchingFilament = externalFilaments.find(filament => {
            const colorHex = filament.color_hex || '';
            
            let id = "";
            
            if (amsSpool.tray_sub_brands.toLowerCase().includes("support")) {
                id = filament.id.startsWith(`bambulab_${amsSpool.tray_type.split('-')[0].toLowerCase()}_${transformedMaterial}`) &&
                           colorHex.toLowerCase() === amsSpool.tray_color.slice(0,6).toLowerCase();
            } else {
                id = filament.id.startsWith(`bambulab_${transformedMaterial}`) &&
                           colorHex.toLowerCase() === amsSpool.tray_color.slice(0,6).toLowerCase();
            }
                       
                       
            return id;
        });
        if (matchingFilament) return matchingFilament;
    }

    return null; // No match found
}

// Find mergeable Spool in Spoolman with almost the same stats as the AMS Spool
function findMergeableSpool(amsSpool, allSpools) {
    // Find spools with the same material and color code
    const matchingSpools = allSpools.filter((spoolmanSpool) =>
        spoolmanSpool.filament.material.toLowerCase() === amsSpool.tray_sub_brands.toLowerCase() &&
        spoolmanSpool.filament.color_hex.toLowerCase() === amsSpool.tray_color.slice(0, 6).toLowerCase()
    );

    // Check if any matching spool can be merged based on weight tolerance
    return matchingSpools.find(spoolmanSpool => {
        const tag = spoolmanSpool.extra?.tag;

        const isTagSet = tag && tag.trim() !== "" && tag.trim() !== '""';

        if (isTagSet) {
            return false; // Spule mit gesetztem Tag ignorieren
        }
        const spoolRemainingWeight = (amsSpool.remain / 100) * spoolmanSpool.initial_weight;
        const lowerTolerance = spoolRemainingWeight * 0.85; // -15%
        const upperTolerance = spoolRemainingWeight * 1.15; // +15%

        const weightMatches =
            spoolmanSpool.remaining_weight >= lowerTolerance &&
            spoolmanSpool.remaining_weight <= upperTolerance;

        // Return matching spool if weight matches or if no weight has been used
        return (spoolmanSpool.remaining_weight === 0 || weightMatches || spoolmanSpool.used_weight === 0);
    });
}

// Function to find a matching internal filament based on external filament ID
function findMatchingInternalFilament(externalFilament, internalFilaments) {
    if (!externalFilament) return null;  // Return null if no external filament is provided

    // Find and return the matching internal filament by external ID
    return internalFilaments.find(internalFilament =>
        internalFilament.external_id === externalFilament.id
    ) || null;  // Return null if no match is found
}

// Function to create a new spool in the system
async function createSpool(spoolData) {
    
    // prepare data for post
    const postData = {
        filament_id: Number(spoolData.matchingInternalFilament.id),  // Set the internal filament ID
        initial_weight: Number(spoolData.slot.tray_weight),  // Set the tray weight as initial weight
        first_used: Date.now(),  // Set the timestamp for the first use
        extra: {
            tag: `\"${spoolData.slot.tray_uuid}\"`  // Set the tray UUID as tag
        }
    };
    
    // Debugging URL and Payload
    console.debug(spoolData.printerName, spoolData.logFilePath, "        Sending POST request to:", `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "        Payload:", JSON.stringify(postData));

    
    try {
        
        // Send a POST request to create a new spool with the provided spool data
        const response = await got.post(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`, {
            json: postData,
        });

        // Log success message if spool is created successfully
        console.log(spoolData.printerName, spoolData.logFilePath, `          Spool successfully created for Spool in AMS Slot => ${spoolData.amsId}!`);
    } catch (error) {
        // Log error message if spool creation fails
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
        console.error(spoolData.printerName, spoolData.logFilePath, '          Spool creation failed: ', error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, '          Error details:', error.response?.statusCode, error.responsspoolData.printerName, spoolData.logFilePath,);
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
    }
}

// Function to create both filament and spool in the system
async function createFilamentAndSpool(spoolData) {
    let filamentId;

    try {
        // Prepare the filament data payload
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
            color_hexes: spoolData.matchingExternalFilament.color_hexes,
            finish: spoolData.matchingExternalFilament.finish,
            multi_color_direction: spoolData.matchingExternalFilament.multi_color_direction,
            pattern: spoolData.matchingExternalFilament.pattern,
            translucent: spoolData.matchingExternalFilament.translucent,
            glow: spoolData.matchingExternalFilament.glow,
            vendor_id: vendorID,
        };

        // Debugging URL and Payload
        console.debug(spoolData.printerName, spoolData.logFilePath, "        Sending POST request to:", `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/filament`);
        console.debug(spoolData.printerName, spoolData.logFilePath, "        Payload:", JSON.stringify(filamentPayload));
        
        // Create filament in the Spoolman system
        const filamentResponse = await got.post(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/filament`, {
            json: filamentPayload,
            responseType: 'json'
        });

        filamentId = filamentResponse.body.id;  // Save the filament ID from the response
    } catch (error) {
        // Log error if filament creation fails
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
        console.error(spoolData.printerName, spoolData.logFilePath, '          Filament creation failed: ', error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, '          Error details:', error.filamentResponse?.statusCode, error.filamentResponse?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
    }

    // If filament creation was successful, create the corresponding spool
    if (filamentId) {
        try {
            // Prepare the spool data payload
            const spoolPayload = {
                filament_id: filamentId,
                initial_weight: spoolData.slot.tray_weight,
                first_used: Date.now(),
                extra: {
                    tag: `\"${spoolData.slot.tray_uuid}\"`
                }
            };
            
            // Debugging URL and Payload
            console.debug(spoolData.printerName, spoolData.logFilePath, "        Sending POST request to:", `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
            console.debug(spoolData.printerName, spoolData.logFilePath, "        Payload:", JSON.stringify(spoolPayload));

            // Create spool in the Spoolman system
            await got.post(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`, {
                json: spoolPayload,
                responseType: 'json'
            });

            // Log success message if both filament and spool were created successfully
            console.log(spoolData.printerName, spoolData.logFilePath, `          Filament and Spool successfully created for Spool in AMS Slot => ${spoolData.amsId}!`);
        } catch (error) {
            // Log error if spool creation fails
            console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
            console.error(spoolData.printerName, spoolData.logFilePath, '          Spool creation failed: ', error.message);
            console.error(spoolData.printerName, spoolData.logFilePath, '          Error details:', error.spoolResponse?.statusCode, error.spoolResponse?.body || error.stack);
            console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
        }
    }
}

// Function to merge a spool with an existing spool in the system
async function mergeSpool(spoolData) {
    
    // prepare data for post
    const postData = {
        extra: {
            tag: `\"${spoolData.slot.tray_uuid}\"`  // Set the tray UUID as tag
        }
    };

    // Debugging URL and Payload
    console.debug(spoolData.printerName, spoolData.logFilePath, "        Sending POST request to:", `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spoolData.mergeableSpool.id}`);
    console.debug(spoolData.printerName, spoolData.logFilePath, "        Payload:", JSON.stringify(postData));
    
    try {
        // Send a PATCH request to update the spool with new tag data
        const response = await got.patch(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spoolData.mergeableSpool.id}`, {
            json: postData
        });

        // Log success message if the spool merge is successful
        console.log(spoolData.printerName, spoolData.logFilePath, `          Spool successfully merged with Spool-ID ${spoolData.mergeableSpool.id} => ${spoolData.mergeableSpool.filament.name}`);
    } catch (error) {
        // Log error details if the merge fails
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
        console.error(spoolData.printerName, spoolData.logFilePath, '          Spool merge failed: ', error.message);
        console.error(spoolData.printerName, spoolData.logFilePath, '          Error details:', error.response?.statusCode, error.response?.body || error.stack);
        console.error(spoolData.printerName, spoolData.logFilePath, '          #####');
    }
}

async function haveSpoolDataChanged(spools, lastSpoolData) {
    if (!Array.isArray(spools) || !Array.isArray(lastSpoolData)) return true;

    const lengthChanged = spools.length !== lastSpoolData.length;

    const dataChanged = !spools.every((spool, index) => {
        const lastSpool = lastSpoolData[index];

        if (!spool || !lastSpool) return false;

        const isEqual = spool?.extra?.tag === lastSpool?.extra?.tag &&
                        spool.remaining_weight === lastSpool.remaining_weight &&
                        JSON.stringify(spool.filament) === JSON.stringify(lastSpool.filament);

        return isEqual;
    });

    return lengthChanged || dataChanged;
}


// Format given Date to readable date
function formatDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

// Format given Date to perfect date format for logs
function formatDateLog(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}:${minutes}:${seconds}`;
}

function processData(amsData) {
    return amsData.map(ams => ({
        ...ams,
        tray: ams.tray.map(slot => {
            // Correct false color PETG Translucent
            const isPetgTranslucent = slot.tray_sub_brands === "PETG Translucent" && slot.tray_color === "00000000";
            const updatedTrayColor = isPetgTranslucent ? "FFFFFF00" : (slot.tray_color ?? "N/A");

            // Set remaining Filament to 0 if slot indicates it as negative
            if (!slot.remain || slot.remain < 0) slot.remain = 0;

            return {
                ...slot,
                remain: slot.remain,
                tray_color: updatedTrayColor,
                tray_sub_brands: slot.tray_sub_brands === "" ? "N/A" : (slot.tray_sub_brands ?? "N/A"),
                tray_weight: slot.tray_weight ?? 0,
                tray_uuid: slot.tray_uuid === "000000000000000000000000000000000" ? "N/A" : (slot.tray_uuid ?? "N/A"),
            };
        })
    }));
}

// Main function to handle the printers mqtt messages and proceed to update, merge, create Spools and Filament
async function handleMqttMessage(printer, topic, message) {
        
    // block updates when there is already updates to proceed
    if (printer.blockMqttUpdates) return;
    
    printer.blockMqttUpdates = true;
        
    try {
        printer.mqttStatus = "Connected";
        const data = JSON.parse(message);
        console.debug(printer.name, printer.logFilePath,`Processing MQTT message for Printer: ${printer.id}`);
        console.debug(printer.name, printer.logFilePath,'Check if message contains AMS Data');
        if (data?.print?.ams?.ams) {
            const currentTime = new Date();
            let printHeader = false;
            
            console.debug(printer.name, printer.logFilePath,'Check next Update Interval');
            // Update if the AMS data is stale
            if ((currentTime.getTime() - printer.lastUpdateTime.getTime() > printer.update_interval) || printer.first_run) {
                printer.first_run = false;
                const isValidAmsData = data.print.ams.humidity !== "" && data.print.ams.temp !== "";
            
                console.debug(printer.name, printer.logFilePath,'Fetch Data from Spoolman');
                // Fetch data from Spoolman API
                let spools = await getSpoolmanSpools();
                console.debug(printer.name, printer.logFilePath,'Registered Spools:');
                console.debug(printer.name, printer.logFilePath,JSON.stringify(spools));
                
                if (lastSpoolData.length === 0) lastSpoolData = spools;
                
                let externalFilaments = await getSpoolmanExternalFilaments();
                let internalFilaments = await getSpoolmanInternalFilaments();
                
                console.debug(printer.name, printer.logFilePath,'Registered Filaments:');
                console.debug(printer.name, printer.logFilePath,JSON.stringify(internalFilaments));
                        
                // Check if Spool Data changed
                const spoolsChanged = await haveSpoolDataChanged(spools, lastSpoolData);
                
                // Processing AMS Data for valid options
                const processedAmsData = processData(data.print.ams.ams);
                
                console.debug(printer.name, printer.logFilePath,'Check if AMS Data is valid and check if Spoolman or AMS Data got any changes');
                // If valid AMS data and different from last received, process and Spool Data in Spoolman changed
                if (isValidAmsData && (spoolsChanged || JSON.stringify(processedAmsData) !== JSON.stringify(printer.lastAmsData))) {
                    
                    console.debug(printer.name, printer.logFilePath,'Loaded AMS Spools:');
                    console.debug(printer.name, printer.logFilePath,JSON.stringify(processedAmsData));
                    printHeader = true;
                    // Reset spool data before updating
                    printer.spoolData = [];
    
                    console.debug(printer.name, printer.logFilePath,'Check completed and there are changes');
                    
                    console.debug(printer.name, printer.logFilePath,'Check each AMS Slot and process its Spool Data');
                    // Iterate through AMS trays and process each slot
                    for (const ams of processedAmsData) {
                        
                        if (printHeader) {
                            console.log(printer.name, printer.logFilePath,`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
                            printHeader = false;
                        }
    
                        // Process valid tray slots
                        console.debug(printer.name, printer.logFilePath,'    Check if data from the Slots are valid');
                        if (Array.isArray(ams.tray)) {

                            for (const slot of ams.tray) {
                                
                                // get all newest updates from spoolman for processing each spool
                                spools = await getSpoolmanSpools();
                                externalFilaments = await getSpoolmanExternalFilaments();
                                internalFilaments = await getSpoolmanInternalFilaments();
                                
                                // Check if slot is a valid Slot (loaded or empty slot)
                                const validSlot = Object.keys(slot).length > 6;
                                
                                // Check if slot is loaded and valid
                                if (validSlot) {
                                
                                    // Check if loaded spool is a original Bambu Lab spool or a 3rd party spool
                                    if (slot.tray_uuid !== "N/A" && slot.tray_sub_brands !== "N/A") {
    
                                        console.debug(printer.name, printer.logFilePath,'    Slot is valid');
                                                                                                                                
                                        let found = false;
                                        let remainingWeight = "";
                                        let mergeableSpool = null;
                                        let matchingExternalFilament = null;
                                        let matchingInternalFilament = null;
                                        let existingSpool = null;
                                        let option = "No actions available";
                                        let enableButton = "false";
                                        let automatic = false;
    
                                        // Set automatic mode
                                        if (MODE === "automatic") automatic = true;
    
                                        // Find matching filaments for the slot
                                        matchingExternalFilament = await findMatchingExternalFilament(slot, externalFilaments);
                                        matchingInternalFilament = await findMatchingInternalFilament(matchingExternalFilament, internalFilaments);
    
                                        console.debug(printer.name, printer.logFilePath,"    Check if there are any Spools in Spoolman");
                                        if (spools.length !== 0) {
                                        
                                            // Check existing spools
                                            console.debug(printer.name, printer.logFilePath,'    Spools found. Check if there is a Spool in Spoolman with an already connected Serial');
                                            for (const spool of spools) {
                                                if (spool.extra?.tag && JSON.parse(spool.extra.tag) === slot.tray_uuid) {
                                                    console.debug(printer.name, printer.logFilePath,'    Connected Spool found: ' + JSON.stringify(spool));
                                                    found = true;
                                                    remainingWeight = (slot.remain / 100) * slot.tray_weight;
                                                    
                                                    const patchData = {
                                                        remaining_weight: remainingWeight,
                                                        last_used: currentTime
                                                    };
    
                                                    // Debug URL and Payload
                                                    console.debug(printer.name, printer.logFilePath,"    Sending PATCH request to:", `http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spool.id}`);
                                                    console.debug(printer.name, printer.logFilePath,"    Payload:", JSON.stringify(patchData));
    
                                                    try {
                                                        // Send a PATCH request to update the spool with new tag data
                                                        const response = await got.patch(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spool.id}`, {
                                                            json: patchData
                                                        });
                                                        
                                                        // Log success message if the spool update is successful
                                                        console.log(printer.name, printer.logFilePath,`    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);
                                                        console.log(printer.name, printer.logFilePath,`        - Updated Spool-ID ${spool.id} => ${spool.filament.name}`);
    
                                                    } catch (error) {
                                                        // Log error details if the update fails
                                                        console.error(printer.name, printer.logFilePath,'          #####');
                                                        console.error(printer.name, printer.logFilePath,'          Spool update failed: ', error.message);
                                                        console.error(printer.name, printer.logFilePath,'          Error details:', error.response?.statusCode, error.response?.body || error.stack);
                                                        console.error(printer.name, printer.logFilePath,'          #####');
                                                    }
    
                                                    printer.lastUpdateTime = currentTime;
                                                    existingSpool = spool;
                                                    break;
                                                }
                                            }
                                        } else {
                                            console.debug(printer.name, printer.logFilePath,"No Spools in Spoolman, skip this part");
                                        }
    
                                        // Handle no matching spool found
                                        if (!found) {
                                            console.debug(printer.name, printer.logFilePath,'    Connected Spool not found, process with merging and creation logic');
                                            console.log(printer.name, printer.logFilePath,`    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);
    
                                            if (spools.length !== 0) {
                                                // Try to find mergeable spools
                                                mergeableSpool = await findMergeableSpool(slot, spools);
                                            } else {
                                                mergeableSpool == null;
                                            }
    
                                            console.debug(printer.name, printer.logFilePath,'    Check if Spool is mergeable with an existing Spool');
                                            if (!mergeableSpool) {
                                                console.debug(printer.name, printer.logFilePath,'    Spool is not mergable, check for other existing spools');
                                                // Create new spool if no matching or mergeable spool found
                                                
                                                if (spools.length !== 0) {
                                                    // Try to find mergeable spools
                                                    existingSpool = await findExistingSpool(slot, spools);
                                                } else {
                                                    existingSpool == null;
                                                }
                                                
                                                
                                                console.debug(printer.name, printer.logFilePath,'    Check if there is an existing Spool');
                                                if (!existingSpool) {
                                                    console.debug(printer.name, printer.logFilePath,'    No existing Spool, check if Filament is created');
                                                    if (matchingInternalFilament) {
                                                        console.log(printer.name, printer.logFilePath,'        Filament exists, create s Spool with this Data');
                                                        console.log(printer.name, printer.logFilePath,"        - A new Spool can be created with following Filament:");
                                                        console.log(printer.name, printer.logFilePath,`          Material: ${matchingInternalFilament.material}, Color: ${matchingInternalFilament.name}`);
    
                                                        if (automatic) {
                                                            console.log(printer.name, printer.logFilePath,`          creating Spool...`);
                                                            let info = [];
                                                            info.push({
                                                              amsId: (await num2letter(ams.id)) + slot.id,
                                                              slot,
                                                              matchingInternalFilament,
                                                              matchingExternalFilament,
                                                              printerName: printer.name,
                                                              logFilePath: printer.logFilePath,
                                                            });
                                                            await createSpool(info[0]);
                                                        }
                                                        option = "Create Spool";
                                                    } else if (matchingExternalFilament) {
                                                        console.debug(printer.name, printer.logFilePath,'        Filament does not exists. Create a new Filament');
                                                        // Create new filament and spool if no matching internal filament or existing spool or mergeable spool found
                                                        console.log(printer.name, printer.logFilePath,"        - A new Filament and Spool can be created:");
                                                        console.log(printer.name, printer.logFilePath,`          Material: ${matchingExternalFilament.material}, Color: ${matchingExternalFilament.name}`);
    
                                                        if (automatic) {
                                                            console.log(printer.name, printer.logFilePath,`          creating Filament and Spool...`);
                                                            let info = [];
                                                               info.push({
                                                                amsId: (await num2letter(ams.id)) + slot.id,
                                                                 slot,
                                                                 matchingInternalFilament,
                                                                 matchingExternalFilament,
                                                                 printerName: printer.name,
                                                                 logFilePath: printer.logFilePath,
                                                               });
                                                               await createFilamentAndSpool(info[0]);
                                                        }
                                                        option = "Create Filament & Spool";
                                                    }
                                                }
                                            } else {
                                                console.log(printer.name, printer.logFilePath,`        - Found mergeable Spool => Spoolman Spool ID: ${mergeableSpool.id}, Material: ${mergeableSpool.filament.material}, Color: ${mergeableSpool.filament.name}`);
    
                                                if (automatic) {
                                                    console.log(printer.name, printer.logFilePath,`          merging Spool...`);
                                                    let info = [];
                                                       info.push({
                                                         amsId: (await num2letter(ams.id)) + slot.id,
                                                         slot,
                                                         mergeableSpool,
                                                         matchingInternalFilament,
                                                         matchingExternalFilament,
                                                         printerName: printer.name,
                                                         logFilePath: printer.logFilePath,
                                                       });
                                                    await mergeSpool(info[0]);
                                                }
                                                option = "Merge Spool";
                                            }
    
                                            // Enable button for manual actions
                                            if (!automatic) enableButton = "true";
                                            printer.lastUpdateTime = new Date();
                                        }
    
                                        // Store updated spool data for frontend
                                        printer.spoolData.push({
                                            amsId: (await num2letter(ams.id)) + slot.id,
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
                                        });
                                    } else {
                                        
                                        console.debug(printer.name, printer.logFilePath,'Slot is read-only and will not trigger Spoolman updates, because there is a false remaining Filament state, no Serial or no color. Maybe it is not a Bambu Lab Spool');
                                        
                                        // push info as 3rd party spool
                                        printer.spoolData.push({
                                            amsId: (await num2letter(ams.id)) + slot.id,
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
                                        });
                                        console.log(printer.name, printer.logFilePath,`    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);
                                    }
                                } else {
                                    console.debug(printer.name, printer.logFilePath,'No Data found in Slots');

                                    // push info as not loaded slot
                                    printer.spoolData.push({
                                        amsId: (await num2letter(ams.id)) + slot.id,
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
                                    });
                                    console.log(printer.name, printer.logFilePath,`    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`);
                                }
                            }

                        } else {
                            console.debug(printer.name, printer.logFilePath,'Data from Slots are not valid');
                        }
                    }
                    
                    lastSpoolData = spools;
                    
                    // Update last MQTT AMS data timestamp
                    printer.lastMqttAmsUpdate = new Date();
                    printer.lastAmsData = processedAmsData;
                    console.log(printer.name, printer.logFilePath,"");
                                        
                    clients.forEach(client => {
                      client.write(`data: ${JSON.stringify({ type: "refresh", printer: printer.id})}\n\n`);
                    });
                    
                } else {
                    const UpdateIntSec = printer.update_interval / 1000;
                    const nextUpdateTime = new Date(currentTime.getTime() + printer.update_interval);
                    const nextUpdate = formatDate(nextUpdateTime);
                    console.log(printer.name, printer.logFilePath,`No new AMS Data or changes in Spoolman found. Processing AMS Data for this printer will be paused until ${nextUpdate} (${UpdateIntSec} seconds)...`);
                    printer.lastUpdateTime = new Date();
                }
                
                printer.lastMqttUpdate = new Date();
            } else {
                console.debug(printer.name, printer.logFilePath,`Data will not be processed because of manually set intervall`);
            }
        } else {
            console.debug(printer.name, printer.logFilePath,`No processable Data found for JSON filter data.printer.ams.ams`);
        }
    } catch (error) {
        console.error(printer.name, printer.logFilePath,`Error processing message for Printer: ${printer.id} - ${error.message}`);
    }
    
    printer.blockMqttUpdates = false;
}

// setting up all mqtt connections for passed printer
async function setupMqtt(printer) {
    const now = Date.now();
    const COOLDOWN_PERIOD = 30000;

    printer.lastReconnectAttempt = printer.lastReconnectAttempt || 0;
    printer.reconnectAttempts = printer.reconnectAttempts || 0;

    // Cooldown
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
            printer.reconnectAttempts++;

            const backoffTime = Math.min(60000, 5000 * Math.pow(2, printer.reconnectAttempts));
            console.log(printer.name, printer.logFilePath, `Connection lost. Reconnecting in ${backoffTime / 1000} seconds...`);

            await sleep(backoffTime);
            setupMqtt(printer);
        });

        client.on("error", (error) => {
            console.error(printer.name, printer.logFilePath, `MQTT error for Printer: ${printer.id} - ${error.message}`);
            client.end();
        });

        console.log(printer.name, printer.logFilePath, `Waiting for MQTT messages for Printer: ${printer.id}...`);
    } catch (error) {
        printer.mqttStatus = "Error";
        printer.mqttRunning = false;
        printer.reconnectAttempts++;
        printer.isReconnecting = false;

        console.error(printer.name, printer.logFilePath, `Error in setupMqtt for Printer: ${printer.id} - ${error.message}`);

        const backoffTime = Math.min(60000, 5000 * Math.pow(2, printer.reconnectAttempts));
        console.log(printer.name, printer.logFilePath, `Retrying connection in ${backoffTime / 1000} seconds...`);

        await sleep(backoffTime);
        setupMqtt(printer);
    }
}

// starting logic for initializing all needed stuff and the connection to spoolman and mqtt sessions
async function starting() {
    if (printers) {
        for (const key in printers) {
            printers[key] = {
                ...printers[key],
                logFilePath: path.join(__dirname, "logs", `${printers[key].id}.log`),
            };
        }

        try {
            const spoolmanHealthApi = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/health`);
            const spoolmanHealth = JSON.parse(spoolmanHealthApi.body);

            if (spoolmanHealth.status === "healthy") {
                console.log("Server", serverLogFilePath, "Spoolman connection: true");
                spoolmanStatus = "Connected";

                if (await checkAndSetVendor() && await checkAndSetExtraField()) {
                    console.log("Server", serverLogFilePath, `Backend running on http://localhost:${PORT}`);
                    monitorPrinters();
                } else {
                    console.error("Server", serverLogFilePath, `Error: Vendor or Extra Field 'tag' could not be set!`);
                }
            } else {
                console.error("Server", serverLogFilePath, "Spoolman connection could not be established");
            }
        } catch (error) {
            console.error("Server", serverLogFilePath, "Error starting the service:", error);
        }
    } else {
        console.error("Server", serverLogFilePath, "Error: no printers found in printers.json!");
    }
}

// Monitoring printers to handle all mqtt connections
async function monitorPrinters() {
    while (true) {
        for (const printer of printers) {
            try {
                const isAlive = await ping.promise.probe(printer.ip);

                if (isAlive.alive) {
                    if (!printer.mqttRunning && !printer.isReconnecting) {
                        console.log(printer.name, printer.logFilePath, `MQTT not running for Printer: ${printer.id}, attempting to reconnect...`);
                        setupMqtt(printer);
                    }
                } else {
                    console.error(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is unreachable. Next try in 60s...`);
                    printer.mqttStatus = "Disconnected";
                    printer.mqttRunning = false;
                }
            } catch (error) {
                console.error(printer.name, printer.logFilePath, `Error monitoring Printer: ${printer.id} - ${error.message}`);
            }
        }
        await sleep(RECONNECT_INTERVAL);
    }
}


// A helper function for sleeping
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// REST API to get status infos for requested printer
app.get("/api/status/:printerId", (req, res) => {
    const printerId = req.params.printerId;
    const printer = printers.find(p => p.id === printerId);

    if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
    }

    res.json({
        spoolmanStatus: spoolmanStatus,
        mqttStatus: printer.mqttStatus,
        lastMqttUpdate: printer.lastMqttUpdate,
        lastMqttAmsUpdate: printer.lastMqttAmsUpdate,
        PRINTER_ID: printer.id,
        printerName: printer.name,
        MODE: MODE,
    });
});

// REST API to get spool infos for requested printer
app.get("/api/spools/:printerId", (req, res) => {
    const printerId = req.params.printerId;
    const printer = printers.find(p => p.id === printerId);

    if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
    }

    res.json(printer.spoolData || []);
});

// REST API to get all printers
app.get("/api/printers", (req, res) => {
    res.json(printers);
});

// REST API endpoint to merge a spool
app.post("/api/mergeSpool", async (req, res) => {
    await mergeSpool(req.body);
});

// REST API endpoint to create a new spool
app.post("/api/createSpool", async (req, res) => {
    await createSpool(req.body);
});

// REST API endpoint to create a new spool along with filament
app.post("/api/createSpoolWithFilament", async (req, res) => {
    await createFilamentAndSpool(req.body);
});

// Event source for Server-Sent Events (SSE) connection
app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders(); // Ensure headers are sent immediately

    // Add the current client connection to the list
    clients.push(res);

    // Remove the client connection when it disconnects
    req.on("close", () => {
        clients = clients.filter((client) => client !== res);
    });
});

// REST API endpoint to get logs from requested printers
app.get('/api/logs/:printerId', (req, res) => {
    const printerId = req.params.printerId;
    
    if (printerId === "server") {
        fs.readFile(serverLogFilePath, 'utf8', (err, data) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to read log file' });
             }
            const logLines = data.split('\n').filter(line => line.trim() !== '');
            res.json({ logs: logLines });
        });
    } else {
        const printer = printers.find(p => p.id === printerId);
        if (!printer) {
            return res.status(404).json({ error: 'Printer not found' });
        }

        const logFilePath = printer.logFilePath;

        fs.readFile(logFilePath, 'utf8', (err, data) => {
            if (err) {
                console.error("Server", serverLogFilePath, `Failed to read log file for printerId "${printerId}":`, err.message);
                return res.status(500).json({ error: 'Failed to read log file' });
            }

            const logLines = data.split('\n').filter(line => line.trim() !== '');
            res.json({ logs: logLines });
        });
    }
});

// Start the backend server and initialize configuration
app.listen(PORT, "0.0.0.0", () => {
    console.log("Server", serverLogFilePath, `Version: ${version}`);
    console.log("Server", serverLogFilePath, `Setting up configuration...`);
    starting(); // Begin application setup process
});
