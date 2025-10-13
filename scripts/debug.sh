#!/bin/sh

PRINTERS_FILE="/app/printers/printers.json"
CERTS_DIR="/app/certs"

# Function to display the main menu
main_menu() {
    echo "--- Printer Selection ---"
    i=1
    jq -r '.[] | "\(.name) - \(.id) - \(.ip)"' "$PRINTERS_FILE" | while read -r line; do
        echo "$i. $line"
        i=$((i+1))
    done
    echo "Choose a printer (number): "
    read choice

    selected_printer=$(jq -r ".[$((choice-1))]" "$PRINTERS_FILE")

    if [ -n "$selected_printer" ]; then
        check_and_fetch_cert "$selected_printer"
    else
        echo "Invalid selection."
        main_menu
    fi
}

# Function to check availability and fetch the certificate
check_and_fetch_cert() {
    printer="$1"
    ip=$(echo "$printer" | jq -r '.ip')
    serial=$(echo "$printer" | jq -r '.id')

    echo "Checking availability of $ip:8883..."
    if nc -z -w 3 "$ip" 8883 >/dev/null 2>&1; then
        echo "$ip:8883 is reachable. Fetching certificate..."
        mkdir -p "$CERTS_DIR"
        openssl s_client -connect "$ip:8883" -showcerts </dev/null 2>/dev/null |
        awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' > "$CERTS_DIR/$serial.crt"
        echo "Certificate saved at $CERTS_DIR/$serial.crt"
        printer_menu "$printer"
    else
        echo "$ip:8883 is not reachable."
        main_menu
    fi
}

# Function for the printer menu
printer_menu() {
    printer="$1"
    name=$(echo "$printer" | jq -r '.name')
    ip=$(echo "$printer" | jq -r '.ip')
    access_code=$(echo "$printer" | jq -r '.code')
    serial=$(echo "$printer" | jq -r '.id')

    echo " "
    echo "--- Options for $name ---"
    echo "1. Subscribe to MQTT messages"
    echo "2. Ping"
    echo "3. Back to main menu"
    echo " "
    echo "Choose a option (number): "
    read option

    case $option in
        1)
            mqtt_messages "$ip" "$access_code" "$serial"
            ;;
        2)
            ping_printer "$ip"
            ;;
        3)
            main_menu
            ;;
        *)
            echo "Invalid selection."
            printer_menu "$printer"
            ;;
    esac
}

# Function to subscribe to MQTT messages
mqtt_messages() {
    ip="$1"
    access_code="$2"
    serial="$3"

    echo "Receiving MQTT messages from $serial... (Press Ctrl+C to stop)"
    mosquitto_sub -h "$ip" -p 8883 -u "bblp" -P "$access_code" -t "device/$serial/report" --cafile "$CERTS_DIR/$serial.crt" --insecure -d
}

# Function to check printer port with nc
ping_printer() {
    ip="$1"
    echo "Checking $ip:8883..."
    if nc -z -w 3 "$ip" 8883 >/dev/null 2>&1; then
        echo "$ip:8883 is reachable."
    else
        echo "$ip:8883 is not reachable."
    fi
    echo "Press Enter to continue..."
    read
    main_menu
}

# Check if jq, mosquitto_sub, and openssl are installed
if ! command -v jq >/dev/null 2>&1 || ! command -v mosquitto_sub >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    echo "Missing dependencies. Please install jq, mosquitto-clients, and openssl."
    exit 1
fi

# Start the script
main_menu
