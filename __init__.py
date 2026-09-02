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

import json
import os
import sys
import time
from datetime import datetime, timezone
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


RUN_RECORD_REL = ".renest/native-libs.json"


#: **This file no longer reads memory.** It used to open ``/proc/self/maps`` and write
#: out every shared library the process had loaded. The engine finds the running
#: application by itself and reads the same thing from outside -- measured 2026-09-02
#: on a real environment: the published engine, unchanged, still returns 89 libraries
#: with this file recording none of them. **What is lost** is stated rather than hidden:
#: once the application is closed the engine has nothing to read and falls back to what
#: installed packages declare (89 becomes 11); packing says so and tells the user to
#: start it and pack again.


def _owner_of(node_cls: object) -> dict | None:
    """Which installed node pack this node class came from, in ComfyUI's own terms.

    ``python_module`` is what ComfyUI itself reports for a node (``custom_nodes.X``
    for an installed pack, ``nodes`` for a built-in); ``cnr_id`` and ``aux_id`` are
    the registry identifiers newer versions attach. Read with ``getattr``, so a
    version that does not set one simply leaves that key out.

    ``dir`` is the folder the class was actually loaded from, taken from the module
    file rather than from the name -- that is the one the packer needs, and it is
    right on every version, including the ones that set no attributes at all.
    """
    out: dict = {}
    module = getattr(node_cls, "RELATIVE_PYTHON_MODULE", None)
    if isinstance(module, str) and module:
        out["python_module"] = module
    for attr in ("cnr_id", "aux_id"):
        value = getattr(node_cls, attr, None)
        if isinstance(value, str) and value:
            out[attr] = value
    src = getattr(sys.modules.get(getattr(node_cls, "__module__", "") or ""), "__file__", None)
    saw_file = isinstance(src, str) and bool(src)
    if saw_file:
        # Not resolved: this runs once per node class every time a prompt finishes,
        # and resolving asks the filesystem each time inside somebody's run. We want
        # the folder as it sits in the tree being packed anyway, not through symlinks.
        parts = Path(src).parts
        if "custom_nodes" in parts:
            after = parts[parts.index("custom_nodes") + 1:]
            if after:
                out["dir"] = after[0]
    # "Built-in" is only ever claimed on evidence: ComfyUI said so, or we read the
    # file and it is outside custom_nodes. A class assembled at run time has no file
    # at all, and calling that one built-in would tell the packer to leave out a pack
    # that really is installed -- the one wrong answer that costs a rebuild.
    if "dir" not in out and (
        out.get("python_module") == "nodes"
        or (saw_file and "python_module" not in out)
    ):
        out["builtin"] = True
    return out or None


def _node_owners() -> dict:
    """Every node type this ComfyUI has loaded, mapped to where it came from.

    **Only this process can answer it.** Packing runs later and has to guess from
    the outside, by searching every custom_nodes folder for the class name as text
    -- which misses a pack that assembles its node names at start-up, and picks the
    wrong one when two packs use the same name.
    """
    try:
        import nodes

        mappings = nodes.NODE_CLASS_MAPPINGS
    except Exception:
        return {}
    out: dict = {}
    for name, node_cls in list(mappings.items()):
        if not isinstance(name, str):
            continue
        owner = _owner_of(node_cls)
        if owner:
            out[name] = owner
    return out


#: Shortest gap between two video-memory readings. Short enough to catch a model
#: being loaded, long enough that asking costs nothing next to the run itself.
SAMPLE_MIN_GAP_S = 2.0

#: What one run's readings add up to. Reset when a prompt starts, read when it ends.
#: ``running`` keeps idle time out of it: the figure is what *a run* was seen using,
#: and an app sitting there with a model still loaded would inflate it for free.
_vram = {"max_used_bytes": 0, "samples": 0, "last_at": 0.0, "max_gap_s": 0.0,
         "running": False}


def _video_memory_in_use() -> int | None:
    """Bytes of video memory in use on the card this run is using, right now.

    **The current device only.** Asking about a second card would create a context
    on it, which costs that card memory the run never wanted to spend.
    """
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        used = int(total) - int(free)
        return used if used > 0 else None
    except Exception:
        return None


def _reset_video_memory_tally(running: bool = False) -> None:
    _vram.update({"max_used_bytes": 0, "samples": 0, "last_at": 0.0, "max_gap_s": 0.0,
                  "running": running})


def _sample_video_memory(force: bool = False) -> None:
    """Take one reading, unless nothing is running or the last one was too recent.

    Readings are taken on the messages the app already sends while a prompt runs, so
    nothing extra is running in the background and nothing can outlive the run.
    """
    if not _vram["running"]:
        return
    now = time.monotonic()
    last = _vram["last_at"]
    if last and not force and now - last < SAMPLE_MIN_GAP_S:
        return
    used = _video_memory_in_use()
    if used is None:
        return
    if last:
        _vram["max_gap_s"] = max(_vram["max_gap_s"], now - last)
    _vram["last_at"] = now
    _vram["samples"] += 1
    _vram["max_used_bytes"] = max(_vram["max_used_bytes"], used)


