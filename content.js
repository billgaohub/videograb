// VideoGrab — isolated-world content script.
// Scans video elements, resolves X/Twitter, Bilibili, and YouTube videos, and relays media URLs.
(() => {
  const NON_VIDEO_EXT_RE = /\.(vtt|srt|ass|sub|xml|json|js|css|html|txt|jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot|m4a|aac|mp3|ogg|wav)(\?|#|$)/i;
  const NON_VIDEO_KEYWORDS_RE = /(thumb|thumbnails|storyboard|sprite|caption|subtitle|avatar|profile_images|emoji|x-card-animation|grok-.*visual|promo|banner|byteeffecttos\.com|ies\.fe\.effect)/i;
  const CHUNK_RE = /\.(ts|m4s)(\?|#|$)/i;
  const INIT_OR_AUDIO_SEGMENT_RE = /(\/0\/0\/|\/aud\/|\/mp4a\/|\/subtitles\/|[\/_-]init\.mp4(\?|#|$))/i;
  const VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov|m4v|flv)(\?|#|$)/i;

  const seen = new Set();
  const seenTweets = new Set();
  const seenBili = new Set();
  const seenYoutube = new Set();

  function isMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (NON_VIDEO_EXT_RE.test(url)) return false;
    if (NON_VIDEO_KEYWORDS_RE.test(url)) return false;
    if (CHUNK_RE.test(url)) return false;
    if (INIT_OR_AUDIO_SEGMENT_RE.test(url)) return false;
    if (url.includes("googlevideo.com/videoplayback")) return false;

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

  function send(url, source, isDirectVideoTag = false, priority = 0) {
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    if (!isDirectVideoTag && !isMediaUrl(url)) return;
    if (
      NON_VIDEO_EXT_RE.test(url) ||
      NON_VIDEO_KEYWORDS_RE.test(url) ||
      CHUNK_RE.test(url) ||
      INIT_OR_AUDIO_SEGMENT_RE.test(url) ||
      url.includes("googlevideo.com/videoplayback")
    ) {
      return;
    }

    if (seen.has(url)) return;
    seen.add(url);

    chrome.runtime.sendMessage({
      type: "VIDEO_FOUND",
      item: {
        url,
        kind: kindOf(url),
        source,
        priority,
        pageTitle: document.title || "Video",
        pageUrl: window.location.href,
        foundAt: Date.now()
      },
    }).catch(() => {});
  }

  function resolveTweetId(tweetId, priority = 3) {
    if (!tweetId || seenTweets.has(tweetId)) return;
    seenTweets.add(tweetId);
    chrome.runtime.sendMessage({
      type: "RESOLVE_TWITTER_TWEET",
      tweetId,
      priority,
      pageTitle: document.title || "X Video",
      pageUrl: window.location.href
    }).catch(() => {});
  }

  function scanTwitterDom() {
    if (!/(^|\.)(x\.com|twitter\.com)$/i.test(window.location.hostname)) return;

    const urlMatch = window.location.pathname.match(/\/status\/(\d+)/);
    if (urlMatch) {
      resolveTweetId(urlMatch[1], 3);
    }

    const videos = Array.from(document.querySelectorAll("video"));
    videos.forEach((v) => {
      const isPlaying = !v.paused && v.currentTime > 0;
      const priority = isPlaying ? 3 : 2;
      const article = v.closest("article");
      if (article) {
        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/status\/(\d+)/);
          if (m) resolveTweetId(m[1], priority);
        }
      }
    });
  }

  function scanBilibiliDom() {
    if (!/(^|\.)bilibili\.com$/i.test(window.location.hostname)) return;
    const m = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/i);
    if (!m) return;
    const id = m[1];
    const params = new URLSearchParams(window.location.search);
    const p = Number(params.get("p") || 1);
    const key = `${id}_${p}`;
    if (seenBili.has(key)) return;
    seenBili.add(key);

    chrome.runtime.sendMessage({
      type: "RESOLVE_BILIBILI_VIDEO",
      bvid: /^BV/i.test(id) ? id : null,
      aid: /^av/i.test(id) ? id : null,
      p,
      pageTitle: document.title.replace(/_哔哩哔哩_bilibili$/i, ""),
      pageUrl: window.location.href
    }).catch(() => {});
  }

  function scanYoutubeDom() {
    const host = window.location.hostname;
    if (!/(^|\.)youtube\.com$/i.test(host) && host !== "youtu.be") return;
    const params = new URLSearchParams(window.location.search);
    let vid = params.get("v");
    if (!vid) {
      const sm = window.location.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
      if (sm) vid = sm[1];
    }
    if (!vid || seenYoutube.has(vid)) return;
    seenYoutube.add(vid);

    chrome.runtime.sendMessage({
      type: "RESOLVE_YOUTUBE_VIDEO",
      videoId: vid,
      pageTitle: document.title.replace(/\s*-\s*YouTube$/i, ""),
      pageUrl: window.location.href
    }).catch(() => {});
  }

  function scanDom() {
    scanTwitterDom();
    scanBilibiliDom();
    scanYoutubeDom();

    const videos = Array.from(document.querySelectorAll("video"));
    videos.forEach((v) => {
      const isPlaying = !v.paused && v.currentTime > 0;
      const isVisible = v.offsetWidth > 120 && v.offsetHeight > 120;
      const priority = isPlaying ? 2 : (isVisible ? 1 : 0);

      const urls = [v.currentSrc, v.src];
      v.querySelectorAll("source").forEach((s) => urls.push(s.src));

      for (const u of urls) {
        if (u && /^https?:\/\//i.test(u)) {
          send(u, "video-tag", true, priority);
        }
      }
    });
  }

  function scanPerformance() {
    try {
      performance.getEntriesByType("resource").forEach((e) => {
        if (isMediaUrl(e.name)) send(e.name, "network");
      });
    } catch (_) {}
  }

  try {
    const po = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        if (isMediaUrl(e.name)) send(e.name, "network");
      });
    });
    po.observe({ entryTypes: ["resource"] });
  } catch (_) {}

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__videograb && d.type === "MEDIA_URL") {
      send(d.url, d.via || "page-hook", false, d.priority || 0);
    }
  });

  let t = null;
  const mo = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(scanDom, 500);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("play", scanDom, true);
  document.addEventListener("loadedmetadata", scanDom, true);
  document.addEventListener("timeupdate", () => {
    if (!t) {
      t = setTimeout(() => { scanDom(); t = null; }, 1000);
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "RESCAN") {
      seenTweets.clear();
      seenBili.clear();
      seenYoutube.clear();
      scanDom();
      scanPerformance();
    }
  });

  scanDom();
  scanPerformance();
})();
