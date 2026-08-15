/* comfyui-renest — the Renest sidebar panel (GPL-3.0).
 *
 * Copyright (C) 2026 Tensor Logic Digital, LLC. Free software under the GNU
 * General Public License, version 3 or (at your option) any later version;
 * distributed WITHOUT ANY WARRANTY. See the LICENSE file for the full terms.
 *
 * Talks ONLY to:
 *  - its own Python half (/renest/info, /renest/token) via the ComfyUI api client;
 *  - the local Renest engine at http://127.0.0.1:7799/api/v1. That HTTP surface is
 *    the whole contract — this extension never imports the engine's code, because
 *    the process boundary is also the licence boundary.
 *
 * Token discipline: the engine's access token lives in a module variable only.
 * It is never written to localStorage, sessionStorage or cookies.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SERVE = "http://127.0.0.1:7799/api/v1";
// uv first: rebuilding an environment calls uv anyway, and `pip install` would
// install into this very ComfyUI environment — the one you are about to capture.
const INSTALL_CMD = "uv tool install renest";
const SERVE_CMD = "renest serve";

let token = null; // memory only — never persisted
let info = null; // {base_path, comfyui_dir, python, token_present}
let panelEl = null;
let pollTimer = null;
let lastRunFlag = false; // a run succeeded since panel last rendered

// ---------------------------------------------------------------- helpers --
async function fetchInfo() {
  const r = await api.fetchApi("/renest/info");
  if (!r.ok) throw new Error("renest info route missing");
  return r.json();
}

async function fetchToken() {
  if (token) return token;
  const r = await api.fetchApi("/renest/token");
  if (!r.ok) return null;
  token = (await r.json()).token;
  return token;
}

async function serveAlive() {
  try {
    const r = await fetch(`${SERVE}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function serveFetch(path, opts = {}) {
  const t = await fetchToken();
  if (!t) throw new Error("no serve token — run `renest serve` once on this machine");
  const r = await fetch(`${SERVE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      detail = body.error || body.detail || detail;
    } catch { /* keep status text */ }
    throw new Error(detail);
  }
  return r.json();
}

// What this installation actually looks like. The ComfyUI desktop app keeps data,
// program and Python environment in three different places, which the engine cannot
// work out from a single folder — but this code runs inside ComfyUI, so it just tells it.
function envOf(i) {
  const body = { target: i.base_path };
  // The interpreter running ComfyUI. When the environment has no lock file (the
  // desktop app has none), the engine reads the installed packages from it —
  // without this, such a nest ships with no dependency list at all.
  if (i.python) body.env_python = i.python;
  // comfyui_dir is deliberately not sent: the engine would then also look for custom
  // nodes and models under that tree, while on the desktop app those live under the
  // data folder instead.
  return body;
}

function fmtBytes(n) {
  if (!n && n !== 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text != null) node.textContent = text;
  return node;
}

function copyBtn(cmd) {
  const b = el("button",
    "margin-left:8px;padding:2px 8px;font-size:11px;cursor:pointer;border:1px solid #555;" +
    "border-radius:4px;background:transparent;color:inherit", "Copy");
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(cmd); b.textContent = "✓"; }
    catch { b.textContent = "✗"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1200);
  };
  return b;
}

function toast(severity, summary, detail) {
  try {
    app.extensionManager.toast.add({ severity, summary, detail, life: 6000 });
  } catch { console.log(`[renest] ${summary}: ${detail || ""}`); }
}

// ------------------------------------------------------------------ panel --
const S = {
  root: "padding:14px;font-size:13px;line-height:1.55;display:flex;flex-direction:column;gap:12px",
  h: "font-size:14px;font-weight:700;margin:0",
  sub: "opacity:.75;margin:0",
  code: "display:block;font-family:monospace;font-size:12px;padding:8px 10px;border:1px solid #444;" +
    "border-radius:6px;margin-top:6px;user-select:all;overflow-x:auto;white-space:nowrap",
  pri: "padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;border:none;border-radius:6px;" +
    "background:#2E8B6E;color:#fff",
  sec: "padding:8px 14px;font-size:13px;cursor:pointer;border:1px solid #555;border-radius:6px;" +
    "background:transparent;color:inherit",
  box: "border:1px solid #444;border-radius:8px;padding:10px 12px",
  log: "font-family:monospace;font-size:11px;max-height:180px;overflow-y:auto;white-space:pre-wrap;" +
    "border:1px solid #333;border-radius:6px;padding:8px;opacity:.85",
};

function render() {
  if (!panelEl) return;
  panelEl.replaceChildren();
  const root = el("div", S.root);
  panelEl.appendChild(root);
  drawInto(root);
}

