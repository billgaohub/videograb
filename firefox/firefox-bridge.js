// VideoGrab — Firefox bridge.
//
// Firefox has no chrome.offscreen API, so in the Firefox build the HLS
// engine (offscreen.js) is loaded directly into the background page,
// alongside background.js. Two plumbing differences follow:
//
// 1. background.js cannot reach the engine via chrome.runtime.sendMessage
//    (messages are never delivered to the sender's own context), so it
//    calls self.__vgStartHls() instead — defined here.
// 2. The engine reports back with chrome.runtime.sendMessage
//    (HLS_TASK_UPDATE / OFFSCREEN_SAVE_BLOB). Those messages would go
//    nowhere in a single-page background, so this bridge intercepts them
//    and applies exactly the same state updates background.js performs
//    when they arrive from Chrome's offscreen document.
//
// Load order in the Firefox manifest's background.scripts matters:
//   mux.min.js -> offscreen.js -> firefox-bridge.js -> background.js
// `hlsTasks` below is the binding declared by background.js; top-level
// let/const bindings are shared across classic scripts in the same page,
// and every lookup here happens at message time, after all scripts load.
//
// On Chrome this file is not loaded and does nothing.

(function () {
  if (typeof chrome === "undefined" || !chrome.runtime) return;
  if (chrome.offscreen) return; // Chrome path: real offscreen document.

  self.__vgStartHls = function (msg) {
    const fn = self.runHlsDownload;
    if (typeof fn === "function") {
      fn(msg);
    }
  };

  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);

  async function handleTaskUpdate(msg) {
    const existing = hlsTasks.get(msg.taskId) || { taskId: msg.taskId, url: msg.taskId };
    const updated = { ...existing, ...msg, updatedAt: Date.now() };
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
    return { ok: true };
  }

  async function handleSaveBlob(msg) {
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
    return { ok: true, downloadId };
  }

  chrome.runtime.sendMessage = function (message, ...rest) {
    if (message && message.type === "HLS_TASK_UPDATE") {
      return handleTaskUpdate(message);
    }
    if (message && message.type === "OFFSCREEN_SAVE_BLOB") {
      return handleSaveBlob(message);
    }
    return originalSendMessage(message, ...rest);
  };
})();
