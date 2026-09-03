document.addEventListener("DOMContentLoaded", () => {
  const logContainer = document.getElementById("logs");
  const logBox = document.getElementById("log-box");
  let logAPI;
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

  // The headline names the log and is the picker over the others; menu.js
  // fills it once the printer list is there. See renderTitlePicker().
  if (name === "server") {
    logAPI = `./api/logs/server?limit=250`;
  } else if (printerSerial) {
    logAPI = `./api/logs/${printerSerial}?limit=250`;
  } else {
    logContainer.innerHTML = '<p>Error: No printer serial provided in the URL.</p>';
    return;
  }
  
  const downloadBtn = document.getElementById("download-logs");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const downloadUrl = (name === "server")
        ? `./api/logs/server/download`
        : `./api/logs/${printerSerial}/download`;

      // A log carries every address and serial the service has seen, and these
      // files end up attached to bug reports, so the choice is asked rather
      // than assumed.
      downloadWithExportMode({
        url: downloadUrl,
        title: "Download the log",
        what: name === "server"
          ? "The server log, including its rotated history."
          : `The log of ${name}, including its rotated history.`,
      });
    });
  }

  // The download hands out a zip as soon as the log has rotated, so the button
  // has to say which of the two it is rather than promising the wrong one.
  function updateDownloadLabel(fileCount) {
    if (!downloadBtn) return;
    downloadBtn.textContent = fileCount > 1
      ? `Download all ${fileCount} log files...`
      : "Download this log file...";
  }

  // Detect if the user is scrolling manually
  logBox.addEventListener("scroll", () => {
    // Check if the user is not at the bottom
    userScrolling = logBox.scrollTop + logBox.clientHeight < logBox.scrollHeight - 5;
  });

  // Load logs dynamically
  async function loadLogs() {
    try {
      const response = await fetch(logAPI);
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

      const logData = await response.json();
      updateDownloadLabel(logData.files ?? 1);
      if (!logData.logs || logData.logs.length === 0) {
        logContainer.innerHTML = "<p>No log files found.</p>";
        return;
      }

      const isAtBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 5;

      // Update logs without forcing scrolling
      logContainer.innerHTML = logData.logs
        .map((line) => `<p>${line}</p>`)
        .join("");

      // If the user has not manually scrolled or is already at the bottom, auto-scroll down
      if (!userScrolling || isAtBottom) {
        requestAnimationFrame(() => {
          logBox.scrollTop = logBox.scrollHeight;
        });
      }
    } catch (error) {
      console.error("Error loading logs:", error);
      logContainer.innerHTML = "<p>Error loading logs. Please try again later.</p>";
    }
  }

  // Load logs periodically
  loadLogs(); // Initial load
  setInterval(loadLogs, 5000); // Reload logs every 5 seconds
});