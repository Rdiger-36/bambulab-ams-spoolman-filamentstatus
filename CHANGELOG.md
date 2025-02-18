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
