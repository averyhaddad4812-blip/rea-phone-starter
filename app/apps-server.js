#!/usr/bin/env node
// REA Studio's app host: serves the apps you publish, each at its own lasting link.
//
// It runs on a different web address from REA Studio on purpose: a published app can
// never see REA Studio's passcode, key or data. It only reads published copies from
// DATA_DIR/published, never anything else, and it has no login and nothing to change.
//
// Every published app gets:
// - a home-screen install (a web app manifest and an offline-ready service worker),
// - its own saved data (each app's localStorage keys are kept apart from other apps').
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLISHED = path.join(DATA, "published");
const ICONS = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8081);
const SLUG = /^[a-z0-9][a-z0-9-]{2,60}$/;

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra,
  });
  res.end(body);
}

function readMeta(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(PUBLISHED, slug, "meta.json"), "utf8")); } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Added to the top of every published app: install support, offline support, and
// localStorage kept separate per app (apps share this web address).
function headExtras(slug, meta) {
  return `
<link rel="manifest" href="/${slug}/manifest.webmanifest">
<link rel="apple-touch-icon" href="/${slug}/icon-192.png">
<meta name="theme-color" content="${esc(meta.theme || "#181818")}">
<script>(function(){var P=${JSON.stringify(slug + ":")};try{var r=window.localStorage;
function own(k){return P+String(k)}function keys(){var o=[];for(var i=0;i<r.length;i++){var k=r.key(i);if(k&&k.indexOf(P)===0)o.push(k.slice(P.length))}return o}
var s={getItem:function(k){return r.getItem(own(k))},setItem:function(k,v){r.setItem(own(k),String(v))},removeItem:function(k){r.removeItem(own(k))},
clear:function(){keys().forEach(function(k){r.removeItem(own(k))})},key:function(i){return keys()[i]||null},get length(){return keys().length}};
Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(e){}
if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/${slug}/sw.js",{scope:"/${slug}/"}).catch(function(){})})})();</script>
`;
}

function manifest(slug, meta) {
  return JSON.stringify({
    id: `/${slug}/`, name: meta.name, short_name: meta.name.slice(0, 24), start_url: `/${slug}/`, scope: `/${slug}/`,
    display: "standalone", background_color: meta.theme || "#181818", theme_color: meta.theme || "#181818",
    icons: [
      { src: `/${slug}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/${slug}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/${slug}/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
}

// Network first, so updates show up right away; the saved copy keeps it working offline.
function serviceWorker(slug, meta) {
  return `const C=${JSON.stringify("app-" + slug + "-" + (meta.version || 1))};const H="/${slug}/";
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.add(H)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n.startsWith("app-${slug}-")&&n!==C).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin||!u.pathname.startsWith(H))return;
e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match(H))))});`;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return send(res, 400, "Bad request"); }
  const [slug, file = ""] = url.pathname.replace(/^\/+/, "").split(/\/(.*)/s);
  if (!slug) return send(res, 200, "<!doctype html><meta name=viewport content='width=device-width'><title>Apps</title><p style='font-family:system-ui;padding:24px'>Nothing to see here. Open an app with its own link.</p>", "text/html; charset=utf-8");
  if (!SLUG.test(slug)) return send(res, 404, "Not found");
  const meta = readMeta(slug);
  if (!meta) return send(res, 404, "This app isn't published (any more).");
  if (url.pathname === `/${slug}`) return send(res, 301, "", "text/plain", { Location: `/${slug}/` });

  if (file === "" || file === "index.html") {
    let html;
    try { html = fs.readFileSync(path.join(PUBLISHED, slug, "index.html"), "utf8"); } catch { return send(res, 404, "Not found"); }
    const extras = headExtras(slug, meta);
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + extras) : extras + html;
    return send(res, 200, html, "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
  }
  if (file === "manifest.webmanifest") return send(res, 200, manifest(slug, meta), "application/manifest+json", { "Cache-Control": "no-cache" });
  if (file === "sw.js") return send(res, 200, serviceWorker(slug, meta), "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
  const icon = { "icon-192.png": "app-icon-192.png", "icon-512.png": "app-icon-512.png", "icon-maskable-512.png": "app-icon-maskable-512.png" }[file];
  if (icon) {
    try { return send(res, 200, fs.readFileSync(path.join(ICONS, icon)), "image/png", { "Cache-Control": "public, max-age=86400" }); }
    catch { return send(res, 404, "Not found"); }
  }
  send(res, 404, "Not found");
});

server.listen(PORT, () => console.log(`REA Studio app host is running on port ${PORT}`));
