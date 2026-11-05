"use strict";
/* VideoGrab Desktop — URL resolvers.
 * Ported from the VideoGrab browser extension (v0.1.3) and extended for
 * desktop: YouTube/Bilibili adaptive (DASH) pairs for ffmpeg merging,
 * a Douyin page resolver, and generic page/MP4/HLS sniffing.
 * No data collection: all requests go only to the platforms themselves.
 */

const UA_PC =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_ANDROID_YT =
  "com.google.android.youtube/20.03.35 (Linux; U; Android 14; en_US) gzip";

function fmtSize(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

async function fetchText(url, headers = {}, opts = {}) {
  const resp = await fetch(url, {
    redirect: opts.redirect || "follow",
    headers: { "User-Agent": UA_PC, ...headers },
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
  return resp;
}

/* ---------------- X / Twitter ---------------- */
async function resolveTwitter(url) {
  const m = url.match(/\/status\/(\d+)/);
  if (!m) throw new Error("链接里没有推文 ID");
  const tweetId = m[1];
  const token = ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const resp = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=zh`);
  if (!resp.ok) throw new Error(`X 接口返回 ${resp.status}`);
  const data = await resp.json();

  const groups = [];
  const collect = (t) => {
    if (!t) return;
    if (Array.isArray(t.mediaDetails)) {
      for (const md of t.mediaDetails) {
        if (md?.video_info?.variants) groups.push(md.video_info.variants);
      }
    }
    if (t.video?.variants) groups.push(t.video.variants);
  };
  collect(data); collect(data.quoted_tweet); collect(data.parent);

  const items = [];
  const seen = new Set();
  for (const variants of groups) {
    const mp4s = variants
      .filter((v) => {
        const u = v.url || v.src || "";
        const ct = (v.content_type || v.type || "").toLowerCase();
        return (ct.includes("mp4") || /\.mp4(\?|$)/i.test(u)) && !/_(seg|init|audio)/i.test(u);
      })
      .map((v) => {
        const u = v.url || v.src;
        let bitrate = v.bitrate || 0;
        const rm = u.match(/\/(\d+)x(\d+)\//);
        return { url: u, bitrate, w: rm ? +rm[1] : 0, h: rm ? +rm[2] : 0 };
      })
      .sort((a, b) => b.bitrate - a.bitrate);
    for (const v of mp4s) {
      if (seen.has(v.url)) continue;
      seen.add(v.url);
      items.push({
        kind: "mp4",
        url: v.url,
        label: v.h ? `${v.h}p · ${(v.bitrate / 1e6).toFixed(1)} Mbps` : `MP4 · ${(v.bitrate / 1e6).toFixed(1)} Mbps`,
        headers: {},
      });
    }
  }
  if (!items.length) throw new Error("这条推文里没找到视频");
  const title = data.text ? `@${data.user?.screen_name || "X"} ${data.text.slice(0, 60)}` : `X ${tweetId}`;
  return { site: "X / Twitter", title, items };
}

/* ---------------- Bilibili ---------------- */
async function resolveBilibili(url) {
  const bv = url.match(/(BV[0-9A-Za-z]{10})/);
  const av = url.match(/av(\d+)/i);
  const pMatch = url.match(/[?&]p=(\d+)/);
  const pageNum = pMatch ? +pMatch[1] : 1;
  const qp = bv ? `bvid=${bv[1]}` : av ? `aid=${av[1]}` : null;
  if (!qp) throw new Error("链接里没有 BV/av 号");

  const dlHeadersPre = { "User-Agent": UA_PC, Referer: "https://www.bilibili.com/" };
  // cid via pagelist: the view API and video page are risk-control-prone
  // (HTTP 412 from many IPs) while pagelist + playurl stay open.
  const plResp = await fetch(`https://api.bilibili.com/x/player/pagelist?${qp}`, { headers: dlHeadersPre });
  const pl = await plResp.json().catch(() => null);
  if (!pl || pl.code !== 0 || !Array.isArray(pl.data) || !pl.data.length) {
    throw new Error(`B站 pagelist 接口：${pl?.message || plResp.status}`);
  }
  const pages = pl.data;
  const page = pages[pageNum - 1] || pages[0];
  const cid = page.cid;
  // Title via view API is best-effort only (412 tolerated)
  let videoTitle = "";
  try {
    const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?${qp}`, { headers: dlHeadersPre })).json();
    if (v.code === 0 && v.data?.title) videoTitle = v.data.title;
  } catch (_) {}
  const title = (videoTitle || page.part || (bv ? bv[1] : `av${av?.[1]}`)) +
    (pages.length > 1 && page.part && videoTitle ? ` - ${page.part}` : "");
  const dlHeaders = { "User-Agent": UA_PC, Referer: "https://www.bilibili.com/" };
  const items = [];

  // DASH first (video+audio pair → ffmpeg merge, best quality)
  try {
    const dashUrl = `https://api.bilibili.com/x/player/playurl?${qp}&cid=${cid}&qn=127&fnval=4048&fourk=1`;
    const dj = await (await fetch(dashUrl, { headers: dlHeaders })).json();
    const dash = dj?.data?.dash;
    if (dash?.video?.length && dash?.audio?.length) {
      const vids = [...dash.video].sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth));
      const auds = [...dash.audio].sort((a, b) => b.bandwidth - a.bandwidth);
      const seenH = new Set();
      const urlList = (f) => [f.baseUrl || f.base_url, ...((f.backupUrl || f.backup_url || []))].filter(Boolean);
      for (const v of vids.slice(0, 4)) {
        if (seenH.has(v.height)) continue;
        seenH.add(v.height);
        items.push({
          kind: "dash",
          videoUrl: urlList(v)[0],
          videoUrls: urlList(v),
          audioUrl: urlList(auds[0])[0],
          audioUrls: urlList(auds[0]),
          durationSec: (dash.duration || 0),
          label: `${v.height}p · DASH 合并（ffmpeg）`,
          headers: dlHeaders,
        });
      }
    }
  } catch (_) { /* fall through to durl */ }

  // Pre-merged MP4 (html5 path, caps at 720p)
  const mp4Url = `https://api.bilibili.com/x/player/playurl?${qp}&cid=${cid}&qn=80&type=mp4&platform=html5&high_quality=1`;
  const pj = await (await fetch(mp4Url, { headers: dlHeaders })).json();
  const durl = pj?.data?.durl?.[0];
  if (durl?.url) {
    items.push({
      kind: "mp4",
      url: durl.url,
      label: `MP4 直下 · ${pj.data.quality === 64 ? "720p" : "qn" + pj.data.quality}${durl.size ? " · " + fmtSize(durl.size) : ""}`,
      headers: dlHeaders,
    });
  }
  if (!items.length) throw new Error("B站没有返回可下载的流（可能需要登录或地区限制）");
  return { site: "Bilibili", title, items };
}

/* ---------------- YouTube ---------------- */
async function resolveYoutube(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
  if (!m) throw new Error("链接里没有视频 ID");
  const videoId = m[1];

  const watchHtml = await (await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {}, { timeout: 20000 })).text();
  const vm = watchHtml.match(/"VISITOR_DATA":"([^"]+)"/);
  const visitorData = vm ? vm[1] : "";

  const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false&vg=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA_ANDROID_YT,
      ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
    },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: "ANDROID", clientVersion: "20.03.35", androidSdkVersion: 34, osName: "Android", osVersion: "14", visitorData, hl: "en", gl: "US" } },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`YouTube 接口返回 ${resp.status}`);
  const data = await resp.json();
  if (data.playabilityStatus && data.playabilityStatus.status !== "OK") {
    throw new Error(`YouTube 不可播：${data.playabilityStatus.reason || data.playabilityStatus.status}`);
  }
  const title = data?.videoDetails?.title || `YouTube ${videoId}`;
  const durSec = Number(data?.videoDetails?.lengthSeconds || 0);
  const sd = data.streamingData || {};
  const dlHeaders = { "User-Agent": UA_ANDROID_YT, Range: "bytes=0-" };
  const items = [];

  // Adaptive: best video-only mp4 + best audio/mp4 → ffmpeg merge (unlocks 1080p/4K)
  const av = (sd.adaptiveFormats || []).filter((f) => f.url);
  const vOnly = av.filter((f) => (f.mimeType || "").startsWith("video/") && (f.mimeType || "").includes("mp4"))
    .sort((a, b) => {
      const areaDiff = (b.width * b.height) - (a.width * a.height);
      if (areaDiff !== 0) return areaDiff;
      const aAvc = (a.mimeType || "").includes("avc1") ? 1 : 0;
      const bAvc = (b.mimeType || "").includes("avc1") ? 1 : 0;
      return (bAvc - aAvc) || ((b.bitrate || 0) - (a.bitrate || 0));
    });
  const aOnly = av.filter((f) => (f.mimeType || "").startsWith("audio/") && (f.mimeType || "").includes("mp4"))
    .sort((a, b) => {
      const aOk = a.itag === 139 || a.itag === 599 ? 1 : 0;
      const bOk = b.itag === 139 || b.itag === 599 ? 1 : 0;
      return (bOk - aOk) || ((b.bitrate || 0) - (a.bitrate || 0));
    });
  if (vOnly.length && aOnly.length) {
    const aUrls = [...new Set(aOnly.map((a) => a.url))];
    const seenH = new Set();
    for (const v of vOnly) {
      if (seenH.has(v.height) || items.filter((i) => i.kind === "dash").length >= 3) continue;
      seenH.add(v.height);
      const vUrls = [...new Set(vOnly.filter((x) => x.height === v.height).map((x) => x.url))];
      items.push({
        kind: "dash",
        videoUrl: vUrls[0],
        videoUrls: vUrls,
        audioUrl: aUrls[0],
        audioUrls: aUrls,
        durationSec: durSec,
        label: `${v.height}p · 双流合并（ffmpeg）${v.contentLength ? " · ~" + fmtSize(Number(v.contentLength) + Number(aOnly[0].contentLength || 0)) : ""}`,
        headers: dlHeaders,
      });
    }
  }
  // Progressive (audio+video in one file, usually ≤360p)
  const prog = (sd.formats || []).filter((f) => f.url && (f.mimeType || "").includes("video/mp4"))
    .sort((a, b) => (b.width * b.height - a.width * a.height));
  for (const f of prog) {
    items.push({
      kind: "mp4",
      url: f.url,
      label: `${f.qualityLabel || f.height + "p"} · 单文件直下${f.contentLength ? " · " + fmtSize(f.contentLength) : ""}`,
      headers: dlHeaders,
    });
  }
  if (!items.length) throw new Error("YouTube 没有返回可下载的流（可能被风控，换网络再试）");
  return { site: "YouTube", title, items };
}