def _video_memory_block() -> dict | None:
    """What the readings amount to, in the shape a nest keeps them.

    **The figure never travels without how it was taken.** Checks this far apart can
    miss a short burst, so the gap is reported as the largest one between readings --
    a floor that is too low by design, and one that may only ever warn.
    """
    if _vram["samples"] < 1 or _vram["max_used_bytes"] <= 0:
        return None
    gap = _vram["max_gap_s"] if _vram["samples"] >= 2 else SAMPLE_MIN_GAP_S
    return {
        "max_used_bytes": int(_vram["max_used_bytes"]),
        "sample_interval_s": max(round(float(gap or SAMPLE_MIN_GAP_S), 2), 0.01),
        "samples": int(_vram["samples"]),
    }


def _write_run_record(video_memory: dict | None = None) -> None:
    """Put the record beside ComfyUI, so packing can read it after the app is closed.

    **One file, nothing else touched.** Written whole to a temporary name and moved
    into place, so a reader never sees half of it. Any failure is swallowed: this is
    a convenience for a later pack, never a reason to disturb somebody's run.

    ``video_memory`` is passed in rather than read here, because only the caller knows
    how the run ended -- and a figure from a run that did not finish is worse than none.
    """
    facts = _env_facts()
    root = facts.get("comfyui_dir") or facts.get("base_path")
    owners = _node_owners()
    if not root:
        return
    dest = Path(root) / RUN_RECORD_REL
    # Write when there is something to record, **and also when there is not but a
    # record already exists**: the earlier figure has to be replaced by what is true
    # now, even when what is true now is "nothing measured". "Write only when there is
    # something" used to be enough, because the library list was never empty and so
    # every run rewrote the file. Once this file stopped reading memory, a run that
    # ended in an error had nothing to record and returned early -- leaving the video
    # memory figure from the last *successful* run on disk, to be picked up at packing
    # time as if it belonged to this one. Caught 2026-09-02 by
    # test_a_run_that_did_not_finish_never_leaves_a_figure_behind.
    # The other side holds too: never written before and nothing to record now means
    # do not create the file at all.
    if not (video_memory or owners) and not dest.exists():
        return
    payload = {
        # 2 adds node_owners. 3 drops mapped_library_paths: this file stopped reading
        # memory, and the engine finds the running application by itself. Readers must
        # go on treating every part as optional -- a record written by an older install
        # still carries the old key and is still perfectly good for what it does carry.
        "record_version": 3,
        "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "python": sys.executable,
    }
    if owners:
        payload["node_owners"] = owners
    if video_memory:
        payload["video_memory"] = video_memory
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".json.part")
        tmp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        tmp.replace(dest)
    except OSError:
        pass


_START_EVENTS = ("execution_start",)
_SUCCESS_EVENT = "execution_success"
_DONE_EVENTS = (_SUCCESS_EVENT, "execution_error", "execution_interrupted")


def _watch_for_finished_runs() -> None:
    """Write the record when a prompt finishes, reading video memory along the way.

    Hooked by wrapping the server's own outgoing-message call rather than any
    execution internal: that one call is what every ComfyUI version uses to tell
    the browser how a prompt is going, and wrapping it cannot change what is sent.
    Video memory has to be read *during* the run, which is why every message is a
    chance to take one -- but **only a run that finished may carry that figure**: a
    workflow that stops on its first node has a peak of a few hundred megabytes, and
    letting that overwrite a real run's figure hands the next machine check a floor
    far below what the run needs. Libraries are kept either way (a run that reached
    an error still loaded them); the figure is dropped, and no figure honestly reads
    as "nobody measured".

    The call is passed through exactly as received, arguments untouched: a wrapper
    with a narrower signature would raise **before** the guard below could catch it,
    and that exception would land in the caller's run.
    """
    from server import PromptServer

    server = PromptServer.instance
    original = server.send_sync

    def send_sync(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        try:
            event = args[0] if args else kwargs.get("event")
            if event in _START_EVENTS:
                _reset_video_memory_tally(running=True)
            _sample_video_memory(force=event in _DONE_EVENTS)
            if event in _DONE_EVENTS:
                _write_run_record(
                    _video_memory_block() if event == _SUCCESS_EVENT else None
                )
                _vram["running"] = False
        except Exception:  # never let a bookkeeping slip break somebody's run
            pass
        return original(*args, **kwargs)

    server.send_sync = send_sync


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

try:
    _watch_for_finished_runs()
except Exception as e:  # same rule: a missing record is not worth a broken start
    print(f"[comfyui-renest] run record hook not installed: {e}")
