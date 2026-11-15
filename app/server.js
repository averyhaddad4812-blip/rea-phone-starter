#!/usr/bin/env node
// REA Studio back room: a tiny, dependency-free server.
//
// - Serves the phone app (app/public).
// - Study: runs REA checks on open-source F-Droid apps and has an AI explain them.
// - Source: fetches the whole real source code of open-source apps (from F-Droid's records).
// - Build: turns a description into a working web app with a live preview (Lovable-style),
//   following Craft Anything's steps: Study, Build, Check, Ready. It can remix real
//   open-source code, with the license tracked and credit added automatically.
// - Any AI model on OpenRouter can be picked.
// - Locked with a passcode, with a monthly spending limit across everything.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(__dirname, "public");
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const REPORTS = path.join(DATA, "reports");
const PROJECTS = path.join(DATA, "projects");
const USAGE_FILE = path.join(DATA, "usage.json");
const SECRETS_FILE = path.join(DATA, "secrets.json");
const SETTINGS_FILE = path.join(DATA, "settings.json");
const SOURCES = path.join(DATA, "sources");
const MODELS_FILE = path.join(DATA, "models.json");
const PUBLISHED = path.join(DATA, "published");

const PORT = Number(process.env.PORT || 8080);
const PASSCODE = process.env.APP_PASSCODE || "";
const DEV = process.env.DEV === "1";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5";
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_URL = OPENROUTER_BASE + "/chat/completions";
const FDROID_METADATA = process.env.FDROID_METADATA_URL || "https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata";
const LIMIT_USD = Number(process.env.MONTHLY_LIMIT_USD || 20);
const CACHE_DAYS = 7;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const PROJECT_ID = /^p_[a-f0-9]{12}$/;

// Any model on OpenRouter can be picked in Settings. These are shown first as popular picks.
const POPULAR = [
  { id: "anthropic/claude-sonnet-5.5", note: "Best all-rounder" },
  { id: "anthropic/claude-opus-5.5", note: "Smartest, about twice the cost" },
  { id: "anthropic/claude-haiku-5.5", note: "Fastest and cheapest" },
  { id: "openai/gpt-6.1-sol", note: "OpenAI's model" },
  { id: "google/gemini-4-carbon", note: "Google's model" },
  { id: "moonshotai/kimi-k3.1-pro", note: "Moonshot's model" },
];
const MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

if (!PASSCODE && !DEV) {
  console.error("Set APP_PASSCODE so only you can use the app (or DEV=1 for local testing).");
  process.exit(1);
}
fs.mkdirSync(REPORTS, { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(SOURCES, { recursive: true });
fs.mkdirSync(PUBLISHED, { recursive: true });

// The OpenRouter key comes from the host's settings, or from the app's Settings screen
// (saved on the server only, readable by nobody else, and never sent back to the phone).
let OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
if (!OPENROUTER_KEY) {
  try { OPENROUTER_KEY = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")).openrouterKey || ""; } catch { /* not set yet */ }
}

// Signs preview links so only links the app made will open a preview.
const PREVIEW_SECRET = crypto.createHash("sha256").update("rea-preview:" + (PASSCODE || crypto.randomUUID())).digest();

// ---------- small helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("Couldn't read that request")); }
    });
    req.on("error", reject);
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          const last = (stderr || stdout || err.message).trim().split("\n").filter(Boolean).pop() || err.message;
          reject(new Error(last.replace(/^❌\s*/, "")));
        } else resolve({ stdout, stderr });
      });
  });
}

