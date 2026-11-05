"use strict";
/* VideoGrab Desktop — download engine: streamed MP4 with byte progress,
 * HLS and DASH handled by ffmpeg with time-based progress. */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const exeDir = path.dirname(process.execPath);
  for (const cand of [
    path.join(exeDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    path.join(process.cwd(), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ]) {
    if (fs.existsSync(cand)) return cand;
  }
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return "ffmpeg"; // last resort; spawn will error visibly
}
const FFMPEG = findFfmpeg();

function sanitize(name) {
  return String(name || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video";
}

const tasks = new Map();
let seq = 0;

function newTask(title, label, outDir) {
  const id = `t${++seq}_${Date.now().toString(36)}`;
  const task = {
    id, title, label, status: "queued", percent: 0,
    downloaded: 0, total: 0, speed: "", file: "", error: "",
    listeners: new Set(), outDir,
  };
  tasks.set(id, task);
  return task;
}

function emit(task) {
  const payload = JSON.stringify({
    id: task.id, status: task.status, percent: task.percent,
    downloaded: task.downloaded, total: task.total, speed: task.speed,
    file: task.file, error: task.error, title: task.title, label: task.label,
  });
  for (const res of task.listeners) { try { res.write(`data: ${payload}\n\n`); } catch (_) {} }
  if (task.status === "done" || task.status === "error") {
    for (const res of task.listeners) { try { res.end(); } catch (_) {} }
    task.listeners.clear();
  }
}

function destPath(task, ext = ".mp4") {
  const titlePart = sanitize(task.title).slice(0, 56);
  const labelPart = task.label.replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  const base = `${titlePart} [${labelPart}]`;
  let p = path.join(task.outDir, base + ext);
  let n = 1;
  while (fs.existsSync(p)) p = path.join(task.outDir, `${base} (${n++})${ext}`);
  return p;
}

async function streamToFile(url, headers, dest, task, baseBytes, grandTotal) {
  const resp = await fetch(url, { headers: headers || {}, redirect: "follow", signal: AbortSignal.timeout(1000 * 60 * 60) });
  if (!resp.ok) throw new Error(`下载请求返回 ${resp.status}`);
  const len = Number(resp.headers.get("content-length") || 0);
  const out = fs.createWriteStream(dest);
  const reader = resp.body.getReader();
  let got = 0, lastEmit = 0, lastBytes = baseBytes, lastTime = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    task.downloaded = baseBytes + got;
    const now = Date.now();
    if (now - lastEmit > 200) {
      const dt = (now - lastTime) / 1000;
      if (dt > 0) task.speed = `${((task.downloaded - lastBytes) / dt / 1048576).toFixed(1)} MB/s`;
      lastBytes = task.downloaded; lastTime = now; lastEmit = now;
      if (grandTotal) task.percent = Math.min(99, Math.floor(task.downloaded / grandTotal * 100));
      emit(task);
    }
  }
  await new Promise((r) => out.end(r));
  if (len && got < len * 0.99) {
    throw new Error(`流下载不完整：${got}/${len} 字节`);
  }
  return len || got;
}

async function downloadMp4(item, task) {
  task.status = "downloading"; emit(task);
  const dest = destPath(task);
  const headResp = await fetch(item.url, { headers: item.headers || {}, redirect: "follow", signal: AbortSignal.timeout(1000 * 60 * 60) });
  if (!headResp.ok) throw new Error(`下载请求返回 ${headResp.status}`);
  task.total = Number(headResp.headers.get("content-length") || 0);
  // stream this same response to disk
  const out = fs.createWriteStream(dest);
  const reader = headResp.body.getReader();
  let lastEmit = 0, lastBytes = 0, lastTime = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    task.downloaded += value.length;
    const now = Date.now();
    if (now - lastEmit > 200) {
      const dt = (now - lastTime) / 1000;
      if (dt > 0) task.speed = `${((task.downloaded - lastBytes) / dt / 1048576).toFixed(1)} MB/s`;
      lastBytes = task.downloaded; lastTime = now; lastEmit = now;
      if (task.total) task.percent = Math.min(99, Math.floor(task.downloaded / task.total * 100));
      emit(task);
    }
  }
  await new Promise((r) => out.end(r));
  if (task.total && task.downloaded < task.total * 0.99) {
    try { fs.unlinkSync(dest); } catch (_) {}
    throw new Error(`下载不完整：${task.downloaded}/${task.total} 字节（连接被提前关闭）`);
  }
  task.percent = 100; task.file = dest; task.status = "done"; emit(task);
}

function ffmpegArgsFor(item) {
  const h = item.headers || {};
  const args = ["-hide_banner", "-loglevel", "error", "-stats", "-y"];
  const headerStr = Object.entries(h).filter(([k]) => k.toLowerCase() !== "user-agent")
    .map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const ua = h["User-Agent"] || h["user-agent"];
  const pushInput = (u) => {
    if (ua) args.push("-user_agent", ua);
    if (headerStr) args.push("-headers", headerStr);
    args.push("-i", u);
  };
  return { args, pushInput };
}

