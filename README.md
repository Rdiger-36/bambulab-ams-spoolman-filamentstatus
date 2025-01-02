# Bambulab AMS Spoolman Filament Status

This project integrates a Bambulab AMS system with Spoolman to synchronize filament spool usage. It listens for MQTT updates from the printer and updates spool data on Spoolman.

This project is based on the script from [Diogo Resende](https://github.com/dresende) posted in this issue https://github.com/Donkie/Spoolman/issues/217

**THIS SOLUTION ONLY WORKS WITH ORIGINAL BAMBULAB SPOOLS BECAUSE THEY CAN BE IDENTIFIED WITH THEIR SERIAL NUMBER**

## Features

- Real-time AMS filament updates
- Synchronizes spool usage with Spoolman
- Lightweight Docker container for easy deployment

---

## Getting Started

### Prerequisites

- A running instance of Spoolman
- Access to your Bambulab AMS printer with its **serial number**, **access code**, and **IP address**

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
   docker pull ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus
   ```

2. Run the container:
   ```bash
   docker run -d \
     -e PRINTER_ID=<your_printer_serial> \
     -e PRINTER_CODE=<your_access_code> \
     -e PRINTER_IP=<printer_ip_address> \
     -e SPOOLMAN_IP=<spoolman_ip_address> \
     -e SPOOLMAN_PORT=<spoolman_port> \
     -e UPDATE_INTERVAL=120000 \
     --name bambulab-ams-spoolman-filamentstatus \
    ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus:latest
   ```
   
   Docker Compose
   ```bash
   version: '3.8'
    services:
      bambulab-ams-spoolman-filamentstatus:
        image: ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus
        container_name: bambulab-ams-spoolman-filamentstatus
        environment:
          - PRINTER_ID=<your_printer_serial> # Must be in capital letters!
          - PRINTER_CODE=<your_access_code>
          - PRINTER_IP=<printer_ip_address>
          - SPOOLMAN_IP=<spoolman_ip_address>
          - SPOOLMAN_PORT=<spoolman_port>
          - UPDATE_INTERVAL=120000 # Time in ms for updating spools in Spoolman (standard 120000 ms -> 2 minutes) min. 1000
        restart: unless-stopped
   ```
---

## Environment Variables

| Variable         | Description                                    |
|-------------------|------------------------------------------------|
| `PRINTER_ID`      | Printer serial number (Note: Must be in capital letters!!) |
| `PRINTER_CODE`    | Printer access code                           |
| `PRINTER_IP`      | Local IP address of the printer               |
| `SPOOLMAN_IP`     | IP address of the Spoolman instance           |
| `SPOOLMAN_PORT`   | Port of the Spoolman instance                 |
| `UPDATE_INTERVAL` | Time in ms for updating spools in Spoolman (standard 120000 ms -> 2 minutes) min. 1000|

---

## Usage

Once the container is running, it will automatically connect to the Bambulab AMS system and Spoolman. Logs can be viewed using:

```bash
docker logs -f bambulab-ams-spoolman-filamentstatus
```

Example Output:
```bash
Connected to MQTT broker
AMS [A] (hum: 30, temp: 25ºC)
    - [A0] Bambu Basic Black (75%) [[ ABCD1234 ]]
      - Not found. Update spool tag!
    - [A1] Bambu PLA White (50%) [[ EFGH5678 ]]
      - Updated spool 12
```

| Slot in Log  | Slot on AMS  |
|--------------|--------------|
| `A0`         | AMS Slot 1   |
| `A1`         | AMS Slot 2   |
| `A2`         | AMS Slot 3   |
| `A3`         | AMS Slot 4   |

---

## Spoolman Spool Configuration

1. You have to add an Extra Field to your Spoolman spools:
   - Go to Settings > Extra Fileds > Spools
   - Add the Extra Fields "tag"
3. Go to "Spools" in Spoolman and create or edit a spool
4. After entering all your necessary information you have to add the serial number of your spool to the Extra Field called "tag"
5. Click on save.

![image](https://github.com/user-attachments/assets/b33ad131-07db-4317-ad4f-74ddeffffcd9)

---

## Where can i find the serial number of the spool?

1. If the container is running and all parameters are entered correctly, you can read the serial numbers from the conatiner log
3. At the first start with an not linked spool the output looks like this:
   ```bash
    - [A0] Bambu PETG Black (75%) [[ ABCD1234 ]]
      - Not found. Update spool tag!
   ```
4. Now the spool must be linked to an already created spool in Spoolman
5. The serial number (located between the double square brackets), in this case ABCD1234, must be entered in Spoolman under the desired spool in the extra field “tag”
6. The container must be restarted
7. The log output should now look like this:
   ```bash
    - [A0] Bambu PETG Black (75%) [[ ABCD1234 ]]
      - Updated spool 15
   ```
8. This must be done with every spool that is not yet linked


## Things and Features I'm Working on
 - simple Web UI with Bambulab MQTT and Spoolman integration --> ready for test in dev build
   - add new recognized spools to Spoolman incl. mapping filaments or register new filament --> ready for test in dev build
   - merge new spool with empty, new or not paired spool --> ready for test in dev build
 - Multiple printer Support 
