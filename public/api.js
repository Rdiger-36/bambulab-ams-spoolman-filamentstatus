// The API page: every route of this service, opened into a form that sends the
// request from here and shows the answer.
//
// Nothing on this page knows a route by name. It reads /api/openapi.json, the
// document src/openapi.js builds, and renders whatever is in it: the groups,
// the parameters, an example body, the shapes of the answers. A new route only
// has to be described there and it appears here, which is also what keeps the
// page from drifting behind the API the way a hand written list would.
//
// Dependency free like the rest of public/. Swagger UI would have done the
// same job, but it is a megabyte of somebody else's code for a page that has
// to work on an installation without internet access, and the look would have
// been nothing like the three pages next to it.

import { escapeHtml } from "./ui.js";

/** Where the key typed into the field is kept, so it survives a reload. */
const KEY_STORAGE = "apiExplorerKey";

/** How many events the stream view keeps on screen. */
const MAX_EVENTS = 50;

/** The longest answer that is rendered in full, in characters. */
const MAX_BODY_CHARS = 200_000;

/** The document, once loaded. */
let spec = null;

/** The printers of this installation, to prefill a serial number with. */
let printers = [];

document.addEventListener("DOMContentLoaded", async () => {
    initMenubar({ onPrinters: list => { printers = list; } });
    restoreKey();

    document.getElementById("api-key").addEventListener("input", event => {
        try {
            sessionStorage.setItem(KEY_STORAGE, event.target.value);
        } catch { /* Storage blocked: the key lives for this page load only. */ }
        refreshAllCurl();
    });
    document.getElementById("api-filter").addEventListener("input", event => applyFilter(event.target.value));
    document.getElementById("api-expand").addEventListener("click", () => setAllOpen(true));
    document.getElementById("api-collapse").addEventListener("click", () => setAllOpen(false));

    try {
        const response = await fetch("./api/openapi.json");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        spec = await response.json();
    } catch (err) {
        document.getElementById("api-groups").innerHTML =
            `<p class="set-error">Could not load the API description: ${escapeHtml(err.message)}</p>`;
        return;
    }

    // The menu loads the printers on its own; waiting for it here is what lets
    // the first form already carry a real serial number.
    if (!printers.length) {
        try {
            printers = await (await fetch("./api/printers")).json();
        } catch { /* Nothing to prefill with, the example serial stays. */ }
    }

    render();
    openFromHash();
});

/** Puts the key back into the field after a reload. */
function restoreKey() {
    try {
        const stored = sessionStorage.getItem(KEY_STORAGE);
        if (stored) document.getElementById("api-key").value = stored;
    } catch { /* Storage blocked. */ }
}

/** The key as typed, or an empty string. */
function currentKey() {
    return document.getElementById("api-key").value.trim();
}

/* ---- Rendering the document ---- */

/** Renders the head, the introduction and one card per group. */
function render() {
    document.getElementById("api-version").textContent =
        `Version ${spec.info.version}. The same description as OpenAPI 3.0 imports into Swagger UI, Postman or a client generator.`;
    document.getElementById("api-description").innerHTML = markdown(spec.info.description || "");

    const groups = document.getElementById("api-groups");
    groups.innerHTML = "";

    for (const tag of groupsInOrder()) {
        const card = document.createElement("div");
        card.className = "set-card api-group";
        card.innerHTML = `
            <div class="set-card-head">
                <h2>${escapeHtml(tag.name)}</h2>
                <span class="api-group-note">${markdown(tag.description || "")}</span>
            </div>`;

        for (const operation of operationsOf(tag.name)) {
            card.appendChild(renderOperation(operation));
        }

        groups.appendChild(card);
    }
}

/**
 * The tags in the order the document lists them, plus any tag an operation
 * carries that the list forgot, so nothing is silently left off the page.
 */
function groupsInOrder() {
    const listed = spec.tags || [];
    const known = new Set(listed.map(tag => tag.name));
    const extra = [];
    for (const operation of allOperations()) {
        const name = operation.op.tags?.[0] || "Other";
        if (!known.has(name)) {
            known.add(name);
            extra.push({ name, description: "" });
        }
    }
    return [...listed, ...extra];
}

