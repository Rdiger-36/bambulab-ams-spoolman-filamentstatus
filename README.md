# Bambulab AMS Spoolman Filament Status

This project integrates Bambu Lab Printers with one or multiple AMS with Spoolman to synchronize filament spool usage. It listens for MQTT updates from the printers and manages spools on Spoolman.

Please note that these data represent rough estimates communicated by the AMS!

This project is based on the idea of a script from [Diogo Resende](https://github.com/dresende) posted in this issue https://github.com/Donkie/Spoolman/issues/217 


## !! Attention !!
This Solution only Works on Bambu Lab Printers with AMS for the P and X Series. The AMS Lite is not supported on updating Spools on Spoolman because it only shows 100% or 0% left on the Spool ([#Issue 4](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/issues/4#issuecomment-2550571529)).
However it can be used to Create Spools and Filaments on Spoolman and connect thier serials with it.



## Features

- Real-time AMS filament status updates for all possible AMS on one printer (max. 4)
- Multiple Printer Support
- Synchronizes spool usage with Spoolman
- Lightweight Docker container for easy deployment
- Web UI for manually merge or create Spools and Filaments with collected data
- Automatic Mode for automatically merge or create Spools and Filaments with collected data

## Getting Started

### Prerequisites

- A running instance of Spoolman
- Access to your Bambu Lab printers with its **serial number**, **access code**, and **IP address**
- Turn on the "Update remaining capacity" option in Bambu Studio:
  ![Bildschirmfoto 2025-01-16 um 18 00 45](https://github.com/user-attachments/assets/fe6cf018-b211-4fd6-8931-1c895842d71b) ![Bildschirmfoto 2025-01-16 um 18 01 44](https://github.com/user-attachments/assets/23c60d83-e5ed-41af-9fbc-24cc9dd8ede7)



### Supported Architectures

Simply pulling `ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest` should retrieve the correct image for your arch.

The architectures supported by this image are:

| Architecture | Spoorted |
| :----: | :----: |
| x86-64 | ✅ |
| arm64 | ✅ |
| armhf | ✅ |


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

2. Run the container:
   ```bash
   docker run -d \
     -e SPOOLMAN_IP=<spoolman_ip_address> \
     -e SPOOLMAN_PORT=<spoolman_port> \
     -e UPDATE_INTERVAL=120000 \
     -e MODE=automatic \
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
        - SPOOLMAN_IP=<spoolman_ip_address>
        - SPOOLMAN_PORT=<spoolman_port>
        - UPDATE_INTERVAL=120000
        - MODE=automatic
      volumes:
        - /path/to/your/config/printers:/app/printers
        - /path/to/your/config/logs:/app/logs
      restart: unless-stopped
   ```

## Environment Variables

| Variable             | Description                                   |
|----------------------|-----------------------------------------------|
| `SPOOLMAN_IP`        | IP address of the Spoolman instance           |
| `SPOOLMAN_PORT`      | Port of the Spoolman instance                 |
| `SPOOLMAN_SUBFOLDER` | Set this if Spoolman is running in a subfolder |
| `SPOOLMAN_ENDPOINT`  | Provide Spoolman full endpoint instead of IP, PORT & SUBFOLDER |
| `SPOOLMAN_FQDN`      | Access Spoolman via a web link in the footer or from the button "Go to Spoolman" from "Show Info!" dialog (e.g., http(s)://spoolman.your.domain or http(s)://your.domain/spoolman) |
| `UPDATE_INTERVAL`    | Time in ms for updating spools in Spoolman (standard 120000 ms -> 2 minutes) min. 5000 (5 sec), max 3000000 (5 min)|
| `MODE`               | Set the mode of the service: "automatic" or "manual" (standard: manual) |
| `DEBUG`              | Enable this to show more Logs for Debugging (not for WEB UI Logs): "true" or "false" (standard: false)|

Old ENVs (PRINTER_IP, PRINTER_ID, PRINTER_CODE) also works, but will be overwritten if you use multiple printers in printers.json 

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
[LOG] Bambu Lab P1S - MQTT not running for Printer: 01P00A460901001, attempting to reconnect...
[LOG] Bambu Lab P1S - Setting up MQTT connection for Printer: 01P00A460901001...
[LOG] Bambu Lab Test Printer A - MQTT not running for Printer: 0AX12345678, attempting to reconnect...
[LOG] Bambu Lab Test Printer A - Setting up MQTT connection for Printer: 0AX12345678...
[LOG] Bambu Lab Test Printer A - MQTT client connected for Printer: 0AX12345678
[LOG] Bambu Lab Test Printer A - Waiting for MQTT messages for Printer: 0AX12345678...
[LOG] Bambu Lab P1S - MQTT client connected for Printer: 01P00A460901001
[LOG] Bambu Lab P1S - Waiting for MQTT messages for Printer: 01P00A460901001...
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

| Slot in Log  | Slot on AMS         | Slot in Log  | Slot on AMS      |
|--------------|---------------------|--------------|------------------|
| `A0`         | first AMS, Slot 1   |`B0`          |second AMS, Slot 1|
| `A1`         | first AMS, Slot 2   |`B1`          |second AMS, Slot 2|
| `A2`         | first AMS, Slot 3   |`B2`          |second AMS, Slot 3|
| `A3`         | first AMS, Slot 4   |`B3`          |second AMS, Slot 4|

This will be expanded till D (max. 4 AMS on one Printer)


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

## Web UI
Main Menu with loaded Bambu Lab Spools, 3rd Party Spools and empty Slots:
![image](https://github.com/user-attachments/assets/ef105065-fb3a-4901-85ae-80557d7124af)

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


Menubar for seletion Printers, Logs or change Dark-/Lightmode:
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

Now the script will check if your printer is reachable and request its certificate for the authorization.
After that you can choose between 3 options (option 3 is to go back to the main menu):

```bash
Checking availability of 192.168.XXX.XXX...
192.168.XXX.XXX is reachable. Fetching certificate...
Certificate saved at /app/certs/01PXXXXXXXXXX.crt
 
--- Options for Bambu Lab P1S ---
1. Subscribe to MQTT messages
2. Ping
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

Option 2, "Ping," is a simple ping check of your printer:

```bash
Pinging 192.168.XXX.XXX...
PING 192.168.XXX.XXX (192.168.XXX.XXX): 56 data bytes
64 bytes from 192.168.XXX.XXX: seq=0 ttl=254 time=1.936 ms
64 bytes from 192.168.XXX.XXX: seq=1 ttl=254 time=1.505 ms
64 bytes from 192.168.XXX.XXX: seq=2 ttl=254 time=1.225 ms
64 bytes from 192.168.XXX.XXX: seq=3 ttl=254 time=2.733 ms

--- 192.168.XXX.XXX ping statistics ---
4 packets transmitted, 4 packets received, 0% packet loss
round-trip min/avg/max = 1.225/1.849/2.733 ms
Press Enter to continue...
```


## FAQ
Q: I can not merge my existing Spool to Spoolman. I can only create a new Spool or the container creates it automatically.

A: Please check your filament, not spool, in spoolman. The material must be the same material from the Web UI or Logs. For example PETG HF could be set as PETG.


## Things and Features I'm Working on

| Type | Feature/Bug | Available in dev build | Available in latest release | Status/Info |
|------|-------------|------------------------|-----------------------------|-------------|

Nothing at this moment

## Support Me
[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/Rdiger36)