/* ---------------- Douyin ---------------- */
async function resolveDouyin(rawUrl) {
  // Follow short-link redirects manually to land on the canonical page
  let current = rawUrl;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA_PC }, signal: AbortSignal.timeout(15000) });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { current = loc; continue; }
    break;
  }
  const idm = current.match(/(?:video|note)\/(\d+)/) || current.match(/modal_id=(\d+)/) || rawUrl.match(/(\d{15,})/);
  const awemeId = idm ? idm[1] : null;
  const pageUrl = awemeId ? `https://www.douyin.com/video/${awemeId}` : current;

  const html = await (await fetchText(pageUrl, { Referer: "https://www.douyin.com/" }, { timeout: 20000 })).text();
  // The SSR payload embeds play_addr url_list values; find douyinvod URLs
  const urls = new Set();
  for (const mm of html.matchAll(/https?:\\?\/\\?\/[^"'\s]+?(?:douyinvod|amemv|snssdk)[^"'\s]+?(?=["'\\])/g)) {
    const u = mm[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (/\.mp4|play|video_id=/.test(u)) urls.add(u);
  }
  for (const mm of html.matchAll(/"play_addr":\{"uri":"[^"]+","url_list":\[([^\]]+)\]/g)) {
    for (const um of mm[1].matchAll(/"([^"]+)"/g)) urls.add(um[1].replace(/\\\//g, "/"));
  }
  let list = [...urls].filter((u) => !u.includes("playwm") || true);
  // Prefer the no-watermark variant: playwm → play
  list = list.map((u) => u.replace("playwm", "play"));
  list = [...new Set(list)];
  if (!list.length) throw new Error("抖音页面里没解析到播放地址（页面可能要求登录/验证，换网络或稍后再试）");
  const tm = html.match(/<title>([^<]{2,80})<\/title>/);
  return {
    site: "抖音",
    title: tm ? tm[1].replace(/ - 抖音$/, "") : `抖音 ${awemeId || ""}`,
    items: list.slice(0, 3).map((u, i) => ({
      kind: "mp4",
      url: u,
      label: `MP4 直下${i ? " · 备选 " + i : ""}`,
      headers: { "User-Agent": UA_PC, Referer: "https://www.douyin.com/" },
    })),
  };
}

/* ---------------- Generic ---------------- */
async function resolveGeneric(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(mp4|webm|mov|mkv)(\?|$)/.test(url.toLowerCase())) {
    return { site: "通用直链", title: decodeURIComponent(path.split("/").pop() || "video"), items: [{ kind: "mp4", url, label: "视频直链", headers: { "User-Agent": UA_PC } }] };
  }
  if (/\.m3u8(\?|$)/.test(url)) {
    return { site: "通用 HLS", title: "HLS Stream", items: [{ kind: "hls", url, label: "HLS → MP4（ffmpeg）", headers: { "User-Agent": UA_PC } }] };
  }
  const resp = await fetchText(url, {}, { timeout: 20000 });
  const finalUrl = resp.url || url;
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("video/")) {
    return { site: "通用直链", title: "video", items: [{ kind: "mp4", url: finalUrl, label: `视频直链 · ${ct}`, headers: { "User-Agent": UA_PC } }] };
  }
  const html = await resp.text();
  const items = [];
  const seen = new Set();
  const push = (u, label, kind) => {
    u = u.replace(/&amp;/g, "&");
    if (!u.startsWith("http") || seen.has(u)) return;
    seen.add(u);
    items.push({ kind, url: u, label, headers: { "User-Agent": UA_PC, Referer: finalUrl } });
  };
  for (const mm of html.matchAll(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"/gi)) push(mm[1], "og:video", "mp4");
  for (const mm of html.matchAll(/<video[^>]+src="([^"]+)"/gi)) push(mm[1], "video 标签", "mp4");
  for (const mm of html.matchAll(/https?:\/\/[^"'\s<>]+?\.m3u8[^"'\s<>]*/gi)) push(mm[0], "HLS 流", "hls");
  for (const mm of html.matchAll(/https?:\/\/[^"'\s<>]+?\.mp4[^"'\s<>]*/gi)) push(mm[0], "MP4 链接", "mp4");
  const tm = html.match(/<title>([^<]{2,100})<\/title>/i);
  if (!items.length) throw new Error("这个页面里没找到视频（可能需要登录，或视频是 DASH/DRM）");
  return { site: "通用网页", title: tm ? tm[1].trim() : finalUrl, items: items.slice(0, 10) };
}

/* ---------------- Entry ---------------- */
async function resolveInput(input) {
  const url = String(input || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("请粘贴一个 http(s) 网址");
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith("x.com") || host.endsWith("twitter.com")) return resolveTwitter(url);
  if (host.endsWith("bilibili.com") || host === "b23.tv") {
    if (host === "b23.tv") {
      const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA_PC } });
      return resolveBilibili(r.url);
    }
    return resolveBilibili(url);
  }
  if (host.endsWith("youtube.com") || host === "youtu.be" || host.endsWith("youtube-nocookie.com")) return resolveYoutube(url);
  if (host.endsWith("douyin.com") || host.endsWith("iesdouyin.com")) return resolveDouyin(url);
  return resolveGeneric(url);
}

module.exports = { resolveInput, fmtSize, UA_PC };