// On Ample, the server naps after a minute without visitors. While a build or a study is
// running, leave a note asking it to stay awake (removed as soon as the work is done).
const AWAKE_DIR = process.env.AMPLE_AWAKE_DIR || (fs.existsSync("/run/ample/awake") ? "/run/ample/awake" : "");
function holdAwake(name, minutes) {
  if (!AWAKE_DIR) return () => {};
  const file = path.join(AWAKE_DIR, `rea-studio-${name}`);
  try { fs.writeFileSync(file, String(Math.floor(Date.now() / 1000) + minutes * 60)); } catch { return () => {}; }
  return () => { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function equalSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Passcode check that takes the same time whether it's right or wrong.
const failures = new Map();
function authorized(req) {
  if (!PASSCODE) return true;
  const ip = req.socket.remoteAddress || "?";
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (Date.now() < f.until) return false;
  if (equalSecret(req.headers["x-passcode"] || "", PASSCODE)) { failures.delete(ip); return true; }
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.count = 0; } // 5 wrong tries: wait 5 minutes
  failures.set(ip, f);
  return false;
}

// ---------- brain and spending ----------

// OpenRouter's full model list, refreshed every 6 hours (no key needed to read it).
let modelCache = readJson(MODELS_FILE, { at: 0, list: [] });
async function allModels() {
  if (Date.now() - modelCache.at < 6 * 3600 * 1000 && modelCache.list.length) return modelCache.list;
  try {
    const res = await fetch(`${OPENROUTER_BASE}/models`, { signal: AbortSignal.timeout(20 * 1000) });
    const data = await res.json();
    const list = (data.data || [])
      .filter((m) => MODEL_ID.test(m.id) && !m.id.endsWith(":batch")
        && (m.architecture?.input_modalities || ["text"]).includes("text")
        && (m.architecture?.output_modalities || ["text"]).includes("text"))
      .map((m) => ({
        id: m.id, name: m.name || m.id,
        prompt: Number(m.pricing?.prompt), completion: Number(m.pricing?.completion),
        context: m.context_length || 0, maxOut: m.top_provider?.max_completion_tokens || 0, created: m.created || 0,
      }));
    if (list.length) {
      modelCache = { at: Date.now(), list };
      fs.writeFileSync(MODELS_FILE, JSON.stringify(modelCache));
    }
  } catch { /* keep the last list we had */ }
  return modelCache.list;
}
function modelInfo(id) { return modelCache.list.find((m) => m.id === id); }

// Rough cost of one build (about 20,000 tokens in, 10,000 out; big apps cost more) and one question, in dollars.
function estimate(m) {
  if (!m || !(m.prompt >= 0) || !(m.completion >= 0)) return null;
  return { build: m.prompt * 20000 + m.completion * 10000, question: m.prompt * 2500 + m.completion * 350 };
}

function currentModel() {
  const chosen = readJson(SETTINGS_FILE, {}).model;
  return chosen && MODEL_ID.test(chosen) ? chosen : DEFAULT_MODEL;
}
function brain(id) {
  const m = modelInfo(id);
  const name = m ? m.name.replace(/^[^:]{1,30}:\s*/, "") : id.split("/").pop();
  return { id, name, short: name, cost: estimate(m), popular: POPULAR.find((p) => p.id === id)?.note || "" };
}

function monthKey() { return new Date().toISOString().slice(0, 7); }
function spentThisMonth() { return Number(readJson(USAGE_FILE, {})[monthKey()] || 0); }
function addSpend(usd) {
  const u = readJson(USAGE_FILE, {});
  u[monthKey()] = Math.round((Number(u[monthKey()] || 0) + usd) * 1e6) / 1e6;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}

// One call to the chosen AI brain through OpenRouter. Real cost comes back from OpenRouter.
async function callModel({ system, user, maxTokens, timeoutMs }) {
  const model = currentModel();
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json", "X-Title": "REA Studio" },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(maxTokens, modelInfo(model)?.maxOut || maxTokens),
      usage: { include: true },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const plain = {
      401: "your OpenRouter key didn't work, so check it's copied correctly",
      402: "your OpenRouter credits have run out",
      429: "OpenRouter is busy, so try again in a minute",
    }[res.status];
    throw new Error(plain || data?.error?.message || `OpenRouter said ${res.status}`);
  }
  const choice = data?.choices?.[0] || {};
  const usage = data.usage || {};
  const cost = typeof usage.cost === "number" ? usage.cost
    : ((usage.prompt_tokens || 0) * 2 + (usage.completion_tokens || 0) * 10) / 1e6;
  addSpend(cost);
  return { text: (choice.message?.content || "").trim(), finish: choice.finish_reason, cost, model };
}

function aiReady() {
  if (!OPENROUTER_KEY) return "Connect your OpenRouter key in Settings first, so an AI brain can help.";
  if (spentThisMonth() >= LIMIT_USD) return `You've reached your $${LIMIT_USD} monthly limit, so the AI is paused until next month.`;
  return "";
}

// ---------- Study: REA checks ----------

function reportPaths(appId) {
  return { md: path.join(REPORTS, `${appId}.md`), json: path.join(REPORTS, `${appId}.json`) };
}

function savedReport(appId, maxAgeDays = Infinity) {
  const p = reportPaths(appId);
  try {
    const age = Date.now() - fs.statSync(p.json).mtimeMs;
    if (age < maxAgeDays * 24 * 3600 * 1000) {
      return { summary: JSON.parse(fs.readFileSync(p.json, "utf8")), markdown: fs.readFileSync(p.md, "utf8") };
    }
  } catch { /* no usable saved report */ }
  return null;
}

async function checkApp(appId) {
  const cached = savedReport(appId, CACHE_DAYS);
  if (cached) return { ...cached, cached: true };

  // Download the newest build from F-Droid. get-app.sh hands back the file and its source
  // through a GitHub-style output file, so no text parsing is needed.
  const outFile = path.join(os.tmpdir(), `rea-out-${crypto.randomUUID()}`);
  try {
    await run("bash", [path.join(ROOT, "scripts", "get-app.sh"), appId], { env: { ...process.env, GITHUB_OUTPUT: outFile } });
    const out = Object.fromEntries(fs.readFileSync(outFile, "utf8").trim().split("\n").map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
    }));
    const p = reportPaths(appId);
    await run("python3", [path.join(ROOT, "scripts", "quick_report.py"), out.file, "--source", out.url, "--out", p.md, "--json", p.json]);
    fs.rmSync(out.file, { force: true }); // app files aren't kept
    return { summary: JSON.parse(fs.readFileSync(p.json, "utf8")), markdown: fs.readFileSync(p.md, "utf8"), cached: false };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

const STUDY_PROMPT = `You are the explainer inside REA Studio, a phone app that helps a beginner understand Android apps.
You are given a report that REA (an open-source reverse engineering toolkit) produced from the app's file.
Rules:
- Answer the person's question using ONLY facts in the report. Never guess or add outside facts about the app.
- Plain, warm, everyday English for someone with no coding background. Explain any technical word you use.
- Short: lead with the answer, then at most 5 short bullet points. They're reading on a phone.
- If the report can't answer the question (for example how a specific feature works inside the code), say so honestly and say a deeper code check would be needed.
- Finish with one line that starts with "Limits:" saying what this check could not see.`;

let studying = false;

