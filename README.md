<h1 align="center">Bambulab AMS Spoolman Filament Status</h1>

<p align="center">
  Synchronize your Bambu Lab AMS filament spools with Spoolman, automatically.<br/>
  Tracks what a print actually consumes and keeps Spoolman in sync in real time.
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Rdiger-36/bambulab-ams-spoolman-filamentstatus?style=flat-square&label=version&color=blue" alt="version" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
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

Based on the idea of a script from [Diogo Resende](https://github.com/dresende), posted in this [issue](https://github.com/Donkie/Spoolman/issues/217).

> [!IMPORTANT]
> Version 1.3.0 is still in development.
> To use the pre-release version you need to use the dev build:
> 
> ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:dev

## What it does

Every Bambu Lab printer reports what its AMS holds, and every sliced print says how much of each filament it needs. This service listens to both and keeps [Spoolman](https://github.com/Donkie/Spoolman) in step with them: it recognises the spools in your AMS, links them to the spools in your inventory, and books what a print actually used onto the right one when the job is done, without you touching Spoolman.

An original Bambu Lab spool is recognised by its RFID tag and linked on its own; a 3rd party spool is linked to a Spoolman spool once, by hand in the Web UI, and is tracked from then on like any other. Everything runs in one Docker container on your own network, over MQTT and FTPS to the printer. Nothing goes through the Bambu cloud.

![Dashboard](docs/images/dashboard-dark.png)

## What changed in 1.3.0

- **G-code tracking is the new default.** Filament consumption is read from the sliced file of the print instead of the AMS RFID remain percentage, so 3rd party spools without a tag are covered as well. The previous behaviour lives on as [Legacy mode](docs/legacy-mode.md).
- **Everything is configured in the Web UI now.** The [settings page](docs/settings.md) holds every setting and the printer list.
- **Environment variables and hand-written `printers.json` are deprecated.** They keep working, see [Deprecated configuration](docs/deprecated-configuration.md).

## Attention

Works with Bambu Lab printers with a connected AMS of the A, P, H and X series.

Automatic creating and merging of spools and filaments in Spoolman relies on the RFID tag of original Bambu Lab spools. A 3rd party spool is linked to a Spoolman spool manually in the Web UI instead; its consumption is then tracked like any other.

### Supported hardware

| Printer | Supported |
| :---- | :---- |
| A series with AMS Lite | ⚠️ read only in [legacy mode](docs/legacy-mode.md) |
| A1 with AMS Standard / 2 Pro | ✅ |
| P series | ✅ |
| H series | ✅ |
| X series | ✅ |

| AMS | Supported |
| :---- | :---- |
| AMS | ✅ |
| AMS 2 Pro | ✅ |
| AMS HT | ✅ |
| AMS Lite | ⚠️ read only in [legacy mode](docs/legacy-mode.md) |

Up to 12 AMS on one printer: max. 4 AMS Standard / 2 Pro plus 8 AMS HT.

x86-64, arm64 and arm/v7 are built; the [installation](docs/installation.md#supported-architectures) says which device falls under which.

## Features

- Real-time AMS status for every connected AMS, on any number of printers
- Consumption tracked from the sliced G-code, so 3rd party spools are covered too
- Automatic merging and creating of spools and filaments in Spoolman, or manually per click
- Manual assignment of a Spoolman spool to an AMS slot for spools the printer cannot identify, checked against the material the printer reports
- A detail dialog per slot: everything Spoolman holds about the spool and its filament, next to what the printer reports, with the remaining weight, lot number and comment editable in place
- New filaments filled in from the SpoolmanDB catalogue, multi colour spools included
- Web UI with print dashboard, printer management, settings and log viewer, no container restart needed
- Lightweight Docker container, ready for x86-64, arm64 and arm/v7

## How it works

The printers publish their state via MQTT, this service listens and talks to Spoolman through its API. From what an AMS reports it merges a detected spool into a matching Spoolman spool, creates the spool when only the filament exists, or imports the filament from the SpoolmanDB and creates both, automatically or per click in `manual` mode.

While a print runs, the sliced `.gcode.3mf` is fetched from the printer via FTPS and the grams per filament are read from it. When the job reaches a final state, that amount is booked onto the linked spool; a cancelled print is booked proportionally to the layers printed. A slot that is linked to nothing is named in the log and skipped, so a missing link is visible rather than silently untracked.

➡️ **[How it works](docs/how-it-works.md)**: G-code tracking, operation modes, AMS slot names, archiving empty spools

## Getting started

You need a running Spoolman instance and, per printer, its serial number, access code and IP address, reachable on port **8883** (MQTT) and **990** (FTPS). The service itself is one container, started with `docker run` or Docker Compose and configured in its Web UI on `http://<host>:4000` afterwards; nothing has to be prepared in Spoolman.

➡️ **[Installation](docs/installation.md)**: prerequisites, the container, and the first start

## Documentation

| Page | Covers |
| :---- | :---- |
| [Installation](docs/installation.md) | Prerequisites, supported architectures, `docker run` and Docker Compose, first start |
| [How it works](docs/how-it-works.md) | Merging and creating in Spoolman, G-code tracking, operation modes, AMS slot names, archiving empty spools |
| [Web UI](docs/web-ui.md) | Dashboard, assigning a spool to a slot, the spool and filament dialog, menu and logs |
| [Settings](docs/settings.md) | Every card of the settings page, the printer dialog, the service actions, a printer that is switched off |
| [Troubleshooting](docs/troubleshooting.md) | Reading the logs, the `debug-printers` CLI, diagnostics and what an export contains |
| [Legacy mode](docs/legacy-mode.md) | The RFID based tracking of 1.2.x and what it cannot do |
| [Deprecated configuration](docs/deprecated-configuration.md) | Environment variables, hand-written `printers.json`, and the three container level variables |
| [FAQ](docs/faq.md) | The questions that come up most |

> [!IMPORTANT]
> The Web UI has no authentication and is meant for a trusted local network. It can change the printer list and the Spoolman endpoint, so do not expose the port to the internet. The access code of a printer is stored in plain text in `printers/printers.json` and is never sent back to the browser.

## Feedback

Found a bug, an issue or an improvement? [Let me know](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/issues).

## Support me

[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/Rdiger36)