function runFfmpeg(item, task, buildArgs, durationSec) {
  return new Promise((resolve, reject) => {
    const dest = buildArgs.dest;
    const args = buildArgs.args.concat(["-c", "copy", "-movflags", "+faststart", dest]);
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let errTail = "";
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      errTail = (errTail + s).slice(-2000);
      const tm = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (tm && durationSec > 0) {
        const secs = +tm[1] * 3600 + +tm[2] * 60 + +tm[3];
        task.percent = Math.min(99, Math.floor(secs / durationSec * 100));
      }
      const sm = s.match(/speed=\s*([\d.]+x)/);
      if (sm) task.speed = sm[1];
      emit(task);
    });
    proc.on("error", (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        task.percent = 100; task.file = dest; task.status = "done"; emit(task);
        resolve();
      } else {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(new Error(`ffmpeg 退出码 ${code}：${errTail.split(/\r?\n/).filter(Boolean).pop() || "未知错误"}`));
      }
    });
  });
}

async function hlsDuration(item) {
  try {
    const resp = await fetch(item.url, { headers: item.headers || {}, signal: AbortSignal.timeout(15000) });
    let text = await resp.text();
    if (text.includes("#EXT-X-STREAM-INF")) {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
      if (first) {
        const u = new URL(first.trim(), item.url).href;
        const r2 = await fetch(u, { headers: item.headers || {}, signal: AbortSignal.timeout(15000) });
        text = await r2.text();
      }
    }
    let total = 0;
    for (const mm of text.matchAll(/#EXTINF:([\d.]+)/g)) total += +mm[1];
    return total;
  } catch (_) { return 0; }
}

async function downloadHls(item, task) {
  task.status = "downloading"; emit(task);
  const dur = await hlsDuration(item);
  const { args, pushInput } = ffmpegArgsFor(item);
  pushInput(item.url);
  args.push("-bsf:a", "aac_adtstoasc");
  await runFfmpeg(item, task, { args, dest: destPath(task) }, dur);
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true });
    let buf = "";
    proc.stderr.on("data", (d) => { buf += d.toString(); });
    proc.on("close", () => {
      const m = buf.match(/Duration: (\d+):(\d+):([\d.]+)/);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0);
    });
    proc.on("error", () => resolve(0));
  });
}

async function downloadDash(item, task) {
  // Two-step on purpose: some CDNs (Bilibili) cut ffmpeg's own HTTP reads
  // short while still exiting 0. Download both streams with the regular
  // downloader first, then merge local files, then verify duration.
  task.status = "downloading"; emit(task);
  const tmpV = path.join(task.outDir, `.vg-${task.id}-v.tmp`);
  const tmpA = path.join(task.outDir, `.vg-${task.id}-a.tmp`);
  const tryUrls = async (urls, dest, baseBytes) => {
    let lastErr;
    for (const u of urls && urls.length ? urls : []) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await streamToFile(u, item.headers, dest, task, baseBytes, 0); }
        catch (e) { lastErr = e; }
      }
    }
    throw lastErr || new Error("没有可用的下载地址");
  };
  try {
    const vLen = await tryUrls(item.videoUrls || [item.videoUrl], tmpV, 0);
    task.total = vLen;
    emit(task);
    const aLen = await tryUrls(item.audioUrls || [item.audioUrl], tmpA, vLen);
    task.total = vLen + aLen;

    task.status = "merging"; task.percent = 99; emit(task);
    const dest = destPath(task);
    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", tmpV, "-i", tmpA, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", dest], { windowsHide: true });
      let err = "";
      proc.stderr.on("data", (d) => { err = (err + d.toString()).slice(-1000); });
      proc.on("error", (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)));
      proc.on("close", (code) => {
        if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) resolve();
        else reject(new Error(`ffmpeg 合并失败（退出码 ${code}）：${err.split(/\r?\n/).filter(Boolean).pop() || ""}`));
      });
    });
    if (item.durationSec > 0) {
      const actual = await probeDuration(dest);
      if (actual > 0 && actual < item.durationSec * 0.85) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw new Error(`合并结果时长异常：${actual.toFixed(0)}s，预期约 ${item.durationSec}s（源流可能被截断）`);
      }
    }
    task.percent = 100; task.file = dest; task.status = "done"; emit(task);
  } finally {
    try { fs.unlinkSync(tmpV); } catch (_) {}
    try { fs.unlinkSync(tmpA); } catch (_) {}
  }
}

async function runDownload(item, title, outDir) {
  const task = newTask(title, item.label, outDir);
  (async () => {
    try {
      if (item.kind === "mp4") await downloadMp4(item, task);
      else if (item.kind === "hls") await downloadHls(item, task);
      else if (item.kind === "dash") await downloadDash(item, task);
      else throw new Error(`未知类型 ${item.kind}`);
    } catch (e) {
      task.status = "error"; task.error = String(e.message || e); emit(task);
    }
  })();
  return task;
}

module.exports = { runDownload, tasks, FFMPEG, sanitize, emit };
