document.addEventListener("DOMContentLoaded", () => {
  const toggleButton = document.getElementById("dark-mode-toggle");
  const body = document.body;
  const darkModeIcon = document.getElementById("dark-mode-icon");
  const logContainer = document.getElementById("logs");
  const logBox = document.getElementById("log-box");
  let logAPI;
  let userScrolling = false; // Variable to detect manual scrolling

  const lightModeIcon = "https://img.icons8.com/ios-glyphs/30/moon-symbol.png";
  const darkModeIconUrl = "https://img.icons8.com/color/48/sun--v1.png";

  // Dark Mode Toggle
  const darkModeEnabled = localStorage.getItem("dark-mode") === "true";
  if (darkModeEnabled) {
    body.classList.add("dark-mode");
    darkModeIcon.src = darkModeIconUrl;
  }

  toggleButton.addEventListener("click", () => {
    const isDarkMode = body.classList.toggle("dark-mode");
    darkModeIcon.src = isDarkMode ? darkModeIconUrl : lightModeIcon;
    localStorage.setItem("dark-mode", isDarkMode);
  });

  // Query parameters
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  const printerSerial = getQueryParam("serial");
  const name = getQueryParam("name");

  if (name === "server") {
    document.getElementById("headline").textContent = "Server";
    logAPI = `./api/logs/server?limit=250`;
  } else if (printerSerial) {
    document.getElementById("headline").textContent = `${name} - ${printerSerial}`;
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
      window.location.href = downloadUrl;
    });
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