async function investigate(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  let appId = String(body.appId || "").trim();
  const link = appId.match(/f-droid\.org\/(?:[a-z_-]+\/)?packages\/([A-Za-z0-9_.]+)/);
  if (link) appId = link[1];
  if (!PACKAGE_ID.test(appId)) {
    return send(res, 400, { error: "Type the app's F-Droid package id (like org.fossify.math) or paste its F-Droid link." });
  }
  const question = String(body.question || "Is this app safe to install?").trim().slice(0, 1000);

  if (studying) return send(res, 429, { error: "Still studying the last app. Try again in a minute." });
  studying = true;
  const release = holdAwake("study", 10);
  try {
    // Safety, Version 1: only apps from F-Droid, where every app is open source, and only
    // read-only checks of the app file (clean-room: no decompiling, nothing is run).
    const safety = { passed: true, note: "It's on F-Droid, where every app is open source. Clean-room mode is on." };
    const { summary, markdown, cached } = await checkApp(appId);

    let ai = { answer: "", limits: "", cost: 0 };
    let aiNote = aiReady() ? `${aiReady()} The report is ready below.` : "";
    if (!aiNote) {
      try {
        const out = await callModel({
          system: STUDY_PROMPT,
          user: `Question: ${question}\n\nREA report:\n<report>\n${markdown}\n</report>`,
          maxTokens: 700, timeoutMs: 90 * 1000,
        });
        const m = out.text.match(/\n?\s*\**Limits:?\**:?\s*([\s\S]*)$/i);
        ai = { answer: m ? out.text.slice(0, m.index).trim() : out.text, limits: m ? m[1].trim() : "", cost: out.cost };
      } catch (e) { aiNote = `The AI couldn't answer just now (${e.message}). The report is ready below.`; }
    }
    send(res, 200, { appId, question, safety, cached, summary, ...ai, aiNote, brain: brain(currentModel()).short,
      spentUsd: spentThisMonth(), limitUsd: LIMIT_USD });
  } catch (e) {
    send(res, 502, { error: e.message || "Something went wrong running REA." });
  } finally {
    studying = false;
    release();
  }
}

function listReports(res) {
  const items = fs.readdirSync(REPORTS).filter((f) => f.endsWith(".json")).map((f) => {
    const full = path.join(REPORTS, f);
    try { return { ...JSON.parse(fs.readFileSync(full, "utf8")), checkedAt: fs.statSync(full).mtime.toISOString() }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  send(res, 200, { reports: items.slice(0, 30) });
}

// ---------- Build: Lovable-style app building ----------

const BUILD_PROMPT = `You are the builder inside REA Studio, a phone app where a beginner with no coding experience describes apps and you build them.

Build or update ONE self-contained HTML file, with all CSS and JavaScript inline. Load a well-known library from cdn.jsdelivr.net, unpkg.com or cdnjs.cloudflare.com only if it really helps.
- Design for a phone screen first (about 390px wide) with big touch targets. Make it look polished and colorful unless the person asks for something else.
- Save data with localStorage, wrapped in try/catch. No servers, no logins, no API keys.
- Make everything actually work. No placeholder buttons and no "coming soon".
- Keep it light so it runs smoothly on a phone: no huge images or heavy 3D unless asked.
- When updating, keep everything the person liked and change only what they asked for. Always send the complete file.

Using other apps:
- A REA report about an app is for ideas: its purpose, features and screens.
- Source code from an open-source app (with its license) may be reused and translated into this web app. When you use any of it, or are asked to build from it, keep a short visible credit inside the app (for example a small "Credits" note) naming the original project, its license and its link, and put the same credit in an HTML comment at the top of the file. Keep the original's own copyright lines in that comment.
- Never use the original app's name, logo or icons as this app's own name or branding. Never use copyrighted characters or real brands.
Never build something that pretends to be a real company's login or payment page, collects passwords, or is meant to harm or deceive people. If asked for that, explain briefly and kindly, and don't send an app.
If the request is unclear, make a sensible choice and mention it, rather than asking.

Reply in this format:
1. Two or three short, warm, plain-English sentences about what you built or changed. No code and no jargon.
2. On the first build only, a short name for the app: <app_name>Name</app_name>
3. The complete file: <app_html>...</app_html>`;

function projectFile(id) { return path.join(PROJECTS, `${id}.json`); }
function loadProject(id) { return PROJECT_ID.test(id) ? readJson(projectFile(id), null) : null; }
function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFile(p.id), JSON.stringify(p));
}

function previewUrl(id, rev) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const t = crypto.createHmac("sha256", PREVIEW_SECRET).update(`${id}.${exp}`).digest("hex");
  return `/preview/${id}?exp=${exp}&t=${t}&v=${rev}`;
}

// Safety net: an app built from someone's open-source code always carries their credit.
function withCredit(p, html) {
  const meta = p.remixFrom ? (sourceMeta(p.remixFrom) || p.remixLicense) : null;
  const link = meta?.sourceCode || meta?.link || "";
  if (!meta || !link || !html || html.includes(link)) return html;
  const credit = `<!-- Based on "${String(meta.name).replace(/--/g, "-")}" (${link}), licensed under ${meta.license}. Changed and translated with REA Studio. -->\n`;
  return /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>\s*/i, (m) => m.trimEnd() + "\n" + credit) : credit + html;
}

function projectView(p) {
  const latest = p.versions[p.versions.length - 1];
  const inspired = p.inspiredBy ? savedReport(p.inspiredBy) : null;
  const remix = p.remixFrom ? sourceMeta(p.remixFrom) : null;
  return {
    id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
    inspiredBy: p.inspiredBy || null, inspiredLabel: inspired?.summary?.label || p.inspiredBy || null,
    remix: p.remixFrom ? { pkg: p.remixFrom, name: remix?.name || p.remixLicense?.name || p.remixFrom,
      license: remix?.license || p.remixLicense?.license || "Unknown", link: remix?.sourceCode || p.remixLicense?.link || "" } : null,
    messages: p.messages.slice(-40),
    rev: p.rev, versionCount: p.versions.length, canUndo: p.versions.length > 1,
    published: p.published && appsUrl() ? { url: `${appsUrl()}/${p.published.slug}/`, upToDate: p.published.rev === p.rev, at: p.published.at } : null,
    html: latest ? withCredit(p, latest.html) : "", previewUrl: latest ? previewUrl(p.id, p.rev) : "",
  };
}

