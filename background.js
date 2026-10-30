// VideoGrab — background service worker (MV3).
// Handles network-level stream filtering, deduplication, quality ranking,
// X/Twitter, Bilibili, and YouTube direct MP4 resolution, Referer spoofing,
// and persistent background HLS downloads via Offscreen API.

const KEY = (tabId) => `vg_tab_${tabId}`;

const NON_VIDEO_EXT_RE = /\.(vtt|srt|ass|sub|xml|json|js|css|html|txt|jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot|m4a|aac|mp3|ogg|wav)(\?|#|$)/i;
const NON_VIDEO_KEYWORDS_RE = /(thumb|thumbnails|storyboard|sprite|caption|subtitle|avatar|profile_images|emoji|x-card-animation|grok-.*visual|promo|banner|byteeffecttos\.com|ies\.fe\.effect)/i;
const CHUNK_RE = /\.(ts|m4s)(\?|#|$)/i;
const INIT_OR_AUDIO_SEGMENT_RE = /(\/0\/0\/|\/aud\/|\/mp4a\/|\/subtitles\/|[\/_-]init\.mp4(\?|#|$))/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov|m4v|flv)(\?|#|$)/i;

const resolvedTweets = new Set();
const resolvedBili = new Set();
const resolvedYoutube = new Set();
const hlsTasks = new Map();
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  // Firefox has no Offscreen API: the HLS engine (offscreen.js) is loaded
  // directly into the background page instead (see firefox-bridge.js).
  if (!chrome.offscreen) return;
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "WORKERS"],
    justification: "Download HLS video segments in the background, remux TS to MP4, and create Blob URLs without interrupting when popup closes."
  }).catch((err) => {
    if (!String(err).includes("Only a single offscreen")) {
      throw err;
    }
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function isMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (NON_VIDEO_EXT_RE.test(url)) return false;
  if (NON_VIDEO_KEYWORDS_RE.test(url)) return false;
  if (CHUNK_RE.test(url)) return false;
  if (INIT_OR_AUDIO_SEGMENT_RE.test(url)) return false;

  // YouTube: only accept full resolved direct streams (#vg_direct=), reject player byte-range chunks
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

function kindOf(url) {
  if (/\.m3u8(\?|#|$)/i.test(url)) return "hls";
  if (/\.webm(\?|#|$)/i.test(url)) return "webm";
  return "mp4";
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

async function getList(tabId) {
  try {
    const data = await chrome.storage.session.get(KEY(tabId));
    return deduplicateList(data[KEY(tabId)] || []);
  } catch (_) {
    return [];
  }
}

async function addItem(tabId, item) {
  if (!tabId || tabId <= 0 || !item || !item.url) return [];
  if (!isMediaUrl(item.url)) return await getList(tabId);

  const rawList = await getList(tabId);
  rawList.unshift(item);
  const cleanList = deduplicateList(rawList).slice(0, 30);

  try {
    await chrome.storage.session.set({ [KEY(tabId)]: cleanList });
    const hasActiveDl = Array.from(hlsTasks.values()).some((t) => t.status === "downloading" || t.status === "remuxing");
    if (!hasActiveDl) {
      await chrome.action.setBadgeText({ tabId, text: String(cleanList.length) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2ecc71" });
    }
  } catch (_) {}

  return cleanList;
}

// 1. Resolve X/Twitter direct pre-muxed MP4
async function resolveTwitterTweet(tabId, tweetId, pageUrl = "", pageTitle = "", priority = 3) {
  if (!tabId || !tweetId || !/^\d+$/.test(String(tweetId))) return;
  const cacheKey = `${tabId}_${tweetId}`;
  if (resolvedTweets.has(cacheKey)) return;
  resolvedTweets.add(cacheKey);

  try {
    const token = ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=zh`;
    const resp = await fetch(apiUrl);
    if (!resp.ok) return;
    const data = await resp.json();

    const variantGroups = [];
    const collectFromTweet = (t) => {
      if (!t) return;
      if (Array.isArray(t.mediaDetails)) {
        for (const m of t.mediaDetails) {
          if (m && m.video_info && Array.isArray(m.video_info.variants)) {
            variantGroups.push(m.video_info.variants);
          }
        }
      }
      if (t.video && Array.isArray(t.video.variants)) {
        variantGroups.push(t.video.variants);
      }
    };

    collectFromTweet(data);
    collectFromTweet(data.quoted_tweet);
    collectFromTweet(data.parent);

    for (const variants of variantGroups) {
      const mp4s = variants
        .filter((v) => {
          const u = v.url || v.src || "";
          const ct = (v.content_type || v.type || "").toLowerCase();
          return (ct.includes("mp4") || /\.mp4(\?|$)/i.test(u)) && !INIT_OR_AUDIO_SEGMENT_RE.test(u);
        })
        .map((v) => {
          const u = v.url || v.src;
          let bitrate = v.bitrate || 0;
          if (!bitrate) {
            const m = u.match(/\/(\d+)x(\d+)\//);
            if (m) bitrate = Number(m[1]) * Number(m[2]);
          }
          return { url: u, bitrate };
        })
        .sort((a, b) => b.bitrate - a.bitrate);

      if (mp4s.length > 0) {
        const title = data.text
          ? `@${data.user?.screen_name || "X"}: ${data.text.slice(0, 40)}`
          : pageTitle;
        await addItem(tabId, {
          url: mp4s[0].url,
          kind: "mp4",
          source: "twitter-hd",
          priority,
          pageTitle: title || pageTitle,
          pageUrl: pageUrl || `https://x.com/i/status/${tweetId}`,
          foundAt: Date.now()
        });
      }
    }
  } catch (err) {
    resolvedTweets.delete(cacheKey);
    console.warn("resolveTwitterTweet error:", err);
  }
}

// 2. Resolve Bilibili direct pre-muxed MP4 (720P/1080P audio+video combined)
async function resolveBilibiliVideo(tabId, bvid, aid, pageNum = 1, pageUrl = "", pageTitle = "") {
  const idKey = bvid || (aid ? `av${aid}` : "");
  if (!tabId || !idKey) return;
  const cacheKey = `${tabId}_${idKey}_p${pageNum || 1}`;
  if (resolvedBili.has(cacheKey)) return;
  resolvedBili.add(cacheKey);

  try {
    const queryParam = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(String(aid).replace(/^av/i, ""))}`;
    const viewResp = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`);
    if (!viewResp.ok) return;
    const viewJson = await viewResp.json();
    if (viewJson.code !== 0 || !viewJson.data) return;

    const vData = viewJson.data;
    const pages = Array.isArray(vData.pages) ? vData.pages : [];
    const targetPage = pages[(Number(pageNum) || 1) - 1] || pages[0];
    const cid = targetPage ? targetPage.cid : vData.cid;
    if (!cid) return;

    const playUrl = `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&qn=80&type=mp4&platform=html5&high_quality=1`;
    const playResp = await fetch(playUrl, { credentials: "include" });
    if (!playResp.ok) return;
    const playJson = await playResp.json();
    const durl = playJson?.data?.durl?.[0]?.url;
    if (!durl) return;

    const cleanTitle = vData.title
      ? (pages.length > 1 && targetPage?.part ? `${vData.title} - ${targetPage.part}` : vData.title)
      : pageTitle;

    await addItem(tabId, {
      url: durl,
      kind: "mp4",
      source: "bilibili-mp4",
      priority: 3,
      pageTitle: cleanTitle || "Bilibili Video",
      pageUrl: pageUrl || "https://www.bilibili.com/",
      foundAt: Date.now()
    });
  } catch (err) {
    resolvedBili.delete(cacheKey);
    console.warn("resolveBilibiliVideo error:", err);
  }
}

// 3. Resolve YouTube direct pre-muxed MP4 via Android Innertube API
async function resolveYoutubeVideo(tabId, videoId, pageUrl = "", pageTitle = "") {
  if (!tabId || !videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
  const cacheKey = `${tabId}_${videoId}`;
  if (resolvedYoutube.has(cacheKey)) return;
  resolvedYoutube.add(cacheKey);

  try {
    const watchHtml = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: "omit"
    }).then((r) => r.text());
    const vm = watchHtml.match(/"VISITOR_DATA":"([^"]+)"/);
    const visitorData = vm ? vm[1] : "";

    const playerResp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false&vg=1", {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.03.35",
            androidSdkVersion: 34,
            osName: "Android",
            osVersion: "14",
            visitorData,
            hl: "zh-CN",
            gl: "US"
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      })
    });

    if (!playerResp.ok) {
      resolvedYoutube.delete(cacheKey);
      return;
    }

    const data = await playerResp.json();
    const formats = (data?.streamingData?.formats || [])
      .filter((f) => f && f.url && (f.mimeType || "").includes("video/mp4"))
      .sort((a, b) => ((b.width || 0) * (b.height || 0) || b.bitrate || 0) - ((a.width || 0) * (a.height || 0) || a.bitrate || 0));

    if (formats.length > 0) {
      const best = formats[0];
      const title = data?.videoDetails?.title || pageTitle?.replace(/\s*-\s*YouTube$/i, "") || "YouTube Video";
      await addItem(tabId, {
        url: `${best.url}#vg_direct=${videoId}`,
        kind: "mp4",
        source: "youtube-mp4",
        priority: 3,
        qualityLabel: best.qualityLabel || "MP4",
        pageTitle: title,
        pageUrl: pageUrl || `https://www.youtube.com/watch?v=${videoId}`,
        foundAt: Date.now()
      });
    } else {
      resolvedYoutube.delete(cacheKey);
    }
  } catch (err) {
    resolvedYoutube.delete(cacheKey);
    console.warn("resolveYoutubeVideo error:", err);
  }
}

