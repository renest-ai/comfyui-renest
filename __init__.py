"""comfyui-renest — the official Renest panel for ComfyUI.

Copyright (C) 2026 Tensor Logic Digital, LLC

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for the
full terms.

Boundaries, on purpose:

* This extension runs inside ComfyUI's process, so it is GPL-3.0 like ComfyUI.
* It talks to the Renest engine (the ``renest`` pip package — source-available
  under its own licence, not open source; its escape hatch and the nest format
  specs are Apache-2.0) over **loopback HTTP only** — never by importing it. The process boundary is the
  licence boundary, and the HTTP surface is the whole contract.
* It ships no node classes. Everything the user sees lives in ``web/renest.js``.

The Python half does exactly two things:

1. the token bridge — read the engine's local access token and hand it to the
   panel's browser code, which keeps it in a variable and never persists it;
2. report the shape of this installation — where the data lives, where ComfyUI
   itself lives, and which Python is running it. Only code inside ComfyUI's
   process can know these, and the engine needs them to pack the right things.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}
__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


def _token_candidates() -> list[Path]:
    """Where the engine's access token can be, most specific first. Read-only.

    Platform notes (checked against the platformdirs source, not from memory):

    * macOS: ``~/Library/Application Support/renest/serve.token``
    * Windows: ``%LOCALAPPDATA%\\renest\\renest\\serve.token`` — note the doubled
      ``renest\\renest`` (platformdirs uses the app name as the author directory
      when no author is given); ``%APPDATA%`` is checked as a fallback.
    """
    env = os.environ.get("RENEST_TOKEN_FILE")
    out: list[Path] = [Path(env)] if env else []
    home = Path.home()
    out.append(home / ".config" / "renest" / "serve.token")
    out.append(home / "Library" / "Application Support" / "renest" / "serve.token")
    for var in ("LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(var)
        if base:
            out.append(Path(base) / "renest" / "renest" / "serve.token")
    return out


def _read_token() -> str | None:
    """Read the token fresh every time, so rotating it needs no ComfyUI restart."""
    for p in _token_candidates():
        try:
            text = p.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            continue
    return None


def _env_facts() -> dict:
    """The three things only code inside ComfyUI's process can know.

    * ``base_path`` — the data folder: custom nodes, models, inputs and outputs.
    * ``comfyui_dir`` — where ComfyUI itself lives. The ``folder_paths`` module
      sits in ComfyUI's own source tree, so its location is that tree — and it
      is the copy actually running, which beats reading any config file.
    * ``python`` — the interpreter running ComfyUI. When the environment has no
      lock file, the engine asks this interpreter what is installed instead of
      guessing.

    These differ in the ComfyUI desktop app, which keeps data, program and Python
    environment in three separate places. Paths are not secrets; the access token
    still travels only over ``/renest/token``.
    """
    facts: dict = {"base_path": str(Path.cwd()), "comfyui_dir": None, "python": sys.executable}
    try:
        import folder_paths

        facts["base_path"] = str(Path(folder_paths.base_path).resolve())
        src = getattr(folder_paths, "__file__", None)
        if src:
            facts["comfyui_dir"] = str(Path(src).resolve().parent)
    except Exception:
        pass
    return facts


def _register_routes() -> None:
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/renest/info")
    async def renest_info(request: web.Request) -> web.Response:
        """What this installation looks like, plus whether a token is present.

        The token itself never travels through this route — only whether it exists.
        """
        return web.json_response({**_env_facts(), "token_present": _read_token() is not None})

    @routes.get("/renest/token")
    async def renest_token(request: web.Request) -> web.Response:
        """Hand the engine's access token to the panel's browser code.

        The exposure is bounded: the engine listens on 127.0.0.1 only, so the
        token is meaningless off this machine — even if ComfyUI itself is exposed
        to a LAN, a remote caller cannot reach the loopback engine. The browser
        side keeps the token in a variable and writes it nowhere.
        """
        token = _read_token()
        if token is None:
            return web.json_response(
                {"error": "No Renest access token yet — run `renest serve` once on this machine."},
                status=404,
            )
        return web.json_response({"token": token})


try:
    _register_routes()
except Exception as e:  # never let this extension break ComfyUI's startup
    print(f"[comfyui-renest] route registration failed: {e}")