const jobs = new Map();
let building = false;

function startBuild(project, request) {
  building = true;
  const release = holdAwake("build", 12);
  const job = { id: "j_" + crypto.randomBytes(8).toString("hex"), projectId: project.id, status: "running", step: "Reading your idea", startedAt: Date.now() };
  jobs.set(job.id, job);
  runBuild(job, project, request)
    .then(() => { job.status = "done"; })
    .catch((e) => {
      job.status = "error";
      job.error = e.message || "Something went wrong while building.";
      const p = loadProject(project.id);
      if (p) { p.messages.push({ role: "note", text: job.error, at: new Date().toISOString() }); saveProject(p); }
    })
    .finally(() => {
      building = false;
      release();
      job.finishedAt = Date.now();
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000);
    });
  return job;
}

async function runBuild(job, project, request) {
  const prev = project.versions.length ? project.versions[project.versions.length - 1].html : "";
  const report = project.inspiredBy ? savedReport(project.inspiredBy) : null;
  const history = project.messages.filter((m) => m.role === "me" || m.role === "ai").slice(-9, -1)
    .map((m) => `${m.role === "me" ? "Person" : "Builder"}: ${m.text}`).join("\n");
  const user = [
    report && `A REA report about an app the person studied, for ideas:\n<report>\n${report.markdown}\n</report>`,
    remixCode(project, request),
    history && `Conversation so far:\n${history}`,
    prev ? `Current version of the app:\n<current_app>\n${prev}\n</current_app>` : "There's no app yet, so build the first version.",
    `The person's request: ${request}`,
  ].filter(Boolean).join("\n\n");

  job.step = `Writing your app with ${brain(currentModel()).short}`;
  const out = await callModel({ system: BUILD_PROMPT, user, maxTokens: 32000, timeoutMs: 8 * 60 * 1000 });

  job.step = "Checking it";
  const p = loadProject(project.id) || project;
  const htmlMatch = out.text.match(/<app_html>\s*([\s\S]*?)\s*<\/app_html>/i);
  const nameMatch = out.text.match(/<app_name>\s*([\s\S]*?)\s*<\/app_name>/i);
  const said = out.text.replace(/<app_name>[\s\S]*?<\/app_name>/i, "").replace(/<app_html>[\s\S]*$/i, "").trim();

  if (!htmlMatch) {
    if (out.finish === "length") {
      throw new Error(prev ? "That change made the app too big to write in one go. Try asking for one part at a time."
        : "The app got too big to write in one go. Try asking for a smaller first version, then add to it.");
    }
    // No app this time: the brain explained something instead (for example, why it won't build a request).
    p.messages.push({ role: "ai", text: said || "I couldn't build that one. Try describing it a different way.", at: new Date().toISOString(), cost: out.cost, brain: brain(out.model).short });
    saveProject(p);
    return;
  }
  let html = htmlMatch[1].replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
  html = withCredit(p, html);

  if (!/<(html|body|div|main|canvas|script)\b/i.test(html) || html.length > 500_000) {
    throw new Error("The app that came back didn't look right. Try asking again.");
  }
  p.versions.push({ html, at: new Date().toISOString(), model: out.model });
  if (p.versions.length > 10) p.versions.splice(0, p.versions.length - 10);
  p.rev = (p.rev || 0) + 1;
  if (nameMatch && p.name === "New app") p.name = nameMatch[1].replace(/[<>]/g, "").slice(0, 40) || p.name;
  p.messages.push({ role: "ai", text: said || "Here's your app.", at: new Date().toISOString(), cost: out.cost, brain: brain(out.model).short, rev: p.rev });
  saveProject(p);
}

// The real source code to remix, with its license, chosen to fit the request.
function remixCode(project, request) {
  const meta = project.remixFrom ? sourceMeta(project.remixFrom) : null;
  if (!meta || !fs.existsSync(sourceDir(meta.pkg))) return "";
  const firstAsk = project.messages.find((m) => m.role === "me")?.text || "";
  const files = pickSourceFiles(meta.pkg, `${firstAsk} ${request}`);
  const tree = listFiles(sourceDir(meta.pkg)).map((f) => f.path).slice(0, 300).join("\n");
  return `The person chose to build from the open-source app "${meta.name}". Base this app on its real code: reuse and translate its logic, features and behavior into the web app wherever they fit the request. Always include the credit described in your instructions.\nLicense: ${meta.license}\nLink: ${meta.sourceCode}\n`
    + `All files in that project:\n${tree}\n\nThe files most related to this request:\n`
    + files.map((f) => `<source_file path="${f.path}">\n${f.text}\n</source_file>`).join("\n");
}

