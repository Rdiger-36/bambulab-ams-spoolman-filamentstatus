#!/bin/sh

PRINTERS_FILE="/app/printers/printers.json"

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
        printer_menu "$selected_printer"
    else
        echo "Invalid selection."
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
    echo "2. Check reachability"
    echo "3. Back to main menu"
    echo " "
    echo "Choose a option (number): "
    read option

    case $option in
        1)
            mqtt_messages "$ip" "$access_code" "$serial"
            ;;
        2)
            ping_printer "$ip" "$serial"
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

    echo "Starting Node.js MQTT listener for printer $serial..."
    echo "Press Ctrl+C to stop."
    echo " "

    node /app/scripts/mqtt.js "$ip" "$access_code" "$serial"
}

# Function to check printer port with nc
ping_printer() {
    ip="$1"
    serial="$2"
    echo "Checking if printer ($ip - $serial) is reachable on port 8883..."

    if nc -z -w 3 "$ip" 8883 >/dev/null 2>&1; then
        echo "Printer ($ip - $serial) is reachable on port 8883."
    else
        echo "Printer ($ip - $serial) is NOT reachable on port 8883."
    fi

    echo
    read -rp "Press Enter to continue..."
    main_menu
}

# Check if jq, mosquitto_sub, and openssl are installed
if ! command -v jq >/dev/null 2>&1 || ! command -v mosquitto_sub >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    echo "Missing dependencies. Please install jq, mosquitto-clients, and openssl."
    exit 1
fi

# Start the script
main_menu
