let autoButton = null;

// Initialize the document once it has fully loaded
document.addEventListener("DOMContentLoaded", () => {
    
    const toggleButton = document.getElementById("dark-mode-toggle");
    const body = document.body;
    const darkModeEnabled = localStorage.getItem("dark-mode") === "true";
    const lightModeIcon = "https://img.icons8.com/ios-glyphs/30/moon-symbol.png";
    const darkModeIcon = document.getElementById("dark-mode-icon");
    const darkModeIconUrl = "https://img.icons8.com/color/48/sun--v1.png";
    
    // Apply dark mode if it was previously enabled
    if (darkModeEnabled) {
        const darkModeEnabled = body.classList.toggle("dark-mode");
        darkModeIcon.src = darkModeEnabled ? darkModeIconUrl : lightModeIcon;
        localStorage.setItem("dark-mode", darkModeEnabled);
    }

    // Dynamically add transition after page load
    window.addEventListener("DOMContentLoaded", () => {
        // Add the transition class after a short delay to prevent the initial animation
        setTimeout(() => {
            body.classList.add("transition-enabled");
        }, 100);
    });
    
    // Handle dark mode toggle button clicks
    toggleButton.addEventListener("click", () => {
        const darkModeEnabled = body.classList.toggle("dark-mode");
        darkModeIcon.src = darkModeEnabled ? darkModeIconUrl : lightModeIcon;
        localStorage.setItem("dark-mode", darkModeEnabled);
    });
    
    // Fetch initial data and set up periodic updates
    // Fetch and display printers dynamically
    fetchPrinters();

    // Set up Server-Sent Events (SSE) connection for real-time updates
    const eventSource = new EventSource('/api/events'); // Backend URL for events

    // Handle incoming messages from SSE
    eventSource.onmessage = function (event) {
        
        // Parse the event data
        const data = JSON.parse(event.data);
        const printerId = document.getElementById('printer-serial').textContent;
            
        if (data.type === 'refresh' && data.printer === printerId && !isDialogOpen()) {
            fetchPrinters(); // Refresh data when needed
        }
    };

    // Handle errors in SSE connection
    eventSource.onerror = function(error) {
        console.error("Error with the SSE connection:", error);
    };

    // Check if any modal dialog is currently open
    function isDialogOpen() {
        const dialog = document.getElementById("info-dialog");
        return dialog && dialog.open;
    }
    
    // Fetch printers from the backend
    async function fetchPrinters() {
        try {
            const response = await fetch("/api/printers");
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

            const printers = await response.json();
            const printerMenu = document.getElementById("printer-menu");
            printerMenu.innerHTML = ""; // Clear existing menu items

            printers.forEach(printer => {
              const menuItem = document.createElement("a"); // create menu entry
              menuItem.textContent = printer.name;
              menuItem.href = "#"; // set url for loading logs
              menuItem.onclick = (event) => {
                event.preventDefault();
                loadPrinterData(printer.id);
                sessionStorage.setItem("lastSelectedPrinterId", printer.id);
              };
              printerMenu.appendChild(menuItem);
            });

            // Automatically load the first printer
            if (printers.length > 0) {
                 const lastSelectedPrinterId = sessionStorage.getItem("lastSelectedPrinterId");
                 if (lastSelectedPrinterId) {
                     loadPrinterData(lastSelectedPrinterId); // loading last printer
                 } else {
                     loadPrinterData(printers[0].id); // load first printer if theres no last used
                 }
             }
        } catch (error) {
            console.error("Error fetching printers:", error);
            alert("Failed to load printers. Please check the backend.");
        }
    }

    // Fetch and display data for a specific printer
    async function loadPrinterData(printerId) {
        try {
            const [statusResponse, spoolsResponse] = await Promise.all([
                fetch(`/api/status/${printerId}`),
                fetch(`/api/spools/${printerId}`)
            ]);

            if (!statusResponse.ok || !spoolsResponse.ok) {
                throw new Error("Error fetching printer data.");
            }

            const status = await statusResponse.json();
            const spools = await spoolsResponse.json();

            updateStatus(status);
            updateSpools(spools);
        } catch (error) {
            console.error(`Error loading data for printer ${printerId}:`, error);
        }
    }

    
    // Update the displayed list of spools based on fetched data
    async function updateSpools(spools) {
        const spoolListElement = getElementSafe("spool-list");
        if (!spoolListElement) return;

        spoolListElement.innerHTML = ""; // Clear previous content

        // Populate spool list with new data
        for (const amsSpool of spools) {
            const spoolRow = document.createElement("tr");

            // Calculate remaining weight of the spool
            const amsSpoolRemainingWeight = (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain;

            // Determine the color name of the spool
            let colorName = amsSpool.slot.tray_color;

            if (amsSpool.matchingExternalFilament?.name) colorName = amsSpool.matchingExternalFilament?.name;
            
            // Create and set up action button for the spool
            const button = document.createElement("button");
            button.type = "button";
            button.disabled = true;

            setupButton(button, amsSpool);

            button.addEventListener("click", () => {
                const content = generateDialogContent(button, amsSpool);

                let actionText;
                if (button.textContent === "Create Spool") {
                    actionText = "Create";
                } else if (button.textContent === "Merge Spool") {
                    actionText = "Merge";
                } else {
                    actionText = "Create Filament and Spool";
                }

                const actionCallback = () => performAction(button, amsSpool);
                showDialog(button, content, actionText, actionCallback);
            });

            if (amsSpool.existingSpool?.filament?.name) {
                // Populate table row with spool data
                spoolRow.innerHTML = `
                    <td>${amsSpool.amsId}</td>
                    <td>${amsSpool.slotState}</td>
                    <td>${amsSpool.slot.tray_sub_brands}</td>
                    <td>${amsSpoolRemainingWeight} g / ${amsSpool.slot.tray_weight} g (${amsSpool.slot.remain}%)</td>
                    <td style="background-color: #${amsSpool.existingSpool.filament.color_hex}; color: ${getTextColor(amsSpool.existingSpool.filament.color_hex)}">
                        ${cutDisplayColorName(amsSpool.existingSpool.filament.name)}
                    </td>
                    <td>${amsSpool.slot.tray_uuid}</td>
                `;
            } else {
            
                // Populate table row with spool data
                spoolRow.innerHTML = `
                    <td>${amsSpool.amsId}</td>
                    <td>${amsSpool.slotState}</td>
                    <td>${amsSpool.slot.tray_sub_brands}</td>
                    <td>${amsSpoolRemainingWeight} g / ${amsSpool.slot.tray_weight} g (${amsSpool.slot.remain}%)</td>
                    <td style="${colorName !== 'N/A' ? `background-color: #${amsSpool.slot.tray_color}; color: ${getTextColor(amsSpool.slot.tray_color)}` : ''}">
                        ${cutDisplayColorName(colorName)}
                    </td>
                    <td>${amsSpool.slot.tray_uuid}</td>
                `;
            }

            // Add the action button to the row
            const buttonCell = document.createElement("td");
            buttonCell.appendChild(button);
            spoolRow.appendChild(buttonCell);
            spoolListElement.appendChild(spoolRow);
        }
    }
    
    function cutDisplayColorName(colorName) {
        
        let cuttedName = colorName.replace("For AMS ", "")
                                  .replace("Support for PLA/PETG ", "")
                                  .replace("Support for PLA ", "")
                                  .replace("Matte ", "")
                                  .replace("Silk ", "")
                                  .replace("Silk+ ", "")
                                  .replace("Glow ", "")
                                  .replace("HF ", "")
                                  .replace("FR ", "")
        
        return cuttedName;
        
    }

    // Configure the action button based on spool options
    function setupButton(button, amsSpool) {
        if (amsSpool.option === "Merge Spool") {
            button.textContent = "Merge Spool";
            if (amsSpool.enableButton === "true") button.disabled = false;
        } else if (amsSpool.option === "Create Spool") {
            button.textContent = "Create Spool";
            if (amsSpool.enableButton === "true") button.disabled = false;
        } else if (amsSpool.option === "Create Filament & Spool") {
            button.textContent = "Create Filament & Spool";
            if (amsSpool.enableButton === "true") button.disabled = false;
        } else {
            button.textContent = "No actions available";
        }
    }

    // Generate the content of the confirmation dialog
    function generateDialogContent(button, amsSpool) {
        if (button.textContent === "Create Spool") {
            return `
                <p>Do you really want to create a Spool with the following stats in Spoolman?</p>
                <table>
                    <tr>
                        <th>AMS Spool:</th>
                        <td>${amsSpool.slot.tray_sub_brands} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.slot.tray_uuid}</td>
                    </tr>
                    <tr>
                        <th>Spoolman Filament:</th>
                        <td>Bambu Lab - ${amsSpool.matchingInternalFilament.material} - ${amsSpool.matchingInternalFilament.name}</td>
                    </tr>
                </table>
            `;
        } else if (button.textContent === "Merge Spool") {
            let remain = (amsSpool.slot.remain / 100) * amsSpool.slot.tray_weight;

            return `
                <p>Do you really want to merge this Spool with an existing Spool in Spoolman?</p>
                <table>
                    <tr>
                        <th>AMS Spool:</th>
                        <td>${amsSpool.slot.tray_sub_brands} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.slot.tray_uuid}</td>
                    </tr>
                    <tr>
                        <th>Spoolman Spool:</th>
                        <td>Spool-ID ${amsSpool.mergeableSpool.id} - Bambu Lab - ${amsSpool.mergeableSpool.filament.material} - ${amsSpool.mergeableSpool.filament.name} - ${remain} g left on spool</td>
                    </tr>
                </table>
            `;
        } else {
            return `
                <p>Do you really want to create a Spool and a new Filament with the following stats in Spoolman?</p>
                <table>
                    <tr>
                        <th>AMS Spool:</th>
                        <td>${amsSpool.slot.tray_sub_brands} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.slot.tray_uuid}</td>
                    </tr>
                    <tr>
                        <th>New Spool & Filament:</th>
                        <td>${amsSpool.matchingExternalFilament.manufacturer} - ${amsSpool.matchingExternalFilament.material} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.matchingExternalFilament.density} g/cm³ - ${amsSpool.matchingExternalFilament.diameter} mm</td>
                    </tr>
                </table>
            `;
        }
    }

    // Show a confirmation dialog
    function showDialog(button, content, actionButtonText, actionCallback) {
        const dialog = document.getElementById("info-dialog");
        const dialogContent = document.getElementById("dialog-content");
        const closeDialog = document.getElementById("close-dialog");
        const actionButton = document.getElementById("action-button");

        dialogContent.innerHTML = content;
        updateElementText("action-button", actionButtonText);

        actionButton.onclick = () => {
            actionCallback();
            dialog.close();
        };

        closeDialog.onclick = () => dialog.close();
        dialog.showModal();
    }

    // Send the selected action to the backend
    function performAction(button, amsSpool) {
        let endpoint;

        if (button.textContent === "Create Spool") {
            endpoint = "/api/createSpool";
        } else if (button.textContent === "Merge Spool") {
            endpoint = "/api/mergeSpool";
        } else if (button.textContent === "Create Filament & Spool") {
            endpoint = "/api/createSpoolWithFilament";
        } else {
            console.log("Unknown action!");
            return;
        }

        fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(amsSpool)
        });

        button.textContent = "No actions available";
        button.disabled = true;

        alert("Action successfully sent to the backend. After the next MQTT Event, the UI will be updated. If not, please check your logs!");
    }

    // Update various status elements in the UI
    function updateStatus(data) {
                
        data.lastMqttUpdate = data.lastMqttUpdate
            ? formatDate(new Date(data.lastMqttUpdate))
            : "No update yet";

        data.lastMqttAmsUpdate = data.lastMqttAmsUpdate
            ? formatDate(new Date(data.lastMqttAmsUpdate))
            : "No update yet";
        
        updateElementText("spoolman-status", data.spoolmanStatus);
        updateElementText("mqtt-status", data.mqttStatus);
        updateElementText("last-mqtt-update", data.lastMqttUpdate);
        updateElementText("last-mqtt-ams-update", data.lastMqttAmsUpdate);
        updateElementText("printer-name", data.printerName);
        updateElementText("mode", data.MODE);
        updateElementText("printer-serial", data.PRINTER_ID);
        
    }

    // Safely get an element by ID and log a warning if it doesn't exist
    function getElementSafe(id) {
        const element = document.getElementById(id);
        if (!element) {
            console.warn(`Element with ID "${id}" was not found.`);
        }
        return element;
    }

    // Update the text content of a specific element
    function updateElementText(id, text) {
        const element = getElementSafe(id);
        if (element) element.textContent = text;
    }

    // Display an error message to the user
    function showError(message) {
        const errorElement = getElementSafe("error-message");
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.display = "block";
        }
    }

    // Calculate the appropriate text color based on background brightness
    function getTextColor(hexColor) {
        
        if (hexColor === "N/A") hexColor = "FFFFFFFF"
        
        const r = parseInt(hexColor.slice(0, 2), 16);
        const g = parseInt(hexColor.slice(2, 4), 16);
        const b = parseInt(hexColor.slice(4, 6), 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 128 ? "black" : "white";
    }

    // Format a Date object into a human-readable string
    function formatDate(date) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
    }
    
});

// redirect to log page on button click
function redirectToLogs(type) {
    
    if (type === "server") {
        window.location.href = `logs.html?name=server`;
    } else {
        const printerSerial = document.getElementById('printer-serial').textContent.trim();
        const encodedSerial = encodeURIComponent(printerSerial);
        const printerName = document.getElementById('printer-name').textContent.trim();
        const encodedName = encodeURIComponent(printerName);
        window.location.href = `logs.html?serial=${encodedSerial}&name=${encodedName}`;
    }
}
