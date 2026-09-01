-----------------------------------------------------------------------------------------------
Version 1.3.0-dev.4
   - Fixes:
      - Multi colour spools (PLA Silk Multi-Color, PLA Basic Gradient, TPU 90A Blaze and Frozen) show all of their colours again instead of only the first one
         - The AMS reports every colour of a spool in cols and only the first of them in tray_color. cols never left the server: the client projection did not carry it, so the Web UI drew a two colour spool as if it were plain
         - A Spoolman filament with several colours has no color_hex at all, it has multi_color_hexes, and that field was not carried either, so even a spool already linked in Spoolman had no colour to draw
         - The colour swatch draws the whole set: colours that run side by side down the strand (SpoolmanDB "coaxial", the Silk multi colour spools) as hard bands, colours that change along the length ("longitudinal", the gradient spools) as a fade, and any number of them rather than exactly two. A single colour spool is unchanged
         - The swatch in the assignment dialog and the ranking of its candidates read the colour set as well, so a multi colour spool is no longer the entry with no colour next to it and can reach the top of the list for its own slot
      - A slot whose report contains no cols no longer throws. Three matching functions read the field directly, and processData now fills it in from the single colour the printer always sends
      - Swapping two multi colour filaments that share their first colour is detected. Change detection compared only tray_color, which is identical for both, so the slot kept showing the colours of the spool that had been taken out
      - Filament consumption is booked onto the right spool when two loaded spools look alike
         - The sliced file names the AMS slot each filament was meant for, in the position of the filament in the slicer's list, and that is now the first thing consumption is matched on. It is the only thing that separates two spools identical in profile and colour
         - It is confirmed rather than trusted: the printer can reassign slots when a job is sent and the sliced file is written before that, so the slot counts only when it really holds the profile and the colours the slice expects. Anything unconfirmed is matched exactly as before
         - The position is resolved against the slots the printer actually reports, never calculated. With two AMS units and a spool on the external holder the slicer lists nine filaments, and arithmetic on four slots per unit turned the ninth into a unit that printer does not have. The list length is no help either: it is the project's filament count, and the same printer produced files with six, eight and nine entries
         - What the printer reports is taken as it stands, while the fallback below is checked against the slot first. A print started with a different spool selected than the one that was sliced is not a mistake to correct, it is exactly what that field exists to report, and checking it against the sliced colour booked onto the spool that was sliced instead of the one that was consumed
         - Where the printer reports which slot each filament of the print is running from, in print.mapping, that is what is used. It needs no assumption about how the slicer numbers its list, and it is the assignment after any reassignment the printer made when the job was sent rather than the slicer's intention before it. Measured against two prints on a P2S, every entry matched, including the external spool holder
         - Without it, the order is by AMS unit id, which is what the printer numbers them by: the four slot units first, then an AMS HT, then the external spool holder. Read off a printer, whose nine reported slots matched the nine filaments of a sliced file position for position
         - The amounts no longer merge before the match: two filaments in two slots stayed two entries, where they used to be added together and could not be split afterwards however the spools were identified
      - A gradient spool is no longer confused with a plain spool of the same first colour
         - Bambu Studio slices PLA Basic Gradient under GFA00, the same profile as plain PLA Basic, and the AMS reports only the first colour of a set in tray_color. Arctic Whisper, Solar Breeze and an ordinary white PLA Basic were one and the same for consumption matching, for the duplicate warning in the dashboard, and for a manual assignment, which survived a spool swap it should have been dropped for
         - The whole colour set is part of all three now, sorted, because Bambu Studio and SpoolmanDB do not agree on the order. A single colour spool is unchanged in every one of them, so nothing stored has to be migrated
      - A spool on the external spool holder is shown and can be assigned, in G-code mode
         - The printer reports it outside the AMS block, as vir_slot, and this service ignored the field. Its consumption therefore landed on whichever AMS slot happened to match by material and colour
         - It appears as a slot of its own called External, in a table of its own like an AMS HT unit, classified as the 3rd party spool it is because the holder has no RFID chip. Assigning a Spoolman spool to it is what makes its consumption bookable, and the consumption then reaches it through the slot the sliced file names rather than through a colour that another spool may share
         - An empty holder is still reported by the printer, in full, with only the fields that name a material left blank and a colour of fully transparent white. It shows as no slot at all rather than as a spool nobody can identify
         - Legacy mode leaves it out, for the same reason it shows every chipless spool read-only: it derives the weight from the RFID remain percentage and there is no chip to read
         - Firmware that reports the holder as vt_tray instead is read as well
      - The dashboard no longer shows a print's figures twice when it runs from remapped slots. The needed and after-print amounts appeared on the slot being consumed and again on the slot that merely holds the colour the file was sliced with, because the fallback match did not know the amount already belonged to a slot the printer had named. The booking itself was correct throughout
      - Consumption is no longer booked onto a spool that never printed it when two filaments of one print share a profile. Bambu Studio slices PLA Basic black and PLA Basic white as the same GFA00, so with only the black spool loaded the white filament reached it through the last matching stage, which reads the profile alone. That stage now applies only where the profile names a single filament of the print; otherwise the filament stays unbooked and the log asks for an assignment, which is also what the dashboard shows
      - The log line that admits to a guess reaches the log file. It was written with console.warn, which is not one of the three overridden by the logger, so it went to raw stdout with the routing arguments printed as text and never into the printer log
      - The duplicate warning no longer promises what an assignment cannot do. Two spools reach that point only when the sliced file could not separate them either, so assigning both splits nothing; assigning one decides which spool carries the total
   - Development:
      - The Web UI no longer decides for itself which sliced filament belongs to which slot. The browser held a second implementation of the booking match, untested because public/ has no tests, and both defects fixed in this release sat in it
         - The decision is one function now, matchConsumption() in src/ams.js. The booking runs it over the spools it may book on, and /api/print runs it over every loaded slot and names the answer on each consumption entry as matchedAmsId, which is all the dashboard reads
         - A slot that serves two filaments of one print shows their amounts added up, which is what the booking writes onto its spool
         - The "Required but not loaded" list is what the server could not place, rather than a second guess at the same question
         - public/ keeps its rules: no build step, no dependency, no module of its own
      - New test server under scripts/test-server: a mock printer over TLS on 8883, a mock Spoolman on 7912 and the service pointed at both, started with one command and writing to a temporary directory rather than to printers/
         - The scenario fills all 25 addressable positions (four AMS units, eight AMS HT units and the external spool holder) with the multi colour filaments from the Bambu Lab hex code tables, next to single colour, empty, being read and 3rd party slots
         - The catalogue it serves is copied from SpoolmanDB, so matching runs against the real ids, colour sets and directions

