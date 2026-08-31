// Settings page. Renders the fields the backend describes in /api/settings, so
// a new setting only has to be added to the schema in src/settings.js, and
// manages the printer list through /api/printers.

// Order and headline of the field groups. The group key comes from the schema.
const GROUPS = [
    { key: "spoolman",  title: "Spoolman connection" },
    { key: "tracking",  title: "Tracking" },
    { key: "intervals", title: "Intervals and retries" },
    { key: "behaviour", title: "Behaviour" },
];

let fields = [];
let values = {};
let sources = {};
let printers = [];
// Set once an input was touched, so a settings update pushed over SSE cannot
// overwrite what is currently being typed.
let formDirty = false;

document.addEventListener("DOMContentLoaded", () => {
    // Menu bar, including the dark mode button
    initMenubar();

    document.getElementById("settings-form").addEventListener("submit", saveSettings);
    document.getElementById("reload-settings").addEventListener("click", () => loadSettings(true));
    document.getElementById("add-printer").addEventListener("click", () => openPrinterDialog(null));
    document.getElementById("printer-dialog-cancel").addEventListener("click", () => closeDialog("printer-dialog"));
    document.getElementById("confirm-dialog-cancel").addEventListener("click", () => closeDialog("confirm-dialog"));

    loadSettings();
    loadPrinters();

    const eventSource = new EventSource("./api/events");
    eventSource.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "printers_update") {
            loadPrinters();
            // A renamed or removed printer changes the menu as well
            refreshMenubarPrinters();
        }
        if (data.type === "settings_update" && !formDirty) loadSettings();
    };
});

/* ---- HTTP helpers ---- */

async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

