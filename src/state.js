// Shared mutable runtime state accessed by multiple modules
export const state = {
    spoolmanStatus: "Disconnected",
    vendorID: null,
    clients: [],       // SSE client connections
    lastSpoolData: [], // last known Spoolman spool list for change detection
};
