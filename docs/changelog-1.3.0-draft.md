# CHANGELOG draft for 1.3.0

The dev blocks of 1.3.0-dev.1 and later stay in CHANGELOG.md for the whole dev
phase, because that is what testers on the dev images read to see what changed
between two builds. This file is the consolidated release block, written into
CHANGELOG.md in place of those dev blocks when the release build is cut, not
before.

Every dev build after dev.9 has to be folded in here as well, or regenerate the
whole block from the dev blocks at release time.

## Draft

-----------------------------------------------------------------------------------------------
Version 1.3.0
   - Breaking:
      - AMS slots are numbered the way the printer numbers them: the first slot of the first unit is A1, the last one of a fourth unit is D4. Every slot label moves up by one, in the Web UI, in the logs, in the API and in the Spoolman location of a spool
         - Nothing has to be done by hand. The assignments in printers/mappings.json are renumbered on the first start, and the Spoolman location follows on the next reading of the AMS, so "P1S - A0" becomes "P1S - A1" on its own. A location set by hand is still left alone
         - A caller of the API sees the new labels in amsId, which is what to look at first for a script or a home automation reading them. The Home Assistant integration is the one to check
         - Before this the labels counted from 0 while the printer's display, its touchscreen and Bambu Studio all counted from 1, so the second slot of the AMS was A1 on one screen and A2 on the other
      - The API answers only two kinds of caller now: the Web UI of this installation, and a request carrying an API key. Anything else is answered with 401 and a sentence saying so. This holds whether or not a Web UI password is set; the pages themselves stay open to the network without one, it is /api/ that asks
         - A script, a home automation or an integration that called this API without a key stops working and needs one. Create it under "API keys" in the Network access card and send it as "Authorization: Bearer <key>" or "X-API-Key: <key>". The Home Assistant integration is the one to look at first
         - Before this, an installation without a password answered every caller on the network, which is also why the key list could never say who was actually using the API
   - Deprecated:
      - Configuring the service through environment variables is deprecated. Nothing has to change and every variable keeps working, but the settings page is the supported place for it now
         - A variable only seeds a setting that has never been saved. After the first save the settings file owns the value, so a change made in the UI is not reverted by the container definition on the next start
         - The printer list is edited on the settings page instead of in printers.json, which the service writes itself now
         - An installation that still relies on them says so once in the dashboard and on every start in "docker logs", naming the variables that are actually still in charge. Both stop on their own once nothing is left that the environment decides
         - The settings page says the same thing where it matters: a standing note at the top names every variable still in charge and says that a save writes the whole configuration into printers/settings.json, so none of those variables changes anything afterwards. It appears under exactly the condition the "from the environment" badges do, so an installation that never used the variables never sees it
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
      - Each AMS unit says how it is doing above its slot table: relative humidity, the temperature inside it, and the drying cycle while one is running, with its target temperature and the minutes left
         - What is shown depends on which unit it is, because the units report different things. An AMS 2 Pro and an AMS HT carry a real sensor and a dryer and show all of it; the original AMS and the AMS Lite report only the five step humidity level and show that. The external spool holder reports none of it and gets no header
         - The readings are display only. They never reach Spoolman, they are kept out of the change detection that decides when a slot is reprocessed, and they are pushed to the browser at most every 30 seconds
      - The header of an AMS unit names the unit: "AMS 2 Pro A", "AMS HT B". Nothing in the report states the model, so it is read off what the unit can do: a single slot unit is an HT, a dryer with a humidity percentage is a 2 Pro. An original AMS and an AMS Lite send byte for byte the same fields and stay a plain "AMS", which the tooltip of the name says
      - The Web UI can ask for a password, off unless one is set in the Network access card. One password for the installation, stored as a scrypt hash and never sent back to the browser, a session that lasts 30 days and survives a restart, and a lockout after repeated wrong guesses. Forgotten it? Stop the container, remove the AUTH_PASSWORD line from printers/settings.json, start it again
      - API keys for the callers that have no browser, in the same Network access card. Named keys, created and revoked one at a time, shown once and stored as a hash, sent as "Authorization: Bearer" or "X-API-Key". A key is a full session and works whether or not a password is set
      - Reworked menu bar: the three pages sit in it and the current one is marked, every log is its own entry, and the bar is down to two kinds of thing, where you can go and your session. What a page is showing is picked in the page instead, in the dashboard headline and in the log title. Plus a dark mode that covers every page
      - The dashboard headline moved into the head of the status card and reads "Loaded Spools on <printer>", with the tracking mode at one end of that line and the monitoring switch at the other. The six facts under it, Spoolman, the printer connection, the serial and the two timestamps, are cells of one size in the middle of the card instead of columns stretched over its whole width
      - The monitoring switch stays red while it is off, because off is not a preference here but a stopped service: it closes the MQTT connection to the printer, so nothing is read from it and nothing reaches Spoolman
      - The whole Web UI works on a phone. An AMS unit is one card there, with its header as the head and its slots as sections inside it, instead of four free floating tiles; the printer list, the spool tables and the API keys are cards with their labels above the values instead of a table behind a sideways scroll; and a dialog fits inside the screen
      - Every page keeps to the same width as the settings page, 1180 px, instead of stretching to the window, so the menu bar and the content under it line up and a wide screen no longer pulls a spool table or a log line across the whole desk
      - New ENVs: LEGACY_MODE, DATA_DIR, LOG_DIR, SUPERVISOR, LOG_MAX_SIZE_MB, LOG_KEEP_SERVER, LOG_KEEP_PRINTER, ALLOWED_HOSTS, AUTH_PASSWORD
   - Fixes:
      - A spool is created with the weight the AMS reports instead of always starting at 100 % (issue #59)
      - Consumption is booked onto the right spool when two loaded spools look alike, and no longer onto a spool that never printed it
      - Multi colour spools show all of their colours, and a gradient spool is no longer taken for a plain spool of the same first colour
      - An AMS update is no longer let through by a check that could not fail. The report was tested for empty humidity and temperature fields on the AMS block, where a P2S never puts them: the check compared undefined against an empty string and passed on every report. The fields sit on the units, and that is where they are read now
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
      - Dark mode reaches the controls the browser draws itself. The list of an open select came out white with grey text in it on a dark Windows install, because Chromium paints that list with the colours of the select, and the select had none: it was transparent. Fields carry a colour of their own now, and the page declares which colour scheme it is in, which is what the scrollbars, the radio buttons and the spin buttons follow
      - The confirmation dialogs of "Merge Spool", "Create Spool" and "Create Filament & Spool" fit a phone. They carry the tray UUID of the slot, 32 characters with nothing to break at, so the table could not shrink below its own content and a merge ended mid word. A value may break inside a word now, and on a phone the rows stack, the label above the value it names
      - Several dashboard fixes: the theme no longer flashes on page load, the confirmation dialog stays usable, the legacy table uses the full width, and a spool the printer cannot identify is labelled "3rd party"
      - The API is no longer reachable from every other website the browser has open. The wildcard CORS header is gone, a request has to be addressed to this service under an IP address, localhost, a .local name or a name listed in the new "Network access" setting, and a request that changes something is refused when it comes from another site
   - Development:
      - Node 22, and the README is rebuilt around G-code tracking with new screenshots
      - One projection for what a client sees of a slot, one consumption match, and the rules both sides apply live in public/shared.js instead of in two implementations
      - src/location.js is the single place that writes a Spoolman location
      - src/passwords.js, src/auth.js, src/security.js and src/apikeys.js hold the hashing, the session, the request guard and the keys, each covered by its own test file. No variant of the diagnostics bundle carries the password hash or the key file
      - printers/mappings.json carries a schemaVersion beside its assignments, so a flat file written before the slot renumbering is read as version 0, renumbered once and written back
      - extractAmsEnvironment() in src/ams.js is the one reading of the per-unit environment fields, covered against the four unit shapes that have been observed
      - New test server under scripts/test-server: a mock printer and a mock Spoolman, started with one command
      - The test suite runs on node:test and covers public/ for the first time
      - The release notes of every version carry the merged pull requests grouped by the label they were given, configured in .github/release.yml, with the breaking ones first

-----------------------------------------------------------------------------------------------
