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
// The web console's sign-up page, for someone who has no Renest account to sign in to.
const REGISTER_URL = "https://app.renest.ai/register";
// What a nest kept on this machine is, where it sits, and how to take it with you.
const LOCAL_NEST_DOCS_URL = "https://renest.ai/docs/plugin-nest-this-run#where";
// Refusals that mean "your drive will not take this" — a plan without cloud storage, or
// a full drive. Packing on this machine stays free, so these offer that instead.
const DRIVE_REFUSALS = new Set(["PLAN_CANNOT_PACK", "QUOTA_EXCEEDED"]);
// The engine's own class for "the drive checked the nest and said no": the packing
// worked, so the heading must not say "Packing failed". Not a service code, so it is
// kept apart from DRIVE_REFUSALS (which the contract test checks against the server).
const DRIVE_REJECTED = "DRIVE_REJECTED";

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
// The one save button, and the words every "press it again" sentence points back at.
const SAVE_LABEL = "Nest this run";

// Which half of the panel is showing: "save" or "takeback".
let activeTab = "save";
// Take back: the one session the engine holds for this panel (its id only — the
// permission itself stays in the engine's memory), and the job running in it. A session
// is closed when a take-back finishes, on Close, and whenever the panel is drawn afresh.
const tb = { session: null, jobId: null, kind: null, timer: null };
const TB_SESSION_ID = /^tb_[0-9a-f]{24}$/;
const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted"];
const TAKEBACK_FINE_PRINT =
  "We bring files back and check them. We don't install custom nodes, and we don't say " +
  "whether the workflow will run.";

// ---------------------------------------------------------------- helpers --
const BRIDGE = "/renest/api";

/** Where the engine stands: "ready", "engine_unreachable", "token_missing",
 * "panel_backend_missing" (this file loaded but its Python half did not), or "no_answer".
 *
 * "no_answer" is not a verdict. Only the bridge saying so means the engine is not running;
 * a call that timed out, dropped, or came back as somebody else's error page (a provider's
 * proxy, say) only means this check did not get through. Calling that "not installed" sent
 * people off to reinstall an engine that was running: seen 2026-10-19 on a rented machine,
 * where the check made the moment a run finished did not answer within 5 s and the panel
 * swapped "That run worked" for the install guide, twice. So: ask again, waiting longer
 * each time, and say "couldn't reach" rather than "not installed" if it still fails. */
const PROBE_WAITS_MS = [5000, 10000, 15000];
const PROBE_PAUSE_MS = 1500;
let engineSeenReady = false;

async function probeOnce(ms) {
  let r;
  try {
    r = await api.fetchApi(`${BRIDGE}/health`, { signal: AbortSignal.timeout(ms) });
  } catch {
    return "no_answer";
  }
  if (r.ok) return "ready";
  let body = {};
  try { body = await r.json(); } catch { /* not ours */ }
  if (body.renest_bridge_error) return body.renest_bridge_error;
  return r.status === 404 ? "panel_backend_missing" : "no_answer";
}

