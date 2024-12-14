import mqtt from "mqtt";
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

async function num2letter(num) {
  return String.fromCharCode("A".charCodeAt(0) + Number(num));
}

async function main() {
  try {
    // MQTT Client erstellen
    const client = mqtt.connect(`tls://bblp:${PRINTER_CODE}@${PRINTER_IP}:8883`, {
      rejectUnauthorized: false,
    });

    client.on("connect", () => {
      console.log("MQTT client connected");

      // Abonnieren des MQTT-Themas
      client.subscribe(`device/${PRINTER_ID}/report`, (err) => {
        if (err) {
          console.log(`Subscription error: ${err}`);
        } else {
          console.log(`Subscribed to device/${PRINTER_ID}/report`);
        }
      });
    });

    // Fehlerbehandlung
    client.on("error", (err) => {
      console.log(`MQTT connection error: ${err}`);
    });

    // Nachricht empfangen
    client.on("message", async (topic, message) => {
      try {
        const data = JSON.parse(message);
        if (data.print.ams?.ams) {
          const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
          const spools = JSON.parse(response.body);

          for (const ams of data.print.ams.ams) {
            console.log(`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
            for (const slot of ams.tray) {
              console.log(`    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tag_uid} ]]`);

              let found = false;
              for (const spool of spools) {
                // Prüfe auf mehrere Tag-Felder
                const tagsToCheck = [spool.extra?.tag, spool.extra?.secondary_tag];

                if (tagsToCheck.some((tag) => tag && JSON.parse(tag) === slot.tag_uid)) {
                  found = true;

                  await got.patch(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spool.id}`, {
                    json: {
                      remaining_weight: (slot.remain / 100) * slot.tray_weight,
                    },
                  });
                  console.log(`Updated spool ${spool.id}`);
                  break;
                }
              }

              if (!found) {
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