/** Every operation of the document, as `{ method, path, op }`. */
function allOperations() {
    const list = [];
    for (const [path, methods] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(methods)) {
            list.push({ method: method.toUpperCase(), path, op });
        }
    }
    return list;
}

function operationsOf(tagName) {
    return allOperations().filter(entry => (entry.op.tags?.[0] || "Other") === tagName);
}

/** The element id of one operation, which is also its deep link. */
function operationId(method, path) {
    return `${method.toLowerCase()}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
}

/**
 * One route, folded to its method, path and summary, opening into the form,
 * the curl line, the answer and the documented shapes.
 */
function renderOperation({ method, path, op }) {
    const id = operationId(method, path);
    const details = document.createElement("details");
    details.className = "api-op";
    details.id = id;
    details.dataset.search = `${method} ${path} ${op.summary || ""} ${op.description || ""}`.toLowerCase();

    const badges = [];
    if (op["x-public"]) badges.push(`<span class="pill api-pill">no key needed</span>`);
    if (op["x-stream"]) badges.push(`<span class="pill api-pill">stream</span>`);
    if (op["x-download"]) badges.push(`<span class="pill api-pill">download</span>`);

    details.innerHTML = `
        <summary class="api-op-head">
            <span class="api-method api-method-${method.toLowerCase()}">${method}</span>
            <code class="api-path">${escapeHtml(path)}</code>
            <span class="api-summary">${escapeHtml(op.summary || "")}</span>
            ${badges.join("")}
            <a class="api-anchor" href="#${id}" title="Link to this route" aria-label="Link to this route">#</a>
        </summary>
        <div class="api-op-body">
            ${op.description ? `<div class="api-desc">${markdown(op.description)}</div>` : ""}
            <form class="api-form" autocomplete="off"></form>
            <details class="api-curl">
                <summary>curl</summary>
                <pre class="api-pre"></pre>
            </details>
            <div class="api-response" hidden></div>
            <details class="api-schemas">
                <summary>Request and response shapes</summary>
                <div class="api-schemas-body"></div>
            </details>
        </div>`;

    const form = details.querySelector(".api-form");
    renderForm(form, { method, path, op });
    details.querySelector(".api-schemas-body").innerHTML = renderShapes(op);

    form.addEventListener("input", () => refreshCurl(details, { method, path, op }));
    form.addEventListener("submit", event => {
        event.preventDefault();
        send(details, { method, path, op });
    });
    details.addEventListener("toggle", () => {
        if (details.open) refreshCurl(details, { method, path, op });
    });

    return details;
}

/**
 * The parameters and the body of one operation as inputs.
 *
 * A path parameter is prefilled with a real serial number where the page knows
 * one, otherwise with the example the document carries, so the first click
 * sends something that exists rather than a placeholder.
 */
function renderForm(form, { method, path, op }) {
    const params = op.parameters || [];
    const pathParams = params.filter(param => param.in === "path");
    const queryParams = params.filter(param => param.in === "query");
    const parts = [];

    if (pathParams.length) parts.push(`<h4 class="api-h4">Path</h4><div class="api-fields">${pathParams.map(renderParam).join("")}</div>`);
    if (queryParams.length) parts.push(`<h4 class="api-h4">Query</h4><div class="api-fields">${queryParams.map(renderParam).join("")}</div>`);

    if (op.requestBody) {
        const media = op.requestBody.content?.["application/json"];
        const example = media?.example ?? exampleFor(media?.schema);
        const optional = op.requestBody.required === false;
        parts.push(`
            <h4 class="api-h4">Body <span class="api-muted">JSON${optional ? ", optional" : ""}</span></h4>
            <textarea class="api-body set-mono" name="body" rows="${Math.min(14, Math.max(3, JSON.stringify(example, null, 2).split("\n").length))}" spellcheck="false">${escapeHtml(optional && isEmptyObject(example) ? "" : JSON.stringify(example, null, 2))}</textarea>`);
    }

    let action;
    if (op["x-download"]) {
        action = `<button class="btn btn-primary" type="submit">Open download</button><span class="api-muted">Opens in a new tab and saves the file.</span>`;
    } else if (op["x-stream"]) {
        action = `<button class="btn btn-primary" type="submit">Connect</button><button class="btn api-stop" type="button" hidden>Disconnect</button><span class="api-muted">Shows the events as they arrive.</span>`;
    } else {
        action = `<button class="btn ${method === "DELETE" ? "btn-danger" : "btn-primary"}" type="submit">Send</button>`;
        if (op["x-confirm"]) action += `<span class="api-muted api-warn">Asks before it sends: ${escapeHtml(op["x-confirm"])}</span>`;
    }

    parts.push(`<div class="api-actions">${action}<span class="api-form-error set-error"></span></div>`);
    form.innerHTML = parts.join("");
}

/** One parameter as a labelled input, a select for an enum or a boolean. */
function renderParam(param) {
    const schema = param.schema || {};
    const name = `${param.in}:${param.name}`;
    const value = prefill(param);
    const required = param.required ? " required" : "";
    const label = `<span class="set-field-label"><span>${escapeHtml(param.name)}${param.required ? "" : ' <span class="api-muted">optional</span>'}</span></span>`;

    let input;
    if (schema.type === "boolean") {
        input = `<select name="${escapeHtml(name)}"${required}>
            <option value=""${value === "" ? " selected" : ""}>${param.required ? "" : "(default)"}</option>
            <option value="true"${value === "true" ? " selected" : ""}>true</option>
            <option value="false"${value === "false" ? " selected" : ""}>false</option>
        </select>`;
    } else if (schema.enum) {
        const blank = param.required ? "" : `<option value="">(none)</option>`;
        input = `<select name="${escapeHtml(name)}"${required}>${blank}${schema.enum.map(option =>
            `<option value="${escapeHtml(option)}"${String(option) === value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
    } else {
        input = `<input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${required} placeholder="${escapeHtml(schema.example ?? schema.default ?? "")}">`;
    }

    return `<label class="set-field">${label}${input}${param.description ? `<small>${markdown(param.description)}</small>` : ""}</label>`;
}

/** What a parameter input starts with. */
function prefill(param) {
    if (param.name === "printerId" && printers.length) return printers[0].id;
    if (param.in !== "path") return "";
    const schema = param.schema || {};
    return String(schema.example ?? schema.default ?? schema.enum?.[0] ?? "");
}

/* ---- Building the request ---- */

/**
 * The URL and the request options one form describes, or an error message.
 *
 * Relative to the page, like every other request the Web UI makes, so an
 * installation served under a path keeps working.
 */
function buildRequest(details, { method, path, op }) {
    const form = details.querySelector(".api-form");
    const data = new FormData(form);

    let url = path;
    for (const param of (op.parameters || []).filter(entry => entry.in === "path")) {
        const value = String(data.get(`path:${param.name}`) ?? "").trim();
        if (!value) return { error: `${param.name} is required` };
        url = url.replace(`{${param.name}}`, encodeURIComponent(value));
    }

    const query = new URLSearchParams();
    for (const param of (op.parameters || []).filter(entry => entry.in === "query")) {
        const value = String(data.get(`query:${param.name}`) ?? "").trim();
        if (value) query.set(param.name, value);
    }
    const suffix = query.toString();
    if (suffix) url += `?${suffix}`;

    const options = { method, headers: {} };
    if (op.requestBody) {
        const raw = String(data.get("body") ?? "").trim();
        if (raw) {
            try {
                // Parsed and written back, so what is sent is the JSON the
                // textarea holds and not a string with a typo in it.
                options.body = JSON.stringify(JSON.parse(raw));
                options.headers["Content-Type"] = "application/json";
            } catch (err) {
                return { error: `The body is not valid JSON: ${err.message}` };
            }
        } else if (op.requestBody.required !== false) {
            return { error: "This request needs a body" };
        }
    }

    return { url: `.${url}`, absolute: new URL(`.${url}`, window.location.href).href, options };
}

/** Writes the curl line of one form, or the reason there is none. */
function refreshCurl(details, entry) {
    const pre = details.querySelector(".api-curl .api-pre");
    const built = buildRequest(details, entry);
    if (built.error) {
        pre.textContent = `# ${built.error}`;
        return;
    }

    const parts = ["curl"];
    if (built.options.method !== "GET") parts.push(`-X ${built.options.method}`);
    if (entry.op["x-download"]) parts.push("-OJ");
    if (entry.op["x-stream"]) parts.push("-N");
    parts.push(shellQuote(built.absolute));

    const key = currentKey();
    if (key && !entry.op["x-public"]) parts.push(`-H ${shellQuote(`Authorization: Bearer ${key}`)}`);
    else if (!entry.op["x-public"]) parts.push(`-H ${shellQuote("Authorization: Bearer <your API key>")}`);

    if (built.options.body) {
        parts.push(`-H ${shellQuote("Content-Type: application/json")}`);
        parts.push(`-d ${shellQuote(built.options.body)}`);
    }

    pre.textContent = parts.join(" \\\n  ");
}

function refreshAllCurl() {
    for (const details of document.querySelectorAll(".api-op[open]")) {
        const method = details.querySelector(".api-method").textContent;
        const path = details.querySelector(".api-path").textContent;
        refreshCurl(details, { method, path, op: spec.paths[path][method.toLowerCase()] });
    }
}

/** Quotes a value for a POSIX shell. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/* ---- Sending ---- */

/**
 * Sends the request of one form and shows what came back.
 *
 * Three kinds of route are sent differently: a download opens in a new tab so
 * the browser saves the file, a stream is followed with an EventSource, and
 * everything else is one fetch whose status, headers and body are shown.
 */
async function send(details, entry) {
    const { op } = entry;
    const error = details.querySelector(".api-form-error");
    error.textContent = "";

    const built = buildRequest(details, entry);
    if (built.error) {
        error.textContent = built.error;
        return;
    }

    if (op["x-download"]) {
        window.open(built.url, "_blank", "noopener");
        return;
    }

    if (op["x-stream"]) {
        followStream(details, built.url);
        return;
    }

    if (op["x-confirm"] && !window.confirm(`${op["x-confirm"]}\n\nSend the request anyway?`)) return;

    const button = details.querySelector(".api-actions button[type=submit]");
    button.disabled = true;
    const started = performance.now();

    try {
        const response = await fetch(built.url, built.options);
        const text = await response.text();
        showResponse(details, {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            ms: Math.round(performance.now() - started),
            headers: [...response.headers.entries()],
            text,
        });
    } catch (err) {
        showResponse(details, { failed: err.message, ms: Math.round(performance.now() - started) });
    } finally {
        button.disabled = false;
    }
}

/** Renders one answer under its form. */
function showResponse(details, result) {
    const box = details.querySelector(".api-response");
    box.hidden = false;

    if (result.failed) {
        box.innerHTML = `
            <div class="api-response-head">
                <span class="pill pill-bad">failed</span>
                <span class="api-muted">${escapeHtml(result.failed)} after ${result.ms} ms</span>
            </div>`;
        return;
    }

    let body = result.text;
    let kind = "text";
    try {
        body = JSON.stringify(JSON.parse(result.text), null, 2);
        kind = "json";
    } catch { /* Not JSON: shown as it came. */ }

    const truncated = body.length > MAX_BODY_CHARS;
    if (truncated) body = body.slice(0, MAX_BODY_CHARS);

    const contentType = result.headers.find(([name]) => name === "content-type")?.[1] || "";
    box.innerHTML = `
        <div class="api-response-head">
            <span class="pill ${result.ok ? "pill-ok" : "pill-bad"}">${result.status} ${escapeHtml(result.statusText)}</span>
            <span class="api-muted">${result.ms} ms${contentType ? `, ${escapeHtml(contentType)}` : ""}${truncated ? ", cut off after 200 000 characters" : ""}</span>
            <button class="btn btn-small api-copy" type="button">Copy</button>
        </div>
        <details class="api-headers">
            <summary>Headers</summary>
            <pre class="api-pre">${escapeHtml(result.headers.map(([name, value]) => `${name}: ${value}`).join("\n"))}</pre>
        </details>
        <pre class="api-pre api-response-body api-${kind}">${escapeHtml(body) || '<span class="api-muted">(empty)</span>'}</pre>`;

    box.querySelector(".api-copy").addEventListener("click", async event => {
        try {
            await navigator.clipboard.writeText(body);
            event.target.textContent = "Copied";
        } catch {
            event.target.textContent = "Select and press Ctrl+C";
        }
    });
}

/**
 * Follows the event stream and lists the events as they arrive, newest last,
 * until the stop button closes it or the page is left.
 */
function followStream(details, url) {
    const box = details.querySelector(".api-response");
    const connect = details.querySelector(".api-actions button[type=submit]");
    const stop = details.querySelector(".api-stop");

    box.hidden = false;
    box.innerHTML = `
        <div class="api-response-head">
            <span class="pill pill-ok">connected</span>
            <span class="api-muted api-stream-count">waiting for the first event</span>
        </div>
        <pre class="api-pre api-response-body api-json api-stream"></pre>`;

    const output = box.querySelector(".api-stream");
    const count = box.querySelector(".api-stream-count");
    const lines = [];
    let received = 0;

    const source = new EventSource(url);
    source.onmessage = event => {
        received += 1;
        let text = event.data;
        try {
            text = JSON.stringify(JSON.parse(event.data));
        } catch { /* Shown as it came. */ }
        lines.push(`${new Date().toLocaleTimeString()}  ${text}`);
        if (lines.length > MAX_EVENTS) lines.shift();
        output.textContent = lines.join("\n");
        count.textContent = `${received} event${received === 1 ? "" : "s"}, the last ${Math.min(received, MAX_EVENTS)} shown`;
        output.scrollTop = output.scrollHeight;
    };
    source.onerror = () => {
        box.querySelector(".pill").className = "pill pill-bad";
        box.querySelector(".pill").textContent = "reconnecting";
    };

    const end = () => {
        source.close();
        box.querySelector(".pill").className = "pill";
        box.querySelector(".pill").textContent = "disconnected";
        stop.hidden = true;
        connect.hidden = false;
        window.removeEventListener("pagehide", end);
    };

    connect.hidden = true;
    stop.hidden = false;
    stop.onclick = end;
    window.addEventListener("pagehide", end);
}

/* ---- The documented shapes ---- */

/** The request body and every response of one operation as schema trees. */
function renderShapes(op) {
    const parts = [];

    const requestSchema = op.requestBody?.content?.["application/json"]?.schema;
    if (requestSchema) {
        parts.push(`<h4 class="api-h4">Request body</h4>${renderSchema(requestSchema)}`);
    }

    for (const [status, response] of Object.entries(op.responses || {})) {
        const [type, media] = Object.entries(response.content || {})[0] || [];
        const pillClass = status.startsWith("2") ? "pill-ok" : "pill-bad";
        parts.push(`
            <h4 class="api-h4"><span class="pill ${pillClass}">${escapeHtml(status)}</span> <span class="api-h4-text">${markdown(response.description || "")}</span>${type ? ` <span class="api-muted">${escapeHtml(type)}</span>` : ""}</h4>
            ${media?.schema ? renderSchema(media.schema) : ""}`);
    }

    return parts.join("");
}

/**
 * A schema as a nested list: the type, what it means, and its fields.
 *
 * References are followed so a shape reads in place rather than as a name to
 * look up elsewhere; a reference met twice on the same branch is shown by name
 * to stop a cycle.
 */
function renderSchema(schema, seen = new Set()) {
    if (!schema) return "";

    if (schema.$ref) {
        const name = schema.$ref.split("/").pop();
        if (seen.has(name)) return `<span class="api-type">${escapeHtml(name)}</span>`;
        const resolved = spec.components?.schemas?.[name];
        if (!resolved) return `<span class="api-type">${escapeHtml(name)}</span>`;
        return `<span class="api-type-name">${escapeHtml(name)}</span> ${renderSchema(resolved, new Set([...seen, name]))}`;
    }

    if (schema.oneOf || schema.allOf) {
        const list = schema.oneOf || schema.allOf;
        const word = schema.oneOf ? "one of" : "all of";
        return `<span class="api-muted">${word}</span><ul class="api-tree">${list.map(item => `<li>${renderSchema(item, seen)}</li>`).join("")}</ul>`;
    }

    const type = typeLabel(schema);
    const note = schema.description ? ` <span class="api-field-desc">${markdown(schema.description)}</span>` : "";
    const enumNote = schema.enum ? ` <span class="api-muted">${schema.enum.map(value => `<code>${escapeHtml(JSON.stringify(value))}</code>`).join(" ")}</span>` : "";

    if (schema.type === "object" && schema.properties && Object.keys(schema.properties).length) {
        const required = new Set(schema.required || []);
        const rows = Object.entries(schema.properties).map(([name, property]) => `
            <li>
                <code class="api-field${required.has(name) ? " api-required" : ""}">${escapeHtml(name)}</code>
                ${renderSchema(property, seen)}
            </li>`).join("");
        const extra = schema.additionalProperties && typeof schema.additionalProperties === "object"
            ? `<li><code class="api-field">*</code> ${renderSchema(schema.additionalProperties, seen)}</li>`
            : "";
        return `<span class="api-type">${type}</span>${note}<ul class="api-tree">${rows}${extra}</ul>`;
    }

    if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `<span class="api-type">${type}</span>${note}<ul class="api-tree"><li><code class="api-field">*</code> ${renderSchema(schema.additionalProperties, seen)}</li></ul>`;
    }

    if (schema.type === "array" && schema.items && (schema.items.$ref || schema.items.properties || schema.items.oneOf)) {
        return `<span class="api-type">${type}</span>${note}<ul class="api-tree"><li>${renderSchema(schema.items, seen)}</li></ul>`;
    }

    return `<span class="api-type">${type}</span>${enumNote}${note}`;
}

