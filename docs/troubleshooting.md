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
[LOG] Bambu Lab P1S -     - [A1] PLA Basic 000000FF [[ XXXXXX00000A ]] => Spool-ID 1 (G-code mode)
```

A slot that is already linked is logged once, when the loaded filament changes. The remain percentage of the AMS is not logged for it, the weight does not come from there.

A print, from start to booking:

```bash
[LOG] Bambu Lab P1S - [Print] Print running: "bracket.gcode.3mf", fetching slice info via FTPS...
[LOG] Bambu Lab P1S - [Print] Slice info loaded: 2 filament(s), 260 layers
[LOG] Bambu Lab P1S - [Print] FINISH, booking filament consumption: {"GFA00|000000":{"tray_info_idx":"GFA00","color":"#000000","type":"PLA","grams":24.7}, ...}
[LOG] Bambu Lab P1S - [Print] Booked 24.7g for spool 1 (A1, GFA00 PLA #000000)
[LOG] Bambu Lab P1S - [Print] Booked 3.1g for spool 7 (A3, GFA01 PLA #FFFFFF, manually assigned)
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

## The Web UI answers with 403

The service accepts a request only under the name it was addressed to, which is
what keeps a page on another website from reaching an installation on your
network. IP addresses, `localhost` and `.local` names are always accepted, so
this only appears when the Web UI is reached under a real domain name or through
a reverse proxy:

```
Host "ams.example.com" is not allowed. Reach this service under its IP address,
or add the name to "Allowed host names" on the settings page.
```

The server log carries the same line once per refused name. Open the Web UI
under the IP address of the host, which is never refused, and add the name under
**Network access** on the settings page, comma separated for more than one. It
takes effect on save, without a restart. `ALLOWED_HOSTS` in the container
definition seeds the same setting on an installation that has never saved it.

A `PUT` or `POST` answered with 403 while the pages load has the same cause
behind a reverse proxy that rewrites the `Host` header: the same entry fixes
it.

## The password is gone

A forgotten Web UI password is not recoverable, it is stored as a hash. Take it
out of the configuration instead: stop the container, open
`printers/settings.json`, remove the `AUTH_PASSWORD` line from `values`, and
start the container again. The Web UI is open again until a new password is set
on the settings page.

If the container is what sets it, through an `AUTH_PASSWORD` environment
variable on an installation that never saved the field, change it there instead.
A value saved in the Web UI wins over the variable.

Sessions end whenever the password changes, on every device, because the cookie
is signed with it. A browser that suddenly asks again after somebody changed the
password is doing what it should.

## Diagnostics and privacy

Logs and configuration describe a home network: the address of every printer and of Spoolman, the serial numbers, and in `printers.json` the access codes. Every download that can carry them asks first and offers an anonymised variant.

**Download diagnostics** produces one archive with everything a bug report needs: `info.json` (version, Node, platform, uptime, tracking mode), `settings.json` with the origin of each value, `printers.json`, `mappings.json` and `logs/` including the rotated history. The API keys are not in it at all, and the Web UI password and the printer access codes are replaced before the archive is written. **Download log** on the log page asks the same question for that one log.

Anonymised replaces the last octet of every IP address, everything after the first five characters of a serial number (in file names as well), the whole access code, the Spoolman host name (keeping scheme, port and path), and shortens the data and log paths to their last two segments. Printer names, spool data and RFID tag ids are kept: they make a log readable and say nothing about the network.

**The access code is never part of any export**, anonymised or not.