async function resolveByTabUrl(tabId, tabUrl, tabTitle = "") {
  if (!tabUrl) return;
  try {
    const u = new URL(tabUrl);
    const host = u.hostname.toLowerCase();

    // X / Twitter
    if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
      const m = u.pathname.match(/\/status\/(\d+)/);
      if (m) await resolveTwitterTweet(tabId, m[1], tabUrl, tabTitle, 3);
    }

    // Bilibili
    if (host.endsWith("bilibili.com")) {
      const bm = u.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/i);
      if (bm) {
        const id = bm[1];
        const p = Number(u.searchParams.get("p") || 1);
        if (/^BV/i.test(id)) {
          await resolveBilibiliVideo(tabId, id, null, p, tabUrl, tabTitle);
        } else {
          await resolveBilibiliVideo(tabId, null, id, p, tabUrl, tabTitle);
        }
      }
    }

    // YouTube
    if (host.endsWith("youtube.com") || host === "youtu.be") {
      let vid = u.searchParams.get("v");
      if (!vid) {
        const sm = u.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
        if (sm) vid = sm[1];
        else if (host === "youtu.be") {
          const ym = u.pathname.match(/^\/([a-zA-Z0-9_-]{11})/);
          if (ym) vid = ym[1];
        }
      }
      if (vid) {
        await resolveYoutubeVideo(tabId, vid, tabUrl, tabTitle);
      }
    }
  } catch (_) {}
}

