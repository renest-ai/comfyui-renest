/* comfyui-renest — the Renest sidebar panel (GPL-3.0).
 *
 * Copyright (C) 2026 Tensor Logic Digital, LLC. Free software under the GNU
 * General Public License, version 3 or (at your option) any later version;
 * distributed WITHOUT ANY WARRANTY. See the LICENSE file for the full terms.
 *
 * Talks ONLY to its own Python half, on ComfyUI's own address, through the ComfyUI
 * api client. Calls to the Renest engine go to /renest/api/..., and the Python half
 * forwards them to the engine on the machine running ComfyUI.
 *
 * Why not straight to http://127.0.0.1:7799: this code runs in the user's browser.
 * On a rented machine that browser is on their own computer, so 127.0.0.1 is their
 * laptop and the engine on the rented machine is out of reach. Going through
 * ComfyUI also means the engine's access token never reaches the browser at all.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// uv first: rebuilding an environment calls uv anyway, and `pip install` would
// install into this very ComfyUI environment — the one you are about to capture.
// `--upgrade`: on a machine that already has an older copy, the bare install is a
// silent no-op (uv sees "installed" and leaves the old version). On a fresh machine
// it changes nothing, so one command serves both.
const INSTALL_CMD = "uv tool install --upgrade renest";
const SERVE_CMD = "renest serve";
// Uploads from this panel are approved in the browser, and the engine may only ask for
// that approval once this machine is signed in from its own terminal.
const LOGIN_CMD = "renest login";

let panelEl = null;
let pollTimer = null;
let lastRunFlag = false; // a run succeeded since panel last rendered
// The graph that last ran to the end, as ComfyUI runs it, read the moment the run
// finished. Renest only saves runs that worked, so the panel only nests the canvas
// when it is still exactly this graph. Read at the end of the run rather than when
// it was queued: a seed set to "randomize" has already moved on by then, and the
// canvas shows the moved-on value.
let lastGoodGraph = null;

const graphKey = (output) => JSON.stringify(output);

// ---------------------------------------------------------------- helpers --
const BRIDGE = "/renest/api";

/** Where the engine stands: "ready", "engine_unreachable", "token_missing", or
 * "panel_backend_missing" (this file loaded but its Python half did not). */