async function engineState(onRetry) {
  for (let i = 0; i < PROBE_WAITS_MS.length; i++) {
    if (i > 0) {
      if (onRetry) onRetry(i);
      // A drop or a proxy's instant error page fails in milliseconds; without a pause all
      // three tries would be spent before a brief interruption has had time to pass.
      await new Promise((resolve) => setTimeout(resolve, PROBE_PAUSE_MS));
    }
    const state = await probeOnce(PROBE_WAITS_MS[i]);
    if (state !== "no_answer") {
      if (state === "ready") engineSeenReady = true;
      return state;
    }
  }
  return "no_answer";
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

/** The ways forward the Renest service offered with a refusal, as links. The engine
 * already dropped anything that is not a web page; checked again here, because a link
 * is the one place a stray scheme could run code. */
function drawActions(parent, actions) {
  if (!Array.isArray(actions)) return;
  const row = el("div", "display:flex;flex-wrap:wrap;gap:12px;margin-top:8px");
  for (const a of actions.slice(0, 4)) {
    const href = safeHttpUrl(a && a.url);
    const label = a && typeof a.label === "string" ? a.label : "";
    if (href && label) row.appendChild(linkOut(href, label));
  }
  if (row.childNodes.length) parent.appendChild(row);
}

/** The free way out: pack the same run onto this machine's disk instead. */
function localInsteadBtn(out, ctx) {
  const b = el("button", S.sec + ";margin-top:10px", "Save on this machine instead");
  b.onclick = () => startPack(out, ctx.recipe, ctx.name, "local", ctx);
  return b;
}

/** This machine has no Renest sign-in: say so, hand over the one command, and point
 * someone without an account at the sign-up page. */
function drawSignIn(out, message, ctx) {
  out.replaceChildren();
  const box = el("div", S.box);
  box.appendChild(el("div", "font-weight:600", "Sign this machine in first"));
  box.appendChild(el("p", S.sub + ";margin-top:4px", message ||
    "This machine is not signed in to Renest. In its terminal, run:"));
  const c = el("code", S.code, LOGIN_CMD);
  c.appendChild(copyBtn(LOGIN_CMD));
  box.appendChild(c);
  box.appendChild(el("p", S.sub + ";margin-top:8px",
    `It shows a code to approve in your browser. Then press "${(ctx && ctx.again) || SAVE_LABEL}" again.`));
  const signUp = el("p", S.sub + ";margin-top:8px", "No Renest account yet? ");
  signUp.appendChild(linkOut(REGISTER_URL, "Create one"));
  box.appendChild(signUp);
  out.appendChild(box);
  if (ctx && ctx.recipe) out.appendChild(localInsteadBtn(out, ctx));
}

/** Start the real pack of a previewed run. ``destination`` is "drive" or "local"; the
 * machine decides everything else (see the bridge). */
async function startPack(out, recipe, name, destination, ctx) {
  const job = { ...(ctx || {}), recipe, name, destination };
  try {
    // The preview was of the canvas as it was then. Switching tabs or editing since
    // would otherwise nest the old graph under a list that no longer matches it.
    const now = await app.graphToPrompt();
    if (graphKey(now.output) !== graphKey(recipe.workflow)) {
      out.replaceChildren(el("p", "opacity:.75",
        `The canvas changed after this preview. Press "${job.again || SAVE_LABEL}" again to preview what is there now.`));
      return false;
    }
    const body = { ...recipe, name, destination };
    const res = await serveFetch("/pack", { method: "POST", body: JSON.stringify(body) });
    followJob(out, res.job_id, job);
    return true;
  } catch (e) {
    if (e.errorClass === "NOT_SIGNED_IN") {
      drawSignIn(out, e.message, job);
      return false;
    }
    out.appendChild(el("p", "color:#e5484d", `Couldn't start: ${e.message}`));
    return false;
  }
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
  // Drawn afresh (opened, a tab switched, "Check again"): whatever take-back was showing
  // is gone from the screen, so its session goes too.
  endTakeback();
  panelEl.replaceChildren();
  const root = el("div", S.root);
  panelEl.appendChild(root);
  drawInto(root);
}

/** Two section headings, Save and Take back. Plain buttons: no framework in here. */
function drawTabsInto() {
  const bar = el("div", "display:flex;gap:4px;border-bottom:1px solid #444");
  for (const [id, label] of [["save", "Save"], ["takeback", "Take back"]]) {
    const on = activeTab === id;
    const b = el("button",
      "padding:6px 12px;font-size:13px;cursor:pointer;background:transparent;color:inherit;" +
      "border:none;border-bottom:2px solid " + (on ? "#2E8B6E" : "transparent") +
      ";font-weight:" + (on ? "700" : "400") + ";opacity:" + (on ? "1" : ".7"), label);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.onclick = () => {
      if (activeTab === id) return;
      activeTab = id;
      render();
    };
    bar.appendChild(b);
  }
  return bar;
}

async function drawInto(root) {
  root.appendChild(el("h3", S.h, "Renest"));
  const status = el("p", S.sub, "Checking the local Renest engine…");
  root.appendChild(status);

  const state = await engineState(() => {
    status.textContent = "Still checking the local Renest engine — it is taking longer than usual…";
  });
  if (state === "no_answer") {
    // Not "isn't installed": nothing said so. Most often a slow or busy link for a moment.
    status.textContent = engineSeenReady
      ? "Couldn't reach the Renest engine just now. It was answering a moment ago — this is usually a slow connection to this machine."
      : "Couldn't reach the Renest engine through ComfyUI just now. This is usually a slow connection to this machine.";
    const retry = el("button", S.sec, "Check again");
    retry.onclick = render;
    root.appendChild(retry);
    return;
  }
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

  root.insertBefore(drawTabsInto(), status);
  if (activeTab === "takeback") {
    status.remove();
    drawTakeback(root);
    return;
  }

  status.textContent = lastRunFlag
    ? "That run worked — you can nest it now."
    : "Engine ready. Run your workflow once; when it finishes, you can save it.";

  // One way in (founder 2026-10-19): only a workflow that just ran to the end is saved.
  // What a nest is worth is the environment facts caught at that run, not the files alone.
  root.appendChild(el("div", "font-weight:600", SAVE_LABEL));
  root.appendChild(el("p", S.sub + ";font-size:12px",
    "Saves the workflow on the canvas with the models, custom nodes and locked dependencies " +
    "behind the run that just finished, and takes it back into this ComfyUI later from the " +
    "Take back tab."));
  const nestBtn = el("button", S.pri, SAVE_LABEL);
  root.appendChild(nestBtn);
  const out = el("div", "");
  root.appendChild(out);
  root.appendChild(el("p", S.sub + ";font-size:11px",
    "Files are checked byte for byte. Taking them back later does not promise the workflow will run."));

  nestBtn.onclick = async () => {
    nestBtn.disabled = true;
    nestBtn.textContent = "Previewing…";
    out.replaceChildren();
    try {
      const prompt = await app.graphToPrompt();
      if (!prompt.output || Object.keys(prompt.output).length === 0) {
        out.appendChild(el("p", "opacity:.75",
          "The canvas is empty — load or build a workflow first. Renest saves runs that work; there's nothing to save yet."));
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
      drawPreview(out, preview, recipe, {
        again: SAVE_LABEL, cleanable: true, models: (preview.items || {}).models || [],
      });
    } catch (e) {
      out.appendChild(el("p", "color:#e5484d", `Preview failed: ${e.message}`));
    } finally {
      nestBtn.disabled = false;
      nestBtn.textContent = SAVE_LABEL;
    }
  };
}

/** A list that shows its first few rows and opens the rest on a click — "… and 3 more"
 * that cannot be opened hides exactly the lines someone was looking for. */
function rowsWithMore(parent, rows, limit = 6) {
  rows.slice(0, limit).forEach((r) => parent.appendChild(r));
  if (rows.length <= limit) return;
  const more = el("button",
    "align-self:flex-start;padding:0;margin-top:2px;font-size:11px;cursor:pointer;border:none;" +
    "background:transparent;color:#4cc38a;text-decoration:underline", `Show ${rows.length - limit} more`);
  more.onclick = () => {
    rows.slice(limit).forEach((r) => parent.insertBefore(r, more));
    more.remove();
  };
  parent.appendChild(more);
}

/** A path that wraps after a slash rather than mid-name, and copies as typed. */
function pathNode(path, style) {
  const span = el("span", style);
  String(path).split("/").forEach((part, i, all) => {
    span.appendChild(document.createTextNode(part + (i < all.length - 1 ? "/" : "")));
    if (i < all.length - 1) span.appendChild(document.createElement("wbr"));
  });
  return span;
}

/** One "label … value" line; the value may wrap, the label never does. A null label
 * leaves no indent (a line of its own rather than one under a heading). */
function factRow(label, value, valueStyle = "") {
  const row = el("div", "display:flex;gap:10px;padding:2px 0;align-items:baseline");
  if (label !== null) row.appendChild(el("span", "flex:none;min-width:96px;opacity:.8", label));
  row.appendChild(el("span", "min-width:0;overflow-wrap:anywhere;" + valueStyle, value));
  return row;
}

/** The files a drive save has checked, offered for the person to clear themselves. */
function cleanableBlock(models) {
  const box = el("div", S.box + ";margin-top:8px;display:flex;flex-direction:column;gap:4px");
  box.appendChild(el("p", "margin:0",
    "These files are now on your drive, checked byte for byte. If you want the space back, " +
    "you can delete them from this machine yourself — Take back brings them back later."));
  const rows = models.map((m) => {
    const size = m.size_bytes ?? m.approx_bytes;
    const row = el("div", "display:flex;gap:10px;padding:2px 0;align-items:baseline;" +
      "font-family:monospace;font-size:11px;opacity:.85");
    row.append(pathNode(m.path || m.name || "?", "min-width:0;flex:1;overflow-wrap:anywhere"),
      el("span", "flex:none", size ? fmtBytes(size) : ""));
    return row;
  });
  rowsWithMore(box, rows);
  const total = models.reduce((n, m) => n + (Number(m.size_bytes ?? m.approx_bytes) || 0), 0);
  box.appendChild(el("div", "font-size:11px;opacity:.6",
    `${models.length} file${models.length === 1 ? "" : "s"} · ${fmtBytes(total)}`));
  box.appendChild(el("p", S.sub + ";font-size:11px;margin-top:4px",
    "Workflows you haven't saved are not checked. Renest never deletes files here."));
  return box;
}

function drawPreview(out, preview, recipe, opts = {}) {
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
    "Save it to your Renest drive (needs a subscription; you approve each upload once, " +
    "in your browser), or keep it on this machine only, free."));

  const nameInput = el("input",
    "width:100%;box-sizing:border-box;margin-top:10px;padding:8px 10px;font-size:13px;" +
    "border:1px solid #555;border-radius:6px;background:transparent;color:inherit");
  nameInput.value = withLocalDate(preview.default_name) || "my-run";
  out.appendChild(nameInput);
  const buttons = el("div", "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px");
  const toDrive = el("button", S.pri, "Save to my Renest drive");
  const toLocal = el("button", S.sec, "Save on this machine only");
  buttons.append(toDrive, toLocal);
  out.appendChild(buttons);

  const ctx = { ...opts, outDir: preview.out_dir };
  const go = async (btn, destination) => {
    const label = btn.textContent;
    toDrive.disabled = toLocal.disabled = true;
    btn.textContent = "Starting…";
    const started = await startPack(out, recipe, nameInput.value.trim() || undefined,
      destination, ctx);
    if (!started && btn.isConnected) {
      toDrive.disabled = toLocal.disabled = false;
      btn.textContent = label;
    }
  };
  toDrive.onclick = () => go(toDrive, "drive");
  toLocal.onclick = () => go(toLocal, "local");
}

