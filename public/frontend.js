let autoButton = null;
// When false (default) the spool weight is tracked from the sliced G-code, so the
// main table shows the Spoolman remaining weight instead of the AMS RFID remain %.
let legacyMode = false;
// Spoolman reachability, mirrored from /api/status. Read as a flag rather than
// parsed back out of the status pill's text, which carries a "● " prefix.
let spoolmanConnected = false;
// Render context of the last full legacy-table render, reused for single-row
// SSE updates (see upsertSpoolRow).
let lastLegacyCtx = null;
// Printer name, used to suggest a location matching the SET_LOCATION format.
let currentPrinterName = "";

// Mirrors src/ams.js correctRemainInt: Bambu reports remain% on a 1kg basis
// for regular color filament <1kg, but support/accessory material (tray_type
// suffix "-S") is measured relative to its actual spool size already.
function correctRemainIntJS(remainOn1kgBasis, trayWeight, trayType) {
	const remain = parseFloat(remainOn1kgBasis);
	// Mirrors correctRemainInt in src/ams.js: the AMS reports no percentage for
	// the first seconds after a spool goes in, and null must not become 0.
	if (!Number.isFinite(remain)) return null;
	const weight = parseFloat(trayWeight);
	const isSupportMaterial = typeof trayType === "string" && trayType.endsWith("-S");

	if (weight < 1000 && !isSupportMaterial) {
		let percent = ((remain / 100) * 1000 / weight) * 100;
		if (percent > 100) percent = 100;
		if (percent < 0) percent = 0;
		return Math.round(percent);
	}
	return Math.round(remain);
}

