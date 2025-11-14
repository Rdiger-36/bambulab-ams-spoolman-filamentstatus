import aiohttp
import voluptuous as vol
from homeassistant import config_entries
import homeassistant.helpers.config_validation as cv

from .const import DOMAIN, CONF_BASE_URL, CONF_PRINTERS


class AmsManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Step 1: enter base URL."""
        if user_input is None:
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema({
                    vol.Required(CONF_BASE_URL): str
                })
            )

        base_url = user_input[CONF_BASE_URL].rstrip("/")

        # Test API: /api/printers
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{base_url}/api/printers") as resp:
                    if resp.status != 200:
                        raise Exception()
                    printers = await resp.json()
        except Exception:
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema({
                    vol.Required(CONF_BASE_URL): str
                }),
                errors={"base": "cannot_connect"},
            )

        self._base_url = base_url
        self._printers_raw = printers

        return await self.async_step_select_printers()


    async def async_step_select_printers(self, user_input=None):
        """Step 2: printer selection."""

        printer_names = {
            p["id"]: f"{p['name']} ({p['id']})"
            for p in self._printers_raw
        }

        if user_input is None:
            return self.async_show_form(
                step_id="select_printers",
                data_schema=vol.Schema({
                    vol.Required(CONF_PRINTERS): cv.multi_select(printer_names)
                })
            )

        selected = user_input[CONF_PRINTERS]

        printer_map = {p["id"]: p["name"] for p in self._printers_raw}

        return self.async_create_entry(
            title=f"Bambu AMS Monitoring ({self._base_url})",
            data={
                CONF_BASE_URL: self._base_url,
                CONF_PRINTERS: [
                    {"id": pid, "name": printer_map[pid]}
                    for pid in selected
                ]
            },
        )
