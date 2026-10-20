# comfyui-renest

**Nest a working run — save its files and dependencies, checked byte for byte.**

Renest saves a ComfyUI or fine-tuning setup that already worked on a rented GPU — the model files, custom nodes, exact package versions and workflow — and brings it back on another Linux GPU machine, every file checked against its SHA-256. It promises that the files and dependencies come back verified; whether the app then runs is tested on every restore and reported, not promised.

This is the official [Renest](https://renest.ai) panel for ComfyUI. The moment a run
succeeds, **Nest this run** saves everything that run depended on — models, custom nodes,
dependency versions, the workflow itself — into a single open-format archive (a "nest")
on this machine's disk and checks every file byte for byte. Then you choose: **Save to my
Renest drive** uploads it once you approve that upload in your browser (the drive needs a
paid subscription), or **Save on this machine only** keeps it on this disk, free, with no
account needed. Restore it later on another
machine and those files and dependencies come back, checked again against the same
fingerprints. Docs: https://renest.ai/docs/plugin-nest-this-run

## What it looks like

- A **Renest** tab in the ComfyUI sidebar.
- After a successful run: **Nest this run** → a preview of exactly what will be
  saved (models / ComfyUI itself / custom nodes / dependency locks, with sizes),
  anything that could not be captured, and where the nest will be written → one of
  two buttons:
  - **Save to my Renest drive** → a short code to approve in your browser → live
    progress until it is saved, checked and on your Renest drive. The drive needs a
    subscription; if your plan has none, or the drive is full, the panel says so, links
    to the plans page, and offers **Save on this machine instead**.
  - **Save on this machine only** → the same pack, kept on this disk. Free, no sign-in.
    On a rented machine it is gone when the machine is, unless you copy the folder off.
- If the Renest engine isn't installed yet, the tab shows the two commands that
  install it. Nothing else to configure.

## Nest this run / Take back

**Nest this run** only takes the workflow that just ran to the end: what a nest is
worth is what that run used, caught while it worked. A canvas that has not run, or has
changed since its last run finished, gets "run it once first" instead. Once the drive has
checked an upload, the panel lists the model files it now holds, so you can free the space
yourself — Renest never deletes anything in your ComfyUI folder. **Take back** (approved
once in your browser) lists your saved workflows, compares one with this machine — ComfyUI,
Python, torch, custom nodes, files — and brings the missing files back, checked byte for
byte. A file that is already here with different bytes is kept; ours lands beside it. It
does not install custom nodes, and it does not promise the workflow will run.

## Install

**Via ComfyUI-Manager**: search for "Renest", install, restart ComfyUI.

**Manually**:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/renest-ai/comfyui-renest
```

Then install the Renest engine (any terminal, once per machine):

```bash
uv tool install --upgrade renest
# no uv yet?  curl -LsSf https://astral.sh/uv/install.sh | sh
#             or:  pip install uv   (a single binary, no dependencies —
#             safe to run inside this ComfyUI environment)
# or, if you know this environment is separate: pip install renest
renest login
renest serve
```

`renest login` is only needed for the Renest drive (no account yet? create one at
https://app.renest.ai/register). It signs this machine in to your Renest account: it
prints a page and a
code, you approve them in your browser, and the machine keeps a sign-in that can only
*ask* for an upload. Every upload from the panel is then approved by you, once, in
your own browser.

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

- **The panel works on a rented machine, opened from your own browser.** The browser
  only ever talks to ComfyUI's own address (`/renest/api/...`). The panel's Python
  half, running next to ComfyUI, passes each call on to the engine over **loopback
  HTTP only** (`127.0.0.1:7799` on that machine). It never imports the engine's code:
  the process boundary is also the licence boundary.
- **The engine's token never reaches your browser.** The Python half reads it from
  the file the engine writes on that machine and adds it to each call it passes on.
- **Only the calls the panel needs are passed on**: check the engine, preview and
  pack, follow and cancel that job; for Take back, open a session you approve in your
  browser, compare or fetch one saved workflow, and close the session. Which folder gets
  packed, where the nest is written and where taken-back files land are decided on the
  machine, never by what the browser sends; the browser only picks the workflow, its
  name, and drive or this machine. Anyone who
  can open your ComfyUI can use the panel too, so keep that address to yourself.
- **No cloud credentials pass through here.** Bucket keys and account tokens are
  the engine's business; this panel never sees, stores or forwards them.
- **Nothing is uploaded without your approval.** A nest is written to your own disk
  first, and **Save on this machine only** uploads nothing. Each upload to your Renest
  drive asks for your approval in your own browser,
  from the account this machine was signed in to; the permission it gets covers that
  one upload only and is withdrawn when it ends. The machine keeps nothing that can
  upload by itself.
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