async function createProject(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const prompt = String(body.prompt || "").trim().slice(0, 2000);
  if (!prompt) return send(res, 400, { error: "Describe the app you'd like first." });
  const inspiredBy = body.inspiredBy && PACKAGE_ID.test(body.inspiredBy) && savedReport(body.inspiredBy) ? body.inspiredBy : null;
  const remixMeta = body.remixFrom ? sourceMeta(body.remixFrom) : null;
  const remixFrom = remixMeta && fs.existsSync(sourceDir(remixMeta.pkg)) ? remixMeta.pkg : null;
  const notReady = aiReady();
  if (notReady) return send(res, 400, { error: notReady });
  if (building) return send(res, 429, { error: "Still building your last app. Give it a minute." });

  const now = new Date().toISOString();
  const project = { id: "p_" + crypto.randomBytes(6).toString("hex"), name: "New app", createdAt: now, inspiredBy, rev: 0,
    remixFrom, remixLicense: remixMeta ? { name: remixMeta.name, license: remixMeta.license, link: remixMeta.sourceCode } : null,
    messages: [{ role: "me", text: prompt, at: now }], versions: [] };
  saveProject(project);
  const job = startBuild(project, prompt);
  send(res, 200, { project: projectView(project), jobId: job.id });
}

async function addMessage(req, res, project) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return send(res, 400, { error: "Type what you'd like to change." });
  const notReady = aiReady();
  if (notReady) return send(res, 400, { error: notReady });
  if (building) return send(res, 429, { error: "Still building. Give it a minute." });
  project.messages.push({ role: "me", text, at: new Date().toISOString() });
  saveProject(project);
  const job = startBuild(project, text);
  send(res, 200, { project: projectView(project), jobId: job.id });
}

function undo(res, project) {
  if (building) return send(res, 429, { error: "Wait for the build to finish first." });
  if (project.versions.length < 2) return send(res, 400, { error: "There's no earlier version to go back to." });
  project.versions.pop();
  project.rev = (project.rev || 0) + 1;
  project.messages.push({ role: "note", text: "Went back to the version before.", at: new Date().toISOString() });
  saveProject(project);
  send(res, 200, { project: projectView(project) });
}

function listProjects(res) {
  const items = fs.readdirSync(PROJECTS).filter((f) => f.endsWith(".json")).map((f) => {
    const p = readJson(path.join(PROJECTS, f), null);
    return p && { id: p.id, name: p.name, updatedAt: p.updatedAt, versionCount: p.versions.length, inspiredBy: p.inspiredBy || null,
      remixLicense: p.remixLicense?.license || null, live: Boolean(p.published) };
  }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  send(res, 200, { projects: items.slice(0, 50) });
}

// Previews run in a locked-down sandbox: their own blank origin, so a built app can't
// see the passcode, the key, or anything else in REA Studio. A tiny script:
// - reports errors back to the Check step, and
// - gives the app a stand-in for localStorage (blocked in a sandbox) that REA Studio
//   saves on the server, so built apps remember things between visits.
function checkerScript(saved) {
  const json = JSON.stringify(saved || {}).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");
  return `<script>(function(){function s(m){try{if(parent!==window)parent.postMessage(m,"*")}catch(e){}}
var d=${json},t;function save(){clearTimeout(t);t=setTimeout(function(){s({rea:"storage",data:d})},300)}
function mk(keep){return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},
setItem:function(k,v){d[String(k)]=String(v);if(keep)save()},removeItem:function(k){delete d[String(k)];if(keep)save()},
clear:function(){d={};if(keep)save()},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
try{Object.defineProperty(window,"localStorage",{value:mk(true),configurable:true})}catch(e){}
try{var m={};Object.defineProperty(window,"sessionStorage",{value:{getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}},configurable:true})}catch(e){}
addEventListener("error",function(e){s({rea:"error",message:String(e.message||"Something broke")+(e.lineno?" (line "+e.lineno+")":"")})});
addEventListener("unhandledrejection",function(e){s({rea:"error",message:"Unhandled problem: "+String(e.reason&&e.reason.message||e.reason)})});
addEventListener("load",function(){setTimeout(function(){s({rea:"loaded"})},400)});})();</script>`;
}

function saveStorage(req, res, project) {
  return readBody(req, 300 * 1024).then((body) => {
    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return send(res, 400, { error: "Bad data" });
    const clean = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === "string") clean[String(k).slice(0, 200)] = v;
    if (JSON.stringify(clean).length > 200 * 1024) return send(res, 400, { error: "This app is trying to save too much." });
    const fresh = loadProject(project.id) || project;
    fresh.storage = clean;
    fs.writeFileSync(projectFile(fresh.id), JSON.stringify(fresh)); // not a change to the app, so the date stays
    send(res, 200, { saved: true });
  }, (e) => send(res, 400, { error: e.message }));
}

function servePreview(req, res, url) {
  const id = url.pathname.split("/")[2] || "";
  const exp = Number(url.searchParams.get("exp"));
  const want = crypto.createHmac("sha256", PREVIEW_SECRET).update(`${id}.${exp}`).digest("hex");
  if (!PROJECT_ID.test(id) || !(exp > Date.now()) || !equalSecret(url.searchParams.get("t") || "", want)) {
    return send(res, 403, "This preview link has expired. Open the app again from REA Studio.");
  }
  const p = loadProject(id);
  const latest = p && p.versions[p.versions.length - 1];
  if (!latest) return send(res, 404, "Nothing built yet.");
  const checker = checkerScript(p.storage);
  const source = withCredit(p, latest.html);
  const html = /<head[^>]*>/i.test(source)
    ? source.replace(/<head[^>]*>/i, (m) => m + checker)
    : checker + source;
  send(res, 200, html, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals allow-popups",
  });
}

// ---------- Publish: each app at its own lasting link ----------
//
// Published copies are served by app/apps-server.js on a different web address, so a
// published app can never reach REA Studio. Set that address as APPS_URL (or appsUrl in
// settings.json).