// Turn the engine's NDJSON log tail into plain sentences. Anything we don't
// recognise is dropped rather than dumped: a user watching a 20 GB copy should
// see what is happening, not our wire format.
function humanLog(lines, withInfo = false) {
  const out = [];
  for (const raw of lines.slice(-20)) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.type === "stage_start" && e.desc) out.push(e.desc);
    else if (e.type === "warning" && (e.human || e.message)) out.push(e.human || e.message);
    else if (e.type === "stage_end" && e.desc) out.push(`${e.desc} — done`);
    else if (withInfo && e.type === "info" && e.human) out.push(e.human);
  }
  return out.slice(-4).join("\n");
}

/** The short code to approve in the browser — the same box for an upload and a take-back. */
function drawApproval(waiting, approval, heading) {
  waiting.replaceChildren();
  waiting.appendChild(el("div", "font-weight:600", heading));
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

/** The engine's four packing stages, as a person would name them (serve-api.md §4.1). */
const PACK_STAGES = {
  P1: "Reading and copying what the run used",
  P2: "Writing the manifest",
  P3: "Uploading",
  P4: "Checking with the drive",
};

function followJob(out, jobId, ctx = {}) {
  const local = ctx.destination === "local";
  out.replaceChildren();
  // "Packing…" for a nest kept here; "Saving…" when it is going to the drive, so the
  // heading and the "Uploading" stage line read as one thing, not two.
  const busyHead = local ? "Packing…" : "Saving to your Renest drive…";
  const head = el("div", "font-weight:600", busyHead);
  const stageLine = el("div", S.sub, "Waiting to start");
  const bar = el("div", "height:6px;border-radius:3px;background:#333;overflow:hidden;margin:8px 0");
  const fill = el("div", "height:100%;width:0%;background:#2E8B6E;transition:width .4s");
  bar.appendChild(fill);
  const log = el("div", S.log, "");
  // An empty log box reads as a blank square above Cancel (founder's real run,
  // 2026-10-19): it only shows once there is a sentence in it.
  log.style.display = "none";
  const cancel = el("button", S.sec, "Cancel");
  // Shown while the engine waits for the upload to be approved in the browser.
  const waiting = el("div", S.box);
  waiting.style.display = "none";
  out.append(head, waiting, stageLine, bar, log, cancel);
  let shownCode = null;

  function showApproval(approval) {
    if (shownCode === approval.user_code) return;
    shownCode = approval.user_code;
    drawApproval(waiting, approval, "Approve this upload");
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
      log.style.display = "none";
      stageLine.textContent = "";
      showApproval(job.approval);
      return;
    }
    if (shownCode !== null) {
      waiting.style.display = "none";
      bar.style.display = "";
      head.textContent = busyHead;
    }
    const p = job.progress || {};
    // The stage in words, never its internal code ("stage P1" meant nothing to anyone).
    stageLine.textContent = (job.state === "queued" ? "Waiting to start"
      : PACK_STAGES[job.stage] || "Working…") +
      (p.speed_mbps ? ` · ${p.speed_mbps.toFixed(0)} Mbps` : "");
    if (p.percent != null) fill.style.width = `${Math.round(p.percent)}%`;
    // The engine's log is machine-readable NDJSON. Printing it raw put lines like
    // {"type":"progress","bytes_total":797842085288} on screen (seen on a real run,
    // 2026-08-15) — so keep the last few and show only the sentence inside each.
    if (Array.isArray(job.logs_tail)) log.textContent = humanLog(job.logs_tail);
    log.style.display = log.textContent ? "" : "none";
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)) {
      clearInterval(pollTimer);
      cancel.remove();
      waiting.remove();
      bar.style.display = "";
      if (job.state === "succeeded" && local) {
        fill.style.width = "100%";
        head.textContent = "✓ Saved on this machine only";
        const result = job.result || {};
        const where = result.manifest_path
          ? result.manifest_path.replace(/\/manifest\.json$/, "")
          : (ctx.outDir || "the folder shown in the preview");
        // Honest about what "on this machine" means on a rented one: nothing here
        // outlives the machine unless the person copies it off.
        stageLine.textContent = `Saved on this machine only, at ${where}. It is gone when ` +
          "this machine is. To keep it, copy that folder off the machine — or save it to " +
          "your Renest drive.";
        stageLine.style.overflowWrap = "anywhere";
        out.insertBefore(linkOut(LOCAL_NEST_DOCS_URL, "How to keep or move a nest"), log);
        log.remove();
        toast("success", "Saved on this machine only", "Copy its folder off this machine to keep it.");
      } else if (job.state === "succeeded" && ((job.result || {}).drive || {}).verdict === "pending") {
        // Every byte is up; the drive's own check outran the engine's wait. Not a
        // failure and not yet "verified": said plainly, with a link to watch it.
        fill.style.width = "100%";
        head.textContent = "Uploaded — still being checked on your drive";
        const drive = (job.result || {}).drive || {};
        stageLine.textContent = "Every file is on your drive. It shows as verified there once the check " +
          "finishes. Do not upload it again.";
        const href = safeHttpUrl(drive.console_url);
        if (href) out.insertBefore(linkOut(href, "Open it on your Renest drive"), log);
        log.remove();
        toast("info", "Uploaded, still being checked", "It will show as verified in your drive.");
      } else if (job.state === "succeeded") {
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
        // "Nest this run": once the service has checked the upload (a drive result
        // is there), say which files are now safe to clear — the person clears them.
        // Prefer what the engine read off the checked nest (absolute paths on this machine);
        // the preview's model table is the fallback for an engine that does not send it.
        const engineList = result.local_copy && Array.isArray(result.local_copy.cleanable_files)
          ? result.local_copy.cleanable_files : null;
        const toClear = engineList && engineList.length ? engineList : ctx.models;
        if (ctx.cleanable && result.drive && Array.isArray(toClear) && toClear.length) {
          out.insertBefore(cleanableBlock(toClear), log);
        }
        // Earlier saves the drive had not finished checking keep their copies beside
        // ComfyUI until a take-back sees them checked: said here, so they are never silent.
        const pendingEarlier = Number((result.local_copy || {}).pending_earlier) || 0;
        if (pendingEarlier) {
          out.insertBefore(el("p", S.sub + ";font-size:11px;margin-top:4px",
            `${pendingEarlier} earlier save${pendingEarlier === 1 ? " was" : "s were"} still being ` +
            "checked by your drive; the copies kept beside ComfyUI stay until a take-back " +
            "confirms them."), log);
        }
        // Drop the running trace only after the path is in — it is inserted relative
        // to this element, so removing it first threw and took the path (and the
        // toast) down with it. Caught by looking at the screenshot, not by a test.
        log.remove();
        toast("success", "Saved to your Renest drive", "Files and dependencies checked and uploaded.");
      } else if ((job.error || {}).error_class === "NOT_SIGNED_IN") {
        clearInterval(pollTimer);
        drawSignIn(out, job.error.human, ctx);
      } else {
        const err = job.error || {};
        const refused = job.state === "failed"
          && (DRIVE_REFUSALS.has(err.error_class) || err.error_class === DRIVE_REJECTED);
        head.textContent = refused ? "Your Renest drive did not take this nest"
          : job.state === "failed" ? "✗ Packing failed" : `Stopped (${job.state})`;
        stageLine.textContent = err.human || err.detail || (job.state === "cancelled"
          ? (local ? "Cancelled. Nothing from this run was saved."
            : "Cancelled. Nothing from this run was saved to your drive.")
          : "See the log below.");
        // The service's ways forward (see plans, make room), then the free way out.
        const extra = el("div", "");
        drawActions(extra, err.actions);
        if (refused && !local && ctx.recipe) extra.appendChild(localInsteadBtn(out, ctx));
        if (extra.childNodes.length) out.insertBefore(extra, log);
        // An empty or half-filled bar under "did not take this nest" reads as work still
        // going on. Only a finished save keeps it.
        bar.remove();
        // A cancelled run's last log line is whatever it was doing when stopped ("Waiting
        // for you to approve…"), which reads as if it still is. Failures keep theirs: there
        // the log is the explanation. A refusal is explained by the service's own sentence,
        // and its log ends on "waiting for approval", so it goes too.
        if (job.state === "cancelled") log.remove();
        else if (refused) log.remove();
        if (job.state === "failed") toast("error", refused ? "Not saved to your drive" : "Packing failed",
          stageLine.textContent);
      }
    }
  }, 1000);
}