// DeclarativeNetRequest rules for Douyin, Bilibili, and YouTube Innertube
async function initRefererRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3, 4, 5],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.douyin.com/" }
            ]
          },
          condition: {
            urlFilter: "||douyinvod.com",
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.douyin.com/" }
            ]
          },
          condition: {
            urlFilter: "||douyin.com/aweme/v1/play",
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        },
        {
          id: 3,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
            ]
          },
          condition: {
            urlFilter: "||bilivideo.com",
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        },
        {
          id: 4,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
            ]
          },
          condition: {
            urlFilter: "||bilivideo.cn",
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        },
        {
          id: 5,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "remove" },
              { header: "Cookie", operation: "remove" },
              { header: "User-Agent", operation: "set", value: "com.google.android.youtube/20.03.35 (Linux; U; Android 14) gzip" }
            ]
          },
          condition: {
            urlFilter: "||youtube.com/youtubei/v1/player?prettyPrint=false&vg=1",
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
  } catch (err) {
    console.warn("initRefererRules error:", err);
  }
}
initRefererRules();

async function setDownloadReferer(url, referer) {
  if (!referer || !url) return;
  const ruleId = 10001;
  try {
    const urlObj = new URL(url);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: referer }
            ]
          },
          condition: {
            urlFilter: `||${urlObj.hostname}`,
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        }
      ]
    });
  } catch (err) {
    console.warn("setDownloadReferer error:", err);
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const url = details.url;
    if (isMediaUrl(url)) {
      addItem(details.tabId, {
        url,
        kind: kindOf(url),
        source: "network",
        foundAt: Date.now()
      }).catch(() => {});
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const url = details.url;
    if (
      NON_VIDEO_EXT_RE.test(url) ||
      NON_VIDEO_KEYWORDS_RE.test(url) ||
      CHUNK_RE.test(url) ||
      INIT_OR_AUDIO_SEGMENT_RE.test(url) ||
      url.includes("googlevideo.com/videoplayback")
    ) {
      return;
    }

    const headers = details.responseHeaders || [];
    const ctHeader = headers.find((h) => h.name.toLowerCase() === "content-type");
    const ct = ctHeader ? ctHeader.value.toLowerCase() : "";

    const clHeader = headers.find((h) => h.name.toLowerCase() === "content-length");
    const contentLength = clHeader ? parseInt(clHeader.value, 10) : NaN;
    if (!isNaN(contentLength) && contentLength > 0 && contentLength < 10240 && !ct.includes("mpegurl") && !/\.m3u8/i.test(url)) {
      return;
    }

    if (ct.startsWith("video/") || ct.includes("mpegurl") || ct.includes("application/x-mpegurl")) {
      if (url.includes("video.twimg.com") && /\/pl\/(avc1|mp4a|hevc)\//i.test(url)) return;

      let kind = "mp4";
      if (ct.includes("mpegurl") || /\.m3u8/i.test(url)) kind = "hls";
      else if (ct.includes("webm") || /\.webm/i.test(url)) kind = "webm";

      addItem(details.tabId, {
        url,
        kind,
        source: "network-header",
        foundAt: Date.now()
      }).catch(() => {});
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Message broker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "VIDEO_FOUND" && sender.tab) {
      const list = await addItem(sender.tab.id, msg.item);
      sendResponse({ ok: true, count: list.length });
    } else if (msg.type === "RESOLVE_TWITTER_TWEET") {
      const tabId = (sender.tab && sender.tab.id) || msg.tabId;
      await resolveTwitterTweet(tabId, msg.tweetId, msg.pageUrl, msg.pageTitle, msg.priority || 3);
      const list = await getList(tabId);
      sendResponse({ ok: true, list });
    } else if (msg.type === "RESOLVE_BILIBILI_VIDEO") {
      const tabId = (sender.tab && sender.tab.id) || msg.tabId;
      await resolveBilibiliVideo(tabId, msg.bvid, msg.aid, msg.p || 1, msg.pageUrl, msg.pageTitle);
      const list = await getList(tabId);
      sendResponse({ ok: true, list });
    } else if (msg.type === "RESOLVE_YOUTUBE_VIDEO") {
      const tabId = (sender.tab && sender.tab.id) || msg.tabId;
      await resolveYoutubeVideo(tabId, msg.videoId, msg.pageUrl, msg.pageTitle);
      const list = await getList(tabId);
      sendResponse({ ok: true, list });
    } else if (msg.type === "GET_VIDEOS") {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (tab && tab.url) {
          await resolveByTabUrl(msg.tabId, tab.url, tab.title);
        }
      } catch (_) {}
      const list = await getList(msg.tabId);
      const tasks = Array.from(hlsTasks.values());
      sendResponse({ ok: true, list, tasks });
    } else if (msg.type === "START_HLS_DOWNLOAD") {
      const { url, baseFilename, title, referer, tabId } = msg;
      const taskId = url;
      if (referer) {
        await setDownloadReferer(url, referer);
      }
      await ensureOffscreenDocument();
      hlsTasks.set(taskId, {
        taskId,
        url,
        title: title || baseFilename || "Video",
        status: "downloading",
        done: 0,
        total: 0,
        percent: 0,
        text: "正在启动后台下载…",
        tabId,
        updatedAt: Date.now()
      });
      const startMsg = {
        type: "OFFSCREEN_START_HLS",
        taskId,
        url,
        baseFilename,
        tabId
      };
      if (chrome.offscreen) {
        await chrome.runtime.sendMessage(startMsg);
      } else if (typeof self !== "undefined" && self.__vgStartHls) {
        // Firefox: engine lives in this background page; call it directly
        // (runtime.sendMessage is not delivered to the sender's own context).
        self.__vgStartHls(startMsg);
      } else {
        await chrome.runtime.sendMessage(startMsg);
      }
      sendResponse({ ok: true, taskId });
    } else if (msg.type === "HLS_TASK_UPDATE") {
      const existing = hlsTasks.get(msg.taskId) || { taskId: msg.taskId, url: msg.taskId };
      const updated = {
        ...existing,
        ...msg,
        updatedAt: Date.now()
      };
      hlsTasks.set(msg.taskId, updated);

      try {
        if (updated.status === "downloading" || updated.status === "remuxing") {
          const badge = updated.percent ? `${updated.percent}%` : "DL";
          await chrome.action.setBadgeText({ text: badge });
          await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
        } else if (updated.status === "error") {
          await chrome.action.setBadgeText({ text: "ERR" });
          await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
        }
      } catch (_) {}
      sendResponse({ ok: true });
    } else if (msg.type === "OFFSCREEN_SAVE_BLOB") {
      const { taskId, blobUrl, filename } = msg;
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename: filename || "video.mp4",
        saveAs: false
      });
      const existing = hlsTasks.get(taskId) || { taskId, url: taskId };
      hlsTasks.set(taskId, {
        ...existing,
        status: "completed",
        percent: 100,
        text: `下载完成: ${filename}`,
        updatedAt: Date.now()
      });
      try {
        await chrome.action.setBadgeText({ text: "OK" });
        await chrome.action.setBadgeBackgroundColor({ color: "#2ecc71" });
        setTimeout(() => {
          chrome.action.setBadgeText({ text: "" }).catch(() => {});
        }, 5000);
      } catch (_) {}
      sendResponse({ ok: true, downloadId });
    } else if (msg.type === "SET_REFERER") {
      await setDownloadReferer(msg.url, msg.referer);
      sendResponse({ ok: true });
    } else if (msg.type === "CLEAR") {
      await chrome.storage.session.remove(KEY(msg.tabId));
      for (const [k, v] of hlsTasks.entries()) {
        if (v.status === "completed" || v.status === "error") {
          hlsTasks.delete(k);
        }
      }
      try { await chrome.action.setBadgeText({ tabId: msg.tabId, text: "" }); } catch (_) {}
      sendResponse({ ok: true });
    } else if (msg.type === "DOWNLOAD") {
      const cleanUrl = msg.url.replace(/#vg_direct=.*$/, "");
      let referer = msg.referer || msg.pageUrl;
      if (cleanUrl.includes("douyin")) referer = "https://www.douyin.com/";
      else if (cleanUrl.includes("bilivideo")) referer = "https://www.bilibili.com/";

      if (referer && !cleanUrl.includes("googlevideo.com")) {
        await setDownloadReferer(cleanUrl, referer);
      }
      const id = await chrome.downloads.download({
        url: cleanUrl,
        filename: msg.filename || undefined,
        saveAs: false,
      });
      sendResponse({ ok: true, downloadId: id });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(KEY(tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" && info.url) {
    chrome.storage.session.remove(KEY(tabId)).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
  if (info.status === "complete" && tab && tab.url) {
    resolveByTabUrl(tabId, tab.url, tab.title).catch(() => {});
  }
});
