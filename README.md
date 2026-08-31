<h1 align="center">Bambulab AMS Spoolman Filament Status</h1>

<p align="center">
  Synchronize your Bambu Lab AMS filament spools with Spoolman, automatically.<br/>
  Listens for MQTT updates from your printers and keeps spool usage in sync in real time.
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square&label=version&color=blue" alt="version" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/platform-x86--64%20%7C%20arm64%20%7C%20arm%2Fv7-lightgrey?style=flat-square&color=orange" alt="platform" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="license" />
  <img src="https://img.shields.io/badge/maintained-yes-brightgreen?style=flat-square" alt="maintained" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square&color=yellow" alt="stars" />
  <img src="https://img.shields.io/github/forks/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square&color=orange" alt="forks" />
  <img src="https://img.shields.io/github/issues/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square" alt="open issues" />
  <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2FRdiger-36%2Fbambulab-ams-spoolman-filamentstatus%2Fbambulab-ams-spoolman-filamentstatus&query=%24.downloadCount&style=flat-square&logo=docker&label=pulls&color=blue" alt="GHCR Pulls" />
  <img src="https://img.shields.io/github/last-commit/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square&label=last%20commit" alt="last commit" />
</p>

---

This project is based on the idea of a script from [Diogo Resende](https://github.com/dresende) posted in this [issue](https://github.com/Donkie/Spoolman/issues/217).


## !! Attention !!
This Solution works with Bambu Lab Printers with a connected AMS for the P, H and X-Series.

Spool weight is tracked from the sliced G-code by default, which works for 3rd party spools without an RFID tag as well (see [Tracking modes](#tracking-modes)). Automatically creating and merging Spools and Filaments in Spoolman still relies on the RFID tag of original Bambu Lab spools; a 3rd party spool is linked to a Spoolman spool manually in the Web UI instead.

In the legacy tracking mode (`LEGACY_MODE=true`) the AMS Lite is not supported for updating Spools on Spoolman, because it only reports 100% or 0% left on the Spool ([#Issue 4](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/issues/4#issuecomment-2550571529)). It can still be used to Create Spools and Filaments on Spoolman and connect their serials with it.

### Tracking modes at a glance
<table>
<tr>
<td align="center"><b>MQTT Mode (Old)</b></td>
<td align="center"><b>G-code Mode (New!)</b></td>
</tr>
<tr>
<td><img src="https://github.com/user-attachments/assets/1498ea96-2bf5-49a9-a98e-b50776341efa" width="300"/></td>
<td><img src="https://github.com/user-attachments/assets/35fd8251-5577-41e3-8510-ed41cf8a35b3" width="300"/></td>
</tr>
</table>

## Features

- Real-time AMS filament status updates for all possible AMS on one printer (12 AMS max --> max. 4 AMS Standard/2-Pro + 8 AMS HT)
- Multiple Printer Support
- Synchronizes spool usage with Spoolman
- Tracks filament consumption from the sliced G-code, so 3rd party spools without an RFID tag are covered too
- Manually assign a Spoolman spool to an AMS slot for spools the printer cannot identify by itself
- Lightweight Docker container for easy deployment
- Web UI for manually merge or create Spools and Filaments with collected data
- Automatic Mode for automatically merge or create Spools and Filaments with collected data
- Settings page in the Web UI for the configuration and the printer list, no container restart needed

## Getting Started

### Prerequisites

- A running instance of Spoolman
- Access to your Bambu Lab printers with its **serial number**, **access code**, and **IP address**
- Turn on the "Update remaining capacity" option in Bambu Studio:
  ![Bildschirmfoto 2025-01-16 um 18 00 45](https://github.com/user-attachments/assets/fe6cf018-b211-4fd6-8931-1c895842d71b) ![Bildschirmfoto 2025-01-16 um 18 01 44](https://github.com/user-attachments/assets/23c60d83-e5ed-41af-9fbc-24cc9dd8ede7)

### Supported Architectures

Simply pulling `ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest` should retrieve the correct image for your arch.

The architectures supported by this image are:

| Docker platform | Also known as | Supported | Typical hardware |
| :---- | :---- | :----: | :---- |
| `linux/amd64` | x86-64, x64 | ✅ | PCs, servers, most NAS boxes |
| `linux/arm64` | aarch64, arm64v8 | ✅ | Raspberry Pi 3 and newer on a 64 bit OS, Apple Silicon |
| `linux/arm/v7` | armhf (Debian, Raspberry Pi OS), armv7 (Alpine) | ✅ | Raspberry Pi 2 and newer on a 32 bit OS, older ARM SBCs and NAS boxes |
| `linux/arm/v6` | armhf (Alpine), armel | ❌ | Raspberry Pi 1, Pi Zero, Pi Zero W |

A note on "armhf", because it means two different things. Debian and Raspberry
Pi OS use it for 32 bit ARMv7, which is supported. Alpine uses it for ARMv6,
which is not. Raspberry Pi OS additionally reports "armhf" on an ARMv6 Pi Zero,
so the name alone does not tell you whether an image exists. The Docker platform
in the first column is the one unambiguous identifier.

If `docker pull` reports `no matching manifest for linux/arm/v6`, the device is
an ARMv6 one from the last row. Those are not built: a Pi Zero has a single
1 GHz core and 512 MB of RAM, which this service would not run well on.

### Supported Hardware

The Hardware supported by this image are:
#### Printer Models
| Hardware | Supported |
| :----: | :----: |
| A Series with AMS Lite | ⚠️ - no update status (read only) |
| A 1 with AMS Standard/2-Pro | ✅ |
| H Series | ✅ |
| P Series | ✅ |
| X Series | ✅ |

#### AMS Types
| Hardware | Supported |
| :----: | :----: |
| AMS | ✅ |
| AMS Lite | ⚠️ - no update status (read only) |
| AMS 2 Pro | ✅ |
| AMS HT | ✅ |


### Installation

1. Pull the Docker image:
   ```bash
   docker pull ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest
   ```

2. Create your /path/to/your/config/printers/printers.json:
      ```bash
      [
          {
              "name": "Printer 1",
              "id": "01PXXXXXXXXXXXX",
              "code": "AccessCode",
              "ip": "192.168.1.X"
          },
          {
              "name": "Printer 2",
              "id": "01PXXXXXXXXXXXX",
              "code": "AccessCode",
              "ip": "192.168.1.X"
          },
          {
              "name": "Printer 3",
              "id": "01PXXXXXXXXXXXX",
              "code": "AccessCode",
              "ip": "192.168.1.X"
          }
      ]
     ```
   | Attributes | Printer |
   | :--------: | :-----: |
   | id         | Serial from Printer |
   | code       | AccessCode from Printer |

   This file is optional. Start the container without it and add your printers
   on the settings page of the Web UI instead, see [Settings](#settings). The
   service writes the file itself from then on.

2. Run the container:
   ```bash
   docker run -d \
     -e SPOOLMAN_ENDPOINT=http(s)://<spoolman_ip_address>:<spoolman_port>[/<spoolman_subfolder>] \
     -e UPDATE_INTERVAL=120000 \
     -e MODE=automatic \
     -e TZ=Europe/Berlin \
     -p 4000:4000 \
     -v /path/to/your/config/printers:/app/printers \
     -v /path/to/your/config/logs:/app/logs \
     --name bambulab-ams-spoolman-filamentstatus \
    ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest
   ```
   
   or as Docker Compose:
   ```bash
   services:
    bambulab-ams-spoolman-filamentstatus:
      image: ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest
      container_name: bambulab-ams-spoolman-filamentstatus
      depends_on:
        spoolman:
          condition: service_started
          restart: true
      ports:
        - 4000:4000
      environment:
        - SPOOLMAN_ENDPOINT=http(s)://<spoolman_ip_address>:<spoolman_port>[/<spoolman_subfolder>]
        - UPDATE_INTERVAL=120000
        - MODE=automatic
        - TZ=Europe/Berlin
      volumes:
        - /path/to/your/config/printers:/app/printers
        - /path/to/your/config/logs:/app/logs
      restart: unless-stopped
   ```

## Environment Variables

Every variable below is also a field on the [settings page](#settings). A
variable seeds its setting as long as the setting has never been saved in the
Web UI. After the first save `printers/settings.json` owns the value and the
variable is ignored, so that a value changed in the UI is not silently reverted
by the container definition on the next start.

| Variable             | Description                                   |
|----------------------|-----------------------------------------------|
| `SPOOLMAN_ENDPOINT`  | Provide Spoolman full endpoint (use http or https and optional subfolder) |
| `SPOOLMAN_FQDN`      | Access Spoolman via a web link in the footer or from the button "Go to Spoolman" from "Show Info!" dialog (e.g., http(s)://spoolman.your.domain[/spoolman]) |
| `UPDATE_INTERVAL`    | Time in ms for updating spools in Spoolman (default: 120000 ms -> 2 minutes) min. 5000 (5 sec), max 3000000 (5 min)|
| `MODE`               | Set the mode of the service: "automatic" (or the shorthand "auto") or "manual" (default: manual). An unrecognised value falls back to manual and is reported at startup |
| `NEVER_MERGE_IF_TAG` | Never merge spools if a tag is already set, even if the one is empty (default: "false") |
| `SET_LOCATION`       | Automatically sync the spool location in Spoolman with the AMS slot (e.g. "Bambu Lab P1S - A0") when a spool is detected (default: "false") |
| `LEGACY_MODE`        | Track spool weight from the AMS RFID remain % instead of the sliced G-code: "true" or "false" (default: "false"). See [Tracking modes](#tracking-modes) |
| `DEBUG`              | Enable this to show more Logs for Debugging (not for WEB UI Logs): "true" or "false" (default: false)|
| `OFFLINE_CHECK_INTERVAL` | Time in ms between two reachability checks of a disconnected printer (default: 20000 ms, min. 20000, max. 3600000) |
| `MAX_RETRIES`        | Failed connection attempts before monitoring is disabled for a printer (default: 0, which retries forever) |
| `PRINTER_ID`, `PRINTER_CODE`, `PRINTER_IP` | Single printer seed, used when no `printers.json` exists yet. The printer is written into `printers.json` on the first start |
| `DATA_DIR`, `LOG_DIR` | Where `printers.json`, `settings.json` and `mappings.json` live, and where the log files are written. Default to `/app/printers` and `/app/logs` in the container, which is what the volumes in the examples above mount. Only set these when you cannot mount those paths |
| `LOG_MAX_SIZE_MB` | Size a log file may reach before it is rotated (default: 1 MB, max 100). The current file is renamed to `<name>.log.1` and an empty one takes its place |
| `LOG_KEEP_SERVER`, `LOG_KEEP_PRINTER` | How many rotated files to keep, for the server log and per printer (default: 2 each, max 20). 0 starts the current file over instead of keeping a history. Every printer has its own file, so the printer value multiplies with the number of printers |
| `TZ`           | Time zone of the container, for example `Europe/Berlin`. The log timestamps follow it. Without it the container runs on UTC, so the logs are offset against the clock of the machine reading them |
| `SUPERVISOR`   | Set to "false" to run the service in a single process, without the supervisor that restarts it from the Web UI. Saves about 30 MB of memory, which matters on a 32 bit Raspberry Pi. The restart button then depends on the restart policy of the container, and says so (default: on) |

## Usage

### Checking Logs
Once the container is running, it will automatically connect to the Bambulab AMS system and Spoolman. Logs can be viewed using:

```bash
docker logs -f bambulab-ams-spoolman-filamentstatus
```

Example Output:
```bash
[LOG] Server - Setting up configuration...
[LOG] Server - Spoolman connection: true
[LOG] Server - Checking Vendors...
[LOG] Server - Vendor "Bambu Lab" exists: true
[LOG] Server - Checking Extra Field "tag"...
[LOG] Server - Spoolman Extra Field "tag" for Spool is set: true
[LOG] Server - Backend running on http://localhost:4000
[LOG] Bambu Lab P1S - MQTT not running for Printer: 01PXXXXXXXXXX, attempting to reconnect...
[LOG] Bambu Lab P1S - Setting up MQTT connection for Printer: 01PXXXXXXXXXX...
[LOG] Bambu Lab Test Printer A - MQTT not running for Printer: 0AX12345678, attempting to reconnect...
[LOG] Bambu Lab Test Printer A - Setting up MQTT connection for Printer: 0AX12345678...
[LOG] Bambu Lab Test Printer A - MQTT client connected for Printer: 0AX12345678
[LOG] Bambu Lab Test Printer A - Waiting for MQTT messages for Printer: 0AX12345678...
[LOG] Bambu Lab P1S - MQTT client connected for Printer: 01PXXXXXXXXXX
[LOG] Bambu Lab P1S - Waiting for MQTT messages for Printer: 01PXXXXXXXXXX...
[LOG] Bambu Lab Test Printer A - AMS [A] (hum: 5, temp: 0.0ºC)
[LOG] Bambu Lab Test Printer A -     - [A0] ASA-CF 000000FF (85%) [[ XXXXXX000001 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 5 => Black
[LOG] Bambu Lab Test Printer A -     - [A1] PETG Translucent D6ABFFFF (49%) [[ XXXXXX000002 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 6 => Translucent Purple
[LOG] Bambu Lab Test Printer A -     - [A2] PLA Marble AD4E38FF (63%) [[ XXXXXX000003 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 7 => Red Granite
[LOG] Bambu Lab Test Printer A -     - [A3] PLA Galaxy 594177FF (38%) [[ XXXXXX000004 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 8 => Purple Galaxy
[LOG] Bambu Lab Test Printer A -     - [B0] PLA Basic F4EE2AFF (10%) [[ XXXXXX000005 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 9 => Yellow
[LOG] Bambu Lab Test Printer A -     - [B1] TPU for AMS 90FF1AFF (27%) [[ XXXXXX000006 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 10 => For AMS Neon Green
[LOG] Bambu Lab Test Printer A -     - [B2] PLA Basic 00AE42FF (98%) [[ XXXXXX000007 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 11 => Bambu Green
[LOG] Bambu Lab Test Printer A -     - [B3] PLA Matte BB3D43FF (50%) [[ XXXXXX000008 ]]
[LOG] Bambu Lab Test Printer A -         - Updated Spool-ID 12 => Matte Dark Red
[LOG] Bambu Lab Test Printer A - 
[LOG] Bambu Lab P1S - AMS [A] (hum: 5, temp: 0.0ºC)
[LOG] Bambu Lab P1S -     - [A0] PLA Basic 000000FF (15%) [[ XXXXXX00000A ]]
[LOG] Bambu Lab P1S -         - Updated Spool-ID 1 => Black
[LOG] Bambu Lab P1S -     - [A1] PLA Matte 000000FF (32%) [[ XXXXXX00000B ]]
[LOG] Bambu Lab P1S -         - Updated Spool-ID 2 => Matte Charcoal
[LOG] Bambu Lab P1S -     - [A2] PLA Basic FFFFFFFF (100%) [[ XXXXXX00000C ]]
[LOG] Bambu Lab P1S -         - Updated Spool-ID 3 => Jade White
[LOG] Bambu Lab P1S -     - [A3] PLA Basic 000000FF (100%) [[ XXXXXX00000D ]]
[LOG] Bambu Lab P1S -         - Updated Spool-ID 4 => Black
```

### How does it work

The Bambu Lab Printers sends their data via MQTT. This Service catches the data and process it automatically to communicate with spoolman.
For this, the container also request Spoolman an its build in API.

The collected data can be used for:
- Merging Spools:
    - If a spool is detected in the AMS that has the same material, colour and remaining weight as a spool in Spoolman that does not have a tag, it can be merged with that spool. The spool's serial number is entered as a value called 'tag' in the spool's extra field. So when the AMS spool and the Spoolman spool are connected, the data is updated (remaining weight and time stamp of last use). 
- Creating Spools:
    - If a spool is detected in the AMS that has no spool in Spoolman, it can be created by using an existing registered filament in Spoolman. In this case, the spool will be created and the tag will also be set.
- Creating Filaments and Spools:
    - If a spool is detected in the AMS that, has no spool in Spoolman and has no matching registered filament, then it all can be created by importing a external filament from the SpoolmanDB that matches to the loaded spool in the AMS. After the filament is created an registered, the spool in Spoolman will be created and the tag will also be set.

### Tracking modes

There are two ways the remaining weight of a spool can be tracked.

**G-code tracking (default)**

While a print is running, the service downloads the sliced `.gcode.3mf` from the printer via FTPS and reads how many grams of each filament the print needs. When the print reaches a final state, that amount is booked onto the matching Spoolman spool. A cancelled or failed print is booked proportionally to the layers that were actually printed.

Because the numbers come from the slicer and not from the RFID chip, this also works for 3rd party spools. Those spools carry no chip, so the printer cannot say which spool is loaded. Link it to a Spoolman spool once in the Web UI and the consumption of that slot is booked onto it. The action on such a slot offers both: picking a spool that already exists in Spoolman, or creating filament and spool right there. The form starts from what the AMS does report (material and colour) and fills density and temperatures from Spoolman's material catalogue; manufacturers, materials and locations are pick-or-type, and a value that does not exist yet is created on save. Everything a chipless spool cannot report, full weight and how much is left, has to be entered by hand.

The link is dropped automatically as soon as a different filament is detected in the slot. It also resolves the rare case of two loaded spools that are identical in material and color, which the RFID tag alone cannot tell apart.

Requirements: LAN access to the printer on port 990 (FTPS) with the printer's access code, which is the same code already used for MQTT.

**Legacy tracking (`LEGACY_MODE=true`)**

The behaviour of earlier versions: the remaining weight is read from the AMS RFID chip's remain percentage on every MQTT update and written to Spoolman. Original Bambu Lab spools only, and the AMS Lite is not supported (see [Attention](#-attention-)).

In this mode G-code tracking is switched off completely, with no FTPS download and no consumption booking, and the Web UI shows the classic AMS table instead of the print dashboard.

3rd party spools are not supported here. They carry no RFID chip, so they report no remain percentage, and this mode has nothing else to work from. Such a slot is shown as loaded but offers no action, exactly as it did before G-code tracking existed. Manual assignment is unavailable for the same reason: it exists to tell the G-code booking which spool to charge, and this mode books nothing. Assignments already saved are left on disk untouched and take effect again as soon as G-code tracking is back on.

### Mode:
There are two modes you can run this container: automatic and manual
- automatic:
    - The above functions are all performed automatically, you dont need to interact with the container
      Preview on console:
      ```bash
          - [A0] PETG HF 000000FF (18%) [[ A012456878ABCDEF ]]
                - A new Filament and Spool can be created:
                  Material: PETG, Color: HF Black
                  creating Filament and Spool...
                  Filament and Spool successfully created for Spool in AMS Slot => A0!
                                            
                                            ⬇
                                            
          - [A0] PETG HF 000000FF (17%) [[ A012456878ABCDEF ]]
                - Updated Spool-ID 1 => HF Black

        --------------------------------------------------------------------------------------------------

          - [A0] PETG HF 000000FF (18%) [[ A012456878ABCDEF ]]
                - Found mergeable Spool => Spoolman Spool ID: 1, Material: PETG HF, Color: HF Black
                  merging Spool...
                  Spool successfully merged with Spool-ID 1 => HF Black
                                                              
                                            ⬇
                                            
          - [A0] PETG HF 000000FF (17%) [[ A012456878ABCDEF ]]
                - Updated Spool-ID 1 => HF Black

        --------------------------------------------------------------------------------------------------
        
          - [A0] PETG HF 000000FF (18%) [[ 1CEC14C7DB18404FB71B61DBC4549322 ]]
                - A new Spool can be created with following Filament:
                  Material: PETG HF, Color: HF Black
                  creating Spool...
                  Spool successfully created for Spool in AMS Slot => A0!
                                                              
                                            ⬇
                                            
          - [A0] PETG HF 000000FF (17%) [[ A012456878ABCDEF ]]
                - Updated Spool-ID 1 => HF Black
      ```

      The above functions can also be accessed by a Web UI which is reachable on http://localhost:4000
      You will find more infos about it on te Web UI section

- manual:
      Link to WEB UI

### AMS Infos

| Slot in Log  | Slot on AMS          | Slot in Log  | Slot on AMS         |
|--------------|----------------------|--------------|---------------------|
| `A0`         | first AMS, Slot 1    |`B0`          |second AMS, Slot 1   |
| `A1`         | first AMS, Slot 2    |`B1`          |second AMS, Slot 2   |
| `A2`         | first AMS, Slot 3    |`B2`          |second AMS, Slot 3   |
| `A3`         | first AMS, Slot 4    |`B3`          |second AMS, Slot 4   |
| `HT-A`       | first AMS-HT, Slot 1 |`HT-B`        |second AMS-HT, Slot 1|

This will be expanded till D on normal AMS (max. 4 AMS on one Printer) and from HT-A till HT-H for all connected AMS-HT


## Spoolman Spool Configuration

There is no configuration needed for your Spoolman Service.

The needed Extra Filed "tag" and the manufacrurer "Bambu Lab" will be automatically created at the start of the container:

```bash
Setting up configuration...
Spoolman connection: true
Checking Vendors...
Vendor "Bambu Lab" exists: false
Creating Vendor "Bambu Lab"...
Vendor "Bambu Lab" successfully created!
Checking Extra Field "tag"...
Spoolman Extra Field "tag" for Spool is set: false
Create Extra Filed "tag" for Spools in Spoolman
Extra Field "tag" successfully created!
```

## Settings

The **Settings** entry in the menu opens a page that holds everything the
environment variables cover, plus the printer list. The same menu is on every
page and carries the dashboard, the printer list and the log views; picking a
printer from another page opens it on the dashboard.

- **Printers**: add, edit and remove printers. A new printer connects right
  away, a removed one is disconnected and its spool assignments are dropped.
  Removing a printer, or changing its address or access code, asks first while
  a print is running: the consumption of a running job is booked when it ends,
  so dropping the connection before that loses it.
  The serial number cannot be changed, it keys the MQTT topic, the log file and
  the assignments. The access code is stored on the server and never sent back
  to the browser; leave the field empty while editing to keep the stored one.
- **Test connection**, in the printer dialog and under the Spoolman endpoint.
  The printer test checks both connections the service needs: MQTT on port 8883
  for the AMS data, and FTPS on port 990 for the sliced file the consumption is
  read from. It waits for a report on the topic of the serial number, so a
  serial that does not belong to that address is reported as unconfirmed
  instead of passing. Both tests use the values in the form, so an address can
  be verified before it is saved.
- **Spoolman connection**: only the endpoint is shown, host, port, subfolder
  and the public URL sit in a collapsed section below it. The line under the
  field says which URL the service actually talks to, subfolder included.
- **Tracking, synchronisation, printer connection and logging**: one card each,
  applied to the running service as soon as they are saved. Changing the
  endpoint reconnects and runs the vendor and extra field setup against the new
  instance.
- **Legacy mode** is the one field that needs a restart. The value is saved
  right away, but the running service keeps the mode it started with, and the
  page keeps saying so, with a "Restart now" next to it, until the service is
  restarted. The two tracking modes book consumption differently, so switching
  one into a running process would book a print in flight twice or not at all.

- **Restart service**, in its own card at the bottom. The container runs a small
  supervisor that starts the service again by itself, so this works whether or
  not the container has a restart policy. The page waits for the service to come
  back and reloads itself, or tells you when it does not. While a print is
  running it asks first, because the consumption of that job is booked only when
  it ends.

Everything is stored in `printers/settings.json` next to `printers.json`, so it
survives a container update as long as that volume is mounted.

> [!IMPORTANT]
> The Web UI has no authentication. It is meant for a trusted local network.
> With the settings page it can now change the printer list and the Spoolman
> endpoint, so do not expose the port to the internet. The access code of a
> printer is stored in plain text in `printers/printers.json`, the same as
> before, and is never sent back to the browser.

> [!NOTE]
> **Home Assistant add-on users:** the add-on passes its options as environment
> variables, and those only seed a setting that has never been saved. As soon as
> you save on the settings page, `printers/settings.json` owns the values and
> changing an add-on option has no effect any more. Either configure through the
> add-on options or through the settings page, not both.

## Web UI
Main Menu with loaded Bambu Lab Spools, 3rd Party Spools and empty Slots:
![Dashboard](https://github.com/user-attachments/assets/9e77a5c6-d3a8-4a77-996c-5af866b32824)


The State column indicates the behavoir of the loaded spool and its data.
- ✅ (Checkmark) → Spools recognized correctly and can be processed.
- ⚠️ (Warning) → Empty slot or non-BambuLab spool loaded.
- ❗ (Error) → Filament check failed for BambuLab spools.

If there is an error and you click on the Button "Show Info!", a dialog appears:
![image](https://github.com/user-attachments/assets/aae0bdab-54ce-4f38-aeac-898d882ae80c)

After you followed the guide and its all setup correctly, the table should look like this:
![image](https://github.com/user-attachments/assets/34fb14c4-7e3f-44e6-9979-ed577d4d2ba6)

if you are runing this container in manual mode the filament and spool creation and the spool merging will not be done automatically. For this you can use the buttons and a dialog appears like this;
![Bildschirmfoto 2025-01-04 um 01 33 10](https://github.com/user-attachments/assets/85d9ab66-5afa-45a1-822e-e226c089bc78)


Menubar with one menu holding the dashboard, the printers, the settings and the logs, and the dark and light mode button on the right:
![image](https://github.com/user-attachments/assets/c93c95bf-551b-459e-ae8b-b027b37b067d)

Logs can be accessed over the Backend Logs Menubutton (it only display the logs of the selected Printer from the Main Menu):
![Bildschirmfoto 2025-01-19 um 22 38 12](https://github.com/user-attachments/assets/848e35de-ad8a-4826-8264-6a21f5070765)

## Debug-Printers CLI
You have the ability to check the network and MQTT status of your printer directly from the docker containers build in script.
To use this script, just connect to your intenal CLI of your docker container like this:

```bash
docker exec -it CONTAINER_NAME /bin/sh
```

Then you can run the following command

```bash
debug-printers
```

Now you can type in the number of your printer and hit enter to select your printer

```bash
--- Printer Selection ---
1. Bambu Lab P1S - 01PXXXXXXXXXX - 192.168.XXX.XXX
Choose a printer (number): 
```

After that you can choose between 3 options (option 3 is to go back to the main menu):

```bash
 
--- Options for Bambu Lab P1S ---
1. Subscribe to MQTT messages
2. Check reachability
3. Back to main menu
 
Choose a option (number): 
```

Option 1, "Subscribe to MQTT messages," connects to your printer and displays all MQTT messages it sends (the long message contains the AMS spool data):

```bash
Receiving MQTT messages from 01PXXXXXXXXXX... (Press Ctrl+C to stop)
Client null sending CONNECT
Client null received CONNACK (0)
Client null sending SUBSCRIBE (Mid: 1, Topic: device/01PXXXXXXXXXX/report, QoS: 0, Options: 0x00)
Client null received SUBACK
Subscribed (mid: 1): 0
Client null received PUBLISH (d0, q0, r0, m0, 'device/01PXXXXXXXXXX/report', ... (110 bytes))
{"print":{"bed_temper":11.96875,"wifi_signal":"-67dBm","command":"push_status","msg":1,"sequence_id":"40941"}}
Client null received PUBLISH (d0, q0, r0, m0, 'device/01PXXXXXXXXXX/report', ... (104 bytes))
{"print":{"bed_temper":12,"wifi_signal":"-68dBm","command":"push_status","msg":1,"sequence_id":"40942"}}
Client null received PUBLISH (d0, q0, r0, m0, 'device/01PXXXXXXXXXX/report', ... (4416 bytes))
{"print":{"ipcam":{"ipcam_dev":"1","ipcam_record":"disable","timelapse":"disable","resolution":"","tutk_server":"disable","mode_bits":3},"upload":{"status":"idle","progress":0,"message":""},"net":{"conf":0,"info":[{"ip":XXXXXX,"mask":XXXXXXX}]},"nozzle_temper":15.0625,"nozzle_target_temper":0,"bed_temper":12,"bed_target_temper":0,"chamber_temper":5,"mc_print_stage":"1","heatbreak_fan_speed":"0","cooling_fan_speed":"0","big_fan1_speed":"0","big_fan2_speed":"0","mc_percent":100,"mc_remaining_time":0,"ams_status":0,"ams_rfid_status":0,"hw_switch_state":0,"spd_mag":100,"spd_lvl":2,"print_error":0,"lifecycle":"product","wifi_signal":"-68dBm","gcode_state":"FINISH","gcode_file_prepare_percent":"100","queue_number":0,"queue_total":0,"queue_est":0,"queue_sts":0,"project_id":"XXXXX","profile_id":"XXXXX","task_id":"XXXXX","subtask_id":"XXXXX","subtask_name":"XXXXXXX","gcode_file":"","stg":[],"stg_cur":255,"print_type":"idle","home_flag":24331672,"mc_print_line_number":"0","mc_print_sub_stage":0,"sdcard":true,"force_upgrade":false,"mess_production_state":"active","layer_num":260,"total_layer_num":260,"s_obj":[],"filam_bak":[],"fan_gear":0,"nozzle_diameter":"0.4","nozzle_type":"hardened_steel","cali_version":0,"k":"0.0200","flag3":15,"upgrade_state":{"sequence_id":0,"progress":"","status":"IDLE","consistency_request":false,"dis_state":0,"err_code":0,"force_upgrade":false,"message":"0%, 0B/s","module":"","new_version_state":2,"cur_state_code":0,"idx2":3954728311,"new_ver_list":[]},"hms":[],"online":{"ahb":false,"rfid":false,"version":408456019},"ams":{"ams":[{"id":"0","humidity":"5","temp":"0.0","tray":[{"id":"0","remain":83,"k":0.019999999552965164,"n":1,"cali_idx":-1,"tag_uid":"XXXXXXXXXXXXXXXXXXXXXXX","tray_id_name":"A00-P5","tray_info_idx":"GFA00","tray_type":"PLA","tray_sub_brands":"PLA Basic","tray_color":"5E43B7FF","tray_weight":"1000","tray_diameter":"1.75","tray_temp":"55","tray_time":"8","bed_temp_type":"1","bed_temp":"35","nozzle_temp_max":"230","nozzle_temp_min":"190","xcam_info":"XXXXXXXXXXXXXXXXXXXXXXX","tray_uuid":"XXXXXXXXXXXXXXXXXXXXXXX","ctype":0,"cols":["5E43B7FF"]},{"id":"1","remain":100,"k":0.019999999552965164,"n":1,"cali_idx":-1,"tag_uid":"XXXXXXXXXXXXXXXXXXXXXXX","tray_id_name":"A00-B9","tray_info_idx":"GFA00","tray_type":"PLA","tray_sub_brands":"PLA Basic","tray_color":"0A2989FF","tray_weight":"1000","tray_diameter":"1.75","tray_temp":"55","tray_time":"8","bed_temp_type":"0","bed_temp":"0","nozzle_temp_max":"230","nozzle_temp_min":"190","xcam_info":"XXXXXXXXXXXXXXXXXXXXXXX","tray_uuid":"XXXXXXXXXXXXXXXXXXXXXXX","ctype":0,"cols":["0A2989FF"]},{"id":"2","remain":100,"k":0.019999999552965164,"n":1,"cali_idx":-1,"tag_uid":"XXXXXXXXXXXXXXXXXXXXXXX","tray_id_name":"A00-R0","tray_info_idx":"GFA00","tray_type":"PLA","tray_sub_brands":"PLA Basic","tray_color":"C12E1FFF","tray_weight":"1000","tray_diameter":"1.75","tray_temp":"55","tray_time":"8","bed_temp_type":"0","bed_temp":"0","nozzle_temp_max":"230","nozzle_temp_min":"190","xcam_info":"XXXXXXXXXXXXXXXXXXXXXXX","tray_uuid":"XXXXXXXXXXXXXXXXXXXXXXX","ctype":0,"cols":["C12E1FFF"]},{"id":"3","remain":100,"k":0.019999999552965164,"n":1,"cali_idx":-1,"tag_uid":"XXXXXXXXXXXXXXXXXXXXXXX","tray_id_name":"A00-K0","tray_info_idx":"GFA00","tray_type":"PLA","tray_sub_brands":"PLA Basic","tray_color":"000000FF","tray_weight":"1000","tray_diameter":"1.75","tray_temp":"55","tray_time":"8","bed_temp_type":"0","bed_temp":"0","nozzle_temp_max":"230","nozzle_temp_min":"190","xcam_info":"XXXXXXXXXXXXXXXXXXXXXXX","tray_uuid":"XXXXXXXXXXXXXXXXXXXXXXX","ctype":0,"cols":["000000FF"]}]}],"ams_exist_bits":"1","tray_exist_bits":"f","tray_is_bbl_bits":"f","tray_tar":"255","tray_now":"255","tray_pre":"255","tray_read_done_bits":"f","tray_reading_bits":"0","version":103,"insert_flag":true,"power_on_flag":true},"vt_tray":{"id":"254","tag_uid":"0000000000000000","tray_id_name":"","tray_info_idx":"","tray_type":"","tray_sub_brands":"","tray_color":"00000000","tray_weight":"0","tray_diameter":"0.00","tray_temp":"0","tray_time":"0","bed_temp_type":"0","bed_temp":"0","nozzle_temp_max":"0","nozzle_temp_min":"0","xcam_info":"000000000000000000000000","tray_uuid":"00000000000000000000000000000000","remain":0,"k":0.019999999552965164,"n":1,"cali_idx":-1},"lights_report":[{"node":"chamber_light","mode":"off"}],"command":"push_status","msg":0,"sequence_id":"40943"}}
Client null received PUBLISH (d0, q0, r0, m0, 'device/01PXXXXXXXXXX/report', ... (87 bytes))
```

Option 2, "Check reachability," checks if the printer is reachable from your docker container:

```bash
Checking if printer (192.168.XXX.XXX - 01PXXXXXXXXXX) is reachable on port 8883...
Printer (192.168.XXX.XXX - 01PXXXXXXXXXX) is reachable on port 8883.

Press Enter to continue...
```


## FAQ
Q: I can not merge my existing Spool to Spoolman. I can only create a new Spool or the container creates it automatically.

A: Please check your filament, not spool, in spoolman. The material must be the same material from the Web UI or Logs. For example PETG HF could be set as PETG.


## Things and Features I'm Working on

| Type | Feature/Bug | Available in dev build | Available in latest release | Status/Info |
|------|-------------|------------------------|-----------------------------|-------------|
|Feature|Control settings via Web UI like printer profiles, server powermanagement (shutdown, restart) and other settings|❌|❌|in developement |


If you find some bugs/issues/improvements let me know!

## Support Me
[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/Rdiger36)