// -------------------------------------------------------------- take back --
/** Close the take-back session at the engine, which revokes its permission at the
 * service. Fire and forget: a session nobody closes runs out on its own. */
function closeSession(keepalive = false) {
  const id = tb.session;
  tb.session = null;
  if (!id || !TB_SESSION_ID.test(id)) return;
  serveFetch(`/takeback/sessions/${id}`, { method: "DELETE", keepalive }).catch(() => {});
}

/** Whatever take-back the panel was showing is over. A fetch already bringing files back
 * is left to finish: stopping it halfway helps nobody, and it closes its own session. */
function endTakeback(keepalive = false) {
  if (tb.kind === "fetch" && tb.jobId) return;
  if (tb.kind === "session" && tb.jobId) {
    // Still waiting for the approval: withdraw it, so the code stops working.
    serveFetch(`/jobs/${tb.jobId}`, { method: "DELETE", keepalive }).catch(() => {});
  }
  clearInterval(tb.timer);
  tb.timer = null;
  tb.jobId = null;
  tb.kind = null;
  closeSession(keepalive);
}

/** Follow one take-back job. Its own timer, so a save on the other tab is untouched. */
function pollTakebackJob(jobId, kind, on) {
  clearInterval(tb.timer);
  tb.jobId = jobId;
  tb.kind = kind;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let job;
      try { job = await serveFetch(`/jobs/${jobId}`); }
      catch (e) { if (on.pollError) on.pollError(e); return; }
      if (tb.jobId !== jobId) { clearInterval(timer); return; }
      if (job.approval && job.state === "running") { if (on.approval) on.approval(job.approval); return; }
      if (TERMINAL.includes(job.state)) {
        clearInterval(timer);
        tb.timer = null;
        tb.jobId = null;
        tb.kind = null;
        on.done(job);
        return;
      }
      if (on.progress) on.progress(job);
    } finally {
      busy = false;
    }
  }, 1000);
  tb.timer = timer;
}

