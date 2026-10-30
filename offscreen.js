// VideoGrab — persistent offscreen worker for background HLS downloading,
//断点续传 (segment caching), AES-128 decryption, and TS-to-MP4 remuxing.
// Runs independently of the popup so switching tabs or closing the popup never interrupts downloads.

// Cache downloaded segments by taskId so interrupted downloads can resume without restarting from 0
const taskCache = new Map(); // taskId -> { resolvedPlaylistUrl, isFmp4, initBuffer, segments, downloaded: Map<index, ArrayBuffer> }
const activeTasks = new Set();

function resolveUrl(base, ref) {
  return new URL(ref, base).toString();
}

async function fetchWithRetry(url, retries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
      }
    }
  }
  throw lastErr || new Error("Network error");
}

async function fetchText(url) {
  const r = await fetchWithRetry(url, 3);
  return r.text();
}

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  const segments = [];
  let initSegment = null;
  let pendingVariant = null;
  let currentKey = null;
  let mediaSequence = 0;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const m = /BANDWIDTH=(\d+)/.exec(line);
      pendingVariant = { bandwidth: m ? Number(m[1]) : 0 };
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line);
      if (m) mediaSequence = Number(m[1]);
    } else if (line.startsWith("#EXT-X-KEY")) {
      const methodMatch = /METHOD=([^,]+)/.exec(line);
      const method = methodMatch ? methodMatch[1].trim() : "NONE";
      if (method === "AES-128") {
        const uriMatch = /URI=["']([^"']+)["']/.exec(line);
        const ivMatch = /IV=0x([0-9a-fA-F]+)/.exec(line);
        if (uriMatch) {
          currentKey = {
            method: "AES-128",
            uri: resolveUrl(baseUrl, uriMatch[1]),
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      } else {
        currentKey = null;
      }
    } else if (line.startsWith("#EXT-X-MAP")) {
      const m = /URI=["']?([^"',]+)["']?/.exec(line);
      if (m) {
        initSegment = resolveUrl(baseUrl, m[1]);
      }
    } else if (line.startsWith("#")) {
      continue;
    } else if (pendingVariant) {
      variants.push({ ...pendingVariant, url: resolveUrl(baseUrl, line) });
      pendingVariant = null;
    } else {
      segments.push({
        url: resolveUrl(baseUrl, line),
        key: currentKey ? { ...currentKey } : null,
        seq: mediaSequence + segments.length
      });
    }
  }

  const isFmp4 = Boolean(
    initSegment ||
    segments.some((s) => /\.(m4s|mp4)(\?|#|$)/i.test(s.url))
  );

  return {
    variants,
    segments,
    initSegment,
    isFmp4,
    isMaster: variants.length > 0
  };
}

function buildAesIv(ivHex, seq) {
  const iv = new Uint8Array(16);
  if (ivHex && ivHex.length === 32) {
    for (let i = 0; i < 16; i++) {
      iv[i] = parseInt(ivHex.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    const dv = new DataView(iv.buffer);
    dv.setUint32(12, seq >>> 0, false);
  }
  return iv;
}

function stripFakeTsHeader(u8) {
  if (!u8 || u8.byteLength < 564) return u8;
  if (u8[0] === 0x47 && u8[188] === 0x47) return u8;
  const limit = Math.min(u8.byteLength - 376, 1024);
  for (let i = 1; i < limit; i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) {
      return u8.subarray(i);
    }
  }
  return u8;
}

function remuxTsSegmentsToMp4(buffers) {
  if (typeof muxjs === "undefined" || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
    return null;
  }
  try {
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
    const mp4Parts = [];
    let hasInit = false;

    transmuxer.on("data", (segment) => {
      if (!hasInit && segment.initSegment && segment.initSegment.byteLength > 0) {
        const initCopy = new Uint8Array(segment.initSegment.byteLength);
        initCopy.set(new Uint8Array(segment.initSegment.buffer, segment.initSegment.byteOffset, segment.initSegment.byteLength));
        mp4Parts.push(initCopy);
        hasInit = true;
      }
      if (segment.data && segment.data.byteLength > 0) {
        const dataCopy = new Uint8Array(segment.data.byteLength);
        dataCopy.set(new Uint8Array(segment.data.buffer, segment.data.byteOffset, segment.data.byteLength));
        mp4Parts.push(dataCopy);
      }
    });

    for (const buf of buffers) {
      if (!buf || !buf.byteLength) continue;
      const cleanTs = stripFakeTsHeader(new Uint8Array(buf));
      transmuxer.push(cleanTs);
      transmuxer.flush();
    }

    if (hasInit && mp4Parts.length > 1) {
      return mp4Parts;
    }
  } catch (err) {
    console.warn("remuxTsSegmentsToMp4 error:", err);
  }
  return null;
}

function reportProgress(taskId, patch) {
  chrome.runtime.sendMessage({
    type: "HLS_TASK_UPDATE",
    taskId,
    ...patch
  }).catch(() => {});
}

async function runHlsDownload(msg) {
  const { taskId, url, baseFilename, tabId } = msg;
  if (activeTasks.has(taskId)) return;
  activeTasks.add(taskId);

  try {
    let state = taskCache.get(taskId);

    if (!state) {
      reportProgress(taskId, {
        status: "downloading",
        done: 0,
        total: 0,
        percent: 0,
        text: "后台读取 HLS 播放列表…",
        tabId
      });

      let parsed = parseM3u8(await fetchText(url), url);
      if (parsed.isMaster) {
        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        const best = parsed.variants[0];
        parsed = parseM3u8(await fetchText(best.url), best.url);
      }

      if (!parsed.segments.length) {
        throw new Error("未在播放列表中找到视频切片");
      }

      let initBuffer = null;
      if (parsed.initSegment) {
        const r = await fetchWithRetry(parsed.initSegment, 3);
        initBuffer = await r.arrayBuffer();
      }

      state = {
        isFmp4: parsed.isFmp4,
        initBuffer,
        segments: parsed.segments,
        downloaded: new Map()
      };
      taskCache.set(taskId, state);
    }

    const segs = state.segments;
    const total = segs.length;

    const keyCache = new Map();
    async function getCryptoKey(keyUri) {
      if (keyCache.has(keyUri)) return keyCache.get(keyUri);
      const p = (async () => {
        const r = await fetchWithRetry(keyUri, 3);
        const rawKey = await r.arrayBuffer();
        return crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
      })();
      keyCache.set(keyUri, p);
      return p;
    }

    // Only queue segments that haven't been downloaded yet (supports instant resume!)
    const pendingQueue = [];
    for (let i = 0; i < total; i++) {
      if (!state.downloaded.has(i)) {
        pendingQueue.push([segs[i], i]);
      }
    }

    let done = state.downloaded.size;
    const initialPct = Math.round((done / total) * 100);
    reportProgress(taskId, {
      status: "downloading",
      done,
      total,
      percent: initialPct,
      text: done > 0
        ? `断点续传中 ${done}/${total} (${initialPct}%) — 可切换页面`
        : `后台下载中 0/${total} (0%) — 可切换页面`,
      tabId
    });

    const CONCURRENCY = 6;
    async function worker() {
      while (pendingQueue.length) {
        const [seg, i] = pendingQueue.shift();
        const r = await fetchWithRetry(seg.url, 3);
        let buf = await r.arrayBuffer();

        if (seg.key && seg.key.method === "AES-128" && seg.key.uri) {
          const cryptoKey = await getCryptoKey(seg.key.uri);
          const iv = buildAesIv(seg.key.ivHex, seg.seq);
          buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buf);
        }

        state.downloaded.set(i, buf);
        done = state.downloaded.size;
        const pct = Math.round((done / total) * 100);
        reportProgress(taskId, {
          status: "downloading",
          done,
          total,
          percent: pct,
          text: `后台下载中 ${done}/${total} (${pct}%) — 可随时切换页面`,
          tabId
        });
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pendingQueue.length) }, worker));

    const ordered = new Array(total);
    for (let i = 0; i < total; i++) {
      ordered[i] = state.downloaded.get(i);
    }

    let finalParts = null;
    let isMp4Output = state.isFmp4;

    if (state.isFmp4) {
      finalParts = state.initBuffer ? [state.initBuffer, ...ordered] : ordered;
    } else {
      reportProgress(taskId, {
        status: "remuxing",
        done: total,
        total,
        percent: 99,
        text: "正在后台将 TS 转封装为 MP4…",
        tabId
      });
      const remuxed = remuxTsSegmentsToMp4(ordered);
      if (remuxed) {
        finalParts = remuxed;
        isMp4Output = true;
      } else {
        finalParts = ordered;
        isMp4Output = false;
      }
    }

    const finalFilename = (baseFilename || "video") + (isMp4Output ? ".mp4" : ".ts");
    const mimeType = isMp4Output ? "video/mp4" : "video/mp2t";
    const blob = new Blob(finalParts, { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_SAVE_BLOB",
      taskId,
      blobUrl,
      filename: finalFilename,
      tabId
    });

    // Free memory cache after completion
    taskCache.delete(taskId);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
  } catch (err) {
    const cachedCount = taskCache.get(taskId)?.downloaded?.size || 0;
    const totalCount = taskCache.get(taskId)?.segments?.length || 0;
    const resumeHint = cachedCount > 0 ? `（已缓存 ${cachedCount}/${totalCount}，点击可继续下载）` : "";
    reportProgress(taskId, {
      status: "error",
      text: `下载中断: ${err && err.message ? err.message : err} ${resumeHint}`,
      tabId
    });
  } finally {
    activeTasks.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "OFFSCREEN_START_HLS") {
    runHlsDownload(msg);
    sendResponse({ ok: true });
    return true;
  }
});