function sendJson(url, method, payload) {
    return fetchJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- Banner ---- */

function showBanner(message, kind = "ok") {
    const banner = document.getElementById("set-banner");
    banner.className = `set-banner set-banner-${kind}`;
    banner.textContent = message;
}

function clearBanner() {
    const banner = document.getElementById("set-banner");
    banner.className = "set-banner";
    banner.textContent = "";
}

/* ---- Settings form ---- */

async function loadSettings(userRequested = false) {
    try {
        const view = await fetchJson("./api/settings");
        fields = view.fields;
        values = view.values;
        sources = view.sources;
        renderSettings();
        formDirty = false;
        if (userRequested) clearBanner();
    } catch (err) {
        showBanner(`Could not load the settings: ${err.message}`, "bad");
    }
}

function renderSettings() {
    const container = document.getElementById("settings-groups");
    container.innerHTML = "";

    for (const group of GROUPS) {
        const groupFields = fields.filter(field => field.group === group.key);
        if (!groupFields.length) continue;

        const card = document.createElement("div");
        card.className = "set-card";
        card.innerHTML = `<div class="set-card-head"><h2>${escapeHtml(group.title)}</h2></div>
                          <div class="set-form">${groupFields.map(renderField).join("")}</div>`;
        container.appendChild(card);
    }

    container.querySelectorAll("input, select").forEach(input => {
        input.addEventListener("input", () => { formDirty = true; });
    });
}

/** Builds the input for one field, chosen by the type the schema reports. */
function renderField(field) {
    const value = values[field.key];
    const id = `set-${field.key}`;
    let input;

    if (field.type === "boolean") {
        input = `<label class="set-check"><input type="checkbox" id="${id}" ${value ? "checked" : ""}> <span>Enabled</span></label>`;
    } else if (field.type === "enum") {
        const options = field.options
            .map(option => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`)
            .join("");
        input = `<select id="${id}">${options}</select>`;
    } else if (field.type === "integer") {
        input = `<input type="number" id="${id}" value="${escapeHtml(value)}"
                        ${field.min !== null ? `min="${field.min}"` : ""}
                        ${field.max !== null ? `max="${field.max}"` : ""}>`;
    } else {
        input = `<input type="text" id="${id}" value="${escapeHtml(value ?? "")}">`;
    }

    const badges = [
        field.restartRequired ? `<span class="pill pill-legacy">restart required</span>` : "",
        sources[field.key] === "environment" ? `<span class="pill pill-gcode">from the environment</span>` : "",
    ].join("");

    return `<label class="set-field" for="${id}">
                <span class="set-field-label">${escapeHtml(field.label)} ${badges}</span>
                ${input}
                <small>${escapeHtml(field.description)}</small>
            </label>`;
}

/** Reads every field back out of the form, in the type the backend expects. */
function collectSettings() {
    const payload = {};

    for (const field of fields) {
        const input = document.getElementById(`set-${field.key}`);
        if (!input) continue;

        if (field.type === "boolean") payload[field.key] = input.checked;
        else payload[field.key] = input.value;
    }

    return payload;
}

async function saveSettings(event) {
    event.preventDefault();
    const button = document.getElementById("save-settings");
    button.disabled = true;

    try {
        const result = await sendJson("./api/settings", "PUT", collectSettings());
        fields = result.fields;
        values = result.values;
        sources = result.sources;
        renderSettings();
        formDirty = false;

        if (result.restartRequired.length) {
            const names = result.restartRequired
                .map(key => fields.find(field => field.key === key)?.label ?? key)
                .join(", ");
            showBanner(`Saved. Restart the service to apply: ${names}.`, "warn");
        } else if (result.changed.length) {
            showBanner("Saved and applied.", "ok");
        } else {
            showBanner("Nothing changed.", "ok");
        }
    } catch (err) {
        showBanner(`Could not save: ${err.message}`, "bad");
    } finally {
        button.disabled = false;
    }
}

/* ---- Printers ---- */

async function loadPrinters() {
    try {
        printers = await fetchJson("./api/printers/config");
        renderPrinters();
    } catch (err) {
        document.getElementById("printer-table").innerHTML =
            `<p class="set-error">Could not load the printers: ${escapeHtml(err.message)}</p>`;
    }
}

function renderPrinters() {
    const container = document.getElementById("printer-table");

    if (!printers.length) {
        container.innerHTML = `<p class="set-note">No printers configured yet.</p>`;
        return;
    }

    const rows = printers.map(printer => `
        <tr>
            <td>${escapeHtml(printer.name)}</td>
            <td>${escapeHtml(printer.id)}</td>
            <td>${escapeHtml(printer.ip)}</td>
            <td>${escapeHtml(printer.mqttStatus)}</td>
            <td class="set-row-actions">
                <button class="btn" data-edit="${escapeHtml(printer.id)}">Edit</button>
                <button class="btn" data-delete="${escapeHtml(printer.id)}">Delete</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table>
            <thead><tr><th>Name</th><th>Serial number</th><th>Address</th><th>MQTT</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;

    container.querySelectorAll("[data-edit]").forEach(button => {
        button.onclick = () => openPrinterDialog(printers.find(p => p.id === button.dataset.edit));
    });
    container.querySelectorAll("[data-delete]").forEach(button => {
        button.onclick = () => confirmDeletePrinter(printers.find(p => p.id === button.dataset.delete));
    });
}

/**
 * Opens the add or edit dialog. The serial number is read only while editing:
 * it keys the MQTT topic, the log file and the spool assignments, so a
 * different one describes a different printer.
 */
function openPrinterDialog(printer) {
    const editing = !!printer;
    const dialog = document.getElementById("printer-dialog");

    document.getElementById("printer-dialog-title").textContent = editing ? `Edit ${printer.name}` : "Add printer";
    document.getElementById("printer-dialog-error").textContent = "";
    document.getElementById("printer-dialog-fields").innerHTML = `
        <label class="set-field">
            <span class="set-field-label">Name</span>
            <input type="text" id="printer-name" value="${escapeHtml(printer?.name ?? "")}">
            <small>Shown in the Web UI and in the log files.</small>
        </label>
        <label class="set-field">
            <span class="set-field-label">Serial number</span>
            <input type="text" id="printer-id" value="${escapeHtml(printer?.id ?? "")}" ${editing ? "disabled" : ""}>
            <small>${editing ? "Cannot be changed. Add a new printer instead." : "Found on the printer under Settings, Device."}</small>
        </label>
        <label class="set-field">
            <span class="set-field-label">Address</span>
            <input type="text" id="printer-ip" value="${escapeHtml(printer?.ip ?? "")}">
            <small>Host name or IP address in the local network.</small>
        </label>
        <label class="set-field">
            <span class="set-field-label">Access code</span>
            <input type="password" id="printer-code" value="" autocomplete="new-password"
                   placeholder="${editing ? "unchanged" : ""}">
            <small>${editing ? "Leave empty to keep the stored code." : "LAN access code from the network settings of the printer."}</small>
        </label>`;

    const saveButton = document.getElementById("printer-dialog-save");
    saveButton.onclick = () => savePrinter(printer);
    dialog.showModal();
}

async function savePrinter(printer) {
    const error = document.getElementById("printer-dialog-error");
    const payload = {
        name: document.getElementById("printer-name").value,
        ip: document.getElementById("printer-ip").value,
        code: document.getElementById("printer-code").value,
    };

    try {
        if (printer) {
            await sendJson(`./api/printers/${encodeURIComponent(printer.id)}`, "PUT", payload);
            showBanner(`Saved ${payload.name || printer.name}.`, "ok");
        } else {
            await sendJson("./api/printers", "POST", { ...payload, id: document.getElementById("printer-id").value });
            showBanner(`Added ${payload.name}. The connection is being established.`, "ok");
        }
        closeDialog("printer-dialog");
        loadPrinters();
    } catch (err) {
        error.textContent = err.message;
    }
}

function confirmDeletePrinter(printer) {
    document.getElementById("confirm-dialog-title").textContent = `Delete ${printer.name}?`;
    document.getElementById("confirm-dialog-text").innerHTML =
        `<p>The printer is disconnected and removed from the configuration.
            Its spool assignments are dropped as well. The log file is kept.</p>
         <p class="set-note">Spools already created in Spoolman are not touched.</p>`;

    document.getElementById("confirm-dialog-ok").onclick = async () => {
        try {
            await fetchJson(`./api/printers/${encodeURIComponent(printer.id)}`, { method: "DELETE" });
            showBanner(`Removed ${printer.name}.`, "ok");
            closeDialog("confirm-dialog");
            loadPrinters();
        } catch (err) {
            showBanner(`Could not remove the printer: ${err.message}`, "bad");
            closeDialog("confirm-dialog");
        }
    };

    document.getElementById("confirm-dialog").showModal();
}

function closeDialog(id) {
    document.getElementById(id).close();
}
