// VideoGrab — page-world hook (runs in MAIN world at document_start).
// Intercepts fetch/XHR responses and extracts high-bitrate media URLs.
(() => {
  const NON_VIDEO_EXT_RE = /\.(vtt|srt|ass|sub|xml|json|js|css|html|txt|jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot|m4a|aac|mp3|ogg|wav)(\?|#|$)/i;
  const NON_VIDEO_KEYWORDS_RE = /(thumb|thumbnails|storyboard|sprite|caption|subtitle|avatar|profile_images|emoji|x-card-animation|grok-.*visual|promo|banner|byteeffecttos\.com|ies\.fe\.effect)/i;
  const CHUNK_RE = /\.(ts|m4s)(\?|#|$)/i;
  const INIT_OR_AUDIO_SEGMENT_RE = /(\/0\/0\/|\/aud\/|\/mp4a\/|\/subtitles\/|[\/_-]init\.mp4(\?|#|$))/i;
  const VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov|m4v|flv)(\?|#|$)/i;

  const seen = new Set();

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

  function report(url, via, priority = 0) {
    try {
      if (!isMediaUrl(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      window.postMessage({ __videograb: true, type: "MEDIA_URL", url, via, priority }, "*");
    } catch (_) {}
  }

  function extractVideosFromJson(obj) {
    if (!obj) return;
    try {
      const s = JSON.stringify(obj);

      // Twitter / X: prioritize highest resolution direct MP4s (excluding /0/0/ init segments)
      const rawTwMp4s = s.match(/https?:\\\/\\\/video\.twimg\.com\\\/[^\s"']+\.mp4[^\s"']*/g) || [];
      const twMp4s = rawTwMp4s
        .map((u) => u.replace(/\\\//g, "/"))
        .filter((u) => !INIT_OR_AUDIO_SEGMENT_RE.test(u));

      if (twMp4s.length) {
        twMp4s.sort((a, b) => {
          const score = (u) => (u.includes("1080") ? 4 : u.includes("720") ? 3 : u.includes("480") ? 2 : 1);
          return score(b) - score(a);
        });
        report(twMp4s[0], "twitter-hd", 3);
      }

      // Master HLS playlists
      const m3u8s = s.match(/https?:\\\/\\\/[^\s"']+\.m3u8[^\s"']*/g) || [];
      for (let u of m3u8s) {
        u = u.replace(/\\\//g, "/");
        if (u.includes("master.m3u8") || !u.includes("x")) {
          report(u, "hls-master", 2);
        }
      }

      // Douyin play URLs
      const douyinMatches = s.match(/https?:\\\/\\\/[^\s"']*(?:douyinvod\.com|aweme\/v1\/play)[^\s"']*/g) || [];
      for (let u of douyinMatches) {
        report(u.replace(/\\\//g, "/"), "douyin-api", 2);
      }
    } catch (_) {}
  }

  // fetch hook
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      try {
        const req = args[0];
        const url = typeof req === "string" ? req : req && req.url;
        if (url && isMediaUrl(url)) report(url, "fetch");
      } catch (_) {}

      const resp = await origFetch.apply(this, args);

      try {
        const clone = resp.clone();
        const ct = clone.headers.get("content-type") || "";
        if (ct.includes("json")) {
          clone.json().then(extractVideosFromJson).catch(() => {});
        } else if (ct.startsWith("video/") || ct.includes("mpegurl")) {
          report(resp.url || (typeof args[0] === "string" ? args[0] : args[0]?.url), "fetch-media");
        }
      } catch (_) {}

      return resp;
    };
  }

  // XHR hook
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === "string" && isMediaUrl(url)) {
        report(url, "xhr");
      }
    } catch (_) {}
    return origOpen.call(this, method, url, ...rest);
  };
})();
