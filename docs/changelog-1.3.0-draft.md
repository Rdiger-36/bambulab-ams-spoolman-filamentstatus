# CHANGELOG draft for 1.3.0

The dev blocks of 1.3.0-dev.1 and later stay in CHANGELOG.md for the whole dev
phase, because that is what testers on the dev images read to see what changed
between two builds. This file is the consolidated release block, written into
CHANGELOG.md in place of those dev blocks when the release build is cut, not
before.

Every dev build after dev.7 has to be folded in here as well, or regenerate the
whole block from the dev blocks at release time.

## Draft

-----------------------------------------------------------------------------------------------
Version 1.3.0
   - Deprecated:
      - Configuring the service through environment variables is deprecated. Nothing has to change and every variable keeps working, but the settings page is the supported place for it now
         - A variable only seeds a setting that has never been saved. After the first save the settings file owns the value, so a change made in the UI is not reverted by the container definition on the next start
         - The printer list is edited on the settings page instead of in printers.json, which the service writes itself now
         - An installation that still relies on them says so once in the dashboard and on every start in "docker logs", naming the variables that are actually still in charge. Both stop on their own once nothing is left that the environment decides
         - TZ, DATA_DIR, LOG_DIR and SUPERVISOR are not deprecated: they are container level and have no field in the UI
   - New Features:
      - Filament consumption is tracked from the sliced G-code instead of the AMS RFID remain percentage, and is the default
         - The sliced .gcode.3mf is fetched from the printer over FTPS while the print runs and booked onto the Spoolman spool when the job ends, scaled to the printed layers if it was cancelled
         - Covers 3rd party spools without an RFID chip, which the remain percentage never could
         - LEGACY_MODE=true keeps the previous behaviour
      - Print centric dashboard: print state, layer progress, "on spool / needed / rest" per spool and a list of what the print needs but no slot holds
      - An AMS slot can be linked to a Spoolman spool by hand, or to a filament and spool created right in the dialog, prefilled from the AMS and from the SpoolmanDB catalogue
      - The assignment picker suggests the spools that fit the slot first, by material family and colour, and warns when slot and spool disagree on the material
      - Settings page for everything that used to be an environment variable, plus the printer list, applied without a restart
      - Service card with version, platform, uptime, tracking mode and Spoolman connection, plus update check, reconnect all printers, pause monitoring and a diagnostics download
      - Clicking the filament name of a slot opens a dialog with everything the printer and Spoolman hold about it; remaining weight, lot number and comment can be corrected there
      - A spool that runs empty is archived in Spoolman on its own, off by default, with a threshold in grams
      - The external spool holder is shown as a slot of its own and can be assigned
      - Multi colour filaments are read, drawn and created with all of their colours
      - The Spoolman location of a spool follows the AMS slot it sits in, and is cleared when it leaves
      - Log files are rotated instead of growing forever, and the log view and download read across the rotated history
      - Connection test for Spoolman and for a printer, MQTT and FTPS, against the values in the form
      - Reworked menu bar and a dark mode that covers every page
      - New ENVs: LEGACY_MODE, DATA_DIR, LOG_DIR, SUPERVISOR, LOG_MAX_SIZE_MB, LOG_KEEP_SERVER, LOG_KEEP_PRINTER
   - Fixes:
      - A spool is created with the weight the AMS reports instead of always starting at 100 % (issue #59)
      - Consumption is booked onto the right spool when two loaded spools look alike, and no longer onto a spool that never printed it
      - Multi colour spools show all of their colours, and a gradient spool is no longer taken for a plain spool of the same first colour
      - A printer that is switched off is probed at a growing interval and says so once instead of filling the log (issue #54)
      - A location set by hand in Spoolman is no longer wiped, and a spool moved between two slots keeps its location
      - With more than one printer, every FTPS connection after the first went to the printer that connected first
      - LEGACY_MODE did not switch the G-code tracking off, so consumption was booked twice
      - The log lost most of its lines while the service was running
      - A Spoolman write that failed was answered with success; it is a 502 now and names what Spoolman said
      - A failing "Bambu Lab" vendor lookup no longer stops the whole startup
      - New filaments take their weight and spool weight from SpoolmanDB instead of a fixed 1000 g and 250 g
      - MODE="auto" is accepted, and an unknown value is reported instead of quietly falling back to manual
      - Support material ("-S") no longer has its remaining percentage rescaled to a 1 kg basis
      - Several dashboard fixes: the theme no longer flashes on page load, the confirmation dialog stays usable, the legacy table uses the full width, and a spool the printer cannot identify is labelled "3rd party"
   - Development:
      - Node 22, and the README is rebuilt around G-code tracking with new screenshots
      - One projection for what a client sees of a slot, one consumption match, and the rules both sides apply live in public/shared.js instead of in two implementations
      - src/location.js is the single place that writes a Spoolman location
      - New test server under scripts/test-server: a mock printer and a mock Spoolman, started with one command
      - The test suite runs on node:test and covers public/ for the first time

-----------------------------------------------------------------------------------------------
