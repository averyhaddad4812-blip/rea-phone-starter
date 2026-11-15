// REA Studio phone app. Plain JavaScript, no build step.
"use strict";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

const state = {
  passcode: store.get("passcode", ""),
  view: "home", prevView: "home",
  homeMode: "build",
  brainShort: "Claude",
  // Study
  chats: store.get("chats", {}), current: store.get("current", ""), summaries: {}, studying: false,
  // Build
  project: null, projectId: store.get("projectId", ""), job: store.get("job", null), jobInfo: null,
  buildTab: "chat", check: { rev: -1, loaded: false, slow: false, errors: [] },
  inspiredBy: null, // { appId, label }
};

// ---------- talking to the back room ----------

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "x-passcode": state.passcode, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { lock("That passcode didn't work. Try again."); throw new Error("locked"); }
  if (!res.ok) { const e = new Error(data.error || "Something went wrong."); e.status = res.status; throw e; }
  return data;
}

// ---------- tiny DOM helpers (all text goes in as text, never HTML) ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
function svg(paths, cls) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}
const tick = () => svg(["M5 12.5l4.5 4.5L19 7.5"], "tick");
const shield = () => svg(["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M9 12l2 2 4-4"]);
const chevron = () => svg(["M9 6l6 6-6 6"]);
const colour = (text) => `c${[...String(text)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 6}`;
const initial = (text) => String(text || "?").trim().slice(0, 1).toUpperCase();
const cents = (usd) => (usd < 0.01 ? "under 1¢" : `about ${Math.round(usd * 100)}¢`);

// Turn an AI's short markdown into paragraphs and bullet lists, as plain text.
function richText(text) {
  const out = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim().replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/, "");
    if (!line) { list = null; continue; }
    const bullet = line.match(/^(?:[-•*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      if (!list) { list = el("ul"); out.push(list); }
      list.append(el("li", {}, bullet[1]));
    } else { list = null; out.push(el("p", {}, line)); }
  }
  return out;
}

// ---------- navigation ----------

