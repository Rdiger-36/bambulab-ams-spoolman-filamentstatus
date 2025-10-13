let autoButton = null;

// Initialize the document once it has fully loaded
document.addEventListener("DOMContentLoaded", () => {
    
    const toggleButton = document.getElementById("dark-mode-toggle");
    const body = document.body;
    let darkModeEnabled = localStorage.getItem("dark-mode") === "true";
    const lightModeIcon = "https://img.icons8.com/ios-glyphs/30/moon-symbol.png";
    let darkModeIcon = document.getElementById("dark-mode-icon");
    const darkModeIconUrl = "https://img.icons8.com/color/48/sun--v1.png";
    
    // Apply dark mode if it was previously enabled
    if (darkModeEnabled) {
        darkModeEnabled = body.classList.toggle("dark-mode");
        darkModeIcon.src = darkModeEnabled ? darkModeIconUrl : lightModeIcon;
        localStorage.setItem("dark-mode", darkModeEnabled);
    }
    
    // Dynamically add transition after page load
    // Add the transition class after a short delay to prevent the initial animation
    setTimeout(() => {
        body.classList.add("transition-enabled");
    }, 100);
    
    // Handle dark mode toggle button clicks
    if (toggleButton) {
        toggleButton.addEventListener("click", () => {
            darkModeEnabled = body.classList.toggle("dark-mode");
            darkModeIcon.src = darkModeEnabled ? darkModeIconUrl : lightModeIcon;
            localStorage.setItem("dark-mode", darkModeEnabled);
        });
    } else {
        console.error('Button with ID "dark-mode-toggle" not found!');
    }
    
    // Fetch initial data and set up periodic updates
    // Fetch and display printers dynamically
    fetchPrinters();

    // Set up Server-Sent Events (SSE) connection for real-time updates
    const eventSource = new EventSource('./api/events'); // Backend URL for events

    // Handle incoming messages from SSE
    eventSource.onmessage = function (event) {
        // Parse the event data
        const data = JSON.parse(event.data);
        const printerId = document.getElementById('printer-serial').textContent;
            
        if (data.type === 'slot_update' && data.printer === printerId && !isDialogOpen()) {
            upsertSpoolRow(data.spool);
        } else if (data.type === 'status' && data.printer === printerId) {
			
		    if (data.lastMqttUpdate) {
		        updateElementText(
		           "last-mqtt-update",
		           formatDate(new Date(data.lastMqttUpdate))
		        );
		    }
		    if (data.lastMqttAmsUpdate) {
		        updateElementText(
		           "last-mqtt-ams-update",
		           formatDate(new Date(data.lastMqttAmsUpdate))
		        );
		    }
	    } else if (data.type === 'refresh' && data.printer === printerId) {
		  fetchPrinters();
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
            const response = await fetch("./api/printers");
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
                fetch(`./api/status/${printerId}`),
                fetch(`./api/spools/${printerId}`)
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

        spoolListElement.innerHTML = "";

        const columns = [
          "AMS Slot ID", "Slot state", "Material",
          "Remaining (estimated)", "Color",
          "Serialnumber", "State", "Action"
        ];

        for (let i = 0; i < spools.length; i += 4) {
            const table = document.createElement("table");
            table.className = "spool-table";

            const thead = document.createElement("thead");
            const headerRow = document.createElement("tr");
            for (const col of columns) {
                const th = document.createElement("th");
                th.textContent = col;
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            table.appendChild(thead);

            const tbody = document.createElement("tbody");

            for (let j = i; j < i + 4 && j < spools.length; j++) {
                const amsSpool = spools[j];
                const spoolRow = document.createElement("tr");
        		spoolRow.setAttribute("data-amsid", amsSpool.amsId);


                const amsSpoolRemainingWeight = (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain;
                let colorName = amsSpool.slot.tray_color;
                if (amsSpool.matchingExternalFilament?.name) colorName = amsSpool.matchingExternalFilament?.name;

                const button = document.createElement("button");
                button.type = "button";
                button.disabled = true;

                setupButton(button, amsSpool);

                button.addEventListener("click", () => {
                    const content = generateDialogContent(button, amsSpool);

                    const actionMap = {
                        "Create Spool": "Create",
                        "Merge Spool": "Merge",
                        "Create Filament & Spool": "Create Filament & Spool",
                        "Show Info!": "Go to Spoolman"
                    };

                    const actionText = actionMap[button.textContent] || "No actions available";
                    const actionCallback = () => performAction(button, amsSpool);
                    showDialog(button, content, actionText, actionCallback);
                });

                const filament = amsSpool.existingSpool?.filament;
                const colorStyle = getSpoolColorStyle(filament, amsSpool.slot.tray_color, colorName);

                spoolRow.innerHTML = `
                    <td>${amsSpool.amsId}</td>
                    <td>${amsSpool.slotState}</td>
                    <td>${amsSpool.slot.tray_sub_brands}</td>
                    <td>${amsSpoolRemainingWeight} g / ${amsSpool.slot.tray_weight} g (${amsSpool.slot.remain}%)</td>
                    <td style="${colorStyle}">
                        ${cutDisplayColorName(filament?.name || colorName)}
                    </td>
                    <td>${amsSpool.slot.tray_uuid}</td>
                    <td>${setIcon(amsSpool.error, amsSpool.slotState)}</td>
                `;

                const buttonCell = document.createElement("td");
                buttonCell.appendChild(button);
                spoolRow.appendChild(buttonCell);
                tbody.appendChild(spoolRow);
            }
            table.appendChild(tbody);
            spoolListElement.appendChild(table);
        }
        synchronizeSelectedColumns([0, 1, 2, 3, 4, 5]);
    }
    
    function synchronizeSelectedColumns(indices) {
        const tables = Array.from(document.querySelectorAll('.spool-table'));
        if (tables.length === 0) return;

        indices.forEach(colIdx => {
            let maxWidth = 0;
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.width = 'auto';
                    cell.style.minWidth = 'unset';
                    const cellWidth = cell.offsetWidth;
                    if (cellWidth > maxWidth) maxWidth = cellWidth;
                });
            });
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.minWidth = maxWidth + "px";
                    cell.style.width = maxWidth + "px";
                });
            });
        });
    }
    
    function cutDisplayColorName(colorName) {
        return colorName.replace(/^(For AMS |Support for PLA\/PETG |Support for PLA |Matte |Silk\+? |Glow |HF |FR )/g, "");
    }

    function getSpoolColorStyle(filament, defaultColor, colorName) {
        if (colorName === 'N/A') {
            return '';
        }
        
        if (filament?.color_hex) {
            return `background-color: #${filament.color_hex}; color: ${getTextColor(filament.color_hex)};`;
        } else if (filament?.multi_color_hexes) {
            const colors = filament.multi_color_hexes.split(",");
            return `background: linear-gradient(to right, #${colors[0]} 50%, #${colors[1]} 50%); color: ${getTextColor(colors[0])};`;
        }
        
        return `background-color: #${defaultColor}; color: ${getTextColor(defaultColor)};`;
    }
    
	function createSpoolRow(amsSpool) {
	    const tr = document.createElement("tr");
	    tr.setAttribute("data-amsid", amsSpool.amsId);
	
	    const amsSpoolRemainingWeight = (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain;
	    let colorName = amsSpool.slot.tray_color;
	    if (amsSpool.matchingExternalFilament?.name) colorName = amsSpool.matchingExternalFilament?.name;
	
	    const button = document.createElement("button");
	    button.type = "button";
	    button.disabled = true;
	    setupButton(button, amsSpool);
	
	    button.addEventListener("click", () => {
	        const content = generateDialogContent(button, amsSpool);
	        const actionMap = {
	            "Create Spool": "Create",
	            "Merge Spool": "Merge",
	            "Create Filament & Spool": "Create Filament & Spool",
	            "Show Info!": "Go to Spoolman"
	        };
	        const actionText = actionMap[button.textContent] || "No actions available";
	        const actionCallback = () => performAction(button, amsSpool);
	        showDialog(button, content, actionText, actionCallback);
	    });
	
	    const filament = amsSpool.existingSpool?.filament;
	    const colorStyle = getSpoolColorStyle(filament, amsSpool.slot.tray_color, colorName);
	
	    tr.innerHTML = `
	        <td>${amsSpool.amsId}</td>
	        <td>${amsSpool.slotState}</td>
	        <td>${amsSpool.slot.tray_sub_brands}</td>
	        <td>${amsSpoolRemainingWeight} g / ${amsSpool.slot.tray_weight} g (${amsSpool.slot.remain}%)</td>
	        <td style="${colorStyle}">${cutDisplayColorName(filament?.name || colorName)}</td>
	        <td>${amsSpool.slot.tray_uuid}</td>
	        <td>${setIcon(amsSpool.error, amsSpool.slotState)}</td>
	    `;
	    const tdBtn = document.createElement("td");
	    tdBtn.appendChild(button);
	    tr.appendChild(tdBtn);
	
	    return tr;
	}
	
	function upsertSpoolRow(amsSpool) {
	    const selector = `[data-amsid="${amsSpool.amsId}"]`;
	    const existingRow = document.querySelector(selector);
	    const newRow = createSpoolRow(amsSpool);
	
	    if (existingRow && existingRow.parentElement) {
	        existingRow.parentElement.replaceChild(newRow, existingRow);
	    } else {
	        const tables = document.querySelectorAll('.spool-table tbody');
	        const targetTbody = tables[tables.length - 1] || null;
	        if (targetTbody) {
	            targetTbody.appendChild(newRow);
	            if (typeof synchronizeSelectedColumns === 'function') {
	                try { synchronizeSelectedColumns([0,1,2,3,4,5]); } catch (e) {}
	            }
	        } else {
	            if (typeof fetchPrinters === 'function') fetchPrinters();
	        }
	    }
	}
	
	function setupButton(button, amsSpool) {
        if (amsSpool.error && amsSpool.slotState === "Loaded (Bambu Lab)") {
            button.textContent = "Show Info!";
            button.disabled = false;
            return;
        }

        const actionMap = {
            "Merge Spool": "Merge Spool",
            "Create Spool": "Create Spool",
            "Create Filament & Spool": "Create Filament & Spool",
            "Show Info!": "Show Info!"
        };

        button.textContent = actionMap[amsSpool.option] || "No actions available";
        button.disabled = amsSpool.enableButton !== "true" || document.getElementById('spoolman-status').textContent.trim().startsWith("Disconnected");
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
        } else if (button.textContent === "Create Filament & Spool") {
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
        } else {
            return `
                <p>No machting Filament found in Database, please check manually!</p>
                <p>This error shows up when the official data from BambuLab does not matches with the collected data from the spool!</p>
                <p>To solve this issue, please follow this guide:</p>
                <p>&emsp;1. Click on "Go to Spoolman". This will open Spoolman in the Spool creation menu.</p>
                <p>&emsp;2. Type in the Name of your BambuLab Filament and select it, the necessary data will be filled in automatically.</p>
                <p>&emsp;3. If you wish, you can enter any optional data you need (e.g., first used, price, location…)</p>
                <p>&emsp;4. Copy the serial into the Extra Field 'tag' and click save</p>
                <p>&emsp;5. Wait until the new data is collected. After this, the spool will be displayed correctly!</p>
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

        if (actionButton.textContent === "Go to Spoolman") {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();
                
                const spoolmanLink = document.getElementById("spoolmanLink");
                let linkUrl = spoolmanLink.href;
                linkUrl += "spool/create";
                window.open(linkUrl, "_blank");
            };
        } else {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();
            };
        }
        
        closeDialog.onclick = () => dialog.close();
        dialog.showModal();
    }

    // Send the selected action to the backend
    function performAction(button, amsSpool) {
        const endpointMap = {
            "Create Spool": "./api/createSpool",
            "Merge Spool": "./api/mergeSpool",
            "Create Filament & Spool": "./api/createSpoolWithFilament"
        };

        const endpoint = endpointMap[button.textContent];
        if (!endpoint) return;

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
        
        updateStatusWithIcon("spoolman-status", data.spoolmanStatus);
        updateStatusWithIcon("mqtt-status", data.mqttStatus);
        updateElementText("last-mqtt-update", data.lastMqttUpdate);
        updateElementText("last-mqtt-ams-update", data.lastMqttAmsUpdate);
        updateElementText("printer-name", data.printerName);
        updateElementText("mode", data.MODE);
        updateElementText("printer-serial", data.PRINTER_ID);
        
        const footer = document.getElementById("dynamic-footer");

        if (footer) {
            const URL = data.SPOOLMAN_FQDN || data.SPOOLMAN_URL;
            footer.innerHTML = `
                <div class="container">
                    <div class="content">
                        2025 - v.${data.VERSION} | 
                        <a href="https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus" target="_blank">GitHub Repository</a> - 
                        Created by 
                        <a href="https://github.com/Rdiger-36" target="_blank">Rdiger-36</a> |
                        <a id="spoolmanLink" href="${URL}" target="_blank">Link to Spoolman</a>
                    </div>
                </div>
            `;
        }
    }
    
    // Set status icon for element
    function updateStatusWithIcon(elementId, status) {
        let icon = status === "Connected" ? " ✅" : " ❌";
        updateElementText(elementId, status + icon);
    }
    
    // Set status icon for spool behavior
    function setIcon(status, slotState) {
        let icon = "⚠️";
        if (slotState === "Loaded (Bambu Lab)") icon = status ? "❗️" : "✅";
        return icon;
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
    
    // Calculate the appropriate text color based on background brightness
    function getTextColor(hexColor) {
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