async function drawInto(root) {
  root.appendChild(el("h3", S.h, "Renest — save this run"));
  const status = el("p", S.sub, "Checking the local Renest engine…");
  root.appendChild(status);

  const alive = await serveAlive();
  if (!alive) {
    // No engine yet: show the two commands that install it, rather than a dead end.
    status.textContent = "The Renest engine isn't running on this machine yet.";
    const guide = el("div", S.box);
    guide.appendChild(el("div", "font-weight:600", "Two steps, in any terminal:"));
    const c1 = el("code", S.code, INSTALL_CMD);
    c1.appendChild(copyBtn(INSTALL_CMD));
    guide.appendChild(c1);
    const c2 = el("code", S.code, SERVE_CMD);
    c2.appendChild(copyBtn(SERVE_CMD));
    guide.appendChild(c2);
    guide.appendChild(el("p", S.sub + ";margin-top:8px",
      "renest is a general rebuild tool — one command saves the models, custom nodes, " +
      "dependency locks and workflow behind a working run, verified byte by byte."));
    root.appendChild(guide);
    const retry = el("button", S.sec, "Check again");
    retry.onclick = render;
    root.appendChild(retry);
    return;
  }

  info = info || await fetchInfo().catch(() => null);
  if (!info) { status.textContent = "Plugin backend missing — reinstall comfyui-renest."; return; }
  if (!info.token_present) {
    status.textContent = "Engine found, but no access token yet — run `renest serve` once and reopen.";
    return;
  }
  status.textContent = lastRunFlag
    ? "That run worked — nest it before the machine does something you'll regret."
    : "Engine ready. Nest the current workflow whenever it works.";

  const nestBtn = el("button", S.pri, "Nest this run");
  root.appendChild(nestBtn);
  const out = el("div", "");
  root.appendChild(out);

  nestBtn.onclick = async () => {
    nestBtn.disabled = true;
    nestBtn.textContent = "Previewing…";
    out.replaceChildren();
    try {
      const prompt = await app.graphToPrompt();
      if (!prompt.output || Object.keys(prompt.output).length === 0) {
        out.appendChild(el("p", "opacity:.75",
          "The canvas is empty — load or build a workflow first. Renest saves runs that work; there's nothing to nest yet."));
        return;
      }
      const body = { ...envOf(info), workflow: prompt.output, dry_run: true };
      const preview = await serveFetch("/pack", { method: "POST", body: JSON.stringify(body) });
      drawPreview(out, preview, prompt.output);
    } catch (e) {
      out.appendChild(el("p", "color:#e5484d", `Preview failed: ${e.message}`));
    } finally {
      nestBtn.disabled = false;
      nestBtn.textContent = "Nest this run";
    }
  };
}

function drawPreview(out, preview, workflow) {
  out.replaceChildren();
  const box = el("div", S.box);
  box.appendChild(el("div", "font-weight:600;margin-bottom:6px", "What goes in the nest"));
  const items = preview.items || {};
  // Code entries cover both ComfyUI itself (dep_role "host") and the custom nodes
  // installed into it ("extension"). Showing them on one line counts ComfyUI as a
  // custom node, which makes both the number and the list wrong.
  const code = items.nodes || [];
  const rows = [
    ["Models", items.models || []],
    ["ComfyUI itself", code.filter((i) => i.dep_role === "host")],
    ["Custom nodes", code.filter((i) => i.dep_role !== "host")],
    ["Dependency locks", items.deps || []],
  ];
  for (const [label, list] of rows) {
    if (!list.length) continue;
    const line = el("div", "display:flex;justify-content:space-between;padding:2px 0");
    line.appendChild(el("span", "opacity:.8", label));
    line.appendChild(el("span", "font-family:monospace", String(list.length)));
    box.appendChild(line);
    for (const item of list.slice(0, 6)) {
      const size = item.size_bytes ?? item.approx_bytes;
      box.appendChild(el("div", "font-family:monospace;font-size:11px;opacity:.65;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
        `· ${item.name || item.path || "?"}${size ? ` (${fmtBytes(size)})` : ""}`));
    }
    if (list.length > 6) box.appendChild(el("div", "font-size:11px;opacity:.5", `… and ${list.length - 6} more`));
  }
  const total = el("div", "display:flex;justify-content:space-between;margin-top:6px;font-weight:600");
  total.appendChild(el("span", "", "Estimated size"));
  total.appendChild(el("span", "font-family:monospace", fmtBytes(preview.size_estimate_bytes)));
  box.appendChild(total);
  if (preview.out_dir) {
    const where = el("div", "font-size:11px;opacity:.6;margin-top:6px;word-break:break-all",
      `Saved on this machine to ${preview.out_dir}`);
    box.appendChild(where);
  }
  out.appendChild(box);

  // Say what could not be captured. A confirmation screen that only shows good news
  // sends people off to rebuild from a list that looks complete but isn't.
  const warnings = preview.warnings || [];
  if (warnings.length) {
    const warn = el("div", S.box + ";margin-top:8px;border-color:#8a6d1f");
    warn.appendChild(el("div", "font-weight:600;margin-bottom:4px",
      `Worth reading before you save (${warnings.length})`));
    for (const w of warnings.slice(0, 6)) {
      warn.appendChild(el("div", "font-size:11px;opacity:.8;padding:2px 0", `· ${w}`));
    }
    if (warnings.length > 6) {
      warn.appendChild(el("div", "font-size:11px;opacity:.5", `… and ${warnings.length - 6} more`));
    }
    out.appendChild(warn);
  }

  const nameWrap = el("div", "display:flex;gap:8px;margin-top:10px;align-items:center");
  const nameInput = el("input",
    "flex:1;padding:8px 10px;font-size:13px;border:1px solid #555;border-radius:6px;" +
    "background:transparent;color:inherit");
  nameInput.value = preview.default_name || "my-run";
  const go = el("button", S.pri, "Confirm & nest");
  nameWrap.appendChild(nameInput);
  nameWrap.appendChild(go);
  out.appendChild(nameWrap);

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "Starting…";
    try {
      const body = { ...envOf(info), workflow, name: nameInput.value.trim() || undefined };
      const res = await serveFetch("/pack", { method: "POST", body: JSON.stringify(body) });
      followJob(out, res.job_id);
    } catch (e) {
      out.appendChild(el("p", "color:#e5484d", `Couldn't start: ${e.message}`));
      go.disabled = false;
      go.textContent = "Confirm & nest";
    }
  };
}

