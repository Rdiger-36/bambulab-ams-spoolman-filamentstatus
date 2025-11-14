import aiohttp
from homeassistant.components.switch import SwitchEntity
from homeassistant.helpers.entity import DeviceInfo
from .const import DOMAIN


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up switches from a config entry."""
    data = hass.data[DOMAIN][entry.entry_id]

    host = data["host"]
    port = data["port"]
    printers = data["printers"]   # [{"id":..., "name":...}, ...]

    entities = []
    for printer in printers:
        printer_id = printer["id"]
        printer_name = printer["name"]

        entities.append(
            AmsPrinterSwitch(host, port, printer_id, printer_name)
        )

    async_add_entities(entities, update_before_add=True)


class AmsPrinterSwitch(SwitchEntity):
    """Switch to toggle printer monitoring."""

    def __init__(self, host, port, printer_id, printer_name):
        self._host = host
        self._port = port
        self._printer_id = printer_id
        self._printer_name = printer_name

        self._attr_name = f"Bambu AMS Monitoring {printer_name} - {printer_id}"
        self._attr_unique_id = f"ams_monitoring_{printer_id}"
        self._attr_should_poll = True
        self._attr_is_on = False
        self._attr_icon = "mdi:printer-3d-nozzle"

        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, printer_id)},
            name=printer_name,
            manufacturer="Rdiger-36",
            model="Bambu AMS Monitoring",
        )

    async def async_turn_on(self, **kwargs):
        """Enable monitoring."""
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"http://{self._host}:{self._port}/api/printer/{self._printer_id}/monitoring/start"
            )

        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs):
        """Disable monitoring."""
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"http://{self._host}:{self._port}/api/printer/{self._printer_id}/monitoring/stop"
            )

        self._attr_is_on = False
        self.async_write_ha_state()

    async def async_update(self):
        """Update monitoring state from backend."""
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://{self._host}:{self._port}/api/status/{self._printer_id}"
            ) as resp:
                data = await resp.json()
                self._attr_is_on = data.get("monitoringEnabled", False)
