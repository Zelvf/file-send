"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

test("two devices see one upload advance and finish", async () => {
  const port = 18000 + crypto.randomInt(10000);
  const code = "76543210";
  const server = spawn(process.execPath, ["server.js"], {
    cwd: require("node:path").join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", FILE_SEND_CODE: code },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", chunk => { output += chunk; if (output.includes("FILE SEND is running")) resolve(); });
    server.once("exit", exitCode => reject(new Error(`Server exited: ${exitCode}`)));
  });
  const timeout = delay(5000).then(() => { throw new Error("Server did not start"); });
  let fileId;
  try {
    await Promise.race([ready, timeout]);
    async function unlock() {
      const response = await fetch(`${base}/api/unlock`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code })
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }
    const [sender, viewer] = await Promise.all([unlock(), unlock()]);
    async function transfers(cookie) {
      const response = await fetch(`${base}/api/transfers`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return (await response.json()).transfers;
    }
    const name = `progress-check-${crypto.randomBytes(4).toString("hex")}.bin`;
    const total = 4 * 128 * 1024;
    const upload = new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/files?name=${name}`, {
        method: "PUT", headers: { Cookie: sender, "Content-Length": total }
      }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.write(Buffer.alloc(128 * 1024, 1));
      (async () => {
        for (let i = 0; i < 3; i++) {
          await delay(450);
          req.write(Buffer.alloc(128 * 1024, i + 2));
        }
        req.end();
      })().catch(reject);
    });
    let active;
    for (let i = 0; i < 10; i++) {
      active = (await transfers(viewer)).find(item => item.name === name && item.state === "active");
      if (active?.transferred > 0 && active.transferred < total) break;
      await delay(100);
    }
    assert.ok(active, "other device sees active transfer");
    assert.ok(active.transferred > 0 && active.transferred < total, "other device sees partial progress");
    assert.equal(active.total, total);
    assert.ok((await transfers(sender)).some(item => item.id === active.id), "sender sees the same transfer");
    const result = await upload;
    assert.equal(result.status, 201);
    fileId = result.body.file.id;
    assert.ok((await transfers(viewer)).some(item => item.id === active.id && item.state === "done"));
    const download = await fetch(`${base}/api/files/${fileId}`, { headers: { Cookie: viewer } });
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, total);
    assert.ok((await transfers(sender)).some(item => item.direction === "download" && item.state === "done"));
    const deleted = await fetch(`${base}/api/files/${fileId}`, { method: "DELETE", headers: { Cookie: sender } });
    assert.equal(deleted.status, 200);
    fileId = undefined;
  } finally {
    server.kill();
  }
});