const SHOW_SAVED = "Show my saved workflows";

function drawTakeback(root) {
  root.appendChild(el("div", "font-weight:600", "Take back a workflow"));
  root.appendChild(el("p", S.sub + ";font-size:12px",
    "Brings a saved workflow and its files back into this ComfyUI, and says what changed " +
    "on this machine since it was saved. You approve it once, in your browser."));
  const out = el("div", "display:flex;flex-direction:column;gap:8px");
  root.appendChild(out);
  drawTakebackStart(out);
}

function drawTakebackStart(out) {
  out.replaceChildren();
  const show = el("button", S.pri + ";align-self:flex-start", SHOW_SAVED);
  show.onclick = () => openTakeback(out);
  out.appendChild(show);
}

/** A take-back that did not go through: the engine's sentence, the service's ways
 * forward, and a way back to the start. */
function drawTakebackError(out, title, err) {
  out.replaceChildren();
  out.appendChild(el("div", "font-weight:600", title));
  out.appendChild(el("p", S.sub, (err && (err.human || err.detail)) ||
    "The Renest engine did not say why."));
  const extra = el("div", "");
  drawActions(extra, err && err.actions);
  if (extra.childNodes.length) out.appendChild(extra);
  const again = el("button", S.sec + ";align-self:flex-start", "Start again");
  again.onclick = () => { endTakeback(); drawTakebackStart(out); };
  out.appendChild(again);
}