function appsUrl() {
  return String(process.env.APPS_URL || readJson(SETTINGS_FILE, {}).appsUrl || "").replace(/\/+$/, "");
}

function publish(res, project) {
  if (!appsUrl()) return send(res, 400, { error: "Publishing isn't set up on this server yet." });
  if (building) return send(res, 429, { error: "Wait for the build to finish first." });
  const latest = project.versions[project.versions.length - 1];
  if (!latest) return send(res, 400, { error: "Build the app first." });
  const slug = project.published?.slug || `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app"}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(PUBLISHED, slug);
  fs.mkdirSync(dir, { recursive: true });
  const html = withCredit(project, latest.html);
  const theme = (html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([#a-zA-Z0-9(),.\s%]{1,40})["']/i) || [])[1] || "#181818";
  fs.writeFileSync(path.join(dir, "index.html"), html);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: project.name, slug, theme, version: project.rev, projectId: project.id, publishedAt: new Date().toISOString() }));
  project.published = { slug, rev: project.rev, at: new Date().toISOString() };
  saveProject(project);
  send(res, 200, { project: projectView(project) });
}

function unpublish(project) {
  if (project.published?.slug && /^[a-z0-9][a-z0-9-]{2,60}$/.test(project.published.slug)) {
    fs.rmSync(path.join(PUBLISHED, project.published.slug), { recursive: true, force: true });
  }
  project.published = null;
}

// ---------- Source: the whole real code of open-source apps ----------
//
// F-Droid only lists open-source apps, and its public records say where each app's code
// lives, its license, and the exact version F-Droid built. We download just the code and
// text files of that version (no images or translations), which keeps it small.

const CODE_PATTERNS = ["*.kt", "*.java", "*.kts", "*.gradle", "*.xml", "*.md", "*.txt", "*.toml", "*.properties", "*.json",
  "*.js", "*.ts", "*.dart", "*.py", "*.rs", "*.go", "*.c", "*.cc", "*.cpp", "*.h", "*.swift", "*.html", "*.css",
  "LICENSE*", "COPYING*", "NOTICE*", "!**/res/values-*/**", "!fastlane/**", "!**/fastlane/**"];
const MAX_SOURCES = 6;
let fetching = false;

function sourceDir(pkg) { return path.join(SOURCES, pkg); }
function sourceMeta(pkg) { return PACKAGE_ID.test(pkg) ? readJson(path.join(SOURCES, `${pkg}.json`), null) : null; }

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push({ path: path.relative(base, full).split(path.sep).join("/"), size: fs.statSync(full).size });
  }
  return out;
}

async function fdroidRecord(pkg) {
  const res = await fetch(`${FDROID_METADATA}/${pkg}.yml`, { signal: AbortSignal.timeout(20 * 1000) });
  if (!res.ok) throw new Error("F-Droid has no record of where this app's code lives.");
  const y = await res.text();
  const top = (k) => ((y.match(new RegExp(`^${k}:[ \\t]*(.+)$`, "m")) || [])[1] || "").trim().replace(/^['"]|['"]$/g, "");
  const builds = [...y.matchAll(/versionName:\s*['"]?([^\s'"]+)['"]?[\s\S]*?commit:\s*['"]?([^\s'"]+)['"]?/g)]
    .map((m) => ({ version: m[1], commit: m[2] }));
  return { license: top("License") || "Unknown", repoType: top("RepoType"), repo: top("Repo"),
    sourceCode: top("SourceCode") || top("Repo"), name: top("AutoName") || top("Name"), builds };
}

async function fetchSource(job, pkg) {
  job.step = "Finding where the code lives";
  const info = await fdroidRecord(pkg);
  if (info.repoType !== "git" || !/^https:\/\/[A-Za-z0-9.-]+\/\S+$/.test(info.repo)) {
    throw new Error("This app's code isn't kept in Git, so REA Studio can't fetch it yet.");
  }
  if (fs.statfsSync && (() => { const s = fs.statfsSync(SOURCES); return s.bavail * s.bsize < 150e6; })()) {
    throw new Error("Your server is low on space. Delete some saved source code first.");
  }
  // Match the version REA checked, if we have its report; otherwise F-Droid's newest build.
  const reportVersion = savedReport(pkg)?.summary?.version;
  const build = info.builds.find((b) => b.version === reportVersion) || info.builds[info.builds.length - 1];

  const tmp = sourceDir(pkg) + ".tmp";
  fs.rmSync(tmp, { recursive: true, force: true });
  const git = (args) => run("git", args, { timeout: 3 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  try {
    job.step = "Downloading the source code";
    await git(["init", "-q", tmp]);
    await git(["-C", tmp, "remote", "add", "origin", info.repo]);
    let exact = Boolean(build?.commit);
    try {
      if (!exact) throw new Error("no commit");
      await git(["-C", tmp, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", build.commit]);
    } catch {
      exact = false;
      await git(["-C", tmp, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", "HEAD"]);
    }
    await git(["-C", tmp, "sparse-checkout", "set", "--no-cone", ...CODE_PATTERNS]);
    await git(["-C", tmp, "checkout", "-q", "FETCH_HEAD"]);
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });

    const files = listFiles(tmp);
    const totalSize = files.reduce((a, f) => a + f.size, 0);
    if (!files.length) throw new Error("No code files came down. The app might use an unusual layout.");
    if (totalSize > 80e6) throw new Error("This app's code is too big for your little server.");
    fs.rmSync(sourceDir(pkg), { recursive: true, force: true });
    fs.renameSync(tmp, sourceDir(pkg));
    fs.writeFileSync(path.join(SOURCES, `${pkg}.json`), JSON.stringify({
      pkg, name: info.name || savedReport(pkg)?.summary?.label || pkg, license: info.license, repo: info.repo,
      sourceCode: info.sourceCode, version: exact ? build.version : null, exact,
      fetchedAt: new Date().toISOString(), fileCount: files.length, totalSize,
    }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Keep only the most recent few, so the server doesn't fill up.
  const metas = fs.readdirSync(SOURCES).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(SOURCES, f), null)).filter(Boolean)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  for (const old of metas.slice(MAX_SOURCES)) {
    fs.rmSync(sourceDir(old.pkg), { recursive: true, force: true });
    fs.rmSync(path.join(SOURCES, `${old.pkg}.json`), { force: true });
  }
}

function startSourceJob(pkg) {
  fetching = true;
  const release = holdAwake("source", 10);
  const job = { id: "j_" + crypto.randomBytes(8).toString("hex"), kind: "source", appId: pkg, status: "running", step: "Starting", startedAt: Date.now() };
  jobs.set(job.id, job);
  fetchSource(job, pkg)
    .then(() => { job.status = "done"; })
    .catch((e) => { job.status = "error"; job.error = e.message || "Couldn't fetch the code."; })
    .finally(() => { fetching = false; release(); job.finishedAt = Date.now(); setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000); });
  return job;
}

function safeSourcePath(pkg, rel) {
  const base = sourceDir(pkg);
  const full = path.normalize(path.join(base, String(rel || "")));
  if (!full.startsWith(base + path.sep)) return null;
  try { if (!fs.lstatSync(full).isFile()) return null; } catch { return null; }
  return full;
}

const SOURCE_PROMPT = `You are the code guide inside REA Studio, helping a beginner with no coding background understand an open-source app's real source code.
- Explain in plain, warm, everyday English. Explain any technical word the first time you use it.
- Lead with the answer, then at most 6 short bullet points. They're reading on a phone.
- Quote at most a few short lines of code, only when they help.
- Base your answer on the code you're shown. If it isn't enough, say which other file would probably help.`;

async function askSource(req, res, pkg) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const meta = sourceMeta(pkg);
  if (!meta) return send(res, 404, { error: "Fetch the source code first." });
  const notReady = aiReady();
  if (notReady) return send(res, 400, { error: notReady });
  const question = String(body.question || "").trim().slice(0, 1000);
  if (!question) return send(res, 400, { error: "Type a question first." });
  const file = body.path ? safeSourcePath(pkg, body.path) : null;
  const tree = listFiles(sourceDir(pkg)).map((f) => f.path).slice(0, 400).join("\n");
  const text = file ? fs.readFileSync(file, "utf8").slice(0, 80000) : "";
  try {
    const out = await callModel({
      system: SOURCE_PROMPT, maxTokens: 900, timeoutMs: 2 * 60 * 1000,
      user: `App: ${meta.name} (license: ${meta.license})\n\nFiles in the project:\n${tree}\n\n`
        + (file ? `The file they're looking at, ${body.path}:\n<file>\n${text}\n</file>\n\n` : "")
        + `Question: ${question}`,
    });
    send(res, 200, { answer: out.text, cost: out.cost, brain: brain(out.model).short });
  } catch (e) {
    send(res, 502, { error: `The AI couldn't answer just now (${e.message}).` });
  }
}

