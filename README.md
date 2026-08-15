# comfyui-renest

**Nest a working run — rebuild it anywhere, byte for byte.**

The official [Renest](https://renest.ai) panel for ComfyUI. The moment a run
succeeds, one click saves everything that run depended on — models, custom nodes,
dependency versions, the workflow itself — into a single open-format archive
(a "nest"). Restore it later on any machine you rent and get the same run back,
verified byte for byte.

## What it looks like

- A **Renest** tab in the ComfyUI sidebar.
- After a successful run: **Nest this run** → a preview of exactly what will be
  saved (models / ComfyUI itself / custom nodes / dependency locks, with sizes),
  anything that could not be captured, and where the nest will be written →
  confirm → live progress until it is saved **and verified**.
- If the Renest engine isn't installed yet, the tab shows the two commands that
  install it. Nothing else to configure.

## Install

**Via ComfyUI-Manager**: search for "Renest", install, restart ComfyUI.

**Manually**:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/renest-ai/comfyui-renest
```

Then install the Renest engine (any terminal, once per machine):

```bash
uv tool install renest
# no uv yet?  curl -LsSf https://astral.sh/uv/install.sh | sh
#             or:  pip install uv   (a single binary, no dependencies —
#             safe to run inside this ComfyUI environment)
# or, if you know this environment is separate: pip install renest
renest serve
```

The engine is a separate program with its own licence (source-available: the code
is public to read and audit, but it is not open source; its escape hatch and the
nest format specs are Apache-2.0). It listens on `127.0.0.1:7799` and nothing else.

## Where the nest is saved

Next to the environment it came from: `<the folder holding your ComfyUI>/renest-nests/`.
The panel shows the exact path both before you commit to it and once the nest is
done, so you can back it up, move it, or hand it to someone else. That folder sits
on the same disk as your models, which on a rented pod is the volume that survives
a restart — a home directory there often does not.

## How it works, and what never happens

- The panel talks to the engine over **loopback HTTP only** (`127.0.0.1:7799`),
  authenticated with a token the engine writes on this machine. It never imports
  the engine's code: the process boundary is also the licence boundary.
- **The token stays in memory.** The panel's Python half reads the token file and
  hands the value to the browser code, which keeps it in a variable — never in
  localStorage, sessionStorage or a cookie.
- **No cloud credentials pass through here.** Bucket keys and account tokens are
  the engine's business; this panel never sees, stores or forwards them.
- **Nothing is uploaded by this panel.** A nest is written to your own disk. What
  you do with it afterwards is up to you.
- **Nests carry no absolute paths from your machine.** The archive records where
  things go relative to the environment, not where they came from — so handing a
  nest to someone else does not hand over your folder layout or your user name.

## Requirements

- ComfyUI with the sidebar extension API (frontend 1.4x or newer).
- The `renest` Python package (>= 0.1.0) running `renest serve` on the same machine.
  Any regular Python 3.11+ can host it — it does not have to be the interpreter
  that runs ComfyUI. On the Windows portable build, install it with a normal
  Python rather than the embedded one, which ships without `pip` on PATH.

## Licence

Copyright (C) 2026 Tensor Logic Digital, LLC.

GPL-3.0-or-later. This extension runs inside ComfyUI's process, so it follows
ComfyUI's licence. The Renest engine it talks to is a separate program under its
own source-available licence (shipped as the LICENSE-CLI file of the ``renest``
package); only the engine's escape hatch and the nest format specs are Apache-2.0.

The hosted Renest service at [renest.ai](https://renest.ai) is operated by the
authors of this project.
