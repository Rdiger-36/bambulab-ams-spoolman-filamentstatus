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
            <button class="dropdown-button" type="button" aria-haspopup="true" aria-expanded="false">Menu</button>
            <div class="dropdown-content">
                <a href="index.html">Dashboard</a>
                <div class="submenu">
                    <button type="button" class="submenu-label" aria-haspopup="true" aria-expanded="false">Printers</button>
                    <div class="submenu-content" id="menu-printers"></div>
                </div>
                <a href="settings.html">Settings</a>
                <div class="submenu">
                    <button type="button" class="submenu-label" aria-haspopup="true" aria-expanded="false">Logs</button>
                    <div class="submenu-content">
                        <a href="#" id="menu-printer-logs">Printer Logs</a>
                        <a href="#" id="menu-server-logs">Server Logs</a>
                    </div>
                </div>
            </div>
        </div>`;

    setupMenuToggles(root);

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

/**
 * Makes the menu work by click as well as by hover.
 *
 * Hover alone leaves the menu unusable on a touch screen, and it is easy to
 * lose on the way to a submenu. A click opens and closes an entry, and the menu
 * closes again on the next click outside it or on Escape.
 *
 * @param {HTMLElement} root - the container the menu was rendered into
 */
function setupMenuToggles(root) {
    const dropdown = root.querySelector(".dropdown");
    const button = root.querySelector(".dropdown-button");

    button.addEventListener("click", event => {
        event.stopPropagation();
        setOpen(dropdown, button, !dropdown.classList.contains("open"));
        if (!dropdown.classList.contains("open")) closeSubmenus(root);
    });

    // Opens the menu and steps into it, the usual behaviour of a menu button
    button.addEventListener("keydown", event => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(dropdown, button, true);
        root.querySelector(".dropdown-content a, .dropdown-content .submenu-label")?.focus();
    });

    for (const label of root.querySelectorAll(".submenu-label")) {
        label.addEventListener("click", event => {
            event.stopPropagation();
            const submenu = label.parentElement;
            const wasOpen = submenu.classList.contains("open");
            closeSubmenus(root);
            setOpen(submenu, label, !wasOpen);
        });
    }

    // A pick inside the menu closes it, so it does not stay open over the page
    // that was just navigated to or switched in place.
    root.addEventListener("click", event => {
        if (event.target.closest("a")) closeMenu(root);
    });

    document.addEventListener("click", event => {
        if (!event.target.closest("#menu-root")) closeMenu(root);
    });

    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        // Only take the focus back when it is inside the menu, so Escape in a
        // dialog is not answered by the menu bar.
        const inside = root.contains(document.activeElement);
        closeMenu(root);
        if (inside) button.focus();
    });
}

/** Opens or closes one menu level and keeps its control's aria state in sync. */
function setOpen(container, control, open) {
    container.classList.toggle("open", open);
    control.setAttribute("aria-expanded", String(open));
}

function closeSubmenus(root) {
    for (const submenu of root.querySelectorAll(".submenu")) {
        setOpen(submenu, submenu.querySelector(".submenu-label"), false);
    }
}

function closeMenu(root) {
    const dropdown = root.querySelector(".dropdown");
    if (dropdown) setOpen(dropdown, dropdown.querySelector(".dropdown-button"), false);
    closeSubmenus(root);
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