const VIEWS = ["lock", "home", "chat", "report", "build", "settings"];
function show(view) {
  if (view === "chat" && !state.current) { setMode("study"); view = "home"; }
  if (view === "build" && !state.projectId) { setMode("build"); view = "home"; }
  if (view === "report" && !state.summaries[state.current]) view = state.current ? "chat" : "home";
  if (view !== state.view) state.prevView = state.view;
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $("nav").hidden = ["lock", "chat", "build"].includes(view);
  for (const b of document.querySelectorAll("#nav button")) {
    if (b.dataset.go === view || (b.dataset.go === "home" && view === "report")) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (view === "home") renderHome();
  if (view === "chat") renderChat();
  if (view === "report") renderReport();
  if (view === "build") openBuild();
  if (view === "settings") renderSettings();
}

function lock(message) {
  state.passcode = "";
  store.del("passcode");
  $("lock-error").textContent = message || "";
  show("lock");
  $("passcode").focus();
}

function setBrainName(short) {
  state.brainShort = short || state.brainShort;
  for (const n of document.querySelectorAll(".brain-name")) n.textContent = state.brainShort;
}

// ---------- home ----------

function setMode(mode) {
  state.homeMode = mode;
  $("mode-build").setAttribute("aria-selected", String(mode === "build"));
  $("mode-study").setAttribute("aria-selected", String(mode === "study"));
  $("build-form").hidden = mode !== "build";
  $("build-ideas").hidden = mode !== "build";
  $("ask-form").hidden = mode !== "study";
  $("study-ideas").hidden = mode !== "study";
}

function renderInspired() {
  $("inspired").hidden = !state.inspiredBy;
  if (state.inspiredBy) $("inspired-name").textContent = state.inspiredBy.label;
}

async function renderHome() {
  setMode(state.homeMode);
  renderInspired();
  try {
    const [{ reports }, { projects }, status] = await Promise.all([api("/api/reports"), api("/api/projects"), api("/api/status")]);
    setBrainName(status.brain.short);
    $("projects").replaceChildren(...projects.slice(0, 8).map((p) => {
      const busy = state.job && state.job.projectId === p.id;
      const sub = busy ? "Building now…" : p.versionCount ? `Version ${p.versionCount}` : "Not built yet";
      return el("button", { class: "list-item", type: "button", onclick: () => openProject(p.id) },
        el("div", { class: `tile ${colour(p.id)}` }, initial(p.name)),
        el("div", { class: "grow" }, el("b", {}, p.name), el("span", { class: "muted small" }, sub)),
        chevron());
    }));
    $("projects-empty").hidden = projects.length > 0;
    $("recent").replaceChildren(...reports.slice(0, 6).map((r) => {
      state.summaries[r.package] = r;
      const n = r.sensitive_permissions.length;
      const facts = `${r.genuine ? "Genuine" : "Check its signature"}, ${r.uses_internet ? "goes online" : "stays offline"}, ${n} sensitive permission${n === 1 ? "" : "s"}`;
      return el("button", { class: "list-item", type: "button", onclick: () => openApp(r.package) },
        el("div", { class: "tile c4" }, initial(r.label || r.package)),
        el("div", { class: "grow" }, el("b", {}, r.label || r.package), el("span", { class: "muted small" }, facts)),
        chevron());
    }));
    $("recent-empty").hidden = reports.length > 0;
    $("home-spend").textContent = `This month: $${status.spentUsd.toFixed(2)} of your $${status.limitUsd} limit`;
  } catch { /* the lock screen shows a wrong passcode */ }
}

// ---------- Study: REA investigations ----------

function openApp(appId) {
  state.current = appId;
  store.set("current", appId);
  show(state.chats[appId]?.length ? "chat" : "report");
}

const STUDY_STEPS = ["Downloading it from F-Droid", "Checking its digital signature", "Reading permissions and translations", "Asking the AI to explain"];

async function investigate(appId, question) {
  if (state.studying) return;
  state.studying = true;
  state.current = appId;
  store.set("current", appId);
  const chat = state.chats[appId] || (state.chats[appId] = []);
  chat.push({ role: "me", text: question });
  saveChats();
  show("chat");

  const stepEls = STUDY_STEPS.map((s) => el("div", { class: "step" }, el("span", { class: "spin" }), s));
  $("chat-log").append(el("div", { class: "progress" }, el("b", { class: "small muted" }, "REA is studying the app…"), stepEls));
  scrollTo("chat-log");
  let i = 0;
  const timer = setInterval(() => {
    if (i < stepEls.length - 1) { stepEls[i].classList.add("done"); stepEls[i].firstChild.replaceWith(tick()); i++; }
  }, 6000);

  try {
    const r = await api("/api/investigate", { appId, question });
    state.summaries[r.appId] = r.summary;
    if (r.appId !== appId) { state.chats[r.appId] = chat; delete state.chats[appId]; state.current = r.appId; store.set("current", r.appId); }
    chat.push({ role: "ai", safety: r.safety.note, answer: r.answer, limits: r.limits, note: r.aiNote, brain: r.brain,
      checks: r.cached ? ["Used this week's saved check"] : STUDY_STEPS.slice(0, 3) });
  } catch (e) {
    if (e.message !== "locked") chat.push({ role: "ai", note: e.message, checks: [] });
  } finally {
    clearInterval(timer);
    state.studying = false;
    saveChats();
    if (state.view === "chat") renderChat();
  }
}

function saveChats() {
  for (const list of Object.values(state.chats)) if (list.length > 20) list.splice(0, list.length - 20);
  store.set("chats", state.chats);
}

function scrollTo(id) { const n = $(id); n.scrollTop = n.scrollHeight; }

function renderChat() {
  const appId = state.current;
  const s = state.summaries[appId];
  $("chat-title").textContent = s?.label || appId;
  $("chat-sub").textContent = s ? `${s.package}, version ${s.version}` : appId;
  const log = $("chat-log");
  log.replaceChildren();
  for (const m of state.chats[appId] || []) {
    if (m.role === "me") { log.append(el("div", { class: "bubble me" }, m.text)); continue; }
    if (m.safety) {
      log.append(el("div", { class: "safe" }, shield(),
        el("div", {}, el("b", { class: "small block" }, "Safety check passed"), el("span", { class: "muted small" }, m.safety))));
    }
    if (m.checks?.length) {
      log.append(el("div", { class: "progress" }, el("b", { class: "small muted" }, `REA did ${m.checks.length} check${m.checks.length === 1 ? "" : "s"}`),
        m.checks.map((c) => el("div", { class: "step done" }, tick(), c))));
    }
    if (m.answer || m.note) {
      const bubble = el("div", { class: "bubble ai" });
      if (m.answer) bubble.append(...richText(m.answer));
      if (m.note) bubble.append(el("p", { class: "warn" }, m.note));
      if (s) {
        bubble.append(el("div", { class: "evidence" },
          el("button", { type: "button", onclick: () => show("report") }, "Evidence: signature"),
          el("button", { type: "button", onclick: () => show("report") }, "Evidence: permissions")));
      }
      if (m.limits) bubble.append(el("p", { class: "muted small" }, `Limits: ${m.limits}`));
      if (m.answer && m.brain) bubble.append(el("span", { class: "by" }, `Explained by ${m.brain}`));
      log.append(bubble);
    }
    if (s) {
      log.append(el("div", { class: "row" },
        el("button", { class: "link", type: "button", onclick: () => show("report") }, "Open full report"),
        el("button", { class: "link", type: "button", onclick: inspireFromCurrent }, "Build something like it")));
    }
  }
  if (state.studying) log.append(el("div", { class: "progress" }, el("div", { class: "step" }, el("span", { class: "spin" }), "Working on it…")));
  $("follow").disabled = state.studying;
  scrollTo("chat-log");
}

function renderReport() {
  const s = state.summaries[state.current];
  $("report-body").replaceChildren(
    el("section", { class: "card row" },
      el("div", { class: "tile big c4" }, initial(s.label || s.package)),
      el("div", { class: "grow" }, el("h1", { class: "title" }, s.label || s.package), el("span", { class: "muted small" }, `${s.package}, version ${s.version}`)),
      el("span", { class: s.genuine ? "pill" : "pill warn" }, s.genuine ? "Genuine" : "Check")),
    el("section", { class: "grid2", "aria-label": "At a glance" },
      stat("Internet", s.uses_internet ? "Yes" : "None"),
      stat("Sensitive permissions", String(s.sensitive_permissions.length)),
      stat("Languages", String(s.languages || "1")),
      stat("Screens", String(s.screens.length))),
    el("section", { class: "stack tight" }, el("h2", { class: "section study-ink" }, "Signed by"),
      el("div", { class: "card small" }, s.signature.replace(/^(✅|⚠️|❓)\s*/u, ""))),
    el("section", { class: "stack tight" }, el("h2", { class: "section study-ink" }, "Permissions"),
      s.permissions.length
        ? el("div", { class: "card list" }, s.permissions.map((p) => el("div", { class: "item" },
            el("div", { class: "grow" }, el("span", { class: "mono" }, p.name), el("span", { class: "muted small block" }, p.meaning)),
            p.sensitive ? el("span", { class: "pill warn" }, "Sensitive") : null)))
        : el("div", { class: "card muted small" }, "None. This app asks for no permissions.")),
    el("section", { class: "stack tight" }, el("h2", { class: "section study-ink" }, "More"),
      el("div", { class: "card list" },
        el("div", { class: "item" }, el("span", { class: "grow" }, "Works on"), el("span", { class: "muted" }, s.works_on)),
        el("div", { class: "item" }, el("span", { class: "grow" }, "Size"), el("span", { class: "muted" }, `${s.size_mb} MB`)),
        el("div", { class: "item" }, el("span", { class: "grow" }, "Code pieces"), el("span", { class: "muted" }, Number(s.classes || 0).toLocaleString())))),
    el("p", { class: "muted small" }, `Checked with REA ${s.rea_version || ""}. Fingerprint: `, el("span", { class: "mono" }, s.sha256)),
  );
}
function stat(label, value) {
  return el("div", { class: "card stat" }, el("span", {}, label), el("b", { class: "num" }, value));
}

// REA meets Build: carry a studied app's report over as inspiration (ideas only).
function inspireFromCurrent() {
  const s = state.summaries[state.current];
  if (!s) return;
  state.inspiredBy = { appId: s.package, label: s.label || s.package };
  state.homeMode = "build";
  show("home");
  $("build-prompt").focus();
}

// ---------- Build: Lovable-style ----------

function setJob(job) {
  state.job = job;
  if (job) store.set("job", job); else store.del("job");
}

async function startProject(prompt) {
  $("build-error").textContent = "";
  try {
    const r = await api("/api/projects", { prompt, inspiredBy: state.inspiredBy?.appId });
    state.inspiredBy = null;
    $("build-prompt").value = "";
    useProject(r.project);
    setJob({ id: r.jobId, projectId: r.project.id });
    state.buildTab = "chat";
    show("build");
    pollJob();
  } catch (e) {
    if (e.message !== "locked") $("build-error").textContent = e.message;
  }
}

function useProject(p) {
  state.project = p;
  state.projectId = p.id;
  store.set("projectId", p.id);
}

async function openProject(id) {
  if (id !== state.projectId) { state.project = null; state.check = { rev: -1, loaded: false, slow: false, errors: [] }; }
  state.projectId = id;
  store.set("projectId", id);
  state.buildTab = "preview";
  show("build");
}

async function openBuild() {
  renderBuild();
  try {
    const { project } = await api(`/api/projects/${state.projectId}`);
    if (state.project && state.project.id === project.id && !state.project.versionCount && project.versionCount) state.buildTab = "preview";
    useProject(project);
    if (!project.versionCount) state.buildTab = "chat";
    renderBuild();
  } catch (e) {
    if (e.status === 404) { state.projectId = ""; store.del("projectId"); state.project = null; show("home"); }
  }
  if (state.job && state.job.projectId === state.projectId) pollJob();
}

let polling = false;
async function pollJob() {
  if (polling || !state.job) return;
  polling = true;
  try {
    while (state.job) {
      let info;
      try { info = await api(`/api/jobs/${state.job.id}`); }
      catch (e) {
        if (e.message === "locked") return;
        if (e.status === 404) info = { status: "gone" };
        else { await new Promise((r) => setTimeout(r, 3000)); continue; }
      }
      state.jobInfo = info;
      if (info.status === "running") {
        if (state.view === "build") renderBuildProgress();
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const projectId = state.job.projectId;
      setJob(null);
      state.jobInfo = null;
      try {
        const { project } = await api(`/api/projects/${projectId}`);
        const before = state.project && state.project.id === projectId ? state.project.rev : -1;
        if (state.projectId === projectId) {
          useProject(project);
          if (info.status === "done" && project.rev !== before && project.versionCount) state.buildTab = "preview";
        }
      } catch { /* deleted meanwhile */ }
      if (state.view === "build") renderBuild();
      if (state.view === "home") renderHome();
    }
  } finally {
    polling = false;
  }
}

async function sendChange(text) {
  if (!state.project || state.job) return;
  try {
    const r = await api(`/api/projects/${state.project.id}/messages`, { text });
    useProject(r.project);
    setJob({ id: r.jobId, projectId: r.project.id });
    state.buildTab = "chat";
    renderBuild();
    pollJob();
  } catch (e) {
    if (e.message !== "locked") { state.project.messages.push({ role: "note", text: e.message }); renderBuild(); }
  }
}

function renderBuild() {
  const p = state.project;
  const busy = Boolean(state.job && p && state.job.projectId === p.id);
  $("build-title").textContent = p ? p.name : "Loading…";
  $("build-sub").textContent = !p ? "" : busy ? "Building…" : p.versionCount ? `Version ${p.versionCount}` : "Not built yet";

  $("tab-chat").setAttribute("aria-selected", String(state.buildTab === "chat"));
  $("tab-preview").setAttribute("aria-selected", String(state.buildTab === "preview"));
  $("build-log").hidden = state.buildTab !== "chat";
  $("build-preview").hidden = state.buildTab !== "preview";

  // Conversation
  const log = $("build-log");
  log.replaceChildren();
  if (p?.inspiredBy) {
    log.append(el("div", { class: "safe" }, shield(), el("div", {},
      el("b", { class: "small block" }, `Using ideas from ${p.inspiredLabel}`),
      el("span", { class: "muted small" }, "Clean-room: the builder sees REA's report, never the app's code."))));
  }
  for (const m of p?.messages || []) {
    if (m.role === "me") log.append(el("div", { class: "bubble me" }, m.text));
    else if (m.role === "ai") {
      log.append(el("div", { class: "bubble ai" }, ...richText(m.text),
        m.brain ? el("span", { class: "by" }, `${m.rev ? "Built" : "Answered"} by ${m.brain}${typeof m.cost === "number" ? `, ${cents(m.cost)}` : ""}`) : null,
        m.rev ? el("button", { class: "link", type: "button", onclick: () => { state.buildTab = "preview"; renderBuild(); } }, "See it") : null));
    } else log.append(el("div", { class: "note" }, m.text));
  }
  if (busy) log.append(el("div", { id: "build-progress", class: "progress" }));

  // Preview
  const frame = $("preview");
  if (p?.previewUrl && frame.dataset.key !== `${p.id}:${p.rev}`) {
    frame.dataset.key = `${p.id}:${p.rev}`;
    state.check = { rev: p.rev, loaded: false, slow: false, errors: [] };
    frame.src = p.previewUrl;
    clearTimeout(renderBuild.slowTimer);
    renderBuild.slowTimer = setTimeout(() => { if (!state.check.loaded) { state.check.slow = true; renderSteps(); } }, 12000);
  }
  if (!p?.previewUrl && frame.dataset.key) { frame.removeAttribute("src"); delete frame.dataset.key; }
  $("preview-empty").hidden = Boolean(p?.previewUrl);
  $("open-full").href = p?.previewUrl || "#";
  $("open-full").setAttribute("aria-disabled", String(!p?.previewUrl));
  $("download").disabled = !p?.html;
  $("undo").disabled = !p?.canUndo || busy;
  $("delete").disabled = !p || busy;

  $("change").disabled = busy || !p;
  $("change").placeholder = p?.versionCount ? "Ask for a change" : "Describe your app";
  renderSteps();
  renderBuildProgress();
  if (state.buildTab === "chat") scrollTo("build-log");
}

function renderBuildProgress() {
  const box = $("build-progress");
  if (!box) return;
  const info = state.jobInfo || {};
  box.replaceChildren(el("div", { class: "step" }, el("span", { class: "spin" }), info.step || "Starting…"),
    el("span", { class: "muted small" }, `${info.seconds || 0} seconds so far. A new app usually takes 1 to 3 minutes. Keep this screen open.`));
  $("build-sub").textContent = "Building…";
  renderSteps();
}

function setStep(cls, { on = false, busy = false, problem = false, text = "" }) {
  const li = document.querySelector(`#steps .${cls}`);
  li.classList.toggle("on", on);
  li.classList.toggle("busy", busy);
  li.classList.toggle("problem", problem);
  li.querySelector(".s-state").textContent = text;
}

function renderSteps() {
  const p = state.project;
  const busy = Boolean(state.job && p && state.job.projectId === p.id);
  const built = Boolean(p?.versionCount);
  const c = state.check;
  const errors = c.errors.length;
  setStep("s-study", p?.inspiredBy ? { on: true, text: p.inspiredLabel } : { text: "Skipped" });
  setStep("s-build", busy ? { busy: true, text: "Working…" } : built ? { on: true, text: "Done" } : { text: "Waiting" });
  if (busy || !built) setStep("s-check", { text: "Waiting" });
  else if (errors) setStep("s-check", { problem: true, text: `${errors} problem${errors === 1 ? "" : "s"}` });
  else if (c.loaded) setStep("s-check", { on: true, text: "No errors" });
  else setStep("s-check", { text: c.slow ? "Slow to load" : "Checking…" });
  const ready = built && !busy && c.loaded && !errors;
  setStep("s-ready", ready ? { on: true, text: "Ready!" } : { text: "Not yet" });

  $("fix-bar").hidden = !(errors && !busy);
  if (errors) $("fix-text").textContent = `Check found a problem: ${c.errors[0]}`;
}

// The preview reports back to the Check step, and hands over anything the app saved.
let saveStorageTimer = null;
window.addEventListener("message", (e) => {
  const frame = $("preview");
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.rea === "loaded") state.check.loaded = true;
  if (d.rea === "storage" && state.project && d.data && typeof d.data === "object") {
    // The built app saved something: keep it on the server so it's there next time.
    const id = state.project.id;
    clearTimeout(saveStorageTimer);
    saveStorageTimer = setTimeout(() => api(`/api/projects/${id}/storage`, { data: d.data }, "PUT").catch(() => {}), 800);
    return;
  }
  if (d.rea === "error") {
    const msg = String(d.message || "Something broke").slice(0, 300);
    if (state.check.errors.length < 5 && !state.check.errors.includes(msg)) state.check.errors.push(msg);
  }
  if (state.view === "build") renderSteps();
});

function downloadApp() {
  const p = state.project;
  if (!p?.html) return;
  const url = URL.createObjectURL(new Blob([p.html], { type: "text/html" }));
  const a = el("a", { href: url, download: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-app"}.html` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- settings ----------

async function renderSettings() {
  try {
    const st = await api("/api/status");
    setBrainName(st.brain.short);
    $("brains").replaceChildren(...st.brains.map((b) => el("button", {
      class: "item brain-option", type: "button", role: "radio", "aria-checked": String(b.id === st.model),
      onclick: async () => {
        try { await api("/api/brain", { model: b.id }); renderSettings(); }
        catch (e) { if (e.message !== "locked") $("key-msg").textContent = e.message; }
      },
    }, el("span", { class: "radio" }), el("span", { class: "grow" }, el("b", {}, b.name), el("span", { class: "muted small block" }, b.note)))));
    $("ai-status").textContent = st.aiConnected ? "Connected. Your key stays on your server." : "Not connected yet. Paste your key so the AI can build and explain.";
    $("or-key").placeholder = st.aiConnected ? "Paste a new key to replace it" : "Paste your OpenRouter key";
    $("key-form").querySelector("button").textContent = st.aiConnected ? "Replace key" : "Connect";
    $("limit").textContent = `$${st.limitUsd}`;
    $("spent").textContent = `$${st.spentUsd.toFixed(2)} used this month. The AI pauses when you reach the limit.`;
    $("meter-fill").style.width = `${Math.min(100, (st.spentUsd / st.limitUsd) * 100)}%`;
  } catch { /* the lock screen handles a wrong passcode */ }
}

// ---------- wiring ----------

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) show(go.dataset.go);
  if (e.target.closest("[data-back]")) show(state.prevView === "report" ? "home" : state.prevView);
  const q = e.target.closest("[data-q]");
  if (q) { $("question").value = q.dataset.q; $("app-id").focus(); }
  const idea = e.target.closest("[data-idea]");
  if (idea) { $("build-prompt").value = idea.dataset.idea; $("build-prompt").focus(); }
});

$("mode-build").addEventListener("click", () => setMode("build"));
$("mode-study").addEventListener("click", () => setMode("study"));
$("inspired-clear").addEventListener("click", () => { state.inspiredBy = null; renderInspired(); });
$("inspire-button").addEventListener("click", inspireFromCurrent);

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.passcode = $("passcode").value;
  try {
    await api("/api/status");
    store.set("passcode", state.passcode);
    $("passcode").value = "";
    show("home");
  } catch { /* lock() already showed the message */ }
});

