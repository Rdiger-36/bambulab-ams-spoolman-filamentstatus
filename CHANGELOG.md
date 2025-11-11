-----------------------------------------------------------------------------------------------
Version 1.1.1-dev
   - Changes:
      - Better handling for multiple AMS-HT 
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
