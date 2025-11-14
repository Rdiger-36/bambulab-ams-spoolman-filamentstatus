import aiohttp
import voluptuous as vol
from homeassistant import config_entries
import homeassistant.helpers.config_validation as cv

from .const import DOMAIN, CONF_HOST, CONF_PORT, CONF_PRINTERS


class AmsManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Step 1: enter host + port."""
        if user_input is None:
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema({
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_PORT, default=4000): int
                })
            )

        host = user_input[CONF_HOST]
        port = user_input[CONF_PORT]

        # Test API
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{host}:{port}/api/printers") as resp:
                    if resp.status != 200:
                        raise Exception()
                    printers = await resp.json()
        except Exception:
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema({
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_PORT, default=4000): int
                }),
                errors={"base": "cannot_connect"},
            )

        self._host = host
        self._port = port
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

        # Selected printer IDs
        selected = user_input[CONF_PRINTERS]

        # Map ID → Name
        printer_map = {p["id"]: p["name"] for p in self._printers_raw}

        # FINAL ENTRY CREATION
        return self.async_create_entry(
            title=f"Bambu AMS Monitoring ({self._host}:{self._port})",
            data={
                CONF_HOST: self._host,
                CONF_PORT: self._port,
                CONF_PRINTERS: [
                    {"id": pid, "name": printer_map[pid]}
                    for pid in selected
                ]
            },
        )
