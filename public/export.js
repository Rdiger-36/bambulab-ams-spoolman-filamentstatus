// Shared export dialog. Every download that can carry the user's network asks
// the same question in the same words, on the log page and on the settings
// page, so that the anonymised variant is a visible choice rather than a
// checkbox somebody has to find.
//
// The dialog is built here instead of being written into both pages, which is
// what keeps the wording from drifting apart between them.

const EXPORT_DIALOG_ID = "export-mode-dialog";

// Kept in one place: this is a promise to the user about what leaves the
// machine, and it has to match what src/anonymize.js actually does.
const ANONYMIZED_NOTE = `
    <ul class="set-list">
        <li>IP addresses lose their last octet, <code>192.168.1.42</code> becomes <code>192.168.1.XXX</code></li>
        <li>Serial numbers keep their first five characters, the rest becomes <code>X</code></li>
        <li>Access codes are replaced entirely</li>
        <li>The Spoolman host name is replaced, the scheme, port and path are kept</li>
    </ul>
    <p class="set-note">Printer names and spool data are kept. They are what makes a log readable, and
       they say nothing about the network. Rename a printer before exporting if its name identifies you.</p>`;

function ensureExportDialog() {
    let dialog = document.getElementById(EXPORT_DIALOG_ID);
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = EXPORT_DIALOG_ID;
    dialog.innerHTML = `
        <h3 id="export-mode-title"></h3>
        <div id="export-mode-text"></div>
        <div class="button-container">
            <button class="btn" type="button" id="export-mode-cancel">Cancel</button>
            <button class="btn" type="button" id="export-mode-full">Full</button>
            <button class="btn btn-primary" type="button" id="export-mode-anon">Anonymised</button>
        </div>`;
    document.body.appendChild(dialog);
    return dialog;
}

/**
 * Asks whether an export should be anonymised or complete.
 *
 * @param {object} options
 * @param {string} options.title - headline of the dialog
 * @param {string} options.what - one sentence naming what is about to be downloaded
 * @returns {Promise<"anonymized"|"full"|null>} null when the user cancelled
 */
function askExportMode({ title, what }) {
    const dialog = ensureExportDialog();

    document.getElementById("export-mode-title").textContent = title;
    document.getElementById("export-mode-text").innerHTML = `
        <p>${what}</p>
        <p><strong>Anonymised</strong> is safe to attach to a bug report:</p>
        ${ANONYMIZED_NOTE}
        <p><strong>Full</strong> hands out everything as it is on disk, except the access codes, which are
           never part of an export. Share it only with someone you trust.</p>`;

    const anon = document.getElementById("export-mode-anon");
    const full = document.getElementById("export-mode-full");
    const cancel = document.getElementById("export-mode-cancel");

    return new Promise(resolve => {
        const finish = result => {
            anon.onclick = null;
            full.onclick = null;
            cancel.onclick = null;
            dialog.close();
            resolve(result);
        };

        anon.onclick = () => finish("anonymized");
        full.onclick = () => finish("full");
        cancel.onclick = () => finish(null);
        dialog.addEventListener("cancel", () => finish(null), { once: true });

        dialog.showModal();
        // The safe choice takes the focus, so Enter cannot hand out the full one
        anon.focus();
    });
}

/**
 * Asks, then starts the download.
 *
 * @param {object} options - passed to askExportMode, plus the URL
 * @param {string} options.url - the download endpoint, without the query
 * @returns {Promise<boolean>} whether a download was started
 */
async function downloadWithExportMode({ url, title, what }) {
    const mode = await askExportMode({ title, what });
    if (!mode) return false;

    const separator = url.includes("?") ? "&" : "?";
    window.location.href = `${url}${separator}anonymize=${mode === "anonymized"}`;
    return true;
}