// Initialize the document once it has fully loaded
document.addEventListener("DOMContentLoaded", () => {
    
	document.getElementById("monitoring-toggle").addEventListener("change", toggleMonitoring);

    // The menu bar owns the printer list and the dark mode button. Picking a
    // printer switches the dashboard in place instead of navigating.
    initMenubar({
        onPrinters: showPrinters,
        onPrinterSelect: printer => {
            loadPrinterData(printer.id);
            return true;
        },
    });

    // Set up Server-Sent Events (SSE) connection for real-time updates
    const eventSource = new EventSource('./api/events'); // Backend URL for events

    // Handle incoming messages from SSE
    eventSource.onmessage = function (event) {
        // Parse the event data
        const data = JSON.parse(event.data);
        const printerId = document.getElementById('printer-serial').textContent;
            
        if (data.type === 'slot_update' && data.printer === printerId && !isDialogOpen()) {
            if (legacyMode) upsertSpoolRow(data.spool);
            else scheduleGcodeRefresh();
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
		    // Keep the G-code dashboard (print state / progress) live
		    if (!legacyMode) scheduleGcodeRefresh();
	    } else if (data.type === 'refresh' && data.printer === printerId) {
		  refreshMenubarPrinters();
		} else if (data.type === "monitoring_update") {
			const current = document.getElementById("printer-serial").textContent;

			if (data.printer === current) {
			    document.getElementById("monitoring-toggle").checked = data.enabled;
			}
	  } else if (data.type === "printers_update") {
			// A printer was added, renamed or removed on the settings page
			refreshMenubarPrinters();
	  } else if (data.type === "settings_update") {
			// The status card shows the operation mode and the tracking mode,
			// so it has to be refetched when they change
			if (currentPrinterId) loadPrinterData(currentPrinterId);
	  }

    };

    // Handle errors in SSE connection
    eventSource.onerror = function(error) {
        console.error("Error with the SSE connection:", error);
    };

    // Configuration through environment variables is deprecated since 1.3.0.
    // Shown once per installation rather than once per browser: the dismissal
    // is stored server side, and the notice stops being sent on its own as soon
    // as the values have been saved on the settings page.
    async function showDeprecationNotice() {
        let notice;
        try {
            const response = await fetch("./api/notices");
            notice = (await response.json())["env-config"];
        } catch {
            // A hint is not worth an error message of its own.
            return;
        }

        if (!notice || !notice.active || notice.acknowledged) return;

        const code = list => `<code>${list.map(escapeHtml).join("</code>, <code>")}</code>`;
        const parts = [
            "<p>This installation is still configured through environment variables. That is <b>deprecated since 1.3.0</b>.</p>",
            "<p>They keep working, so nothing has to change today. The settings page is the supported place for them now, and the printer list is edited there as well instead of by hand in <code>printers.json</code>.</p>",
        ];

        if (notice.variables && notice.variables.length) {
            parts.push(`<p>Still taken from the environment: ${code(notice.variables)}</p>`);
        }

        if (notice.printerVariables && notice.printerVariables.length) {
            parts.push(notice.printerVariablesIgnored
                ? `<p>${code(notice.printerVariables)} are set but no longer have an effect: <code>printers.json</code> exists and owns the printer list.</p>`
                : `<p>The printer list was seeded from ${code(notice.printerVariables)} and written to <code>printers.json</code>, which owns it from now on.</p>`);
        }

        parts.push("<p>One thing to know before editing your compose file again: once a setting has been saved here, the settings file owns it and the matching variable stops changing anything.</p>");

        const dialog = document.getElementById("notice-dialog");
        document.getElementById("notice-dialog-title").textContent = "Configuration has moved into the Web UI";
        document.getElementById("notice-dialog-content").innerHTML = parts.join("");

        // Dismissed either way, because both buttons mean the hint was read.
        const acknowledge = async () => {
            try {
                await fetch("./api/notices/env-config/ack", { method: "POST" });
            } catch {
                // Then it is shown again on the next load, which is the safe way round.
            }
        };

        document.getElementById("notice-dialog-close").onclick = async () => {
            await acknowledge();
            dialog.close();
        };

        document.getElementById("notice-dialog-open").onclick = async () => {
            await acknowledge();
            dialog.close();
            window.location.href = "settings.html";
        };

        dialog.showModal();
        document.getElementById("notice-dialog-close").focus();
    }

    showDeprecationNotice();

    // Check if any modal dialog is currently open
    function isDialogOpen() {
        const dialog = document.getElementById("info-dialog");
        return dialog && dialog.open;
    }
    
    // Opens a printer whenever the menu bar has loaded or reloaded the list
    function showPrinters(printers) {
        if (!printers.length) {
            // A fresh install has no printers yet. Point at the page that can
            // add one instead of showing an empty dashboard.
            document.getElementById("status").style.display = "none";
            document.getElementById("spool-list").innerHTML =
                '<p style="text-align:center">No printers configured yet. Add one on the <a href="settings.html">settings page</a>.</p>';
            currentPrinterId = null;
            return;
        }

        // Undo the empty state above, in case a printer was just added
        document.getElementById("status").style.display = "";

        // The remembered printer may have been removed on the settings page
        const lastSelectedPrinterId = sessionStorage.getItem("lastSelectedPrinterId");
        const known = printers.some(printer => printer.id === lastSelectedPrinterId);
        loadPrinterData(known ? lastSelectedPrinterId : printers[0].id);
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

            currentPrinterId = printerId;
            document.getElementById("monitoring-toggle").checked = status.monitoringEnabled === true;

            updateStatus(status); // sets the global legacyMode flag

            if (legacyMode) {
                updateSpools(spools);            // classic AMS table
            } else {
                await loadGcodeView(printerId);  // G-code dashboard
            }
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
	        "Spool", "Remaining (estimated)",
	        "Serialnumber", "State", "Action"
	    ];

	    // Count identical loaded spools (same type AND color) across all units so
	    // the shared Spool cell can flag ambiguous duplicates with ⚠, just like
	    // the G-code view.
	    const keyCount = {};
	    for (const s of spools) {
	        if (s.slotState === "Empty") continue;
	        keyCount[s.key] = (keyCount[s.key] || 0) + 1;
	    }
	    const ctx = { keyCount };
	    // Remembered so single-row SSE updates keep the duplicate-spool ⚠, which
	    // needs the counts across all slots and can't be derived from one row.
	    lastLegacyCtx = ctx;

	    // Split AMS types:
	    // Normal AMS = up to 4 slots per unit
	    // AMS HT and the external spool holder = 1 slot each, own table
	    const normalAMS = spools.filter(s => !isSingleSlotUnit(s.amsId));
	    const htAMS = spools.filter(s => isSingleSlotUnit(s.amsId));

	    // Render normal AMS units in tables of four (original behavior)
	    for (let i = 0; i < normalAMS.length; i += 4) {
	        const table = document.createElement("table");
	        table.className = "spool-table";

	        // Build table header
	        const thead = document.createElement("thead");
	        const headerRow = document.createElement("tr");

	        for (const col of columns) {
	            const th = document.createElement("th");
	            th.textContent = col;
	            headerRow.appendChild(th);
	        }

	        thead.appendChild(headerRow);
	        table.appendChild(thead);

	        // Build table rows
	        const tbody = document.createElement("tbody");

	        for (let j = i; j < i + 4 && j < normalAMS.length; j++) {
	            const spoolRow = createSpoolRow(normalAMS[j], ctx);
	            tbody.appendChild(spoolRow);
	        }

	        table.appendChild(tbody);
	        spoolListElement.appendChild(table);
	    }

	    // Render each AMS HT spool in its own table (1 slot per table)
	    htAMS.forEach(amsSpool => {
	        const table = document.createElement("table");
	        table.className = "spool-table";

	        // Build table header
	        const thead = document.createElement("thead");
	        const headerRow = document.createElement("tr");

	        for (const col of columns) {
	            const th = document.createElement("th");
	            th.textContent = col;
	            headerRow.appendChild(th);
	        }

	        thead.appendChild(headerRow);
	        table.appendChild(thead);

	        // Build table row (single-slot)
	        const tbody = document.createElement("tbody");
	        tbody.appendChild(createSpoolRow(amsSpool, ctx));

	        table.appendChild(tbody);
	        spoolListElement.appendChild(table);
	    });

	    // Synchronize column widths across all tables
	    synchronizeSelectedColumns([0,1,2,3]);
	}
    
    function synchronizeSelectedColumns(indices) {
        const tables = Array.from(document.querySelectorAll('.spool-table'));
        if (tables.length === 0) return;

        // Measure the *content* width of each cell. The tables default to
        // width:100% (generic `table` rule), which stretches every cell; if we
        // measured in that state the per-column maxima would sum to far more
        // than the container and the table would overflow past the menubar /
        // status card. So shrink the tables to their content width first.
        tables.forEach(table => {
            table.style.tableLayout = 'auto';
            table.style.width = 'auto';
        });

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

        // Restore full width so the table spans the same width as the menubar
        // and the status card; the synced columns keep their fixed px widths and
        // the remaining (non-synced) columns absorb the leftover space.
        tables.forEach(table => {
            table.style.width = '';
            table.style.tableLayout = '';
        });
    }
    
    function cutDisplayColorName(colorName) {
        return colorName.replace(/^(For AMS |Support for PLA\/PETG |Support for PLA |Matte |Silk\+? |Glow |HF |FR )/g, "");
    }

    // Every colour of an AMS slot, in the order the printer reported them.
    // `cols` is the full set and `tray_color` only ever the first of them, so
    // the single field is a fallback for a payload that predates `cols` rather
    // than the value to read.
    function slotColorsJS(slot) {
        const cols = Array.isArray(slot?.cols) ? slot.cols.filter(Boolean) : [];
        if (cols.length) return cols.map(normColorJS);
        return slot?.tray_color ? [normColorJS(slot.tray_color)] : [];
    }

    // Every colour of a Spoolman filament. Single and multi colour records are
    // mutually exclusive there: a multi colour filament carries no color_hex.
    function filamentColorsJS(filament) {
        if (filament?.multi_color_hexes) {
            return filament.multi_color_hexes.split(",").filter(Boolean).map(normColorJS);
        }
        return filament?.color_hex ? [normColorJS(filament.color_hex)] : [];
    }

    // The CSS background showing a whole colour set in one box.
    //
    // `direction` is Spoolman's multi_color_direction. A "longitudinal"
    // filament changes colour along its length, which is what the gradient
    // spools do, so it fades. A "coaxial" one carries its colours side by side
    // down the strand and reads as hard bands. An unknown or missing direction
    // is drawn as bands too: equal hard stripes still show every colour, while
    // a fade would invent a transition that may not exist.
    function colorSetBackground(colors, direction) {
        if (!colors.length) return "";
        if (colors.length === 1) return `#${colors[0]}`;

        if (direction === "longitudinal") {
            return `linear-gradient(to right, ${colors.map(c => `#${c}`).join(", ")})`;
        }

        const stops = colors.map((color, index) => {
            const from = (index / colors.length) * 100;
            const to = ((index + 1) / colors.length) * 100;
            return `#${color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
        });
        return `linear-gradient(to right, ${stops.join(", ")})`;
    }

    // The small square in front of a filament name. Empty string when there is
    // no colour to show, so a caller can concatenate it unconditionally.
    function swatchHtml(colors, direction = null) {
        const background = colorSetBackground(colors, direction);
        if (!background) return "";
        const title = colors.map(c => `#${c}`).join(" ");
        return `<span class="gc-swatch" style="background:${background}" title="${title}"></span>`;
    }

	// Build an action button with the shared Create/Merge/Show behaviour.
	function createActionButton(amsSpool) {
	    const button = document.createElement("button");
	    button.type = "button";
	    button.className = "btn btn-small";
	    button.disabled = true;
	    setupButton(button, amsSpool);

	    button.addEventListener("click", () => {
	        // Spool assignment has its own flow: it needs a picker populated from
	        // Spoolman rather than a fixed confirmation text.
	        if (button.textContent === "Assign Spool")   return showAssignDialog(button, amsSpool);
	        if (button.textContent === "Unassign Spool") return showUnassignDialog(button, amsSpool);

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

	    return button;
	}

	// ---------------------------------------------------------------------
	// Manual spool assignment
	//
	// 3rd-party spools have no RFID chip, so nothing links them to a Spoolman
	// spool automatically and their consumption can't be booked. The same picker
	// also resolves two tagged spools that are identical in material and color,
	// which the automatic match can't tell apart.
	// ---------------------------------------------------------------------

	// Ranks Spoolman spools by how well they fit the slot: same material AND
	// color first, then same material, then the rest. Saves scrolling through a
	// long inventory to find the obvious candidate.
	function rankSpoolsForSlot(spools, slot) {
	    const slotMaterial = (slot?.tray_type || "").toUpperCase();
	    // Compared as a set rather than as a single hex, so a multi colour spool
	    // can reach the top for its own slot. Those carry no color_hex at all,
	    // so against the single field they always ranked last.
	    const slotColors   = [...slotColorsJS(slot)].sort().join(",");

	    const score = (sp) => {
	        const material = (sp.filament?.material || "").toUpperCase();
	        const colors   = [...filamentColorsJS(sp.filament)].sort().join(",");
	        if (material && material === slotMaterial && colors && colors === slotColors) return 0;
	        if (material && material === slotMaterial) return 1;
	        return 2;
	    };

	    return [...spools]
	        .map(sp => ({ sp, rank: score(sp) }))
	        .sort((a, b) => a.rank - b.rank || a.sp.id - b.sp.id);
	}

	function spoolPickerLabel(sp) {
	    const fil   = sp.filament || {};
	    const parts = [fil.vendor?.name, fil.material, fil.name].filter(Boolean);
	    const left  = sp.remaining_weight != null ? `${Math.round(sp.remaining_weight)}g left` : "unknown weight";
	    const swatch = swatchHtml(filamentColorsJS(fil), fil.multi_color_direction);
	    return `${swatch}#${sp.id} ${parts.join(" · ") || "Unknown filament"} <span class="gc-muted">(${left})</span>`;
	}

	async function showAssignDialog(button, amsSpool) {
	    showDialog(button, `<p>Loading data from Spoolman…</p>`, "Assign", () => {});
	    const dialogContent = document.getElementById("dialog-content");
	    const actionButton  = document.getElementById("action-button");
	    actionButton.disabled = true;

	    let spools, lookups;
	    try {
	        [spools, lookups] = await Promise.all([
	            fetchJson("./api/spoolman/spools"),
	            fetchJson("./api/spoolman/lookups"),
	        ]);
	    } catch (err) {
	        dialogContent.innerHTML = `<p class="gc-bad">Could not load data from Spoolman: ${escapeHtml(err.message)}</p>`;
	        return;
	    }

	    const slot = amsSpool.slot || {};
	    dialogContent.innerHTML = `
	        <p style="margin-top:0">AMS slot <strong>${escapeHtml(amsSpool.amsId)}</strong> holds a spool the printer cannot identify
	           (${escapeHtml([slot.tray_type, slot.tray_sub_brands].filter(Boolean).join(" · ") || "unknown filament")}).
	           Link it to a Spoolman spool so its consumption can be booked.</p>
	        <div class="sp-tabs">
	            <button type="button" class="sp-tab sp-tab-active" data-mode="assign">Use existing spool</button>
	            <button type="button" class="sp-tab" data-mode="create">Create new spool</button>
	        </div>
	        <div id="sp-pane"></div>`;

	    const pane = dialogContent.querySelector("#sp-pane");
	    const tabs = [...dialogContent.querySelectorAll(".sp-tab")];

	    const selectMode = (mode) => {
	        for (const t of tabs) t.classList.toggle("sp-tab-active", t.dataset.mode === mode);
	        if (mode === "assign") renderAssignPane(pane, actionButton, button, amsSpool, spools);
	        else renderCreatePane(pane, actionButton, button, amsSpool, lookups);
	    };
	    for (const t of tabs) t.addEventListener("click", () => selectMode(t.dataset.mode));

	    // Nothing to assign yet on a fresh Spoolman, so start on the form instead of
	    // an empty picker.
	    selectMode(spools.length ? "assign" : "create");
	}

	function renderAssignPane(pane, actionButton, button, amsSpool, spools) {
	    actionButton.textContent = "Assign";
	    actionButton.disabled = true;

	    if (!spools.length) {
	        pane.innerHTML = `<p class="gc-muted">No spools in Spoolman yet. Use "Create new spool".</p>`;
	        return;
	    }

	    const rows = rankSpoolsForSlot(spools, amsSpool.slot || {}).map(({ sp }) => `
	        <label class="sp-pick">
	            <input type="radio" name="assign-spool" value="${sp.id}"> ${spoolPickerLabel(sp)}
	        </label>`).join("");

	    pane.innerHTML = `<div class="sp-scroll">${rows}</div>`;
	    pane.addEventListener("change", () => { actionButton.disabled = false; }, { once: true });

	    actionButton.onclick = () => {
	        const picked = pane.querySelector('input[name="assign-spool"]:checked');
	        if (!picked) return;
	        document.getElementById("info-dialog").close();
	        sendMapping(button, amsSpool, Number(picked.value));
	    };
	}

	// Values a chipless spool does report, used to pre-fill the form.
	function slotDefaults(slot) {
	    return {
	        material: slot.tray_type || "",
	        color: normColorJS(slot.tray_color) || "000000",
	    };
	}

	function renderCreatePane(pane, actionButton, button, amsSpool, lookups) {
	    actionButton.textContent = "Create";
	    actionButton.disabled = false;

	    const slot = amsSpool.slot || {};
	    const defaults = slotDefaults(slot);

	    // Materials already used here first, then everything Spoolman knows about
	    const materials = [...new Set([...(lookups.materials || []), ...(lookups.externalMaterials || []).map(m => m.material)])];

	    const filamentOptions = (lookups.filaments || [])
	        .map(f => `<option value="${f.id}">#${f.id} ${escapeHtml([f.vendor?.name, f.material, f.name].filter(Boolean).join(" · "))}</option>`)
	        .join("");

	    pane.innerHTML = `
	        <div class="sp-scroll">
	            <div class="sp-section">Filament</div>
	            <label class="sp-field sp-wide">
	                <span>Use filament</span>
	                <select id="sp-filament">
	                    <option value="">+ Create a new filament</option>
	                    ${filamentOptions}
	                </select>
	            </label>

	            <div id="sp-filament-fields">
	                <label class="sp-field">
	                    <span>Manufacturer</span>
	                    <input id="sp-vendor" list="sp-vendors" autocomplete="off" placeholder="e.g. Sunlu">
	                    <datalist id="sp-vendors">${(lookups.vendors || []).map(v => `<option value="${escapeHtml(v.name)}">`).join("")}</datalist>
	                    <small class="gc-muted" id="sp-vendor-hint"></small>
	                </label>
	                <label class="sp-field">
	                    <span>Material *</span>
	                    <input id="sp-material" list="sp-materials" autocomplete="off" value="${escapeHtml(defaults.material)}">
	                    <datalist id="sp-materials">${materials.map(m => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
	                    <small class="gc-muted" id="sp-material-hint"></small>
	                </label>
	                <label class="sp-field">
	                    <span>Name</span>
	                    <input id="sp-name" placeholder="e.g. Galaxy Black">
	                </label>
	                <label class="sp-field">
	                    <span>Colour</span>
	                    <span class="sp-colour">
	                        <input type="color" id="sp-colour-pick" value="#${defaults.color}">
	                        <input id="sp-colour" value="${defaults.color}" maxlength="6" autocomplete="off">
	                    </span>
	                </label>
	                <label class="sp-field">
	                    <span>Density * (g/cm³)</span>
	                    <input type="number" id="sp-density" step="0.01" min="0.01">
	                </label>
	                <label class="sp-field">
	                    <span>Diameter * (mm)</span>
	                    <input type="number" id="sp-diameter" step="0.01" min="0.01" value="1.75">
	                </label>
	                <label class="sp-field">
	                    <span>Nozzle temp (°C)</span>
	                    <input type="number" id="sp-extruder-temp">
	                </label>
	                <label class="sp-field">
	                    <span>Bed temp (°C)</span>
	                    <input type="number" id="sp-bed-temp">
	                </label>
	                <label class="sp-field">
	                    <span>Full weight (g)</span>
	                    <input type="number" id="sp-weight" min="0" value="1000">
	                </label>
	                <label class="sp-field">
	                    <span>Empty spool (g)</span>
	                    <input type="number" id="sp-spool-weight" min="0" value="250">
	                </label>
	            </div>

	            <div class="sp-section">Spool</div>
	            <label class="sp-field">
	                <span>Initial weight (g)</span>
	                <input type="number" id="sp-initial-weight" min="0" value="1000">
	            </label>
	            <label class="sp-field">
	                <span>Remaining (g)</span>
	                <input type="number" id="sp-remaining-weight" min="0" placeholder="leave empty if full">
	            </label>
	            <label class="sp-field">
	                <span>Location</span>
	                <input id="sp-location" list="sp-locations" autocomplete="off" value="${escapeHtml(currentPrinterName ? `${currentPrinterName} - ${amsSpool.amsId}` : "")}">
	                <datalist id="sp-locations">${(lookups.locations || []).map(l => `<option value="${escapeHtml(l)}">`).join("")}</datalist>
	            </label>
	            <label class="sp-field sp-wide">
	                <span>Comment</span>
	                <input id="sp-comment" placeholder="optional">
	            </label>
	            <p class="gc-muted sp-note">The spool is linked to this AMS slot right away. A chipless spool reports no weight,
	               so full and remaining weight have to be entered by hand.</p>
	            <p id="sp-error" class="gc-bad"></p>
	        </div>`;

	    const $ = (id) => pane.querySelector(`#${id}`);

	    // Picking an existing filament makes every filament field irrelevant
	    $("sp-filament").addEventListener("change", (e) => {
	        $("sp-filament-fields").style.display = e.target.value ? "none" : "";
	    });

	    // Density is required and cannot be read off the spool, so fill it (and the
	    // temperatures) from Spoolman's material catalogue as soon as one matches.
	    const applyMaterialDefaults = () => {
	        const value = $("sp-material").value.trim().toLowerCase();
	        const known = (lookups.externalMaterials || []).find(m => m.material.toLowerCase() === value);
	        const hint = $("sp-material-hint");
	        if (!known) {
	            hint.textContent = value ? "Not a known material, enter density yourself" : "";
	            return;
	        }
	        hint.textContent = `Defaults from ${known.material}`;
	        if (!$("sp-density").value) $("sp-density").value = known.density ?? "";
	        if (!$("sp-extruder-temp").value && known.extruder_temp != null) $("sp-extruder-temp").value = known.extruder_temp;
	        if (!$("sp-bed-temp").value && known.bed_temp != null) $("sp-bed-temp").value = known.bed_temp;
	    };
	    $("sp-material").addEventListener("input", applyMaterialDefaults);
	    applyMaterialDefaults();

	    // Typing a manufacturer that does not exist yet creates it on save
	    const vendorNames = new Set((lookups.vendors || []).map(v => v.name.toLowerCase()));
	    $("sp-vendor").addEventListener("input", () => {
	        const value = $("sp-vendor").value.trim();
	        $("sp-vendor-hint").textContent = value && !vendorNames.has(value.toLowerCase())
	            ? "New manufacturer, will be created"
	            : "";
	    });

	    // Keep the picker and the hex field in sync
	    $("sp-colour-pick").addEventListener("input", () => { $("sp-colour").value = $("sp-colour-pick").value.replace("#", "").toUpperCase(); });
	    $("sp-colour").addEventListener("input", () => {
	        const hex = normColorJS($("sp-colour").value);
	        if (/^[0-9A-F]{6}$/.test(hex)) $("sp-colour-pick").value = `#${hex}`;
	    });

	    // Full weight is the usual starting point for a spool's initial weight
	    $("sp-weight").addEventListener("input", () => { $("sp-initial-weight").value = $("sp-weight").value; });

	    actionButton.onclick = () => submitNewSpool(pane, actionButton, button, amsSpool, lookups);
	}

	async function submitNewSpool(pane, actionButton, button, amsSpool, lookups) {
	    const $ = (id) => pane.querySelector(`#${id}`);
	    const error = $("sp-error");
	    error.textContent = "";

	    const filamentId = $("sp-filament").value;
	    const payload = { spool: {
	        initialWeight:   $("sp-initial-weight").value,
	        remainingWeight: $("sp-remaining-weight").value,
	        location:        $("sp-location").value,
	        comment:         $("sp-comment").value,
	    } };

	    if (filamentId) {
	        payload.filamentId = Number(filamentId);
	    } else {
	        const vendorName = $("sp-vendor").value.trim();
	        const known = (lookups.vendors || []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());

	        payload.filament = {
	            vendorId:     known?.id ?? null,
	            vendorName:   known ? null : vendorName,
	            name:         $("sp-name").value,
	            material:     $("sp-material").value,
	            density:      $("sp-density").value,
	            diameter:     $("sp-diameter").value,
	            colorHex:     $("sp-colour").value,
	            weight:       $("sp-weight").value,
	            spoolWeight:  $("sp-spool-weight").value,
	            extruderTemp: $("sp-extruder-temp").value,
	            bedTemp:      $("sp-bed-temp").value,
	        };

	        if (!payload.filament.material.trim()) { error.textContent = "Material is required."; return; }
	        if (!(Number(payload.filament.density) > 0))  { error.textContent = "Density is required and must be greater than 0."; return; }
	        if (!(Number(payload.filament.diameter) > 0)) { error.textContent = "Diameter is required and must be greater than 0."; return; }
	    }

	    const original = actionButton.textContent;
	    actionButton.disabled = true;
	    actionButton.textContent = "Creating...";

	    try {
	        const res = await fetch(`./api/thirdparty/spool/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`, {
	            method: "POST",
	            headers: { "Content-Type": "application/json" },
	            body: JSON.stringify(payload),
	        });
	        const body = await res.json().catch(() => ({}));

	        if (!res.ok) {
	            error.textContent = body.error || `Request failed (HTTP ${res.status})`;
	            actionButton.disabled = false;
	            actionButton.textContent = original;
	            return;
	        }

	        document.getElementById("info-dialog").close();
	        showNotification(`Spool #${body.spoolId} created and assigned to ${amsSpool.amsId}.`, "success");
	        await loadPrinterData(currentPrinterId);
	    } catch (err) {
	        console.error("Spool creation failed:", err);
	        error.textContent = "Request failed. Please check your connection.";
	        actionButton.disabled = false;
	        actionButton.textContent = original;
	    }
	}

	async function fetchJson(url) {
	    const res = await fetch(url);
	    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
	    return res.json();
	}

	function escapeHtml(value) {
	    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	}

	function showUnassignDialog(button, amsSpool) {
	    const sp = amsSpool.existingSpool;
	    const content = `
	        <p>Remove the assignment of AMS slot <strong>${amsSpool.amsId}</strong>
	           ${sp ? `from Spoolman spool <strong>#${sp.id}</strong>` : ""}?</p>
	        <p class="gc-muted" style="font-size:0.85em">Consumption for this slot will no longer be booked until it is assigned again.
	           Already booked weight is not reverted.</p>`;
	    showDialog(button, content, "Unassign", () => sendMapping(button, amsSpool, null));
	}

	// null spoolId removes the assignment.
	async function sendMapping(button, amsSpool, spoolId) {
	    const originalText = button.textContent;
	    button.disabled = true;
	    button.textContent = "Sending...";

	    const url = `./api/mappings/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`;

	    try {
	        const res = spoolId == null
	            ? await fetch(url, { method: "DELETE" })
	            : await fetch(url, {
	                  method: "PUT",
	                  headers: { "Content-Type": "application/json" },
	                  body: JSON.stringify({ spoolId }),
	              });

	        if (!res.ok) {
	            const err = await res.json().catch(() => ({}));
	            showNotification(`Error: ${err.error || "Assignment failed"}`, "error");
	            button.textContent = originalText;
	            button.disabled = false;
	            return;
	        }

	        showNotification(spoolId == null ? "Assignment removed." : `Slot assigned to spool #${spoolId}.`, "success");
	        // The backend also pushes a slot_update over SSE, but re-render right
	        // away so the row never sits on "Sending..." if that event is missed.
	        await loadPrinterData(currentPrinterId);
	    } catch (err) {
	        console.error("Assignment failed:", err);
	        showNotification("Request failed. Please check your connection.", "error");
	        button.textContent = originalText;
	        button.disabled = false;
	    }
	}

	// Combined "Spool" identity cell shared by both the G-code dashboard and the
	// (legacy) classic table: color swatch + readable filament name
	// (vendor · material · name) with an optional ambiguity warning, then a muted
	// second line with the AMS slot id, tray index, Spoolman link and the
	// tag/booking status. Pass `ctx` with a `keyCount` map to enable the
	// duplicate-spool ⚠ marker (only meaningful when all slots are known).
	function spoolIdentityHtml(amsSpool, ctx = null) {
	    const slot = amsSpool.slot || {};
	    const isEmpty = amsSpool.slotState === "Empty";
	    const fil = amsSpool.existingSpool?.filament;

	    const nameParts = [
	        fil?.vendor?.name ?? amsSpool.matchingExternalFilament?.manufacturer,
	        fil?.material     ?? slot.tray_type,
	        fil?.name         ?? amsSpool.matchingExternalFilament?.name ?? slot.tray_sub_brands,
	    ].filter(Boolean);
	    // An empty slot the AMS is busy with is a spool going in or out, which
	    // reports nothing the backend could tell from a truly empty slot.
	    const emptyLabel = amsSpool.option === "Waiting for data" ? "Reading spool" : "Empty slot";
	    const readable = isEmpty ? emptyLabel : (nameParts.length ? nameParts.join(" · ") : "Unknown filament");

	    // The colours come from the slot, not from the matched filament: they are
	    // what physically sits in the AMS, and the printer reports them in the
	    // order they run along the strand. The direction only decides how they
	    // are drawn, and the AMS does not report it, so it comes from whichever
	    // filament record was matched.
	    const direction = fil?.multi_color_direction ?? amsSpool.matchingExternalFilament?.multi_color_direction ?? null;
	    const color = isEmpty ? "" : swatchHtml(slotColorsJS(slot), direction);

	    const spoolmanBaseUrl = (document.getElementById("spoolmanLink")?.href || "").replace(/\/+$/, "");
	    const spoolman = amsSpool.existingSpool?.id
	        ? `<a class="gc-link" href="${spoolmanBaseUrl}/spool/show/${amsSpool.existingSpool.id}" target="_blank">Spoolman #${amsSpool.existingSpool.id}</a>`
	        : `<span class="gc-muted">not linked</span>`;

	    // Tag/booking status is G-code-consumption semantics, so only shown there.
	    let booking = "";
	    if (!isEmpty && ctx?.showBooking) {
	        if (amsSpool.connectedViaMapping) {
	            booking = ` · <span class="gc-ok" title="Manually assigned to a Spoolman spool, consumption is booked onto it">● assigned</span>`;
	        } else if (amsSpool.connectedViaTag) {
	            booking = ` · <span class="gc-ok" title="Physically connected via Spoolman extra.tag, consumption is booked automatically">● tag-linked</span>`;
	        } else {
	            booking = ` · <span class="gc-warn" title="No extra.tag link, consumption cannot be booked automatically; assign a Spoolman spool to track it">● not tracked</span>`;
	        }
	    }

	    // A manual assignment resolves the ambiguity for this slot, so the warning
	    // only applies while the slot still relies on the automatic match.
	    const ambiguous = (!isEmpty && !amsSpool.connectedViaMapping && ctx?.keyCount && ctx.keyCount[amsSpool.key] > 1)
	        ? ` <span class="gc-warn" title="Another loaded spool is identical in profile and colour. Consumption is still split correctly whenever the sliced file names the slot each filament was meant for. Where it does not, the whole amount goes to one of them; assign one to choose which.">⚠</span>`
	        : "";

	    return `
	        ${color}<strong>${readable}</strong>${ambiguous}<br>
	        <span style="font-size:0.82em">
	            <span class="gc-muted">${amsSpool.amsId} · <code>${isEmpty ? "—" : (slot.tray_info_idx ?? "—")}</code></span> · ${spoolman}${booking}
	        </span>`;
	}

	function createSpoolRow(amsSpool, ctx = null) {
	    const tr = document.createElement("tr");
	    tr.setAttribute("data-amsid", amsSpool.amsId);
	
	    let amsSpoolRemainingWeight = amsSpool.correctedWeight ?? (amsSpool.slot.remain == null
	        ? null
	        : (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain);
	    let correctedRemain = amsSpool.correctedRemain ?? amsSpool.slot.remain;
	    let totalWeight = amsSpool.slot.tray_weight;

	    // In G-code mode the AMS RFID remain % is not tracked, so show the actual
	    // Spoolman remaining weight/percentage of the tag-connected spool instead.
	    const sp = amsSpool.existingSpool;
	    if (!legacyMode && (amsSpool.connectedViaTag || amsSpool.connectedViaMapping) && sp && sp.remaining_weight != null) {
	        const full = sp.filament?.weight;
	        amsSpoolRemainingWeight = Math.round(sp.remaining_weight);
	        if (sp.remaining_percentage != null) {
	            correctedRemain = Math.round(sp.remaining_percentage);
	        } else if (full) {
	            correctedRemain = Math.round((sp.remaining_weight / full) * 100);
	        }
	        if (full) totalWeight = Math.round(full);
	    }

	    const button = createActionButton(amsSpool);

	    tr.innerHTML = `
	        <td data-label="Spool" style="text-align:left">${spoolIdentityHtml(amsSpool, ctx)}</td>
	        <td data-label="Remaining">${amsSpoolRemainingWeight == null ? "—" : `${amsSpoolRemainingWeight} g`} / ${totalWeight} g (${correctedRemain == null ? "—" : `${correctedRemain}%`})</td>
	        <td data-label="Serialnumber">${amsSpool.slot.tray_uuid ?? "—"}</td>
	        <td data-label="State">${setIcon(amsSpool.error, amsSpool.slotState)}</td>
	    `;
	    const tdBtn = document.createElement("td");
	    tdBtn.setAttribute("data-label", "Action");
	    tdBtn.appendChild(button);
	    tr.appendChild(tdBtn);
	
	    return tr;
	}
	
	function upsertSpoolRow(amsSpool) {
	    const selector = `[data-amsid="${amsSpool.amsId}"]`;
	    const existingRow = document.querySelector(selector);
	    const newRow = createSpoolRow(amsSpool, lastLegacyCtx);
	
	    if (existingRow && existingRow.parentElement) {
	        existingRow.parentElement.replaceChild(newRow, existingRow);
	    } else {
	        const tables = document.querySelectorAll('.spool-table tbody');
	        const targetTbody = tables[tables.length - 1] || null;
	        if (targetTbody) {
	            targetTbody.appendChild(newRow);
	            if (typeof synchronizeSelectedColumns === 'function') {
	                try { synchronizeSelectedColumns([0,1,2,3]); } catch (e) {}
	            }
	        } else {
	            if (currentPrinterId) loadPrinterData(currentPrinterId);
	        }
	    }
	}
	
	// =======================================================================
	// G-code mode main view
	//
	// Replaces the classic AMS table with a print-centric dashboard: live print
	// state + each loaded spool joined with its consumption requirement (on spool
	// / needed / rest) and the same action button as the classic table. Driven by
	// /api/spools (full spool objects, for the buttons) + /api/print (print
	// state and per-filament consumption). Refreshed on SSE events.
	// =======================================================================

	let gcodeRefreshTimer = null;

	// Coalesce bursts of SSE events into at most one dashboard refresh per second.
	// Skip while an action dialog is open so the table doesn't change mid-action.
	function scheduleGcodeRefresh() {
	    if (gcodeRefreshTimer) return;
	    gcodeRefreshTimer = setTimeout(() => {
	        gcodeRefreshTimer = null;
	        if (currentPrinterId && !legacyMode && !isDialogOpen()) loadGcodeView(currentPrinterId);
	    }, 1000);
	}

	// The label the server gives the external spool holder. It reports one spool
	// and gets a table of its own, like an AMS HT unit, because it belongs to no
	// four slot unit and would otherwise break their grouping.
	const EXTERNAL_SLOT = "External";

	// Slots that stand alone rather than filling a four slot AMS unit.
	function isSingleSlotUnit(amsId) {
	    return amsId === EXTERNAL_SLOT || amsId.startsWith("HT-");
	}

	// Mirrors normColor in src/gcode.js: slice colors carry a leading "#" and AMS
	// colors carry a trailing alpha byte, so both are trimmed to bare 6-digit hex.
	function normColorJS(color) {
	    return String(color || "").replace(/^#/, "").slice(0, 6).toUpperCase();
	}

	function gcodeStateBadge(state) {
	    const variants = {
	        RUNNING: "gc-state-running", FINISH: "gc-state-done",
	        FAILED:  "gc-state-error",   CANCEL: "gc-state-error",
	        PAUSE:   "gc-state-paused",
	    };
	    return `<span class="gc-state ${variants[state] || ""}">${state || "—"}</span>`;
	}

	async function loadGcodeView(printerId) {
	    const el = getElementSafe("spool-list");
	    if (!el) return;
	    try {
	        const [spoolsRes, printRes] = await Promise.all([
	            fetch(`./api/spools/${printerId}`),
	            fetch(`./api/print/${printerId}`),
	        ]);
	        if (!spoolsRes.ok || !printRes.ok) {
	            const failed = !spoolsRes.ok ? spoolsRes : printRes;
	            const body = await failed.json().catch(() => ({}));
	            throw new Error(body.error || `HTTP ${failed.status}`);
	        }

	        const spools = await spoolsRes.json();
	        const printData = await printRes.json();

	        el.innerHTML = "";
	        el.appendChild(buildGcodeCard(printData));

	        for (const table of buildGcodeSpoolTables(spools, printData)) {
	            el.appendChild(table);
	        }

	        // Align column widths across all AMS tables (each column to its widest
	        // cell) so AMS A / AMS B / … line up uniformly. 5 columns: 0..4,
	        // unlike the classic table the action column has to be included here,
	        // otherwise the table shrinks to its content width and squeezes the
	        // Spool column into a narrow wrapped block.
	        synchronizeSelectedColumns([0, 1, 2, 3, 4]);

	        const missing = buildGcodeMissing(printData);
	        if (missing) el.appendChild(missing);
	    } catch (err) {
	        el.innerHTML = `<p class="gc-required">Request failed: ${err.message}</p>`;
	    }
	}

	function buildGcodeCard(printData) {
	    const active = ["RUNNING", "PAUSE", "PREPARE"].includes(printData.gcodeState);
	    const humanLayer  = (printData.layerNum ?? 0) + 1;
	    const humanTotal  = printData.totalLayers != null ? printData.totalLayers + 1 : null;
	    const progressPct = humanTotal ? Math.round((humanLayer / humanTotal) * 100) : null;

	    const card = document.createElement("div");
	    card.className = "gc-card";

	    let html = `<div class="gc-card-head">
	        ${gcodeStateBadge(printData.gcodeState)}
	        <strong>${printData.jobName ? printData.jobName : "No active print"}</strong>
	        <span class="gc-card-note">${printData.consumptionBooked ? "✔ consumption booked" : ""}</span>
	    </div>`;
	    if (active && humanTotal) {
	        html += `<div class="gc-progress">
	            <div class="gc-progress-labels">
	                <span>Layer ${humanLayer} / ${humanTotal}</span><span>${progressPct}%</span>
	            </div>
	            <div class="gc-progress-track">
	                <div class="gc-progress-bar" style="width:${progressPct}%"></div>
	            </div>
	        </div>`;
	    }
	    // The backend reports why consumption data is missing (e.g. the FTPS
	    // download failed); without this the table would just show a placeholder with no
	    // explanation.
	    if (printData.error) {
	        html += `<p class="gc-required" style="margin:10px 0 0">${printData.error}</p>`;
	    }
	    card.innerHTML = html;
	    return card;
	}

	// Build one table per AMS unit, like the classic view: normal AMS up to 4
	// slots per table, AMS HT a single slot per table. The generic `table`
	// margin gives a clear gap between units.
	function buildGcodeSpoolTables(spools, printData) {
	    const fullCons = printData.fullConsumption || {};
	    const partCons = printData.consumption || {};

	    // Ambiguity is global across all AMS units, so count keys over everything
	    const keyCount = {};
	    for (const s of spools) {
	        if (s.slotState === "Empty") continue;
	        keyCount[s.key] = (keyCount[s.key] || 0) + 1;
	    }
	    const ctx = { fullCons, partCons, keyCount, showBooking: true };

	    const makeTable = (slotsSubset) => {
	        const table = document.createElement("table");
	        table.className = "spool-table";
	        table.innerHTML = `<thead><tr>
	            <th style="text-align:left">Spool</th>
	            <th style="text-align:right">On spool / total</th>
	            <th style="text-align:right">Needed</th>
	            <th style="text-align:right">After print</th>
	            <th>Action</th>
	        </tr></thead>`;
	        const tbody = document.createElement("tbody");
	        for (const s of slotsSubset) tbody.appendChild(createGcodeSpoolRow(s, ctx));
	        table.appendChild(tbody);
	        return table;
	    };

	    const tables = [];
	    const normalAMS = spools.filter(s => !isSingleSlotUnit(s.amsId));
	    const singles   = spools.filter(s => isSingleSlotUnit(s.amsId));

	    // Normal AMS: up to 4 slots per unit/table
	    for (let i = 0; i < normalAMS.length; i += 4) {
	        tables.push(makeTable(normalAMS.slice(i, i + 4)));
	    }
	    // AMS HT and the external spool holder: one slot per table
	    for (const single of singles) tables.push(makeTable([single]));

	    if (!tables.length) {
	        const empty = makeTable([]);
	        empty.querySelector("tbody").innerHTML =
	            `<tr><td colspan="5" style="opacity:0.5">No spools loaded</td></tr>`;
	        tables.push(empty);
	    }
	    return tables;
	}

	// The grams a slot carries in a consumption map.
	//
	// The server decides which sliced filament belongs to which slot, in
	// matchConsumption() (src/ams.js), the same function the booking uses, and
	// names the slot on every entry as `matchedAmsId`. This used to be a second
	// implementation of that decision, and both defects fixed at the end of
	// PR #89 sat in it.
	//
	// Summed rather than picked: one slot can serve two filaments of a print,
	// and the booking writes both of their amounts onto its spool.
	function consumedGrams(cons, amsId) {
	    return Object.values(cons)
	        .filter(e => e.matchedAmsId && e.matchedAmsId === amsId)
	        .reduce((total, e) => total + (e.grams || 0), 0);
	}

	function createGcodeSpoolRow(amsSpool, ctx) {
	    const { fullCons, partCons, keyCount } = ctx;
	    const tr = document.createElement("tr");
	    tr.setAttribute("data-amsid", amsSpool.amsId);

	    const slot   = amsSpool.slot || {};
	    const isEmpty = amsSpool.slotState === "Empty";
	    const needed = isEmpty ? 0 : consumedGrams(fullCons, amsSpool.amsId);
	    const used   = isEmpty ? 0 : consumedGrams(partCons, amsSpool.amsId);

	    // On spool: Spoolman remaining/initial weight whenever we know which spool
	    // this is (tag link or manual assignment), else the AMS-reported
	    // remaining/total weight (g/g, like the legacy MQTT table but without the
	    // percentage).
	    const sp = amsSpool.existingSpool;
	    let onSpool = amsSpool.correctedWeight ?? null;
	    // tray_weight arrives from MQTT as a string, so a weightless 3rd party
	    // spool reports "0", which is truthy. Left as-is it passed the guard
	    // below, divided by zero in the remain% fallback and rendered "NaNg".
	    let totalSpool = Number(slot.tray_weight) || null;
	    if ((amsSpool.connectedViaTag || amsSpool.connectedViaMapping) && sp && sp.remaining_weight != null) {
	        onSpool = Math.round(sp.remaining_weight);
	        if (sp.initial_weight != null) totalSpool = Math.round(sp.initial_weight);
	    } else if (onSpool == null && !isEmpty && slot.remain != null && totalSpool) {
	        // Fallback if correctedWeight wasn't provided by the backend: derive
	        // it client-side from the AMS remain%, same as the legacy table does.
	        const pct = correctRemainIntJS(slot.remain, totalSpool, slot.tray_type);
	        onSpool = Math.round((pct / 100) * totalSpool);
	    }

	    let neededCell     = "—";
	    let afterPrintCell = "—";
	    if (needed > 0) {
	        neededCell = `${needed}g${used ? `<br><span class="gc-muted" style="font-size:0.8em">printed: ${used}g</span>` : ""}`;
	        if (onSpool != null) {
	            const afterPrint = Math.round((onSpool - needed) * 100) / 100;
	            afterPrintCell = `<span class="${afterPrint < 0 ? "gc-bad" : "gc-ok"}">${afterPrint}g</span>`;
	        }
	    }

	    // 3rd-party spools report tray_weight 0, so only show the total when the
	    // AMS or Spoolman actually knows it.
	    const onSpoolCell = onSpool != null && !isEmpty
	        ? `${onSpool}g${totalSpool ? ` / ${totalSpool}g` : ""}`
	        : "—";

	    tr.innerHTML = `
	        <td data-label="Spool" style="text-align:left">${spoolIdentityHtml(amsSpool, ctx)}</td>
	        <td data-label="On spool / total" style="text-align:right">${onSpoolCell}</td>
	        <td data-label="Needed" style="text-align:right">${neededCell}</td>
	        <td data-label="After print" style="text-align:right">${afterPrintCell}</td>
	    `;

	    const tdBtn = document.createElement("td");
	    tdBtn.setAttribute("data-label", "Action");
	    tdBtn.appendChild(createActionButton(amsSpool));
	    tr.appendChild(tdBtn);

	    return tr;
	}

	function buildGcodeMissing(printData) {
	    const fullCons = printData.fullConsumption || {};

	    // An entry the server could place on a loaded slot is by definition not
	    // missing. It matched the slots over every loaded one, not only the
	    // bookable ones, which is exactly the question this list asks.
	    const missing = Object.values(fullCons).filter(e => !e.matchedAmsId);
	    if (!missing.length) return null;

	    const wrap = document.createElement("div");
	    let html = `<h4 class="gc-required" style="margin:16px 0 4px">Required but not loaded</h4>`;
	    html += `<table class="data-table gc-required-table">`;
	    for (const e of missing) {
	        // The sliced file names one colour per filament, so there is never a
	        // set to draw here, unlike on a slot.
	        const swatch = swatchHtml(e.color ? [normColorJS(e.color)] : []);
	        const label = e.type ? `${e.type} <code>${e.tray_info_idx}</code>` : `<code>${e.tray_info_idx}</code>`;
	        html += `<tr><td>${swatch}${label}</td>
	            <td class="gc-required-amount">${e.grams}g needed</td></tr>`;
	    }
	    html += `</table>`;
	    wrap.innerHTML = html;
	    return wrap;
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
            "Assign Spool": "Assign Spool",
            "Unassign Spool": "Unassign Spool",
            "Show Info!": "Show Info!",
            // Not an action: the AMS has not reported the remaining percentage
            // yet, and creating a spool without it would store a partly used
            // one as brand new. The backend offers the real action as soon as
            // the reading arrives, or after five updates without one.
            "Waiting for data": "Waiting for data"
        };

        button.textContent = actionMap[amsSpool.option] || "No actions available";
        button.disabled = amsSpool.enableButton !== "true" || !spoolmanConnected;
        if (amsSpool.option === "Waiting for data") {
            button.title = "The AMS has not reported how much filament is left yet. Creating the spool now would store it as brand new.";
        }
    }

    // Generate the content of the confirmation dialog
    function generateDialogContent(button, amsSpool) {
        if (button.textContent === "Create Spool") {
            return `
                <p>Do you really want to create a Spool with the following stats in Spoolman?</p>
                <table class="data-table">
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
            const remain = amsSpool.slot.remain == null
                ? null
                : (amsSpool.slot.remain / 100) * amsSpool.slot.tray_weight;

            return `
                <p>Do you really want to merge this Spool with an existing Spool in Spoolman?</p>
                <table class="data-table">
                    <tr>
                        <th>AMS Spool:</th>
                        <td>${amsSpool.slot.tray_sub_brands} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.slot.tray_uuid}</td>
                    </tr>
                    <tr>
                        <th>Spoolman Spool:</th>
                        <td>Spool-ID ${amsSpool.mergeableSpool.id} - Bambu Lab - ${amsSpool.mergeableSpool.filament.material} - ${amsSpool.mergeableSpool.filament.name} - ${remain == null ? "unknown" : `${remain} g`} left on spool</td>
                    </tr>
                </table>
            `;
        } else if (button.textContent === "Create Filament & Spool") {
            return `
                <p>Do you really want to create a Spool and a new Filament with the following stats in Spoolman?</p>
                <table class="data-table">
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
        // The harmless choice takes the focus, not the one that writes to Spoolman
        closeDialog.focus();
    }

    // Send the selected action to the backend
    async function performAction(button, amsSpool) {
        const endpointMap = {
            "Create Spool": "./api/createSpool",
            "Merge Spool": "./api/mergeSpool",
            "Create Filament & Spool": "./api/createSpoolWithFilament"
        };

        const endpoint = endpointMap[button.textContent];
        if (!endpoint) return;

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Sending...";

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ printerId: currentPrinterId, amsId: amsSpool.amsId })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showNotification(`Error: ${err.error || "Action failed"}`, "error");
                button.textContent = originalText;
                button.disabled = false;
                return;
            }

            button.textContent = "No actions available";
            showNotification("Action sent successfully. UI updates after next MQTT event.", "success");
        } catch (err) {
            console.error("Action failed:", err);
            showNotification("Request failed. Please check your connection.", "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    function showNotification(message, type = "success") {
        let note = document.getElementById("action-notification");
        if (!note) {
            note = document.createElement("div");
            note.id = "action-notification";
            note.style.cssText = "position:fixed;bottom:1.5rem;right:1.5rem;padding:0.75rem 1.25rem;border-radius:6px;font-size:0.9rem;z-index:9999;transition:opacity 0.4s";
            document.body.appendChild(note);
        }
        note.textContent = message;
        note.style.background = type === "error" ? "#c0392b" : "#27ae60";
        note.style.color = "#fff";
        note.style.opacity = "1";
        clearTimeout(note._timeout);
        note._timeout = setTimeout(() => { note.style.opacity = "0"; }, 3500);
    }

    // Update various status elements in the UI
    function updateStatus(data) {
                
        data.lastMqttUpdate = data.lastMqttUpdate
            ? formatDate(new Date(data.lastMqttUpdate))
            : "No update yet";

        data.lastMqttAmsUpdate = data.lastMqttAmsUpdate
            ? formatDate(new Date(data.lastMqttAmsUpdate))
            : "No update yet";
        
        if (typeof data.LEGACY_MODE === "boolean") legacyMode = data.LEGACY_MODE;

        // Active tracking mode badge
        const modeEl = getElementSafe("tracking-mode");
        if (modeEl) {
            if (legacyMode) {
                modeEl.className = "pill pill-legacy";
                modeEl.textContent = "Legacy · MQTT remain";
                modeEl.title = "Spool weight is tracked from the AMS RFID remain % via MQTT";
            } else {
                modeEl.className = "pill pill-gcode";
                modeEl.textContent = "G-code tracking";
                modeEl.title = "Spool weight is tracked from the sliced G-code consumption";
            }
        }

        spoolmanConnected = data.spoolmanStatus === "Connected";

        updateStatusWithIcon("spoolman-status", data.spoolmanStatus);
        updateStatusWithIcon("mqtt-status", data.mqttStatus);
        updateElementText("last-mqtt-update", data.lastMqttUpdate);
        updateElementText("last-mqtt-ams-update", data.lastMqttAmsUpdate);
        currentPrinterName = data.printerName || "";
        updateElementText("printer-name", data.printerName);
        updateElementText("mode", data.MODE);
        updateElementText("printer-serial", data.PRINTER_ID);
        
        const footer = document.getElementById("dynamic-footer");

        if (footer) {
            const URL = data.SPOOLMAN_FQDN || data.SPOOLMAN_URL;
            footer.innerHTML = `
                <div class="container">
                    <div class="content">
                        2026 - v.${data.VERSION} | 
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
        const el = getElementSafe(elementId);
        if (!el) return;
        const ok = status === "Connected";
        el.innerHTML = `<span class="pill ${ok ? "pill-ok" : "pill-bad"}">● ${status}</span>`;
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

let currentPrinterId = null;


async function toggleMonitoring() {
    if (!currentPrinterId) return;

    const toggle = document.getElementById("monitoring-toggle");
    const enable = toggle.checked;

    const action = enable ? "start" : "stop";

    await fetch(`./api/printer/${currentPrinterId}/monitoring/${action}`, {
        method: "POST"
    });
}
