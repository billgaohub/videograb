"use strict";
/* VideoGrab Desktop v0.1 — paste a URL, resolve, download.
 * Local-only server: binds 127.0.0.1, collects nothing, talks only to
 * the video platforms the user pastes links for. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const isSea = (() => { try { return require("node:sea").isSea(); } catch (_) { return false; } })();
// When packaged with a bundled ffmpeg asset, extract it next to the exe on
// first run so the download engine can spawn it. Must happen BEFORE the
// download engine module resolves the ffmpeg path.
if (isSea) {
  try {
    const sea = require("node:sea");
    const ffName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffBeside = path.join(path.dirname(process.execPath), ffName);
    if (!fs.existsSync(ffBeside) && sea.getAssetKeys().includes("ffmpeg-bin")) {
      fs.writeFileSync(ffBeside, Buffer.from(sea.getAsset("ffmpeg-bin")));
      try { fs.chmodSync(ffBeside, 0o755); } catch (_) {}
    }
  } catch (_) {}
}

const { resolveInput } = require("./lib/resolvers");
const { runDownload, tasks, FFMPEG, emit } = require("./lib/download");

const PORT = Number(process.env.PORT || 17890);
const baseDir = isSea ? path.dirname(process.execPath) : __dirname;
const outDir = process.env.VG_DOWNLOADS || path.join(baseDir, "downloads");
fs.mkdirSync(outDir, { recursive: true });

function loadIndexHtml() {
  if (isSea) {
    try { return require("node:sea").getAsset("index.html", "utf8"); } catch (_) {}
  }
  return fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
}
const INDEX_HTML = loadIndexHtml();

const resolvedCache = new Map(); // token -> {result, at}
function cachePut(result) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  resolvedCache.set(token, { result, at: Date.now() });
  for (const [k, v] of resolvedCache) if (Date.now() - v.at > 30 * 60 * 1000) resolvedCache.delete(k);
  return token;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(INDEX_HTML);
    }
    if (req.method === "GET" && u.pathname === "/api/info") {
      return sendJson(res, 200, { outDir, ffmpeg: FFMPEG, version: "0.2.0" });
    }
    if (req.method === "POST" && u.pathname === "/api/resolve") {
      const { url } = await readBody(req);
      const result = await resolveInput(url);
      const token = cachePut(result);
      return sendJson(res, 200, {
        ok: true, token, site: result.site, title: result.title,
        items: result.items.map((it, i) => ({ index: i, kind: it.kind, label: it.label })),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/download") {
      const { token, index } = await readBody(req);
      const entry = resolvedCache.get(token);
      if (!entry) return sendJson(res, 400, { ok: false, error: "解析结果已过期，请重新解析" });
      const item = entry.result.items[Number(index)];
      if (!item) return sendJson(res, 400, { ok: false, error: "选项不存在" });
      const task = await runDownload(item, entry.result.title, outDir);
      return sendJson(res, 200, { ok: true, taskId: task.id });
    }
    if (req.method === "GET" && u.pathname.startsWith("/api/events/")) {
      const task = tasks.get(u.pathname.split("/").pop());
      if (!task) return sendJson(res, 404, { ok: false, error: "任务不存在" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      task.listeners.add(res);
      req.on("close", () => task.listeners.delete(res));
      emit(task); // send current state immediately
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/file") {
      // Play a downloaded file (basename only, confined to outDir)
      const name = path.basename(u.searchParams.get("name") || "");
      const file = path.join(outDir, name);
      if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { ok: false, error: "文件不存在" });
      const size = fs.statSync(file).size;
      const range = req.headers.range;
      const type = name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        const start = m && m[1] ? +m[1] : 0;
        const end = m && m[2] ? Math.min(+m[2], size - 1) : size - 1;
        res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "GET" && u.pathname === "/api/stream") {
      // Preview-proxy a resolved MP4 item (carries the item's headers,
      // forwards Range so the player can seek)
      const entry = resolvedCache.get(u.searchParams.get("token") || "");
      const item = entry?.result.items[Number(u.searchParams.get("index"))];
      if (!item || item.kind !== "mp4") return sendJson(res, 400, { ok: false, error: "该选项不支持预览" });
      const headers = { ...(item.headers || {}) };
      if (req.headers.range) headers.Range = req.headers.range;
      const up = await fetch(item.url, { headers, redirect: "follow", signal: AbortSignal.timeout(1000 * 60 * 30) });
      const out = { "Content-Type": up.headers.get("content-type") || "video/mp4", "Accept-Ranges": "bytes" };
      for (const h of ["content-length", "content-range"]) if (up.headers.get(h)) out[h.replace(/\b\w/g, (c) => c.toUpperCase())] = up.headers.get(h);
      res.writeHead(up.status, out);
      const reader = up.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
      return res.end();
    }
    if (req.method === "GET" && u.pathname === "/api/tasks") {
      return sendJson(res, 200, {
        ok: true,
        tasks: [...tasks.values()].map((t) => ({
          id: t.id, title: t.title, label: t.label, status: t.status,
          percent: t.percent, file: t.file, error: t.error,
        })),
      });
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`VideoGrab Desktop 已启动：${url}`);
  console.log(`下载保存到：${outDir}`);
  console.log(`ffmpeg：${FFMPEG}`);
  if (process.env.VG_OPEN === "1" || isSea) {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
