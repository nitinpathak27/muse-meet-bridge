let isCapturing = false;
let activeTabId = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture Google Meet tab audio for live transcription to Muse Meet Bridge.",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    sendResponse({ isCapturing, activeTabId });
    return true;
  }

  if (msg.type === "START_CAPTURE") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab found.");

        await ensureOffscreen();
        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: tab.id,
        });

        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_START",
          streamId,
          bridgeUrl: msg.bridgeUrl || "http://localhost:3456",
        });

        isCapturing = true;
        activeTabId = tab.id;
        sendResponse({ ok: true });
      } catch (err) {
        console.error("Start capture failed:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "STOP_CAPTURE") {
    (async () => {
      try {
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_STOP",
        });
      } catch {}
      isCapturing = false;
      activeTabId = null;
      sendResponse({ ok: true });
    })();
    return true;
  }
});