async function openTakeback(out) {
  endTakeback();
  out.replaceChildren(el("p", S.sub, "Asking the Renest engine…"));
  let res;
  try {
    res = await serveFetch("/takeback/sessions", { method: "POST", body: "{}" });
  } catch (e) {
    if (e.errorClass === "NOT_SIGNED_IN") {
      drawSignIn(out, e.message, { again: SHOW_SAVED });
      return;
    }
    drawTakebackError(out, "Couldn't start", { human: e.message });
    return;
  }
  const head = el("div", "font-weight:600", "Opening your saved workflows…");
  const waiting = el("div", S.box);
  waiting.style.display = "none";
  const line = el("div", S.sub, "");
  const cancel = el("button", S.sec + ";align-self:flex-start", "Cancel");
  out.replaceChildren(head, waiting, line, cancel);
  let shownCode = null;
  cancel.onclick = async () => {
    try { await serveFetch(`/jobs/${res.job_id}`, { method: "DELETE" }); } catch { /* already done */ }
  };
  pollTakebackJob(res.job_id, "session", {
    approval(approval) {
      head.textContent = "Waiting for approval";
      line.textContent = "";
      if (shownCode === approval.user_code) return;
      shownCode = approval.user_code;
      drawApproval(waiting, approval, "Approve this take-back");
    },
    pollError(e) { line.textContent = `Couldn't check on it just now: ${e.message}`; },
    progress() {
      if (shownCode !== null) {
        waiting.style.display = "none";
        head.textContent = "Approved — listing your saved workflows…";
      }
    },
    done(job) {
      const result = job.result || {};
      if (job.state === "succeeded" && TB_SESSION_ID.test(String(result.session_id || ""))) {
        tb.session = result.session_id;
        if (out.isConnected) drawNestList(out, Array.isArray(result.nests) ? result.nests : []);
        else closeSession();
        return;
      }
      if (!out.isConnected) return;
      const err = job.error || {};
      if (err.error_class === "NOT_SIGNED_IN") {
        drawSignIn(out, err.human, { again: SHOW_SAVED });
        return;
      }
      if (job.state === "cancelled") {
        drawTakebackError(out, "Stopped", { human: "Cancelled. Nothing was listed or fetched." });
        return;
      }
      drawTakebackError(out, "Couldn't list your saved workflows", err);
    },
  });
}

function closeBtn(out, label = "Close") {
  const b = el("button", S.sec + ";align-self:flex-start", label);
  b.onclick = () => { endTakeback(); drawTakebackStart(out); };
  return b;
}

function drawNestList(out, nests) {
  out.replaceChildren();
  out.appendChild(el("div", "font-weight:600", "Your saved workflows"));
  if (!nests.length) {
    out.appendChild(el("p", S.sub, "Your Renest drive has no saved workflows yet."));
    out.appendChild(closeBtn(out));
    return;
  }
  const box = el("div", S.box + ";display:flex;flex-direction:column");
  const rows = nests.map((n) => {
    const row = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;" +
      "padding:6px 0;border-bottom:1px solid #333");
    row.appendChild(el("span", "flex:1 1 140px;min-width:0;overflow-wrap:anywhere;font-weight:600",
      n.name || "(no name)"));
    const tag = n.ran === true ? "ran to completion" : n.ran === false ? "not run" : null;
    if (tag) row.appendChild(el("span", "font-size:11px;opacity:.75;flex:none", tag));
    row.appendChild(el("span", "font-family:monospace;font-size:11px;opacity:.75;flex:none",
      fmtBytes(n.size_bytes)));
    const cmp = el("button", S.sec + ";padding:4px 10px;font-size:12px;flex:none",
      "Compare with this machine");
    if (!n.head_version_id) {
      cmp.disabled = true;
      cmp.title = "This saved workflow has no finished version to take back.";
    }
    cmp.onclick = () => runTakeback(out, n, "compare");
    row.appendChild(cmp);
    return row;
  });
  rowsWithMore(box, rows, 10);
  out.appendChild(box);
  out.appendChild(closeBtn(out));
}

