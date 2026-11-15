#!/usr/bin/env node
// REA Studio back room: a tiny, dependency-free server.
//
// - Serves the phone app (app/public).
// - Runs REA checks on open-source F-Droid apps using the kit's scripts.
// - Asks Claude (through OpenRouter) to explain the results in plain English.
// - Locked with a passcode, one investigation at a time, with a monthly spending limit.
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
const USAGE_FILE = path.join(DATA, "usage.json");

const PORT = Number(process.env.PORT || 8080);
const PASSCODE = process.env.APP_PASSCODE || "";
const DEV = process.env.DEV === "1";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5";
const OPENROUTER_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1") + "/chat/completions";
const LIMIT_USD = Number(process.env.MONTHLY_LIMIT_USD || 20);
const CACHE_DAYS = 7;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

if (!PASSCODE && !DEV) {
  console.error("Set APP_PASSCODE so only you can use the app (or DEV=1 for local testing).");
  process.exit(1);
}
fs.mkdirSync(REPORTS, { recursive: true });

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

// Passcode check that takes the same time whether it's right or wrong.
const failures = new Map();
function authorized(req) {
  if (!PASSCODE) return true;
  const ip = req.socket.remoteAddress || "?";
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (Date.now() < f.until) return false;
  const given = Buffer.from(String(req.headers["x-passcode"] || ""));
  const want = Buffer.from(PASSCODE);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (ok) { failures.delete(ip); return true; }
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.count = 0; } // 5 wrong tries: wait 5 minutes
  failures.set(ip, f);
  return false;
}

// ---------- spending ----------

function monthKey() { return new Date().toISOString().slice(0, 7); }
function readUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { return {}; }
}
function spentThisMonth() { return Number(readUsage()[monthKey()] || 0); }
function addSpend(usd) {
  const u = readUsage();
  u[monthKey()] = Math.round((Number(u[monthKey()] || 0) + usd) * 1e6) / 1e6;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}

// ---------- REA checks ----------

function reportPaths(appId) {
  return { md: path.join(REPORTS, `${appId}.md`), json: path.join(REPORTS, `${appId}.json`) };
}

function cachedReport(appId) {
  const p = reportPaths(appId);
  try {
    const age = Date.now() - fs.statSync(p.json).mtimeMs;
    if (age < CACHE_DAYS * 24 * 3600 * 1000) {
      return { summary: JSON.parse(fs.readFileSync(p.json, "utf8")), markdown: fs.readFileSync(p.md, "utf8") };
    }
  } catch { /* no usable cached report */ }
  return null;
}

async function checkApp(appId) {
  const cached = cachedReport(appId);
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

// ---------- Claude, through OpenRouter ----------

const SYSTEM_PROMPT = `You are the explainer inside REA Studio, a phone app that helps a beginner understand Android apps.
You are given a report that REA (an open-source reverse engineering toolkit) produced from the app's file.
Rules:
- Answer the person's question using ONLY facts in the report. Never guess or add outside facts about the app.
- Plain, warm, everyday English for someone with no coding background. Explain any technical word you use.
- Short: lead with the answer, then at most 5 short bullet points. They're reading on a phone.
- If the report can't answer the question (for example how a specific feature works inside the code), say so honestly and say a deeper code check would be needed.
- Finish with one line that starts with "Limits:" saying what this check could not see.`;

async function askClaude(question, report) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "REA Studio",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      usage: { include: true },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Question: ${question}\n\nREA report:\n<report>\n${report}\n</report>` },
      ],
    }),
    signal: AbortSignal.timeout(90 * 1000),
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
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  const usage = data.usage || {};
  // OpenRouter reports the real cost; if it's missing, estimate from Sonnet-class prices.
  const cost = typeof usage.cost === "number" ? usage.cost
    : ((usage.prompt_tokens || 0) * 2 + (usage.completion_tokens || 0) * 10) / 1e6;
  addSpend(cost);
  const m = text.match(/\n?\s*\**Limits:?\**:?\s*([\s\S]*)$/i);
  return {
    answer: m ? text.slice(0, m.index).trim() : text,
    limits: m ? m[1].trim() : "",
    cost,
  };
}

// ---------- routes ----------

let busy = false;

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

  if (busy) return send(res, 429, { error: "Still working on the last investigation. Try again in a minute." });
  busy = true;
  try {
    // Safety, Version 1: only apps from F-Droid, where every app is open source, and only
    // read-only checks of the app file (clean-room: no decompiling, nothing is run).
    const safety = { passed: true, note: "On F-Droid, where every app is open source · Clean-room mode" };
    const { summary, markdown, cached } = await checkApp(appId);

    let ai = { answer: "", limits: "", cost: 0 };
    let aiNote = "";
    if (!OPENROUTER_KEY) {
      aiNote = "Connect your OpenRouter key to get Claude's plain-English explanation. The report is ready below.";
    } else if (spentThisMonth() >= LIMIT_USD) {
      aiNote = `You've reached your $${LIMIT_USD} monthly limit, so Claude is paused until next month. The report is ready below.`;
    } else {
      try { ai = await askClaude(question, markdown); }
      catch (e) { aiNote = `Claude couldn't answer just now (${e.message}). The report is ready below.`; }
    }
    send(res, 200, { appId, question, safety, cached, summary, ...ai, aiNote, spentUsd: spentThisMonth(), limitUsd: LIMIT_USD });
  } catch (e) {
    send(res, 502, { error: e.message || "Something went wrong running REA." });
  } finally {
    busy = false;
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

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, buf, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": rel === "/sw.js" || rel === "/index.html" ? "no-cache" : "public, max-age=3600",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) {
    if (req.method !== "GET") return send(res, 405, "Method not allowed");
    return serveStatic(req, res);
  }
  if (!authorized(req)) return send(res, 401, { error: "Wrong passcode." });
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return send(res, 200, { aiConnected: Boolean(OPENROUTER_KEY), model: MODEL, limitUsd: LIMIT_USD, spentUsd: spentThisMonth() });
    }
    if (req.method === "GET" && url.pathname === "/api/reports") return listReports(res);
    if (req.method === "POST" && url.pathname === "/api/investigate") return investigate(req, res);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, () => console.log(`REA Studio is running on port ${PORT}`));
