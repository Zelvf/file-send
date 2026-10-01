"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const ROOT = __dirname;
const DATA = path.join(ROOT, "received");
const PID_FILE = path.join(DATA, `server.${PORT}.pid.json`);
const CODE = process.env.FILE_SEND_CODE || String(crypto.randomInt(10000000, 100000000));
const sessions = new Map();
const failed = new Map();
const transfers = new Map();
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
function json(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}
function cookie(req) {
  return (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("lan_session="))?.slice(12);
}
function authorized(req) {
  const token = cookie(req);
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readSmallBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1024) throw new Error("Request too large");
  }
  return JSON.parse(text);
}
function safeName(value) {
  const name = String(value || "").replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "file";
}
function validId(id) { return /^[a-f0-9]{32}$/.test(id); }
function beginTransfer(name, direction, total) {
  const id = crypto.randomBytes(16).toString("hex");
  const transfer = { id, name, direction, transferred: 0, total, state: "active" };
  transfers.set(id, transfer);
  return transfer;
}
function endTransfer(transfer, state) {
  transfer.state = state;
  const timer = setTimeout(() => transfers.delete(transfer.id), 15000);
  timer.unref();
}
async function listFiles() {
  const names = await fsp.readdir(DATA);
  const files = await Promise.all(names.filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(async n => {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(DATA, n), "utf8"));
      if (!validId(meta.id)) return null;
      await fsp.access(path.join(DATA, meta.id));
      return meta;
    } catch { return null; }
  }));
  return files.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function addresses() {
  return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => `http://${n.address}:${PORT}`);
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      return send(res, 200, await fsp.readFile(path.join(ROOT, "public", file)), { "Content-Type": type });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, { unlocked: authorized(req), addresses: addresses() });
    }
    if (req.method === "POST" && url.pathname === "/api/unlock") {
      if (!sameOrigin(req)) return json(res, 403, { error: "Invalid origin" });
      const ip = req.socket.remoteAddress || "unknown";
      const attempt = failed.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, 429, { error: "Too many tries. Wait a minute." });
      let value;
      try { value = await readSmallBody(req); } catch { return json(res, 400, { error: "Invalid code" }); }
      const submitted = Buffer.from(String(value.code || ""));
      const expected = Buffer.from(CODE);
      if (submitted.length !== expected.length || !crypto.timingSafeEqual(submitted, expected)) {
        attempt.count++;
        attempt.until = attempt.count >= 5 ? Date.now() + 60000 : 0;
        if (attempt.count >= 5) attempt.count = 0;
        failed.set(ip, attempt);
        return json(res, 401, { error: "Wrong access code" });
      }
      failed.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
      res.setHeader("Set-Cookie", `lan_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/lock") {
      if (!sameOrigin(req)) return json(res, 403, { error: "Invalid origin" });
      sessions.delete(cookie(req));
      res.setHeader("Set-Cookie", "lan_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }
    if (!authorized(req)) return json(res, 401, { error: "Enter the access code first" });
    if (req.method === "GET" && url.pathname === "/api/transfers") {
      return json(res, 200, { transfers: [...transfers.values()] });
    }
    if (req.method === "GET" && url.pathname === "/api/files") return json(res, 200, { files: await listFiles() });
    if (req.method === "PUT" && url.pathname === "/api/files") {
      if (!sameOrigin(req)) return json(res, 403, { error: "Invalid origin" });
      const rawName = url.searchParams.get("name");
      if (!rawName || rawName.length > 500) return json(res, 400, { error: "Invalid file name" });
      const length = Number(req.headers["content-length"]);
      if (Number.isFinite(length) && length > MAX_BYTES) return json(res, 413, { error: "File exceeds 5 GB limit" });
      const id = crypto.randomBytes(16).toString("hex");
      const temp = path.join(DATA, `${id}.part`);
      const transfer = beginTransfer(safeName(rawName), "upload", Number.isFinite(length) && length > 0 ? length : null);
      let size = 0;
      let exceeded = false;
      try {
        await pipeline(req, async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > MAX_BYTES) { exceeded = true; throw new Error("File exceeds 5 GB limit"); }
            transfer.transferred = size;
            yield chunk;
          }
        }, fs.createWriteStream(temp, { flags: "wx" }));
        const meta = { id, name: safeName(rawName), size, createdAt: new Date().toISOString() };
        await fsp.rename(temp, path.join(DATA, id));
        await fsp.writeFile(path.join(DATA, `${id}.json`), JSON.stringify(meta), { flag: "wx" });
        transfer.total = size;
        endTransfer(transfer, "done");
        return json(res, 201, { file: meta });
      } catch (error) {
        endTransfer(transfer, "failed");
        await fsp.rm(temp, { force: true }).catch(() => {});
        if (exceeded) return json(res, 413, { error: "File exceeds 5 GB limit" });
        if (req.aborted) return;
        throw error;
      }
    }
    const match = url.pathname.match(/^\/api\/files\/([a-f0-9]{32})$/);
    if (match && req.method === "GET") {
      const id = match[1];
      let meta;
      try { meta = JSON.parse(await fsp.readFile(path.join(DATA, `${id}.json`), "utf8")); }
      catch { return json(res, 404, { error: "File not found" }); }
      const stat = await fsp.stat(path.join(DATA, id)).catch(() => null);
      if (!stat) return json(res, 404, { error: "File not found" });
      const name = safeName(meta.name);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      const transfer = beginTransfer(name, "download", stat.size);
      try {
        await pipeline(fs.createReadStream(path.join(DATA, id)), new Transform({
          transform(chunk, encoding, callback) {
            transfer.transferred += chunk.length;
            callback(null, chunk);
          }
        }), res);
        endTransfer(transfer, "done");
      } catch (error) {
        endTransfer(transfer, "failed");
        if (!res.destroyed) res.destroy(error);
      }
      return;
    }
    if (match && req.method === "DELETE") {
      if (!sameOrigin(req)) return json(res, 403, { error: "Invalid origin" });
      const id = match[1];
      await fsp.rm(path.join(DATA, id), { force: true });
      await fsp.rm(path.join(DATA, `${id}.json`), { force: true });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "Server error" });
    else res.destroy();
  }
}

fsp.mkdir(DATA, { recursive: true }).then(() => {
  http.createServer(handler).listen(PORT, HOST, () => {
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, script: __filename }));
    console.log("\nFILE SEND is running. Keep this window open.\n");
    console.log(`Access code: ${CODE}\n`);
    console.log(`This computer: http://localhost:${PORT}`);
    addresses().forEach(a => console.log(`Other devices: ${a}`));
    console.log("\nOpen an Other devices address on a phone or computer on the same Wi-Fi.\n");
  });
}).catch(error => { console.error(error); process.exit(1); });

process.on("exit", () => {
  try {
    const recorded = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    if (recorded.pid === process.pid) fs.rmSync(PID_FILE, { force: true });
  } catch { /* The file may already have been removed by stop.cmd. */ }
});