async function runTakeback(out, nest, mode) {
  const fetching = mode === "fetch";
  out.replaceChildren();
  const head = el("div", "font-weight:600", fetching
    ? `Bringing back the files of ${nest.name || "this workflow"}…`
    : `Comparing ${nest.name || "this workflow"} with this machine…`);
  const line = el("div", S.sub, "");
  const bar = el("div", "height:6px;border-radius:3px;background:#333;overflow:hidden;margin:4px 0");
  const fill = el("div", "height:100%;width:0%;background:#2E8B6E;transition:width .4s");
  bar.appendChild(fill);
  const log = el("div", S.log, "");
  out.append(head, line);
  if (fetching) out.append(bar, log);
  if (!tb.session) {
    drawTakebackError(out, "This take-back has ended", {
      human: `Press "${SHOW_SAVED}" to approve a new one.` });
    return;
  }
  let res;
  try {
    res = await serveFetch("/takeback", { method: "POST", body: JSON.stringify({
      session_id: tb.session, nest_version_id: nest.head_version_id, mode }) });
  } catch (e) {
    drawTakebackError(out, "Couldn't start", { human: e.message });
    return;
  }
  pollTakebackJob(res.job_id, mode, {
    pollError(e) { line.textContent = `Couldn't check on it just now: ${e.message}`; },
    progress(job) {
      const p = job.progress || {};
      if (p.percent != null) fill.style.width = `${Math.round(p.percent)}%`;
      if (Array.isArray(job.logs_tail)) log.textContent = humanLog(job.logs_tail, true);
    },
    done(job) {
      // Bringing files back is the end of a take-back: the session closes either way.
      if (fetching) closeSession();
      if (!out.isConnected) return;
      const err = job.error || {};
      if (err.error_class === "TAKEBACK_SESSION_GONE") tb.session = null;
      if (job.state !== "succeeded") {
        drawTakebackError(out, job.state === "cancelled" ? "Stopped"
          : fetching ? "Couldn't bring the files back" : "Couldn't compare", err);
        return;
      }
      const result = job.result || {};
      if (fetching) drawFetched(out, nest, result);
      else drawReport(out, nest, result);
    },
  });
}

