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
  chats: store.get("chats", {}),      // appId -> [{role, ...}]
  current: store.get("current", ""),  // appId of the open chat
  summaries: {},                       // appId -> report summary
  view: "home",
  prevView: "home",
  busy: false,
};

// ---------- talking to the back room ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-passcode": state.passcode, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { lock("That passcode didn't work. Try again."); throw new Error("locked"); }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ---------- tiny DOM helpers (all text goes in as text, never HTML) ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
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

// Turn Claude's short markdown into paragraphs and bullet lists, as plain text.
function richText(text) {
  const out = [];
  let list = null;
  for (const raw of text.split("\n")) {
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

const VIEWS = ["lock", "home", "chat", "report", "settings"];
function show(view) {
  if (view === "chat" && !state.current) view = "home";
  if (view === "report" && !state.summaries[state.current]) view = state.current ? "chat" : "home";
  if (view !== state.view) state.prevView = state.view;
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $("nav").hidden = view === "lock" || view === "chat";
  for (const b of document.querySelectorAll("#nav button")) {
    if (b.dataset.go === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (view === "home") renderHome();
  if (view === "chat") renderChat();
  if (view === "report") renderReport();
  if (view === "settings") renderSettings();
}

function lock(message) {
  state.passcode = "";
  store.del("passcode");
  $("lock-error").textContent = message || "";
  show("lock");
  $("passcode").focus();
}

// ---------- home ----------

async function renderHome() {
  try {
    const [{ reports }, status] = await Promise.all([api("/api/reports"), api("/api/status")]);
    $("recent").replaceChildren(...reports.slice(0, 6).map((r) => {
      state.summaries[r.package] = r;
      const facts = [r.genuine ? "Genuine" : "Check signature", r.uses_internet ? "Uses Internet" : "Offline",
        `${r.sensitive_permissions.length} sensitive permission${r.sensitive_permissions.length === 1 ? "" : "s"}`];
      return el("button", { class: "recent", type: "button", onclick: () => openApp(r.package) },
        el("div", { class: "tile" }, (r.label || r.package).slice(0, 1).toUpperCase()),
        el("div", { class: "grow" }, el("b", {}, r.label || r.package), el("span", { class: "muted small" }, facts.join(" · "))),
        svg(["M9 6l6 6-6 6"]));
    }));
    $("recent-empty").hidden = reports.length > 0;
    $("home-spend").textContent = `This month: $${status.spentUsd.toFixed(2)} of your $${status.limitUsd} limit`;
  } catch { /* shown on the lock screen if it was the passcode */ }
}

function openApp(appId) {
  state.current = appId;
  store.set("current", appId);
  show(state.chats[appId]?.length ? "chat" : "report");
}

// ---------- investigations ----------

const STEPS = ["Downloading it from F-Droid", "Checking its digital signature", "Reading permissions and translations", "Asking Claude to explain"];

async function investigate(appId, question) {
  if (state.busy) return;
  state.busy = true;
  state.current = appId;
  store.set("current", appId);
  const chat = state.chats[appId] || (state.chats[appId] = []);
  chat.push({ role: "me", text: question });
  saveChats();
  show("chat");

  // Progress card while the back room works.
  const stepEls = STEPS.map((s) => el("div", { class: "step" }, el("span", { class: "spin" }), s));
  const progress = el("div", { class: "steps" }, el("b", { class: "small muted" }, "REA is working…"), stepEls);
  $("chat-log").append(progress);
  scrollChat();
  let i = 0;
  const timer = setInterval(() => {
    if (i < stepEls.length - 1) { stepEls[i].classList.add("done"); stepEls[i].firstChild.replaceWith(tick()); i++; }
  }, 6000);

  try {
    const r = await api("/api/investigate", { appId, question });
    state.summaries[r.appId] = r.summary;
    if (r.appId !== appId) { state.chats[r.appId] = chat; delete state.chats[appId]; state.current = r.appId; store.set("current", r.appId); }
    chat.push({ role: "ai", safety: r.safety.note, answer: r.answer, limits: r.limits, note: r.aiNote,
      checks: r.cached ? ["Used this week's saved check"] : STEPS.slice(0, 3) });
  } catch (e) {
    if (e.message !== "locked") chat.push({ role: "ai", note: e.message, checks: [] });
  } finally {
    clearInterval(timer);
    state.busy = false;
    saveChats();
    if (state.view === "chat") renderChat();
  }
}

function saveChats() {
  // Keep it light: the last 20 messages per app.
  for (const list of Object.values(state.chats)) if (list.length > 20) list.splice(0, list.length - 20);
  store.set("chats", state.chats);
}

function scrollChat() { const log = $("chat-log"); log.scrollTop = log.scrollHeight; }

function renderChat() {
  const appId = state.current;
  const s = state.summaries[appId];
  $("chat-title").textContent = s?.label || appId;
  $("chat-sub").textContent = s ? `${s.package} · v${s.version}` : appId;
  const log = $("chat-log");
  log.replaceChildren();
  for (const m of state.chats[appId] || []) {
    if (m.role === "me") { log.append(el("div", { class: "bubble me" }, m.text)); continue; }
    if (m.safety) {
      log.append(el("div", { class: "safe" }, shield(),
        el("div", {}, el("b", { class: "small block" }, "Safety check passed"), el("span", { class: "muted small" }, m.safety))));
    }
    if (m.checks?.length) {
      log.append(el("div", { class: "steps" }, el("b", { class: "small muted" }, `REA did ${m.checks.length} check${m.checks.length === 1 ? "" : "s"}`),
        m.checks.map((c) => el("div", { class: "step done" }, tick(), c))));
    }
    if (m.answer || m.note) {
      const bubble = el("div", { class: "bubble ai" });
      if (m.answer) bubble.append(...richText(m.answer));
      if (m.note) bubble.append(el("p", { class: "note" }, m.note));
      if (s && (m.answer || m.note)) {
        bubble.append(el("div", { class: "evidence" },
          el("button", { type: "button", onclick: () => show("report") }, "Evidence: signature"),
          el("button", { type: "button", onclick: () => show("report") }, "Evidence: permissions")));
      }
      if (m.limits) bubble.append(el("p", { class: "muted small" }, `Limits: ${m.limits}`));
      log.append(bubble);
    }
    if (s) log.append(el("button", { class: "link", type: "button", onclick: () => show("report") }, "Open full report ›"));
  }
  if (state.busy) $("chat-log").append(el("div", { class: "steps" }, el("div", { class: "step" }, el("span", { class: "spin" }), "Working on it…")));
  $("follow").disabled = state.busy;
  scrollChat();
}

// ---------- report ----------

function renderReport() {
  const s = state.summaries[state.current];
  const body = $("report-body");
  body.replaceChildren(
    el("section", { class: "card row" },
      el("div", { class: "tile big" }, (s.label || s.package).slice(0, 1).toUpperCase()),
      el("div", { class: "grow" }, el("h1", { class: "title" }, s.label || s.package), el("span", { class: "muted small" }, `${s.package} · version ${s.version}`)),
      el("span", { class: s.genuine ? "pill" : "pill warn" }, s.genuine ? "Genuine" : "Check")),
    el("section", { class: "grid2", "aria-label": "At a glance" },
      stat("Internet", s.uses_internet ? "Yes" : "None"),
      stat("Sensitive permissions", String(s.sensitive_permissions.length)),
      stat("Languages", String(s.languages || "1")),
      stat("Screens", String(s.screens.length))),
    el("section", { class: "stack tight" }, el("h2", { class: "section" }, "Signed by"),
      el("div", { class: "card small" }, s.signature.replace(/^✅\s*|^⚠️\s*|^❓\s*/u, ""))),
    el("section", { class: "stack tight" }, el("h2", { class: "section" }, "Permissions"),
      s.permissions.length
        ? el("div", { class: "card list" }, s.permissions.map((p) => el("div", { class: "item" },
            el("div", { class: "grow" }, el("span", { class: "mono" }, p.name), el("span", { class: "muted small block" }, p.meaning)),
            p.sensitive ? el("span", { class: "pill warn" }, "Sensitive") : null)))
        : el("div", { class: "card muted small" }, "None. This app asks for no permissions.")),
    el("section", { class: "stack tight" }, el("h2", { class: "section" }, "More"),
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

// ---------- settings ----------

async function renderSettings() {
  try {
    const st = await api("/api/status");
    $("ai-status").textContent = st.aiConnected ? `Connected · ${st.model}` : "Not connected yet. Add your OpenRouter key in the back room.";
    $("limit").textContent = `$${st.limitUsd}`;
    $("spent").textContent = `$${st.spentUsd.toFixed(2)} used this month. Claude pauses when you reach the limit.`;
    $("meter-fill").style.width = `${Math.min(100, (st.spentUsd / st.limitUsd) * 100)}%`;
  } catch { /* lock screen handles a wrong passcode */ }
}

// ---------- wiring ----------

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) show(go.dataset.go);
  if (e.target.closest("[data-back]")) show(state.prevView === "report" ? "home" : state.prevView);
  const q = e.target.closest("[data-q]");
  if (q) { $("question").value = q.dataset.q; $("app-id").focus(); }
});

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

$("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const appId = $("app-id").value.trim();
  if (!appId) { $("ask-error").textContent = "Type an app's F-Droid package id first, like org.fossify.math."; return; }
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

$("sign-out").addEventListener("click", () => lock("Locked. Enter your passcode to unlock."));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
show(state.passcode ? "home" : "lock");