async function engineState() {
  let r;
  try {
    r = await api.fetchApi(`${BRIDGE}/health`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return "engine_unreachable";
  }
  if (r.ok) return "ready";
  let body = {};
  try { body = await r.json(); } catch { /* not ours */ }
  if (body.renest_bridge_error) return body.renest_bridge_error;
  return r.status === 404 ? "panel_backend_missing" : "engine_unreachable";
}

async function serveFetch(path, opts = {}) {
  const r = await api.fetchApi(`${BRIDGE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    let errorClass = null;
    try {
      const body = await r.json();
      detail = body.error || body.detail || BRIDGE_ERRORS[body.renest_bridge_error] || detail;
      errorClass = body.error_class || null;
    } catch { /* keep status text */ }
    const err = new Error(detail);
    err.errorClass = errorClass;
    throw err;
  }
  return r.json();
}

// The bridge's own answers, as a person would say them.
const BRIDGE_ERRORS = {
  engine_unreachable: "The Renest engine stopped answering on this machine.",
  token_missing: "The Renest engine has no access token yet — restart `renest serve`.",
  not_allowed: "The panel asked the engine for something it does not forward.",
  bad_request: "The panel sent a request the engine could not read.",
};

function fmtBytes(n) {
  if (!n && n !== 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The engine names a nest "<folder> <date>" by the machine's clock, and a rented machine
 * runs on UTC: packed at 02:17 in Beijing, it says yesterday. A name is for the person,
 * so the date in it is theirs — the browser is the one place that knows their time zone.
 * Only a trailing YYYY-MM-DD is swapped; a name the engine got from elsewhere is left alone. */
function withLocalDate(name) {
  if (typeof name !== "string") return name;
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
    String(d.getDate()).padStart(2, "0");
  return name.replace(/ \d{4}-\d{2}-\d{2}$/, ` ${local}`);
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
    const ok = await copyText(cmd);
    b.textContent = ok ? "✓" : "Select it, then press Ctrl/⌘-C";
    setTimeout(() => { b.textContent = "Copy"; }, ok ? 1200 : 4000);
  };
  return b;
}

/** Copy without assuming the clipboard API is there.
 *
 * ComfyUI on a rented pod is opened over plain http at an IP address, and a
 * browser gives ``navigator.clipboard`` only to secure origins — measured on a
 * LAN box: ``http://<ip>:8188`` reports isSecureContext false and no clipboard
 * object at all, while ``http://127.0.0.1:8188`` has both. That is our most
 * common setup, so the button used to fail for exactly the people it is for.
 * The old textarea trick still works there.
 */
async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Only ever link to a web page: the address comes from the engine, which got it from
 * the Renest service, and a link is the one place a stray scheme could run code. */
function safeHttpUrl(u) {
  try {
    const parsed = new URL(String(u));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function linkOut(href, text) {
  const a = el("a", "color:#4cc38a;text-decoration:underline;cursor:pointer", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** This machine has no Renest sign-in: say so, and hand over the one command. */
function drawSignIn(out, message) {
  out.replaceChildren();
  const box = el("div", S.box);
  box.appendChild(el("div", "font-weight:600", "Sign this machine in first"));
  box.appendChild(el("p", S.sub + ";margin-top:4px", message ||
    "This machine is not signed in to Renest. In its terminal, run:"));
  const c = el("code", S.code, LOGIN_CMD);
  c.appendChild(copyBtn(LOGIN_CMD));
  box.appendChild(c);
  box.appendChild(el("p", S.sub + ";margin-top:8px",
    "It shows a code to approve in your browser. Then press \"Nest this run\" again."));
  out.appendChild(box);
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

  const state = await engineState();
  if (state === "panel_backend_missing") {
    status.textContent = "Plugin backend missing — reinstall comfyui-renest and restart ComfyUI.";
    return;
  }
  if (state === "token_missing") {
    status.textContent = "Engine found, but no access token yet — restart `renest serve` and reopen.";
    return;
  }
  if (state !== "ready") {
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
      // Sentence-initial: the brand form, capitalised. The bare command name at the
      // start of a sentence reads as a typo to everyone who does not already know
      // that the command is spelled in lower case.
      "Renest saves the models, custom nodes, dependency locks and workflow behind a " +
      "working run, and checks every file byte for byte."));
    root.appendChild(guide);
    const retry = el("button", S.sec, "Check again");
    retry.onclick = render;
    root.appendChild(retry);
    return;
  }

  status.textContent = lastRunFlag
    ? "That run worked — you can nest it now."
    : "Engine ready. Run your workflow once; when it finishes, you can nest it.";

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
      if (graphKey(prompt.output) !== lastGoodGraph) {
        out.appendChild(el("p", "opacity:.75", lastGoodGraph
          ? "This workflow has changed since its last run finished. Run it once more and let " +
            "it finish — Renest only saves a run that worked."
          : "Run this workflow once and let it finish first — Renest only saves a run that worked."));
        return;
      }
      // `output` is what ComfyUI runs; `workflow` is the canvas itself, the only form
      // ComfyUI's Workflows list can open. Both go, so the restored app opens on this
      // graph instead of an empty canvas.
      const recipe = { workflow: prompt.output, workflow_ui: prompt.workflow };
      // Which folder to pack is filled in on the machine, not here: see the bridge.
      const body = { ...recipe, dry_run: true };
      const preview = await serveFetch("/pack", { method: "POST", body: JSON.stringify(body) });
      drawPreview(out, preview, recipe);
    } catch (e) {
      out.appendChild(el("p", "color:#e5484d", `Preview failed: ${e.message}`));
    } finally {
      nestBtn.disabled = false;
      nestBtn.textContent = "Nest this run";
    }
  };
}

function drawPreview(out, preview, recipe) {
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
    // Label and path on separate lines. Kept as one line with break-all, the path
    // split mid-word at whatever column the panel happened to end at
    // ("…/renest-ne" + "ts"), which reads like a typo. ``anywhere`` moves the whole
    // path down first and only breaks it if it still does not fit.
    const where = el("div", "font-size:11px;opacity:.6;margin-top:6px", "Packed on this machine in");
    where.appendChild(el("div", "font-family:monospace;overflow-wrap:anywhere;opacity:.9",
      preview.out_dir));
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
      // Bullet in its own column, text in a shrinkable one. As one text node the
      // long file paths could not wrap: they ran past the right edge of the box and
      // pushed the bullet onto a line of its own.
      const row = el("div", "display:flex;gap:6px;font-size:11px;opacity:.8;padding:2px 0");
      row.appendChild(el("span", "flex:none", "·"));
      row.appendChild(el("span", "min-width:0;overflow-wrap:anywhere", w));
      warn.appendChild(row);
    }
    if (warnings.length > 6) {
      warn.appendChild(el("div", "font-size:11px;opacity:.5", `… and ${warnings.length - 6} more`));
    }
    out.appendChild(warn);
  }

  out.appendChild(el("p", S.sub + ";margin-top:8px;font-size:12px",
    "Then it is uploaded to your Renest drive. You approve each upload once, in your browser."));

  const nameWrap = el("div", "display:flex;gap:8px;margin-top:10px;align-items:center");
  const nameInput = el("input",
    "flex:1;padding:8px 10px;font-size:13px;border:1px solid #555;border-radius:6px;" +
    "background:transparent;color:inherit");
  nameInput.value = withLocalDate(preview.default_name) || "my-run";
  const go = el("button", S.pri, "Confirm & nest");
  nameWrap.appendChild(nameInput);
  nameWrap.appendChild(go);
  out.appendChild(nameWrap);

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "Starting…";
    try {
      // The preview was of the canvas as it was then. Switching tabs or editing since
      // would otherwise nest the old graph under a list that no longer matches it.
      const now = await app.graphToPrompt();
      if (graphKey(now.output) !== graphKey(recipe.workflow)) {
        out.replaceChildren(el("p", "opacity:.75",
          "The canvas changed after this preview. Press \"Nest this run\" again to preview what is there now."));
        return;
      }
      const body = { ...recipe, name: nameInput.value.trim() || undefined };
      const res = await serveFetch("/pack", { method: "POST", body: JSON.stringify(body) });
      followJob(out, res.job_id);
    } catch (e) {
      if (e.errorClass === "NOT_SIGNED_IN") {
        drawSignIn(out, e.message);
        return;
      }
      out.appendChild(el("p", "color:#e5484d", `Couldn't start: ${e.message}`));
      go.disabled = false;
      go.textContent = "Confirm & nest";
    }
  };
}

