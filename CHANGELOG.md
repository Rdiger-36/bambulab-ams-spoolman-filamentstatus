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