// For remixing: pick the source files most related to what the person asked for.
function pickSourceFiles(pkg, query, budget = 60000) {
  const dir = sourceDir(pkg);
  const files = listFiles(dir).filter((f) => f.size < 120000
    && /\.(kt|java|js|ts|dart|py|rs|go|c|cc|cpp|h|swift|html|css|md)$/i.test(f.path)
    && !/(^|\/)(test|androidTest|build|generated)\//i.test(f.path));
  const words = [...new Set(String(query).toLowerCase().match(/[a-z]{4,}/g) || [])].slice(0, 30);
  for (const f of files) {
    const lower = f.path.toLowerCase();
    f.score = (/readme\.md$/.test(lower) ? 6 : 0) + (/\.(kt|java|js|ts|dart)$/.test(lower) ? 2 : 0)
      + (/(main|activity|viewmodel|helper|util|model)/.test(lower) ? 1 : 0);
    for (const w of words) if (lower.includes(w)) f.score += 5;
    try {
      const t = fs.readFileSync(path.join(dir, f.path), "utf8").toLowerCase();
      for (const w of words) if (t.includes(w)) f.score += 1;
    } catch { /* unreadable file */ }
  }
  files.sort((a, b) => b.score - a.score || a.size - b.size);
  const picked = [];
  let used = 0;
  for (const f of files) {
    if (used + f.size > budget) continue;
    picked.push({ path: f.path, text: fs.readFileSync(path.join(dir, f.path), "utf8") });
    used += f.size;
    if (used > budget * 0.9) break;
  }
  return picked;
}

// ---------- routes ----------

async function saveKey(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const key = String(body.openrouterKey || "").trim();
  if (!/^sk-or-[A-Za-z0-9_-]{10,200}$/.test(key)) {
    return send(res, 400, { error: "That doesn't look like an OpenRouter key. It starts with sk-or-." });
  }
  // Check the key with OpenRouter before saving it.
  try {
    const check = await fetch(OPENROUTER_URL.replace(/\/chat\/completions$/, "/key"), {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20 * 1000),
    });
    if (check.status === 401 || check.status === 403) return send(res, 400, { error: "OpenRouter says that key doesn't work. Try copying it again." });
  } catch { /* OpenRouter unreachable right now: save it anyway, questions will show any problem */ }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify({ openrouterKey: key }), { mode: 0o600 });
  OPENROUTER_KEY = key;
  send(res, 200, { aiConnected: true });
}