const shortId = (v) => (typeof v === "string" && /^[0-9a-f]{12,}$/.test(v) ? v.slice(0, 10) : v);
const bareHost = (u) => (typeof u === "string" ? u.replace(/^https?:\/\//, "").replace(/\.git$/, "") : "");

/** then → now, in words: unchanged, was … · now …, or what was not recorded. */
function thenNow(fact, show = (v) => String(v)) {
  const f = fact || {};
  const has = (v) => v !== null && v !== undefined && v !== "";
  if (f.state === "unchanged") return `unchanged (${show(f.then)})`;
  if (f.state === "changed") return `was ${show(f.then)} · now ${show(f.now)}`;
  if (has(f.then)) return `was ${show(f.then)} · now could not be read`;
  if (has(f.now)) return `now ${show(f.now)} · not recorded when it was saved`;
  return "not recorded";
}

function describePack(side) {
  if (!side) return "not installed";
  const id = side.version || shortId(side.commit);
  const where = bareHost(side.repo_url);
  if (id && where) return `${id} (${where})`;
  return id || where || "no version found";
}

/** "<path>: not handed out — get it yourself from <link>". The address is the file's
 * own origin, recorded at packing; only a web page is ever made a link. */
function withheldRow(path, originUrl, label = "") {
  const row = factRow(label, "", "font-size:12px");
  row.lastChild.appendChild(document.createTextNode(`${path}: not handed out — get it yourself from `));
  const href = safeHttpUrl(originUrl);
  row.lastChild.appendChild(href ? linkOut(href, href) : document.createTextNode("its source"));
  return row;
}

function drawReport(out, nest, result) {
  const rep = result.report || {};
  out.replaceChildren();
  out.appendChild(el("div", "font-weight:600", "What changed since it was saved"));
  out.appendChild(el("div", S.sub + ";font-size:12px", nest.name || ""));
  const box = el("div", S.box + ";display:flex;flex-direction:column;gap:2px");

  box.appendChild(factRow("ComfyUI", thenNow(rep.comfyui, shortId)));
  box.appendChild(factRow("Python", thenNow(rep.python)));
  const pk = rep.packages || {};
  if (pk.state === "unchanged") {
    box.appendChild(factRow("Packages", "unchanged"));
  } else if (pk.state === "changed") {
    // torch and its family one line each; the rest as counts.
    for (const c of pk.shown || []) box.appendChild(factRow(c.name, `was ${c.then} · now ${c.now}`));
    const bits = [];
    if (pk.other_changed) bits.push(`${pk.other_changed} other${pk.other_changed === 1 ? "" : "s"} at a different version`);
    if (pk.added) bits.push(`${pk.added} added since`);
    if (pk.removed) bits.push(`${pk.removed} no longer installed`);
    if (bits.length) box.appendChild(factRow("Packages", bits.join(" · ")));
  } else {
    box.appendChild(factRow("Packages", `not compared${pk.why ? ` — ${pk.why}` : ""}`));
  }
  const gpu = rep.gpu || {};
  if (gpu.then || gpu.now) box.appendChild(factRow("GPU", thenNow(gpu)));

  // Custom nodes: how many of the ones it used are here, and a line for each that is not
  // the same as then.
  const packs = Array.isArray(rep.node_packs) ? rep.node_packs : [];
  if (packs.length) {
    const present = packs.filter((p) => p.state !== "missing").length;
    box.appendChild(factRow("Custom nodes", `${present} of ${packs.length} present`));
    const lines = packs.filter((p) => p.state === "missing" || p.state === "changed").map((p) =>
      factRow("", `${p.dir}: was ${describePack(p.then)} · now ${p.state === "missing"
        ? "not installed" : describePack(p.now)}`, "font-size:12px"));
    rowsWithMore(box, lines);
  } else {
    box.appendChild(factRow("Custom nodes", "none recorded for this workflow"));
  }

  const files = Array.isArray(rep.files) ? rep.files : [];
  const c = rep.counts || {};
  const sum = [`${c.unchanged || 0} unchanged`, `${c.missing || 0} missing`,
    `${c.different_here || 0} different here`];
  if (c.withheld) sum.push(`${c.withheld} not handed out`);
  box.appendChild(factRow("Files", sum.join(" · ")));
  const fileLines = [];
  for (const f of files) {
    if (f.state === "missing") {
      fileLines.push(factRow("", `${f.path}: missing — will be fetched (${fmtBytes(f.size_bytes)})`,
        "font-size:12px"));
    } else if (f.state === "different_here") {
      fileLines.push(factRow("", `${f.path}: different bytes here — yours will be kept, ours lands beside it`,
        "font-size:12px"));
    } else if (f.state === "withheld") {
      fileLines.push(withheldRow(f.path, f.origin_url));
    } else if (f.state === "refused") {
      fileLines.push(factRow("", `${f.path}: refused — ${f.why || "it would be placed where files get run as code"}`,
        "font-size:12px;color:#e5484d"));
    } else if (f.state === "sidebar_workflow") {
      fileLines.push(factRow("", `${f.path}: the workflow — goes to your Workflows list`,
        "font-size:12px"));
    } else if (f.state === "not_placeable") {
      fileLines.push(factRow("", `${f.path}: can't be placed inside this ComfyUI folder — left out`,
        "font-size:12px"));
    }
  }
  rowsWithMore(box, fileLines);
  out.appendChild(box);

  const buttons = el("div", "display:flex;flex-wrap:wrap;gap:8px");
  const bring = el("button", S.pri, "Bring the missing files back");
  bring.onclick = () => runTakeback(out, nest, "fetch");
  buttons.append(bring, closeBtn(out));
  out.appendChild(buttons);
  out.appendChild(el("p", S.sub + ";font-size:11px", TAKEBACK_FINE_PRINT));
}

function drawFetched(out, nest, result) {
  const o = result.outcome || {};
  out.replaceChildren();
  // The heading tells the truth about the count: nothing fetched and something failed
  // is not "files back" (real-stack acceptance, 2026-10-19, offline fetch).
  const failed = Number(o.failed) || 0;
  const fetched = Number(o.fetched) || 0;
  const head = failed && !fetched ? `✗ ${nest.name || "Workflow"}: couldn't bring the files back`
    : failed ? `⚠ ${nest.name || "Workflow"}: some files back, ${failed} couldn't be fetched`
    : `✓ ${nest.name || "Workflow"}: files back`;
  out.appendChild(el("div", "font-weight:600", head));
  let said = `Files back: ${o.fetched || 0} fetched, ${o.already_here || 0} already here, ` +
    `${o.kept_yours || 0} kept yours (see .renest/kept).`;
  said += o.sidebar_workflow ? " Workflow added to your Workflows list."
    : " This save had no editor copy of the workflow, so nothing was added to your Workflows list.";
  out.appendChild(el("p", "margin:0", said));
  const box = el("div", "display:flex;flex-direction:column;gap:2px");
  const lines = [];
  for (const w of o.withheld_files || []) lines.push(withheldRow(w.path, w.origin_url, null));
  for (const f of o.failed_files || []) {
    lines.push(factRow(null, `${f.path}: couldn't be fetched (${f.why || "no reason given"})`,
      "font-size:12px;color:#e5484d"));
  }
  rowsWithMore(box, lines);
  if (lines.length) out.appendChild(box);
  if (result.report_path) {
    const where = el("div", "font-size:11px;opacity:.6", "The full report is at");
    where.appendChild(el("div", "font-family:monospace;overflow-wrap:anywhere;opacity:.9",
      result.report_path));
    out.appendChild(where);
  }
  out.appendChild(el("p", S.sub + ";font-size:11px", TAKEBACK_FINE_PRINT));
  out.appendChild(closeBtn(out, "Done"));
  toast("success", "Files back", `${o.fetched || 0} fetched, checked byte for byte.`);
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
    // Leaving the page ends a take-back too; keepalive lets the close go out as it unloads.
    window.addEventListener("pagehide", () => endTakeback(true));
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
      // Not while a take-back is on screen: redrawing would throw away its list and report.
      if (panelEl && activeTab === "save") render();
    });
  },
});
