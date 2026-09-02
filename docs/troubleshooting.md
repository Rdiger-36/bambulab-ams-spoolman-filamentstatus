# Troubleshooting

[← Documentation](README.md)

## Checking logs

```bash
docker logs -f bambulab-ams-spoolman-filamentstatus
```

Startup and the AMS report:

```bash
[LOG] Server - Setting up configuration...
[LOG] Server - Backend running on http://localhost:4000
[LOG] Server - Spoolman connected successfully!
[LOG] Server - Vendor "Bambu Lab" exists: true
[LOG] Server - Spoolman Extra Field "tag" for Spool is set: true
[LOG] Bambu Lab P1S - Setting up MQTT connection for Printer: 01PXXXXXXXXXX...
[LOG] Bambu Lab P1S - MQTT client connected for Printer: 01PXXXXXXXXXX
[LOG] Bambu Lab P1S - AMS [A] (hum: 5, temp: 0.0ºC)
[LOG] Bambu Lab P1S -     - [A0] PLA Basic 000000FF [[ XXXXXX00000A ]] => Spool-ID 1 (G-code mode)
```

A slot that is already linked is logged once, when the loaded filament changes. The remain percentage of the AMS is not logged for it, the weight does not come from there.

A print, from start to booking:

```bash
[LOG] Bambu Lab P1S - [Print] Print running: "bracket.gcode.3mf", fetching slice info via FTPS...
[LOG] Bambu Lab P1S - [Print] Slice info loaded: 2 filament(s), 260 layers
[LOG] Bambu Lab P1S - [Print] FINISH, booking filament consumption: {"GFA00|000000":{"tray_info_idx":"GFA00","color":"#000000","type":"PLA","grams":24.7}, ...}
[LOG] Bambu Lab P1S - [Print] Booked 24.7g for spool 1 (A0, GFA00 PLA #000000)
[LOG] Bambu Lab P1S - [Print] Booked 3.1g for spool 7 (A2, GFA01 PLA #FFFFFF, manually assigned)
```

A slot that is neither tag-linked nor manually assigned is named and skipped, so the log says which spool is missing its link:

```bash
[LOG] Bambu Lab P1S - [Print] No connected or assigned Spoolman spool for GFG00 PETG (#1E88E5), skipping 12.4g (assign the spool in the Web UI to track it)
```

The same logs are readable in the Web UI, per printer and for the server.

## Debug-Printers CLI

The container ships a script that checks the network and MQTT status of a printer from inside the container:

```bash
docker exec -it CONTAINER_NAME debug-printers
```

Pick a printer by number, then choose between subscribing to its MQTT messages, which prints everything the printer sends including the AMS spool data, and a reachability check on port 8883:

```bash
--- Options for Bambu Lab P1S ---
1. Subscribe to MQTT messages
2. Check reachability
3. Back to main menu
```

## Diagnostics and privacy

Logs and configuration describe a home network: the address of every printer and of Spoolman, the serial numbers, and in `printers.json` the access codes. Every download that can carry them asks first and offers an anonymised variant.

**Download diagnostics** produces one archive with everything a bug report needs: `info.json` (version, Node, platform, uptime, tracking mode), `settings.json` with the origin of each value, `printers.json`, `mappings.json` and `logs/` including the rotated history. **Download log** on the log page asks the same question for that one log.

Anonymised replaces the last octet of every IP address, everything after the first five characters of a serial number (in file names as well), the whole access code, the Spoolman host name (keeping scheme, port and path), and shortens the data and log paths to their last two segments. Printer names, spool data and RFID tag ids are kept: they make a log readable and say nothing about the network.

**The access code is never part of any export**, anonymised or not.
