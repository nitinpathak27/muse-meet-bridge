const toggleBtn = document.getElementById("toggle-btn");
const openConsoleBtn = document.getElementById("open-console-btn");
const statusEl = document.getElementById("status");
const bridgeUrlInput = document.getElementById("bridge-url");

const DEFAULT_URL = "http://localhost:3456";
let capturing = false;

function getBridgeUrl() {
  const raw = (bridgeUrlInput.value || DEFAULT_URL).trim().replace(/\/+$/, "");
  return raw || DEFAULT_URL;
}

function updateUI() {
  if (capturing) {
    toggleBtn.textContent = "⏹ Stop Listening";
    toggleBtn.classList.add("stop");
    statusEl.textContent = `Status: Listening → ${getBridgeUrl()} 🟢`;
  } else {
    toggleBtn.textContent = "▶ Start Listening to This Tab";
    toggleBtn.classList.remove("stop");
    statusEl.textContent = "Status: Idle";
  }
}

chrome.storage.local.get(["bridgeUrl"], (data) => {
  bridgeUrlInput.value = data.bridgeUrl || DEFAULT_URL;
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    capturing = Boolean(res?.isCapturing);
    updateUI();
  });
});

bridgeUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ bridgeUrl: getBridgeUrl() });
});

toggleBtn.addEventListener("click", () => {
  const url = getBridgeUrl();
  chrome.storage.local.set({ bridgeUrl: url });

  if (!capturing) {
    statusEl.textContent = "Starting...";
    chrome.runtime.sendMessage(
      { type: "START_CAPTURE", bridgeUrl: url },
      (res) => {
        if (res?.ok) {
          capturing = true;
          updateUI();
        } else {
          statusEl.textContent = "Error: " + (res?.error || "Make sure Meet tab is active.");
        }
      }
    );
  } else {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }, () => {
      capturing = false;
      updateUI();
    });
  }
});

openConsoleBtn.addEventListener("click", () => {
  const url = getBridgeUrl();
  chrome.storage.local.set({ bridgeUrl: url });
  chrome.tabs.create({ url });
});