/** The type of a schema as a word: `string`, `integer[]`, `object` and so on. */
function typeLabel(schema) {
    let label = schema.type || (schema.$ref ? schema.$ref.split("/").pop() : "any");
    if (schema.type === "array") {
        const items = schema.items || {};
        label = `${items.$ref ? items.$ref.split("/").pop() : (items.type || "any")}[]`;
    }
    if (schema.format) label += ` (${schema.format})`;
    if (schema.nullable) label += ", null";
    if (schema.minimum !== undefined || schema.maximum !== undefined) {
        label += ` ${schema.minimum ?? ""}..${schema.maximum ?? ""}`;
    }
    if (schema.default !== undefined) label += `, default ${JSON.stringify(schema.default)}`;
    return escapeHtml(label);
}

/**
 * A body to start from, built from the schema when the document carries no
 * example: every field with an empty value of its type, so the names are there
 * and only the values have to be typed.
 */
function exampleFor(schema, seen = new Set()) {
    if (!schema) return {};
    if (schema.example !== undefined) return schema.example;

    if (schema.$ref) {
        const name = schema.$ref.split("/").pop();
        if (seen.has(name)) return null;
        return exampleFor(spec.components?.schemas?.[name], new Set([...seen, name]));
    }
    if (schema.oneOf) return exampleFor(schema.oneOf[0], seen);
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map(item => exampleFor(item, seen)));

    switch (schema.type) {
        case "object": {
            const out = {};
            for (const [name, property] of Object.entries(schema.properties || {})) {
                out[name] = exampleFor(property, seen);
            }
            return out;
        }
        case "array":
            return [];
        case "string":
            return schema.default ?? schema.enum?.[0] ?? "";
        case "integer":
        case "number":
            return schema.default ?? schema.minimum ?? 0;
        case "boolean":
            return schema.default ?? false;
        default:
            return null;
    }
}

function isEmptyObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

/* ---- Page behaviour ---- */

/** Hides every route the term does not appear in, and every group left empty. */
function applyFilter(term) {
    const needle = term.trim().toLowerCase();
    for (const group of document.querySelectorAll(".api-group")) {
        let visible = 0;
        for (const details of group.querySelectorAll(".api-op")) {
            const hit = !needle || details.dataset.search.includes(needle);
            details.hidden = !hit;
            if (hit) visible += 1;
        }
        group.hidden = visible === 0;
    }
}

function setAllOpen(open) {
    for (const details of document.querySelectorAll(".api-op")) {
        if (!details.hidden) details.open = open;
    }
}

/** Opens the route a link points at and scrolls to it. */
function openFromHash() {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const details = document.getElementById(id);
    if (!details?.classList.contains("api-op")) return;
    details.open = true;
    details.scrollIntoView({ block: "start" });
}

/**
 * The little markdown the document uses, turned into markup: paragraphs,
 * bold, italics and code. Everything is escaped first, so the text can say
 * `<key>` and mean the angle brackets.
 */
function markdown(text) {
    const paragraphs = escapeHtml(text).split(/\n\s*\n/);
    return paragraphs.map(paragraph => paragraph
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\n/g, " "))
        .map(paragraph => paragraphs.length > 1 ? `<p>${paragraph}</p>` : paragraph)
        .join("");
}
