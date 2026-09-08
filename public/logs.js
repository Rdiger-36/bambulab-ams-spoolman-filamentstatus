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
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  const printerSerial = getQueryParam("serial");
  const name = getQueryParam("name");
  const isServer = name === "server";

  if (!isServer && !printerSerial) {
    logContainer.innerHTML = '<p>Error: No printer serial provided in the URL.</p>';
    return;
  }

  // The raw MQTT trace of a printer: a file of its own next to the log, so it
  // is the same page against a different stream rather than a page of its own.
  // The switch changes it in place and writes it into the address, so a link
  // to a trace still opens the trace.
  let stream = !isServer && getQueryParam("stream") === "mqtt" ? "mqtt" : "log";

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
    return stream === "mqtt" ? "Raw MQTT trace" : "Log";
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

    titleEl.textContent = isServer ? "Server log" : `${name} · ${streamLabel()}`;
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

  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const downloadUrl = isServer
        ? `./api/logs/server/download`
        : `./api/logs/${encodeURIComponent(printerSerial)}/download${stream === "mqtt" ? "?stream=mqtt" : ""}`;

      // A log carries every address and serial the service has seen, and these
      // files end up attached to bug reports, so the choice is asked rather
      // than assumed. A trace carries more than a log does: it is every field
      // the printer reports, so the same choice matters more here.
      downloadWithExportMode({
        url: downloadUrl,
        title: stream === "mqtt" ? "Download the raw MQTT trace" : "Download the log",
        what: isServer
          ? "The server log, including its rotated history."
          : stream === "mqtt"
            ? `Every MQTT report captured from ${name}, including the rotated history.`
            : `The log of ${name}, including its rotated history.`,
      });
    });
  }

  // The download hands out a zip as soon as the log has rotated, so the button
  // has to say which of the two it is rather than promising the wrong one.
  function updateDownloadLabel(fileCount) {
    if (!downloadBtn) return;
    const kind = stream === "mqtt" ? "trace" : "log";
    if (fileCount === null) {
      downloadBtn.textContent = "Download...";
      downloadBtn.disabled = true;
      return;
    }
    downloadBtn.disabled = fileCount === 0;
    downloadBtn.textContent = fileCount > 1
      ? `Download all ${fileCount} ${kind} files...`
      : `Download this ${kind} file...`;
  }

  /** 41 MB, 1.3 MB, 120 KB: the size of a file set, as a download dialog says it. */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    if (mb < 10) return `${mb.toFixed(1)} MB`;
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  /**
   * The line next to the download: what the box shows and what the download
   * would carry. A trace says how many reports are on screen, because fifty is
   * few and a reader looking for one report expects to scroll further than
   * that; the log shows enough that nobody counts.
   */
  function describe(answer) {
    const parts = [];
    if (stream === "mqtt" && answer.capturing === false) parts.push("capture disabled");
    if (stream === "mqtt") parts.push(`last ${limitFor(stream)} reports`);
    parts.push(`refreshes every ${REFRESH_MS / 1000} s`);

    const files = answer.files ?? 1;
    if (files === 0) parts.push("no file yet");
    else if (typeof answer.bytes === "number") parts.push(`${files} ${files === 1 ? "file" : "files"}, ${formatBytes(answer.bytes)}`);
    else parts.push(`${files} ${files === 1 ? "file" : "files"}`);
    return parts.join(" · ");
  }

  /** What the box says when there is nothing to show, and why. */
  function emptyMessage(answer) {
    if (stream === "mqtt" && answer.capturing === false) {
      return "Raw MQTT capture is disabled for this printer. Enable it under Settings › Printers › Log.";
    }
    if (stream === "mqtt") return "No reports captured yet.";
    return "No log files found.";
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
        logContainer.innerHTML = `<p>${emptyMessage(logData)}</p>`;
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
      logContainer.innerHTML = "<p>Error loading logs. Please try again later.</p>";
    }
  }

  renderStream();
  loadLogs(); // Initial load
  setInterval(loadLogs, REFRESH_MS); // Reload logs every 5 seconds
});
