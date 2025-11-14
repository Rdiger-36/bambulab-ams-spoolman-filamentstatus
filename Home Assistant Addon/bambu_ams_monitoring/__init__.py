from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry

from .const import DOMAIN

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    hass.data.setdefault(DOMAIN, {})

    hass.data[DOMAIN][entry.entry_id] = {
        "base_url": entry.data["base_url"],
        "printers": entry.data["printers"]
    }

    await hass.config_entries.async_forward_entry_setups(entry, ["switch"])
    return True

