/**
 * The handful of helpers every page in this UI needs.
 *
 * Unlike `shared.js` next to it, nothing here is a decision the server also
 * makes: these are the two things a page does with the API and with a string
 * before it puts it into the document. They lived once in `frontend.js` and
 * once in `settings.js`, character for character the same in the first case and
 * one error field apart in the second.
 *
 * Loaded unbuilt like everything under `public/`, so no Node built-ins and no
 * dependencies.
 */

/**
 * Fetches JSON and turns a failed request into an exception carrying what the
 * server said.
 *
 * The API answers a failure with `{ ok: false, error }`, so the message is read
 * out of the body rather than from the status code. `conflict` and
 * `printInFlight` are carried onto the error because the settings page and the
 * spool dialog offer to force what was refused, and the status alone does not
 * say which of the two it was.
 *
 * @param {string} url - the endpoint
 * @param {object} [options] - passed straight to fetch
 * @returns {Promise<object>} the parsed body
 */
async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
        const error = new Error(body.error || `HTTP ${res.status}`);
        error.conflict = !!body.conflict;
        error.printInFlight = !!body.printInFlight;
        throw error;
    }

    return body;
}

/** Sends a JSON body and reads the answer through fetchJson. */
function sendJson(url, method, payload) {
    return fetchJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/**
 * Escapes a value for use in the HTML these pages build as strings.
 *
 * Everything that reaches it comes from Spoolman, from the printer or from the
 * user, so a filament called `<b>` has to stay text.
 */
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { escapeHtml, fetchJson, sendJson };
