-----------------------------------------------------------------------------------------------
Version 1.3.0-dev
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
