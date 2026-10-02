document.addEventListener("DOMContentLoaded", () => {
  const logContainer = document.getElementById("logs");
  const logBox = document.getElementById("log-box");
  const streamField = document.getElementById("log-stream-field");
  const streamButtons = [...document.querySelectorAll("#log-stream button")];
  const titleEl = document.getElementById("log-title");
  const fileEl = document.getElementById("log-file");
  const metaEl = document.getElementById("log-meta");
  const downloadBtn = document.getElementById("download-logs");
  let userScrolling = false; // Variable to detect manual scrolling

  // Menu bar, including the dark mode button
  initMenubar();

  // Query parameters
  const query = new URLSearchParams(window.location.search);
  const printerSerial = query.get("serial");
  const name = query.get("name");
  const isServer = name === "server";

  if (!isServer && !printerSerial) {
    showMessage(t("logs.noSerial"));
    return;
  }

  // The raw MQTT trace of a printer: a file of its own next to the log, so it
  // is the same page against a different stream rather than a page of its own.
  // The switch changes it in place and writes it into the address, so a link
  // to a trace still opens the trace.
  let stream = !isServer && query.get("stream") === "mqtt" ? "mqtt" : "log";

  // A trace line is a whole printer report rather than a sentence, several
  // kilobytes of it, and the page reloads every five seconds. Asking for the
  // same 250 lines would be megabytes over the wire per refresh, for a wall of
  // text nobody reads on screen: the file is what gets downloaded and analysed.
  const limitFor = which => (which === "mqtt" ? 50 : 250);
  const REFRESH_MS = 5000;

  function apiUrl() {
    if (isServer) return `./api/logs/server?limit=${limitFor(stream)}`;
    return `./api/logs/${encodeURIComponent(printerSerial)}?limit=${limitFor(stream)}${stream === "mqtt" ? "&stream=mqtt" : ""}`;
  }

  function streamLabel() {
    return stream === "mqtt" ? t("logs.stream.mqtt") : t("logs.stream.log");
  }

  /** Puts the switch, the address and the title into the state of `stream`. */
  function renderStream() {
    streamField.hidden = isServer;
    for (const button of streamButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.stream === stream));
    }

    const url = new URL(window.location.href);
    if (stream === "mqtt") url.searchParams.set("stream", "mqtt");
    else url.searchParams.delete("stream");
    history.replaceState(null, "", url);

    titleEl.textContent = isServer ? t("logs.serverLog") : `${name} · ${streamLabel()}`;
    fileEl.textContent = "";
    metaEl.textContent = "";
    updateDownloadLabel(null);
  }

  for (const button of streamButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.stream === stream) return;
      stream = button.dataset.stream;
      userScrolling = false;
      renderStream();
      loadLogs();
    });
  }

  /**
   * What the download dialog offers to tick, in the scope words the API
   * takes: the shown file ticked, the printer's other file and the server log
   * unticked; on the server log, the server ticked and every printer's log
   * unticked. The traces of other printers are not offered here, they are
   * what the diagnostics bundle on the settings page is for.
   */
  async function downloadChoices() {
    if (!isServer) {
      return [
        { id: `${printerSerial}/log`, label: t("logs.download.optionLog", { name }), checked: stream === "log" },
        { id: `${printerSerial}/trace`, label: t("logs.download.optionTrace", { name }), checked: stream === "mqtt" },
        { id: "server", label: t("logs.download.optionServer"), checked: false },
      ];
    }
    let list = [];
    try {
      const response = await fetch("./api/printers");
      if (response.ok) list = await response.json();
    } catch {
      // Without the list the dialog offers the server log alone
    }
    return [
      { id: "server", label: t("logs.download.optionServer"), checked: true },
      ...list.map(printer => ({ id: `${printer.id}/log`, label: t("logs.download.optionLog", { name: printer.name }), checked: false })),
    ];
  }

  /**
   * The endpoint for what was ticked: one file keeps the plain download, the
   * file as it is on disk or a zip of its history, several go through the
   * bundle, which is the diagnostics archive without the configuration.
   */
  function downloadUrl(selected) {
    if (selected.length !== 1) return `./api/logs/download?scope=${encodeURIComponent(selected.join(","))}`;
    const [id, file] = selected[0].split("/");
    if (id === "server") return "./api/logs/server/download";
    return `./api/logs/${encodeURIComponent(id)}/download${file === "trace" ? "?stream=mqtt" : ""}`;
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      // A log carries every address and serial the service has seen, and these
      // files end up attached to bug reports, so the choice is asked rather
      // than assumed. A trace carries more than a log does: it is every field
      // the printer reports, so the same choice matters more here.
      downloadWithExportMode({
        url: downloadUrl,
        scopeParam: null,
        title: t("logs.download.title"),
        what: t("logs.download.what"),
        choices: {
          heading: escapeText(t("logs.download.heading")),
          options: (await downloadChoices()).map(option => ({ ...option, label: escapeText(option.label) })),
        },
        // The wider export, with the configuration files, lives on the
        // settings page; said here so nobody looks for it in this dialog.
        note: t("logs.download.diagnosticsHint", {
          link: `<a href="settings.html#system">${escapeText(t("logs.download.diagnosticsLink"))}</a>`,
        }),
      });
    });
  }

  /** export.js puts labels into markup as they are, and a printer name is text. */
  function escapeText(text) {
    return String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
  }

  // The download hands out a zip as soon as the log has rotated, so the button
  // has to say which of the two it is rather than promising the wrong one.
  function updateDownloadLabel(fileCount) {
    if (!downloadBtn) return;
    const kind = stream === "mqtt" ? "Trace" : "Log";
    if (fileCount === null) {
      downloadBtn.textContent = t("logs.download.button");
      downloadBtn.disabled = true;
      return;
    }
    downloadBtn.disabled = fileCount === 0;
    downloadBtn.textContent = fileCount > 1
      ? t(`logs.download.all${kind}`, { count: fileCount })
      : t(`logs.download.one${kind}`);
  }

  /**
   * 41 MB, 1.3 MB, 120 KB: the size of a file set, as a download dialog says it.
   * The decimal separator is the viewer's language's, "1,3 MB" in German.
   */
  function formatBytes(bytes) {
    const oneDecimal = value => value.toLocaleString(window.I18N.language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    if (mb < 10) return `${oneDecimal(mb)} MB`;
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${oneDecimal(mb / 1024)} GB`;
  }

  /**
   * The line next to the download: what the box shows and what the download
   * would carry. A trace says how many reports are on screen, because fifty is
   * few and a reader looking for one report expects to scroll further than
   * that; the log shows enough that nobody counts.
   */
  function describe(answer) {
    const parts = [];
    if (stream === "mqtt" && answer.capturing === false) parts.push(t("logs.meta.captureDisabled"));
    if (stream === "mqtt") parts.push(t("logs.meta.lastReports", { count: limitFor(stream) }));
    parts.push(t("logs.meta.refresh", { seconds: REFRESH_MS / 1000 }));

    const files = answer.files ?? 1;
    if (files === 0) parts.push(t("logs.meta.noFile"));
    else if (typeof answer.bytes === "number") parts.push(`${t("logs.meta.files", { count: files })}, ${formatBytes(answer.bytes)}`);
    else parts.push(t("logs.meta.files", { count: files }));
    return parts.join(" · ");
  }

  /** What the box says when there is nothing to show, and why. */
  function emptyMessage(answer) {
    if (stream === "mqtt" && answer.capturing === false) {
      return t("logs.empty.captureDisabled");
    }
    if (stream === "mqtt") return t("logs.empty.noReports");
    return t("logs.empty.noLogs");
  }

  /** Replaces the box's content with one line of text: an empty or an error state. */
  function showMessage(text) {
    const p = document.createElement("p");
    p.textContent = text;
    logContainer.replaceChildren(p);
  }

  // Detect if the user is scrolling manually
  logBox.addEventListener("scroll", () => {
    // Check if the user is not at the bottom
    userScrolling = logBox.scrollTop + logBox.clientHeight < logBox.scrollHeight - 5;
  });

  // Load logs dynamically
  async function loadLogs() {
    const requested = stream;
    try {
      const response = await fetch(apiUrl());
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

      const logData = await response.json();
      // The stream was switched while this answer was on its way: it describes
      // the file the page no longer shows
      if (requested !== stream) return;

      updateDownloadLabel(logData.files ?? 1);
      metaEl.textContent = describe(logData);
      fileEl.textContent = logData.file ?? "";

      if (!logData.logs || logData.logs.length === 0) {
        showMessage(emptyMessage(logData));
        return;
      }

      const isAtBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 5;

      // Update logs without forcing scrolling
      // A line is text: spool and printer names in it may contain markup
      logContainer.replaceChildren(...logData.logs.map(line => {
        const p = document.createElement("p");
        p.textContent = line;
        return p;
      }));

      // If the user has not manually scrolled or is already at the bottom, auto-scroll down
      if (!userScrolling || isAtBottom) {
        requestAnimationFrame(() => {
          logBox.scrollTop = logBox.scrollHeight;
        });
      }
    } catch (error) {
      if (requested !== stream) return;
      console.error("Error loading logs:", error);
      showMessage(t("logs.loadError"));
    }
  }

  renderStream();
  loadLogs(); // Initial load
  setInterval(loadLogs, REFRESH_MS); // Reload logs every 5 seconds
});
