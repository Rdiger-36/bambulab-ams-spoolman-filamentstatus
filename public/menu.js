// Shared menu bar. Every page renders the same menu into #menu-root and wires
// the dark mode button next to it, so navigation and the theme behave the same
// on the dashboard, the log viewer and the settings page.

const LIGHT_MODE_ICON = "https://img.icons8.com/ios-glyphs/30/moon-symbol.png";
const DARK_MODE_ICON = "https://img.icons8.com/color/48/sun--v1.png";

let menuPrinters = [];
let menuOptions = {};

/**
 * Renders the menu bar and loads the printer list into it.
 *
 * @param {object} options
 * @param {function(object): boolean} [options.onPrinterSelect] - called with the
 *   picked printer. Return true when the page switched to it itself; anything
 *   else navigates to the dashboard.
 * @param {function(object[]): void} [options.onPrinters] - called with the
 *   printer list after every load, so a page can react to an empty list or to a
 *   printer that was added elsewhere.
 * @returns {Promise<object[]>} the loaded printer list
 */
function initMenubar(options = {}) {
    menuOptions = options;
    renderMenubar();
    setupDarkMode();
    return refreshMenubarPrinters();
}

function renderMenubar() {
    const root = document.getElementById("menu-root");
    if (!root) return;

    root.innerHTML = `
        <div class="dropdown">
            <button class="dropdown-button" type="button">Menu</button>
            <div class="dropdown-content">
                <a href="index.html">Dashboard</a>
                <div class="submenu">
                    <span class="submenu-label">Printers</span>
                    <div class="submenu-content" id="menu-printers"></div>
                </div>
                <a href="settings.html">Settings</a>
                <div class="submenu">
                    <span class="submenu-label">Logs</span>
                    <div class="submenu-content">
                        <a href="#" id="menu-printer-logs">Printer Logs</a>
                        <a href="#" id="menu-server-logs">Server Logs</a>
                    </div>
                </div>
            </div>
        </div>`;

    document.getElementById("menu-server-logs").onclick = event => {
        event.preventDefault();
        window.location.href = "logs.html?name=server";
    };

    document.getElementById("menu-printer-logs").onclick = event => {
        event.preventDefault();
        const printer = currentMenuPrinter();
        if (!printer) return;
        window.location.href = `logs.html?serial=${encodeURIComponent(printer.id)}&name=${encodeURIComponent(printer.name)}`;
    };
}

/** Reloads the printer list and rebuilds the entries that depend on it. */
async function refreshMenubarPrinters() {
    try {
        const response = await fetch("./api/printers");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        menuPrinters = await response.json();
    } catch (error) {
        console.error("Could not load the printers for the menu:", error);
        menuPrinters = [];
    }

    renderPrinterEntries();
    menuOptions.onPrinters?.(menuPrinters);
    return menuPrinters;
}

function renderPrinterEntries() {
    const list = document.getElementById("menu-printers");
    if (!list) return;

    list.innerHTML = "";

    if (!menuPrinters.length) {
        const empty = document.createElement("span");
        empty.className = "submenu-empty";
        empty.textContent = "None configured";
        list.appendChild(empty);
    }

    for (const printer of menuPrinters) {
        const entry = document.createElement("a");
        entry.textContent = printer.name;
        entry.href = "#";
        entry.onclick = event => {
            event.preventDefault();
            selectMenuPrinter(printer);
        };
        list.appendChild(entry);
    }

    // Without a printer there is no printer log to open.
    const printerLogs = document.getElementById("menu-printer-logs");
    if (printerLogs) printerLogs.style.display = menuPrinters.length ? "" : "none";
}

/**
 * Remembers the pick and hands it to the page. A page that does not handle it
 * itself, the log viewer and the settings page, goes to the dashboard, which
 * then opens the remembered printer.
 */
function selectMenuPrinter(printer) {
    sessionStorage.setItem("lastSelectedPrinterId", printer.id);

    if (menuOptions.onPrinterSelect?.(printer) === true) return;
    window.location.href = "index.html";
}

/** The printer the log entry refers to: the last picked one, else the first. */
function currentMenuPrinter() {
    const lastId = sessionStorage.getItem("lastSelectedPrinterId");
    return menuPrinters.find(printer => printer.id === lastId) ?? menuPrinters[0] ?? null;
}

function setupDarkMode() {
    const body = document.body;
    const toggleButton = document.getElementById("dark-mode-toggle");
    const icon = document.getElementById("dark-mode-icon");
    if (!toggleButton || !icon) return;

    if (localStorage.getItem("dark-mode") === "true") {
        body.classList.add("dark-mode");
        icon.src = DARK_MODE_ICON;
    }

    // Added late so the theme does not animate in on every page load.
    setTimeout(() => body.classList.add("transition-enabled"), 100);

    toggleButton.addEventListener("click", () => {
        const enabled = body.classList.toggle("dark-mode");
        icon.src = enabled ? DARK_MODE_ICON : LIGHT_MODE_ICON;
        localStorage.setItem("dark-mode", enabled);
    });
}