$("build-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = $("build-prompt").value.trim();
  if (!prompt) { $("build-error").textContent = "Describe the app you'd like first."; return; }
  startProject(prompt);
});

$("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const appId = $("app-id").value.trim();
  if (!appId) { $("ask-error").textContent = "Type an app's F-Droid id first, like org.fossify.math."; return; }
  $("ask-error").textContent = "";
  investigate(appId, $("question").value.trim() || "Is this app safe to install?");
  $("question").value = "";
});
$("app-id").addEventListener("input", () => { $("ask-error").textContent = ""; });

$("follow-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("follow").value.trim();
  if (!q || !state.current) return;
  $("follow").value = "";
  investigate(state.current, q);
});

$("tab-chat").addEventListener("click", () => { state.buildTab = "chat"; renderBuild(); });
$("tab-preview").addEventListener("click", () => { state.buildTab = "preview"; renderBuild(); });
$("change-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("change").value.trim();
  if (!text) return;
  $("change").value = "";
  sendChange(text);
});
$("fix-button").addEventListener("click", () => {
  const err = state.check.errors[0];
  if (err) sendChange(`The automatic check found this problem in the app: "${err}". Please fix it and keep everything else the same.`);
});
$("download").addEventListener("click", downloadApp);
$("undo").addEventListener("click", async () => {
  try { const r = await api(`/api/projects/${state.project.id}/undo`, {}); useProject(r.project); renderBuild(); }
  catch (e) { if (e.message !== "locked") { state.project.messages.push({ role: "note", text: e.message }); renderBuild(); } }
});
$("delete").addEventListener("click", async () => {
  const p = state.project;
  if (!p || !window.confirm(`Delete “${p.name}”? This can't be undone.`)) return;
  try {
    await api(`/api/projects/${p.id}`, null, "DELETE");
    state.project = null; state.projectId = ""; store.del("projectId");
    show("home");
  } catch (err) { if (err.message !== "locked") { p.messages.push({ role: "note", text: err.message }); renderBuild(); } }
});

$("sign-out").addEventListener("click", () => lock("Locked. Enter your passcode to unlock."));

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("or-key").value.trim();
  if (!key) return;
  const button = $("key-form").querySelector("button");
  button.disabled = true;
  $("key-msg").textContent = "Checking your key with OpenRouter…";
  try {
    await api("/api/openrouter-key", { openrouterKey: key });
    $("or-key").value = "";
    $("key-msg").textContent = "Connected! You're ready to build and study.";
    renderSettings();
  } catch (err) {
    if (err.message !== "locked") $("key-msg").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
show(state.passcode ? "home" : "lock");
if (state.passcode && state.job) pollJob();
