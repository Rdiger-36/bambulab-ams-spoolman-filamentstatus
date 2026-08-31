// Shared mutable runtime state accessed by multiple modules
export const state = {
    spoolmanStatus: "Disconnected",
    vendorID: null,
    clients: [],       // SSE client connections
    // Last known Spoolman spool list for change detection. null means "not yet
    // seeded". Deliberately not [], which is a legitimate value for an empty
    // Spoolman and must still be comparable against the next fetch.
    lastSpoolData: null,
    // Startup bookkeeping. The monitor loops must be started exactly once, and
    // the Spoolman bootstrap must not run twice in parallel when the endpoint is
    // changed repeatedly in the Web UI.
    monitorsRunning: false,
    spoolmanBootstrapRunning: false,
};