function followJob(out, jobId) {
  out.replaceChildren();
  const head = el("div", "font-weight:600", "Packing…");
  const stageLine = el("div", S.sub, "queued");
  const bar = el("div", "height:6px;border-radius:3px;background:#333;overflow:hidden;margin:8px 0");
  const fill = el("div", "height:100%;width:0%;background:#2E8B6E;transition:width .4s");
  bar.appendChild(fill);
  const log = el("div", S.log, "");
  const cancel = el("button", S.sec, "Cancel");
  out.append(head, stageLine, bar, log, cancel);

  cancel.onclick = async () => {
    try { await serveFetch(`/jobs/${jobId}`, { method: "DELETE" }); } catch { /* already done */ }
  };

  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try { job = await serveFetch(`/jobs/${jobId}`); }
    catch (e) { stageLine.textContent = `poll failed: ${e.message}`; return; }
    const p = job.progress || {};
    stageLine.textContent = `${job.state}${job.stage ? ` · stage ${job.stage}` : ""}` +
      (p.speed_mbps ? ` · ${p.speed_mbps.toFixed(0)} Mbps` : "");
    if (p.percent != null) fill.style.width = `${Math.round(p.percent)}%`;
    if (Array.isArray(job.logs_tail)) log.textContent = job.logs_tail.slice(-12).join("\n");
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)) {
      clearInterval(pollTimer);
      cancel.remove();
      if (job.state === "succeeded") {
        fill.style.width = "100%";
        head.textContent = "✓ Nested & verified";
        // Always show where it landed — people need to find it, back it up, hand it on.
        const where = (job.result || {}).manifest_path;
        stageLine.textContent = "This run can now be rebuilt byte-for-byte on any machine you rent.";
        if (where) {
          const p = el("div", "font-family:monospace;font-size:11px;opacity:.7;margin-top:6px;word-break:break-all",
            where.replace(/\/manifest\.json$/, ""));
          out.insertBefore(p, log);
        }
        toast("success", "Nested", "Saved and verified — rebuild it anywhere.");
      } else {
        head.textContent = job.state === "failed" ? "✗ Packing failed" : `Stopped (${job.state})`;
        const err = job.error || {};
        stageLine.textContent = err.human || err.detail || "See the log above.";
        if (job.state === "failed") toast("error", "Packing failed", stageLine.textContent);
      }
    }
  }, 1000);
}

// -------------------------------------------------------------- extension --
app.registerExtension({
  name: "renest.panel",
  async setup() {
    try {
      app.extensionManager.registerSidebarTab({
        id: "renest",
        icon: "pi pi-inbox",
        title: "Renest",
        tooltip: "Nest this run — rebuild it anywhere",
        type: "custom",
        render: (elArg) => { panelEl = elArg; render(); },
      });
    } catch (e) {
      console.warn("[renest] sidebar API unavailable:", e);
    }
    // The moment a run succeeds is the moment worth saving — this tool only ever
    // reproduces runs that already worked, so that is exactly when to offer it.
    api.addEventListener("execution_success", () => {
      lastRunFlag = true;
      toast("info", "Run succeeded", "Nest it from the Renest tab — before the pod disappears.");
      if (panelEl) render();
    });
  },
});
