import mqtt from "async-mqtt";
import got from "got";
import { config } from "dotenv";

// Lade Umgebungsvariablen aus der .env-Datei
config();

// Umgebungsvariablen
const PRINTER_ID = process.env.PRINTER_ID;
const PRINTER_CODE = process.env.PRINTER_CODE;
const PRINTER_IP = process.env.PRINTER_IP;
const SPOOLMAN_IP = process.env.SPOOLMAN_IP;
const SPOOLMAN_PORT = process.env.SPOOLMAN_PORT;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL 
  ? Math.max(parseInt(process.env.UPDATE_INTERVAL, 10), 1000) 
  : 300000; // Aktualisierungsfrequenz in Millisekunden, Standard: 5 Minuten, Mindestwert: 1 Sekunde

// Speicher für den letzten Aktualisierungszeitpunkt
const lastUpdateTimes = {};

async function num2letter(num) {
  return String.fromCharCode("A".charCodeAt(0) + Number(num));
}

async function main() {
  try {
    // MQTT Client erstellen
    const client = await mqtt.connectAsync(`tls://bblp:${PRINTER_CODE}@${PRINTER_IP}:8883`, {
      rejectUnauthorized: false,
    });

    console.log("MQTT client connected");

    // Abonnieren des MQTT-Themas
    await client.subscribe(`device/${PRINTER_ID}/report`);
    console.log(`Subscribed to device/${PRINTER_ID}/report`);

    // Nachricht empfangen
    client.on("message", async (topic, message) => {
      try {
        const data = JSON.parse(message);

        // Überprüfen, ob die verschachtelten Objekte vorhanden sind
        if (data?.print?.ams?.ams) {
          const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
          const spools = JSON.parse(response.body);

          for (const ams of data.print.ams.ams) {
            let amsHeaderPrinted = false;

            for (const slot of ams.tray) {
              if (slot.remain < 0) {
                continue;
              }

              let found = false;
              const currentTime = Date.now();

              for (const spool of spools) {
                // Prüfe nur spool.extra?.tag
                if (spool.extra?.tag && JSON.parse(spool.extra.tag) === slot.tray_uuid) {
                  found = true;

                  // Überprüfe den letzten Aktualisierungszeitpunkt
                  if (
                    lastUpdateTimes[spool.id] &&
                    currentTime - lastUpdateTimes[spool.id] < UPDATE_INTERVAL
                  ) {
                    // Kein Logging, wenn Update übersprungen wird
                    break;
                  }

                  if (!amsHeaderPrinted) {
                    console.log(`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
                    amsHeaderPrinted = true;
                  }

                  console.log(
                    `    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`
                  );

                  await got.patch(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spool.id}`, {
                    json: {
                      remaining_weight: (slot.remain / 100) * slot.tray_weight,
                    },
                  });
                  console.log(`      - Updated spool ${spool.id}`);

                  // Aktualisiere den letzten Aktualisierungszeitpunkt
                  lastUpdateTimes[spool.id] = currentTime;
                  break;
                }
              }

              if (!found) {
                if (!amsHeaderPrinted) {
                  console.log(`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
                  amsHeaderPrinted = true;
                }

                console.log("      - Not found. Update spool tag!");
              }
            }
          }
        }
      } catch (e) {
        console.error(`Error in message handler: ${e}`);
      }
    });

    console.log("Waiting for MQTT messages...");
  } catch (e) {
    console.error(`Error in main: ${e}`);
  }
}

// Skript ausführen
main();