// Turn the engine's NDJSON log tail into plain sentences. Anything we don't
// recognise is dropped rather than dumped: a user watching a 20 GB copy should
// see what is happening, not our wire format.
function humanLog(lines) {
  const out = [];
  for (const raw of lines.slice(-20)) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.type === "stage_start" && e.desc) out.push(e.desc);
    else if (e.type === "warning" && (e.human || e.message)) out.push(e.human || e.message);
    else if (e.type === "stage_end" && e.desc) out.push(`${e.desc} — done`);
  }
  return out.slice(-4).join("\n");
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
  // Shown while the engine waits for the upload to be approved in the browser.
  const waiting = el("div", S.box);
  waiting.style.display = "none";
  out.append(head, waiting, stageLine, bar, log, cancel);
  let shownCode = null;

  function showApproval(approval) {
    if (shownCode === approval.user_code) return;
    shownCode = approval.user_code;
    waiting.replaceChildren();
    waiting.appendChild(el("div", "font-weight:600", "Approve this upload"));
    waiting.appendChild(el("div", S.sub + ";margin-top:4px",
      "Check that the approval page shows this code:"));
    waiting.appendChild(el("div",
      "font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;margin:6px 0",
      approval.user_code || "?"));
    const href = safeHttpUrl(approval.verify_url);
    if (href) waiting.appendChild(linkOut(href, "Open approval page"));
    waiting.appendChild(el("p", S.sub + ";margin-top:8px",
      "Waiting for you to approve in your browser…"));
    waiting.style.display = "";
  }

  cancel.onclick = async () => {
    try { await serveFetch(`/jobs/${jobId}`, { method: "DELETE" }); } catch { /* already done */ }
  };

  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try { job = await serveFetch(`/jobs/${jobId}`); }
    catch (e) { stageLine.textContent = `poll failed: ${e.message}`; return; }
    if (job.approval && job.state === "running") {
      head.textContent = "Waiting for approval";
      bar.style.display = "none";
      stageLine.textContent = "";
      showApproval(job.approval);
      return;
    }
    if (shownCode !== null) {
      waiting.style.display = "none";
      bar.style.display = "";
      head.textContent = "Packing…";
    }
    const p = job.progress || {};
    stageLine.textContent = `${job.state}${job.stage ? ` · stage ${job.stage}` : ""}` +
      (p.speed_mbps ? ` · ${p.speed_mbps.toFixed(0)} Mbps` : "");
    if (p.percent != null) fill.style.width = `${Math.round(p.percent)}%`;
    // The engine's log is machine-readable NDJSON. Printing it raw put lines like
    // {"type":"progress","bytes_total":797842085288} on screen (seen on a real run,
    // 2026-08-15) — so keep the last few and show only the sentence inside each.
    if (Array.isArray(job.logs_tail)) log.textContent = humanLog(job.logs_tail);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)) {
      clearInterval(pollTimer);
      cancel.remove();
      waiting.remove();
      bar.style.display = "";
      if (job.state === "succeeded") {
        fill.style.width = "100%";
        head.textContent = "✓ Saved to your Renest drive";
        const result = job.result || {};
        const drive = result.drive || {};
        stageLine.textContent = "Its files and dependencies were checked on this machine and uploaded.";
        const href = safeHttpUrl(drive.console_url);
        if (href) out.insertBefore(linkOut(href, "Open it on your Renest drive"), log);
        // Also where the packed copy sits on this machine -- people back it up, hand it on.
        const where = result.manifest_path;
        if (where) {
          const p = el("div", "font-family:monospace;font-size:11px;opacity:.7;margin-top:6px;word-break:break-all",
            where.replace(/\/manifest\.json$/, ""));
          out.insertBefore(p, log);
        }
        // Drop the running trace only after the path is in — it is inserted relative
        // to this element, so removing it first threw and took the path (and the
        // toast) down with it. Caught by looking at the screenshot, not by a test.
        log.remove();
        toast("success", "Saved to your Renest drive", "Files and dependencies checked and uploaded.");
      } else if ((job.error || {}).error_class === "NOT_SIGNED_IN") {
        clearInterval(pollTimer);
        drawSignIn(out, job.error.human);
      } else {
        head.textContent = job.state === "failed" ? "✗ Packing failed" : `Stopped (${job.state})`;
        const err = job.error || {};
        stageLine.textContent = err.human || err.detail || (job.state === "cancelled"
          ? "Cancelled. Nothing from this run was saved to your drive."
          : "See the log below.");
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
        tooltip: "Nest this run — save its files and dependencies",
        type: "custom",
        render: (elArg) => { panelEl = elArg; render(); },
      });
    } catch (e) {
      console.warn("[renest] sidebar API unavailable:", e);
    }
    // The moment a run succeeds is the moment worth saving — this tool only ever
    // reproduces runs that already worked, so that is exactly when to offer it.
    api.addEventListener("execution_success", async () => {
      lastRunFlag = true;
      try {
        lastGoodGraph = graphKey((await app.graphToPrompt()).output);
      } catch {
        lastGoodGraph = null; // could not read the canvas: the panel asks for another run
      }
      // No "before the machine disappears" here: until the nest is in the cloud drive it
      // sits on this machine's own disk, and a warning that implies otherwise misleads.
      toast("info", "Run succeeded", "You can nest it from the Renest tab.");
      if (panelEl) render();
    });
  },
});