-----------------------------------------------------------------------------------------------
Version 1.3.0-dev.3
   - Documentation:
      - The README is rebuilt around G-code tracking, which is the default since 1.3.0
         - Legacy mode has a section of its own and points at the README of v1.2.1 for the behaviour, the Web UI and the configuration it describes
         - The environment variable table and the printers.json format are gone. Both still work, but a variable only seeds a setting that has never been saved, so "Deprecated configuration" says that and links the old README for the full list
         - The three container level variables that have no field in the Web UI (TZ, DATA_DIR/LOG_DIR, SUPERVISOR) are listed separately, because they are not deprecated
         - Fixed what no longer matched the code: the log example was legacy output, the state legend belonged to the classic AMS table that G-code mode replaces, tray_info_idx was wrong in the examples, and the Node badge said 18 while package.json requires 22
         - Added what booking per print rather than per AMS report implies: a slot needs a link before anything is booked, nothing is written to Spoolman while the print runs, and without FTPS access nothing is booked at all
      - New screenshots taken from 1.3.0, stored in docs/images next to the text instead of as uploaded attachments

-----------------------------------------------------------------------------------------------
Version 1.3.0-dev.2
   - New Features:
      - Filament consumption is now tracked from the sliced G-code instead of the AMS RFID remain percentage
         - While a print runs, the sliced .gcode.3mf is downloaded from the printer via FTPS (port 990, same access code as MQTT) and the needed grams per filament are read from Metadata/slice_info.config
         - On FINISH the full amount is booked onto the matching Spoolman spool; on FAILED/CANCEL the amount is scaled to the layers that were actually printed
         - This works for 3rd party spools without an RFID chip as well, which the old remain-percentage tracking could never cover
      - Manual spool assignment: an AMS slot can be linked to a Spoolman spool from the Web UI, either by picking an existing spool or by creating filament and spool directly in the dialog
         - The creation form is pre-filled with what the AMS reports (material, colour) and fills density and temperatures from Spoolman's material catalogue
         - Manufacturer, material and location are pick-or-type; a value that does not exist yet is created on save
         - The new spool is linked to the slot immediately, no separate assignment step
         - Required for 3rd party spools, which carry no RFID tag and therefore no extra.tag link in Spoolman
         - Also resolves two loaded spools that are identical in material and color, which the automatic tag match cannot tell apart
         - The assignment is dropped automatically as soon as a different filament is detected in that slot
         - Stored in printers/mappings.json
      - New ENV LEGACY_MODE: keeps the previous behaviour of writing the AMS RFID remain percentage to Spoolman (default: "false")
      - Settings page in the Web UI: everything that used to be an environment variable can now be changed in the browser, plus the printer list
         - Stored in printers/settings.json, applied to the running service without a restart (Spoolman endpoint, operation mode, intervals, retries, location and merge behaviour, debug logging)
         - The service can be restarted from the settings page, which is what legacy mode needs. entrypoint.js became a small supervisor: it runs the service (the new starting.js) as a child process and starts it again when it ends with the restart exit code, so the button works whether or not the container has a restart policy
            - Every other exit code is passed on, so a crash still means a crash and the Docker restart policy stays in charge of it. Three restarts within a minute stop the supervisor rather than looping
            - SIGTERM and SIGINT are forwarded to the service and waited for, so "docker stop" ends in a clean shutdown instead of a SIGKILL after the grace period
            - New ENV SUPERVISOR=false runs everything in one process again, for machines where the second Node process is too much. The restart button then depends on the container policy and the page says so
            - The page waits for the service to come back and reloads itself, and says what to look at when it does not. While a print is running it asks first
         - Log files are rotated instead of growing forever: past the configured size the current file is renamed to <name>.log.1, the previous one to .2 and so on, and the oldest is dropped. Checked on every start and while the service runs
            - New ENVs LOG_MAX_SIZE_MB (default 1), LOG_KEEP_SERVER and LOG_KEEP_PRINTER (default 2 each), all editable on the settings page. Keeping 0 files starts the current one over instead
            - Nothing truncated the per printer files before, they were created once and appended to forever
            - The log page reads across the rotated files: when the current one holds fewer lines than asked for, the rest is taken from <name>.log.1 and further, so the view no longer goes almost blank right after a rotation
            - The download hands out the whole history as one zip as soon as a log has rotated, oldest file first and numbered; a log without a history is still handed out as a plain .log. The button says which of the two it is
         - One projection for everything a client sees of an AMS slot: /api/spools, /api/print and the live slot updates now hand out the same shape, built in one place. /api/print reported whether a slot is tag-linked but not whether it was manually assigned, so it could not answer on its own whether consumption will be booked; that projection is gone
            - The payload carries what the Web UI displays instead of the raw firmware report and whole Spoolman records, and change detection compares that payload, so a newly displayed field can no longer be left out of a hand-written list and silently never reach the UI
         - A manual assignment now also survives, or fails, on the filament profile the printer reports for the slot: the fingerprint is tray_info_idx, material and colour instead of material and colour alone, so swapping two spools that differ only in profile drops the assignment instead of booking the next print onto the wrong spool. Assignments written before this keep working and are rewritten on the next lookup
         - server.log is appended to instead of being replaced on every start, so a restart no longer takes the lines with it that explain why it happened.
         - Legacy mode is the one field that still needs a restart: the value is saved right away, but the running service keeps the mode it started with, because the two tracking modes book consumption differently and a switch under a running print would book it twice or not at all. The page keeps saying so until the service is restarted, with a "Restart now" next to the notice; without the supervisor it names the manual step instead
         - Environment variables now only seed a setting that has never been saved. After the first save the file owns the value, so a change made in the UI is not reverted by the container definition on the next start
         - The Service card moved to the bottom of the settings page, below Logging, and grew into what a support question usually asks for: version, Node, platform, uptime, memory, the tracking mode the process is actually running in, whether the supervisor is on, and the Spoolman connection
            - New "Download diagnostics": one archive with the logs including their rotated history, the settings and where each value came from, the printer list, the manual assignments, and the facts above. What a bug report otherwise takes four rounds of questions to collect
            - New "Reconnect all printers": rebuilds the MQTT connections without ending the process. Unlike a restart it keeps the consumption tracking of a running print, which lives in memory and is booked when the job ends, so it does not have to ask first
            - New "Pause all monitoring": the global version of the per printer switch on the dashboard, for a Spoolman that is being worked on
            - New update check against the GitHub releases. Nothing is downloaded or installed and nothing about the installation is sent; the answer is cached for six hours and a missing internet connection is reported as "could not check" rather than as an error
         - Every download that can carry the network now asks whether it should be anonymised, the log download included, and says exactly what anonymising replaces
            - IP addresses lose their last octet, serial numbers everything after the first five characters (in the file names as well), the Spoolman host name is replaced while the scheme, port and path are kept, and the data and log paths are shortened
            - Printer names and the spool data are kept: they are what makes a log readable and say nothing about the network
            - The access code is never part of an export, anonymised or not. The service does not write it to a log on purpose, and both variants replace it anyway
         - Configuring the service through environment variables is deprecated with this version. It keeps working and nothing has to change, but the settings page is the supported place for it now, and the printer list is edited there instead of by hand in printers.json
            - An installation that still relies on them says so once in the dashboard and on every start in "docker logs", naming the variables that are actually still in charge and telling PRINTER_ID/PRINTER_CODE/PRINTER_IP that are seeding the printer list apart from ones that are set but no longer have an effect
            - Dismissing the hint is stored on the server, in settings.json beside the values rather than among them, so it does not reappear on the next browser and does not hand a single setting to the file. Both the hint and the log lines stop on their own once nothing is left that the environment still decides
         - Printers can be added, edited and removed in the UI. A new printer connects right away, a removed one is disconnected and its spool assignments are dropped
         - The access code is stored on the server and never sent back to the browser; an edit without a code keeps the stored one
         - printers.json is written by the service now (atomically, temp file plus rename) and no longer has to exist before the first start
      - Reworked menu bar: one menu with the dashboard, a printer submenu, the settings and a log submenu, identical on every page, with the dark and light mode button on the right
         - Picking a printer from the log or settings page opens it on the dashboard
         - The menu opens on hover and on click, closes on a click outside or Escape, and stays reachable on a touch screen and by keyboard: the submenu entries are buttons, ArrowDown opens the menu, Escape closes it and hands the focus back
         - Dialogs open with the focus on a sensible control, the harmless one wherever the other writes or deletes
         - The dashboard points at the settings page while no printer is configured
         - Compact settings layout: three cards, toggles instead of checkboxes, restyled buttons and printer table, and a sticky save bar that stays disabled until something is edited
         - Fields an ordinary install never touches are collapsed: Spoolman host, port, subfolder and public URL, plus the reconnect interval, the retry limit and debug logging
         - The Spoolman card shows the URL the service actually talks to, subfolder included
         - Removing a printer, or changing its address or access code, asks first while a print is running. The consumption of a running job is booked when it ends, so dropping the connection before that would lose it. A rename is unaffected, and legacy mode does not ask because it writes the weight on every AMS update
         - settings.json carries a schema version and a write counter. Two open tabs can no longer overwrite each other silently, the second save is refused with a note. The flat file written by the first version is still read
         - The dashboard shares the same style: buttons, the dialog tables and the "required but not loaded" list use the same light table and button styles, identical in light and dark mode
      - New ENVs DATA_DIR and LOG_DIR to relocate the persistent files and the logs. They default to the paths the container already mounts, so nothing changes for an existing setup
      - Connection test in the Web UI, for Spoolman and for a printer while adding or editing it
         - The printer test checks MQTT on port 8883 and FTPS on port 990, in parallel, and separates a rejected access code from an unreachable address
         - It waits for a report on device/<serial>/report, because the printer accepts a subscription to any topic: a serial number that does not belong to that address is reported as unconfirmed instead of passing
         - Both tests use the values currently in the form, so an address can be verified before it is saved. An empty access code tests the stored one
      - Reworked Web UI: print-centric dashboard showing print state, layer progress and per-spool "on spool / needed / rest", plus a "required but not loaded" list

   - Bugfixes:
      - Fix: with more than one printer, every FTPS connection after the first one went to the printer that connected first
         - basic-ftp writes the host into the secureOptions object it is handed, and for implicit TLS that stored host wins over the host passed to access(). The options were a shared module constant, so the sliced file of printer B was fetched from printer A, or failed with printer A's error
      - Fix: LEGACY_MODE did not switch off the G-code tracking
         - The sliced file was downloaded on every print and consumption was booked via PUT /spool/{id}/use, on top of the remain-percentage PATCH that legacy mode is supposed to be
         - The booking was then overwritten again by the next AMS update, so it mostly wasted requests, but it could stick if the spool was removed right after the print
      - Fix: the log lost most of its lines while the service was running
         - Messages that collapse into the previous line (e.g. "No new AMS Data or changes in Spoolman found.") rewrite the whole file. The file was read outside the write queue, so everything appended between that read and the write was overwritten by the stale snapshot
         - console.error and console.debug appended outside the queue as well and could be dropped the same way
         - A reproduction interleaving 300 ordinary lines with a collapsing one kept 1 of 300 before the fix and all 300 after
      - Fix: MODE="auto" silently behaved like manual mode, because only the exact value "automatic" was recognised
         - "auto" is now accepted as a shorthand, and any unrecognised value is reported at startup instead of quietly falling back to manual
      - Fix: on a fresh Spoolman with no spools yet, the very first spool created was never detected as a change
         - The change-detection baseline was re-seeded from the current fetch while it was empty, so the new spool was compared against itself and the slot kept offering "Create Spool" although it was already linked
      - Fix: new filaments were always created with weight 1000g and spool_weight 250g regardless of the actual product
         - Both values now come from the matched SpoolmanDB entry, so e.g. Support for PLA is created as the 500g product it is
         - A physical spool may deviate from the product (the Support for PLA sample reports 250g on its RFID chip); that stays on the spool as initial_weight and does not change the filament shared by every spool of that type
         - spool_type, finish, pattern, translucent and glow are no longer sent, since Spoolman does not accept them and discarded them on arrival
      - Fix: last_used was not set when booking consumption, because PUT /spool/{id}/use accepts only use_weight and use_length and drops anything else
      - Fix: support and accessory material (tray_type suffix "-S", e.g. "PLA-S") had its remaining percentage rescaled to a 1kg basis, although it is already reported relative to its real spool size
      - Fix: spools were compared by list position instead of by ID, so a reordered Spoolman response looked like a content change on every update
      - Fix: the AMS remain value was overwritten in place during processing, which desynced the change detection for every spool that does not weigh 1000g and made the AMS data look changed on every single message
      - Fix: MQTT reconnects were scheduled both by the connection handler and the monitor loop, which made the actual retry cadence unpredictable
      - Fix: after creating or merging a spool the Web UI stayed on the pending action until some unrelated change triggered a reprocess
      - Fix: action buttons were no longer disabled while Spoolman is unreachable
      - Spoolman spool and filament lists are no longer refetched for every AMS slot, only after a slot actually created or merged something