async function saveBrain(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const list = await allModels();
  const id = String(body.model || "");
  if (!MODEL_ID.test(id) || (list.length && !list.some((m) => m.id === id))) {
    return send(res, 400, { error: "That model isn't on OpenRouter's list." });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readJson(SETTINGS_FILE, {}), model: id }));
  send(res, 200, { model: id, brain: brain(id) });
}

// Search OpenRouter's whole list. Every word typed has to match the name or id.
async function listModels(res, url) {
  const list = await allModels();
  const words = (url.searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = list
    .filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)))
    .sort((a, b) => b.created - a.created);
  const view = (m) => ({ ...brain(m.id), modelId: m.id, context: m.context });
  send(res, 200, {
    total: list.length, count: matches.length,
    models: matches.slice(0, 60).map(view),
    popular: POPULAR.map((p) => modelInfo(p.id)).filter(Boolean).map(view),
  });
}

async function status(res) {
  await allModels();
  const model = currentModel();
  send(res, 200, { aiConnected: Boolean(OPENROUTER_KEY), model, brain: brain(model), limitUsd: LIMIT_USD, spentUsd: spentThisMonth(), canPublish: Boolean(appsUrl()) });
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, buf, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      // Code and styles are always checked for a newer copy, so a phone never mixes old and new parts.
      "Cache-Control": /\.(html|js|css|webmanifest)$/.test(rel) ? "no-cache" : "public, max-age=3600",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self'; frame-ancestors 'none'",
    });
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return send(res, 400, "Bad request"); }
  if (!url.pathname.startsWith("/api/")) {
    if (req.method !== "GET") return send(res, 405, "Method not allowed");
    if (url.pathname.startsWith("/preview/")) return servePreview(req, res, url);
    return serveStatic(req, res, url);
  }
  if (!authorized(req)) return send(res, 401, { error: "Wrong passcode." });
  try {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const route = `${req.method} /${parts.slice(1, 2).join("/")}`;
    if (route === "GET /status") return status(res);
    if (route === "GET /reports") return listReports(res);
    if (route === "POST /investigate") return investigate(req, res);
    if (route === "POST /openrouter-key") return saveKey(req, res);
    if (route === "POST /brain") return saveBrain(req, res);
    if (route === "GET /models") return listModels(res, url);
    if (route === "GET /jobs") {
      const job = jobs.get(parts[2] || "");
      if (!job) return send(res, 404, { error: "That build finished a while ago. Open the app again." });
      return send(res, 200, { status: job.status, step: job.step, error: job.error || "", kind: job.kind || "build",
        projectId: job.projectId || null, appId: job.appId || null,
        seconds: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000) });
    }
    if (parts[1] === "sources") {
      const pkg = parts[2] || "";
      if (!PACKAGE_ID.test(pkg)) return send(res, 400, { error: "That isn't an app id." });
      if (parts.length === 3 && req.method === "POST") {
        if (fetching) return send(res, 429, { error: "Already fetching some code. Give it a minute." });
        return send(res, 200, { jobId: startSourceJob(pkg).id });
      }
      const meta = sourceMeta(pkg);
      if (!meta || !fs.existsSync(sourceDir(pkg))) return send(res, 404, { error: "Not fetched yet." });
      if (parts.length === 3 && req.method === "GET") return send(res, 200, { ...meta, files: listFiles(sourceDir(pkg)).sort((a, b) => a.path.localeCompare(b.path)) });
      if (parts[3] === "file" && req.method === "GET") {
        const file = safeSourcePath(pkg, url.searchParams.get("path"));
        if (!file) return send(res, 404, { error: "That file isn't here." });
        const size = fs.statSync(file).size;
        if (size > 400 * 1024) return send(res, 200, { path: url.searchParams.get("path"), text: "", tooBig: true, size });
        return send(res, 200, { path: url.searchParams.get("path"), text: fs.readFileSync(file, "utf8"), size });
      }
      if (parts[3] === "ask" && req.method === "POST") return askSource(req, res, pkg);
      if (parts.length === 3 && req.method === "DELETE") {
        fs.rmSync(sourceDir(pkg), { recursive: true, force: true });
        fs.rmSync(path.join(SOURCES, `${pkg}.json`), { force: true });
        return send(res, 200, { deleted: true });
      }
    }
    if (parts[1] === "projects") {
      if (parts.length === 2 && req.method === "GET") return listProjects(res);
      if (parts.length === 2 && req.method === "POST") return createProject(req, res);
      const project = loadProject(parts[2] || "");
      if (!project) return send(res, 404, { error: "That app wasn't found." });
      if (parts.length === 3 && req.method === "GET") return send(res, 200, { project: projectView(project) });
      if (parts.length === 3 && req.method === "DELETE") { unpublish(project); fs.rmSync(projectFile(project.id), { force: true }); return send(res, 200, { deleted: true }); }
      if (parts[3] === "publish" && req.method === "POST") return publish(res, project);
      if (parts[3] === "publish" && req.method === "DELETE") { unpublish(project); saveProject(project); return send(res, 200, { project: projectView(project) }); }
      if (parts[3] === "messages" && req.method === "POST") return addMessage(req, res, project);
      if (parts[3] === "undo" && req.method === "POST") return undo(res, project);
      if (parts[3] === "storage" && req.method === "PUT") return saveStorage(req, res, project);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, () => console.log(`REA Studio is running on port ${PORT}`));
