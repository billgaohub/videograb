// VideoGrab — popup controller.
// Renders detected videos and syncs with persistent background downloads (Offscreen API).
// Closing the popup or switching tabs never interrupts ongoing downloads.

const $list = document.getElementById("list");
const $empty = document.getElementById("empty");
const $status = document.getElementById("status");
let activeTabId = null;
let currentItems = [];
let taskMap = new Map();

const NON_VIDEO_EXT_RE = /\.(vtt|srt|ass|sub|xml|json|js|css|html|txt|jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot|m4a|aac|mp3|ogg|wav)(\?|#|$)/i;
const NON_VIDEO_KEYWORDS_RE = /(thumb|thumbnails|storyboard|sprite|caption|subtitle|avatar|profile_images|emoji|x-card-animation|grok-.*visual|promo|banner|byteeffecttos\.com|ies\.fe\.effect)/i;
const CHUNK_RE = /\.(ts|m4s)(\?|#|$)/i;
const INIT_OR_AUDIO_SEGMENT_RE = /(\/0\/0\/|\/aud\/|\/mp4a\/|\/subtitles\/|[\/_-]init\.mp4(\?|#|$))/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov|m4v|flv)(\?|#|$)/i;

function isMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (NON_VIDEO_EXT_RE.test(url)) return false;
  if (NON_VIDEO_KEYWORDS_RE.test(url)) return false;
  if (CHUNK_RE.test(url)) return false;
  if (INIT_OR_AUDIO_SEGMENT_RE.test(url)) return false;

  if (url.includes("googlevideo.com/videoplayback")) {
    return url.includes("#vg_direct=");
  }

  if (url.includes("video.twimg.com")) {
    if (/\/pl\/(avc1|mp4a|hevc)\//i.test(url)) return false;
    return url.includes("/vid/") || url.includes("/pl/");
  }

  if (VIDEO_EXT_RE.test(url)) return true;
  if (url.includes("mime_type=video")) return true;
  if (url.includes("/video/tos/")) return true;
  if (url.includes("/aweme/v1/play/")) return true;

  return false;
}

function getVideoKey(url) {
  try {
    const ytMatch = url.match(/#vg_direct=([a-zA-Z0-9_-]+)/);
    if (ytMatch) return `yt_${ytMatch[1]}`;

    const u = new URL(url);
    const twMatch = u.pathname.match(/\/(ext_tw_video|amplify_video)\/(\d+)/i);
    if (twMatch) return `tw_${twMatch[2]}`;

    const biliMatch = u.pathname.match(/\/upgcxcode\/\d+\/\d+\/(\d+)\//i);
    if (biliMatch) return `bili_${biliMatch[1]}`;

    const dyVid = u.searchParams.get("__vid") || u.searchParams.get("video_id");
    if (dyVid) return `dy_${dyVid}`;
    const dyMatch = u.pathname.match(/\/tos-[^\/]+\/([a-zA-Z0-9]+)/i);
    if (dyMatch) return `dy_${dyMatch[1]}`;

    return u.origin + u.pathname.replace(/\.(m3u8|mp4|webm|mov|m4v)$/i, "");
  } catch (_) {
    return url;
  }
}

function qualityScore(item) {
  let score = 0;
  const url = (item.url || "").toLowerCase();

  if (item.kind === "mp4" || url.includes(".mp4") || url.includes("#vg_direct=")) score += 500;
  else if (item.kind === "hls" || url.includes(".m3u8")) score += 300;
  else if (item.kind === "webm" || url.includes(".webm")) score += 200;

  if (url.includes("master.m3u8") || (url.includes("/pl/") && !url.includes("x"))) score += 100;

  if (url.includes("1080") || url.includes("1920")) score += 400;
  else if (url.includes("720") || url.includes("1280")) score += 300;
  else if (url.includes("480") || url.includes("852")) score += 200;
  else if (url.includes("360") || url.includes("640")) score += 100;

  if (item.priority) score += item.priority * 150;
  if (item.source === "twitter-hd" || item.source === "bilibili-mp4" || item.source === "youtube-mp4") score += 250;
  if (item.source === "video-tag") score += 50;

  return score;
}

function deduplicateList(items) {
  const map = new Map();
  for (const item of items) {
    if (!isMediaUrl(item.url)) continue;
    const key = getVideoKey(item.url);
    const score = qualityScore(item);
    if (!map.has(key)) {
      map.set(key, { ...item, score, key });
    } else {
      const existing = map.get(key);
      if (score > existing.score) {
        map.set(key, {
          ...existing,
          ...item,
          score,
          key,
          pageTitle: item.pageTitle || existing.pageTitle,
          pageUrl: item.pageUrl || existing.pageUrl,
          priority: Math.max(item.priority || 0, existing.priority || 0)
        });
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => (b.priority || 0) - (a.priority || 0) || b.foundAt - a.foundAt
  );
}

function sanitizeTitle(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .replace(/[\\/:*?"<>|#]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function baseNameFromUrl(url, pageTitle = "") {
  try {
    let base = sanitizeTitle(pageTitle);
    if (!base || base.toLowerCase() === "video") {
      const u = new URL(url);
      base = u.pathname.split("/").filter(Boolean).pop() || "video";
      base = decodeURIComponent(base).replace(/[^\w.\-]+/g, "_");
    }
    return base.replace(/\.(m3u8|ts|mp4|webm|mov|m4v)$/i, "") || "video";
  } catch (_) {
    return "video";
  }
}

function fileNameFromUrl(url, kind, forceMp4 = true, pageTitle = "") {
  const base = baseNameFromUrl(url, pageTitle);
  if (kind === "webm" && !forceMp4) {
    return base + ".webm";
  }
  return base + (forceMp4 ? ".mp4" : ".ts");
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ""; }
}

function getQualityTag(item) {
  if (item.qualityLabel) return `${item.qualityLabel.toUpperCase()} MP4`;
  const u = (item.url || "").toLowerCase();
  let res = "";
  if (u.includes("1080") || u.includes("1920")) res = "1080P ";
  else if (u.includes("720") || u.includes("1280")) res = "720P ";
  else if (u.includes("480") || u.includes("852")) res = "480P ";
  else if (u.includes("360") || u.includes("640")) res = "360P ";

  if (item.kind === "hls") return res + "HLS (自动转MP4)";
  if (item.kind === "webm") return res + "WEBM";
  return (res || "高清 ") + "MP4";
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;

  chrome.tabs.sendMessage(tab.id, { type: "RESCAN" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 350));
  const res = await chrome.runtime.sendMessage({ type: "GET_VIDEOS", tabId: tab.id });
  currentItems = (res && res.list) || [];
  taskMap.clear();
  for (const t of (res && res.tasks) || []) {
    taskMap.set(t.taskId, t);
  }
  render();
}

function syncStatusBanner() {
  const allTasks = Array.from(taskMap.values());
  const active = allTasks.find((t) => t.status === "downloading" || t.status === "remuxing");
  const erred = allTasks.find((t) => t.status === "error");
  const recentDone = allTasks.find((t) => t.status === "completed" && Date.now() - (t.updatedAt || 0) < 30_000);

  if (active) {
    $status.textContent = active.text || `后台下载中 (${active.percent || 0}%)…`;
  } else if (erred) {
    $status.textContent = erred.text || "下载中断，点击「继续下载」可断点续传";
  } else if (recentDone) {
    $status.textContent = recentDone.text || "下载已完成";
  }
}

function render() {
  const list = deduplicateList(currentItems);

  const listedUrls = new Set(list.map((i) => i.url));
  for (const t of taskMap.values()) {
    if (!listedUrls.has(t.url) && (t.status === "downloading" || t.status === "remuxing" || t.status === "error")) {
      list.unshift({
        url: t.url,
        kind: "hls",
        source: "后台任务",
        priority: 4,
        pageTitle: t.title || "后台下载视频",
        foundAt: t.updatedAt || Date.now()
      });
    }
  }

  $list.innerHTML = "";
  $empty.hidden = list.length > 0;
  syncStatusBanner();

  list.forEach((item, index) => {
    const li = document.createElement("li");
    const isPrimary = item.priority >= 2 || index === 0;
    if (isPrimary) li.className = "active-video";

    const meta = document.createElement("div");
    meta.className = "meta";

    const badges = document.createElement("div");
    badges.className = "badges";

    if (isPrimary) {
      const curBadge = document.createElement("span");
      curBadge.className = "badge current";
      curBadge.textContent = item.source === "后台任务" ? "后台下载任务" : "当前视频";
      badges.appendChild(curBadge);
    }

    const qBadge = document.createElement("span");
    qBadge.className = "badge" + (item.kind === "hls" ? " hls" : "");
    qBadge.textContent = getQualityTag(item);
    badges.appendChild(qBadge);

    const name = document.createElement("div");
    name.className = "name";
    const displayName = sanitizeTitle(item.pageTitle) || fileNameFromUrl(item.url, item.kind, true);
    name.textContent = displayName;
    name.title = item.url.replace(/#vg_direct=.*$/, "");

    const sub = document.createElement("div");
    sub.className = "sub";
    const task = taskMap.get(item.url);
    if (task && task.text) {
      sub.textContent = task.text;
    } else {
      sub.textContent = `${hostOf(item.url)} · ${item.source}`;
    }

    meta.append(badges, name, sub);

    const btn = document.createElement("button");
    btn.className = "dl";

    if (task && (task.status === "downloading" || task.status === "remuxing")) {
      btn.disabled = true;
      btn.textContent = task.status === "remuxing" ? "转MP4中…" : `下载中 ${task.percent || 0}%`;
    } else if (task && task.status === "error") {
      btn.disabled = false;
      btn.textContent = "继续下载";
    } else if (task && task.status === "completed") {
      btn.disabled = false;
      btn.textContent = "再次下载";
    } else {
      btn.disabled = false;
      btn.textContent = "下载";
    }

    btn.addEventListener("click", () => download(item, btn));

    li.append(meta, btn);
    $list.appendChild(li);
  });
}

async function download(item, btn) {
  btn.disabled = true;
  try {
    if (item.kind === "hls" && item.url.includes("video.twimg.com") && item.pageUrl) {
      const m = item.pageUrl.match(/\/status\/(\d+)/);
      if (m) {
        $status.textContent = "正在解析 X 高清完整 MP4…";
        const res = await chrome.runtime.sendMessage({
          type: "RESOLVE_TWITTER_TWEET",
          tabId: activeTabId,
          tweetId: m[1],
          pageUrl: item.pageUrl,
          pageTitle: item.pageTitle,
          priority: 3
        });
        const updated = (res && res.list || []).find((x) => x.kind === "mp4" && x.key === item.key);
        if (updated) {
          item = updated;
        }
      }
    }

    if (item.kind === "hls") {
      const baseFilename = baseNameFromUrl(item.url, item.pageTitle);
      const title = sanitizeTitle(item.pageTitle) || baseFilename;
      taskMap.set(item.url, {
        taskId: item.url,
        url: item.url,
        title,
        status: "downloading",
        percent: 0,
        text: "后台下载已启动 — 可随时切换页面或关闭弹窗",
        updatedAt: Date.now()
      });
      render();
      await chrome.runtime.sendMessage({
        type: "START_HLS_DOWNLOAD",
        url: item.url,
        baseFilename,
        title,
        referer: item.pageUrl || undefined,
        tabId: activeTabId
      });
    } else {
      const filename = fileNameFromUrl(item.url, item.kind, item.kind !== "webm", item.pageTitle);
      $status.textContent = `已开始浏览器后台下载: ${filename}`;
      await chrome.runtime.sendMessage({
        type: "DOWNLOAD",
        url: item.url,
        filename,
        referer: item.pageUrl || window.location.href
      });
      btn.disabled = false;
    }
  } catch (err) {
    $status.textContent = `下载失败: ${err && err.message ? err.message : err}`;
    btn.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "HLS_TASK_UPDATE") {
    const existing = taskMap.get(msg.taskId) || { taskId: msg.taskId, url: msg.taskId };
    taskMap.set(msg.taskId, { ...existing, ...msg, updatedAt: Date.now() });
    render();
  } else if (msg && msg.type === "OFFSCREEN_SAVE_BLOB") {
    const existing = taskMap.get(msg.taskId) || { taskId: msg.taskId, url: msg.taskId };
    taskMap.set(msg.taskId, {
      ...existing,
      status: "completed",
      percent: 100,
      text: `下载完成: ${msg.filename}`,
      updatedAt: Date.now()
    });
    render();
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  if (activeTabId != null) {
    await chrome.runtime.sendMessage({ type: "CLEAR", tabId: activeTabId });
    currentItems = [];
    for (const [k, v] of taskMap.entries()) {
      if (v.status === "completed" || v.status === "error") {
        taskMap.delete(k);
      }
    }
    render();
    $status.textContent = "已清空列表";
  }
});

load();