-----------------------------------------------------------------------------------------------
-----------------------------------------------------------------------------------------------
Version 1.2.1
   - Bugfixes:
      - Fix: 3rd party spools (no RFID chip) with tray_weight=0 were incorrectly displayed as "Empty" instead of "Loaded (3rd party)"
         - 3rd party spools have no RFID chip and therefore always report tray_weight=0, which caused them to match the empty-slot detection introduced in v1.2.0
         - The empty-slot detection now additionally checks that tray_type is empty, which correctly distinguishes truly empty slots from loaded 3rd party spools
-----------------------------------------------------------------------------------------------
Version 1.2.0
   - New Features:
      - New ENV SET_LOCATION: automatically syncs the spool location in Spoolman with the current AMS slot (e.g. "Bambu Lab P1S - A0") when a spool is detected
         - Disabled by default, enable with SET_LOCATION=true

   - Bugfixes:
      - Fix: Empty AMS slots reported by the printer with N/A values (tray_uuid, tray_sub_brands, tray_color) and tray_weight 0 were incorrectly displayed as "Loaded (3rd party)" instead of "Empty"
         - The slot detection now distinguishes between truly empty slots (tray_weight = 0 + N/A values) and actual 3rd party spools (N/A values but with a valid weight)
-----------------------------------------------------------------------------------------------
Version 1.1.1-dev
   - Changes:
      - Better handling for multiple AMS-HT 
      - New option to stop/start monitoring AMS for each printer
         - possible via switch on WEB UI and via API Call
           (e.g. curl -X POST http://IP_FROM_SERVVICE:PORT/api/printer/PRINTER_ID/monitoring/stop and start)
         - Home Assistant Addon to get state from toggle switch and also use this switch to toggle monitoring
-----------------------------------------------------------------------------------------------
Version 1.1.0
   - Changes:
      - Replaced MQTT subscription in debug-printers from mosquitto_sub to an external Node.js solution. No certificate is needed anymore (this solves issues with Bambulab P2S printers that don't provide a Root CA).
      - Enhanced logging to also capture startup and crash errors that were previously not logged by the app.
      - Improved calculation of remaining filament for spools with capacities other than 1000 grams.
      - Improved handling of the last log line.
-----------------------------------------------------------------------------------------------
Version 1.0.9
   - Changes:
      - Switched printer accessibility check from ping to TCP Port check.
      - Enhanced logging to improve the chronological order.
      - Display only the last 250 lines of the log on the web interface. Include an option to download the complete log via a dedicated Download button.
      - Handling for Spool Updates for Spoolman and the web UI is now separate and not combined for all spools/trays.
      - Removed the Header from the logs (Header for AMS A, B, C with humidity and temp). Now, only the slots and the most recent information will be displayed.
-----------------------------------------------------------------------------------------------
Version 1.0.8
   - Changes:
      - Changed the maximum possible amount of connected AMS-HT to a single printer to 8
-----------------------------------------------------------------------------------------------
Version 1.0.7
   - Bugfixes:
      - Fix false labeling for AMS HT 
         - Normally, all AMS units are assigned a letter from A to D based on their IDs.
           The AMS-HT units originally received the IDs À, Á, Â, and Ã, each followed by an increasing number.
           Since the AMS-HT only has one slot, it does not require an increasing number and is now labeled as HT-A, HT-B, HT-C, and HT-D.
      - Fix wrong remaining weight for spools smaller than 1kg
         - The estimated remaining filament is based on the assumption of 1kg spools.
           However, Bambu also applies these estimates to spools smaller than 1kg, which results in inaccurate measurements

   - New Features:
      - The table layout has been updated. Now each AMS has its own table for a better overview.
-----------------------------------------------------------------------------------------------
Version 1.0.6
   - Spool updates are now only triggered when AMS tray data changes, not when temperature, humidity, or other unrelated values change.
-----------------------------------------------------------------------------------------------
Version 1.0.5
   - Bugfixes:
      - Fix Bug that new Spools throw this error: Cannot read properties of undefined (reading 'toLowerCase')

   - New Features and ENVs:
      - Added a optional feature to prevent merging an existing empty spool if it has a tag, by introducing a new ENV called NEVER_MERGE_IF_TAG wich will be disabled by default.
      - Added a new ENV called SPOOLMAN_ENDPOINT for better backend handling. This will deprecate the ENVs SPOOLMAN_IP, SPOOLMAN_PORT, and SPOOLMAN_SUBFOLDER.
-----------------------------------------------------------------------------------------------
Version 1.0.4
   - Bugfixes:
      - The footer now has a background to prevent it from overlapping the table or other parts of the website.
      - Fixed an error when creating or reading server and printer logs.
      - Scrolling through logs on the web was not possible due to automatic scrolling back to the bottom on refresh.
      - Fixed the bug that prevented merging an empty spool with a new one and its associated tag 

   - New Features:
      - Added a background connection check and reconnection logic for Spoolman.
      - Introduced a new "State" column to indicate whether the data has been processed correctly. If not, an action button allows users to view an info dialog. This helps in cases where AMS data does not match official BambuLab data (e.g., incorrect color codes).
         - ✅ (Checkmark) → Spools recognized correctly and can be processed.
         - ⚠️ (Warning) → Empty slot or non-BambuLab spool loaded.
         - ❗ (Error) → Filament check failed for BambuLab spools.
      - Added support for relative URLs.
      - Added support for Spoolman running in a subfolder.
      - Added support for processing and using multicolor filament and spools.
      - Added a link to Spoolman integration and support for FQDN with HTTPS.
      - Added icons for connection status.
      - If the log displays ‘No new AMS data or changes in Spoolman found…’, only the timestamps will be updated to provide a clearer view
      - The material from a non-BambuLab spool is now shown in the table on the Web-App and in the logs
   
   - New Environment Variables (ENVs):
      - SPOOLMAN_SUBFOLDER → Set this if Spoolman is running in a subfolder.
      - SPOOLMAN_FQDN → Use this to access Spoolman via a web link in the footer or from the button "Go to Spoolman" from "Show Info!" dialog (e.g., http(s)://spoolman.your.domain or http(s)://your.domain/spoolman).
-----------------------------------------------------------------------------------------------
Version 1.0.3
   - Fix Dockerfile that does not contain the script command
-----------------------------------------------------------------------------------------------
Version 1.0.2
   - Added a script for the command line to check the main functionalities of the stored printers
      - connect to your internal docker container like this: docker exec -it NAME_OF_YOU_CONTAINER /bin/sh
        now execute the command "debug-printers"
   - Fixed multiple creations of filaments and spools
   - Fixed false merging of spools if there are multiple spools loaded with the same filament and different serials
   - Fixed error: Cannot read properties of undefined (reading 'extra')
   - Changed color field behavior: all materials will not be displayed in color field
   - Fixed Dockerfile to properly create the log directory, preventing the following error: 'Failed to read log file for printerId'
   - Fixed loosing connection and reconnection problems
-----------------------------------------------------------------------------------------------
Version 1.0.1
   - Added footer to Main Menu
   - Changed color filed behavior: remove "Support for..." and "For AMS" from color field
   - Changed data display behavior in Main Menu
      - From now on, the displayed data will be read from the spool of Spoolman instead of using the external filament database as a source.
        This means that the filament can also be adjusted if there are any problems or errors
   - Fixed incorrect MQTT connection status that showed 'disconnected' after one disconnect and successfull reconnect.
-----------------------------------------------------------------------------------------------
Version 1.0.0
   - Offical Release
   - Features:
      - Real-time AMS filament status updates for all possible AMS on one printer (max. 4)
      - Multiple Printer Support
      - Synchronizes spool usage with Spoolman
      - Lightweight Docker container for easy deployment
      - Web UI for manually merge or create Spools with collected data
      - Automatic Mode for automatically merge or create Spools with collected data

   - Changes from last pre release:
      - Add environment variable TZ to set the timzezone in your container
      - Remove environment variables SHOW_LOGS_WEB (integrated in seperate Site)
      - Add Button for access logs from the backend
      - Add extra site to handle backend logs
      - Empty Slots are now displayable
      - Slots that loaded 3rd party Filament are also shown but have no function
      - Special treatment for Bambu Lab Support Filament
      - minor bugfixes (reconnection error, handle recognized negative filament)
-----------------------------------------------------------------------------------------------
Pre release versions are not tagged
----------------------------------------------------------------------------
