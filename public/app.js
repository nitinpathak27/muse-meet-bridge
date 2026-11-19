const els = {
  statusDot: document.getElementById("status-dot"),
  statusBadge: document.getElementById("status-badge"),
  apiWarning: document.getElementById("api-warning"),
  errorBanner: document.getElementById("error-banner"),
  latestQuestion: document.getElementById("latest-question"),
  questionStatus: document.getElementById("question-status"),
  replyInput: document.getElementById("muse-reply-input"),
  speakBtn: document.getElementById("speak-btn"),
  outputSelect: document.getElementById("audio-output-select"),
  refreshDevicesBtn: document.getElementById("refresh-devices-btn"),
  transcriptList: document.getElementById("live-transcript"),
  copyTranscriptBtn: document.getElementById("copy-transcript-btn"),
  generateNotesBtn: document.getElementById("generate-notes-btn"),
  copyNotesBtn: document.getElementById("copy-notes-btn"),
  meetingNotes: document.getElementById("meeting-notes"),
  demoBtn: document.getElementById("demo-btn"),
  localMicBtn: document.getElementById("local-mic-btn"),
  clearBtn: document.getElementById("clear-btn"),
  apiKeyInput: document.getElementById("api-key-input"),
  wakeWordInput: document.getElementById("wake-word-input"),
  voiceSelect: document.getElementById("voice-select"),
  autoReplyToggle: document.getElementById("auto-reply-toggle"),
  contextInput: document.getElementById("context-input"),
  saveSettingsBtn: document.getElementById("save-settings-btn"),
  ttsPlayer: document.getElementById("tts-player"),
};

let currentState = null;
let selectedSinkId = localStorage.getItem("muse_sink_id") || "";

// --- WebSocket Connection ---
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}`);

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      renderState(msg.state);
    } else if (msg.type === "play_audio") {
      await playAudioBase64(msg.audioBase64, msg.mimeType || "audio/wav");
    } else if (msg.type === "play_speech_fallback") {
      speakBrowserFallback(msg.text);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWS, 1500);
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderState(s) {
  currentState = s;

  // Status dot & badge
  els.statusBadge.textContent = `STATUS: ${s.status}`;
  els.statusDot.className = "dot";
  if (s.status === "LISTENING") els.statusDot.classList.add("listening");
  else if (s.status === "WAITING_FOR_MUSE") els.statusDot.classList.add("waiting");
  else if (s.status === "SPEAKING") els.statusDot.classList.add("speaking");

  // Warnings & errors
  els.apiWarning.classList.toggle("hidden", Boolean(s.hasApiKey));
  if (s.hasApiKey) {
    els.apiKeyInput.placeholder = "✅ Gemini API Key saved & active (paste new key to replace)";
  } else {
    els.apiKeyInput.placeholder = "AIza... (paste key and click Save Settings)";
  }
  if (s.lastError) {
    els.errorBanner.textContent = `⚠️ ${s.lastError}`;
    els.errorBanner.classList.remove("hidden");
  } else {
    els.errorBanner.classList.add("hidden");
  }

  // Sync settings fields (don't overwrite while user is actively typing)
  if (document.activeElement !== els.wakeWordInput) els.wakeWordInput.value = s.wakeWord || "muse";
  if (document.activeElement !== els.voiceSelect) els.voiceSelect.value = s.voice || "Kore";
  els.autoReplyToggle.checked = Boolean(s.autoReply);
  if (document.activeElement !== els.contextInput) els.contextInput.value = s.meetingContext || "";

  // Latest question
  if (s.latestQuestion) {
    els.latestQuestion.textContent = `[${s.latestQuestion.time}] ${s.latestQuestion.text}`;
    els.questionStatus.textContent = s.latestQuestion.answered ? "Answered ✅" : "Waiting for Muse 🔔";
    els.questionStatus.className = `pill ${s.latestQuestion.answered ? "answered" : "pending"}`;
  } else {
    els.latestQuestion.textContent = `Waiting for someone in Google Meet to say "${s.wakeWord || "muse"}..."`;
    els.questionStatus.textContent = "No pending question";
    els.questionStatus.className = "pill";
  }

  // Transcript
  if (!s.transcript || s.transcript.length === 0) {
    els.transcriptList.innerHTML =
      '<p class="empty-msg">No speech captured yet. Start the Chrome Extension on your Google Meet tab or click "Test Local Mic".</p>';
  } else {
    const html = s.transcript
      .map((t) => {
        const cls = t.speaker.startsWith("Muse")
          ? "t-item muse-reply"
          : t.addressedToMuse
          ? "t-item muse-addressed"
          : "t-item";
        return `
          <div class="${cls}">
            <div class="t-meta">[${escapeHtml(t.time)}] <strong>${escapeHtml(t.speaker)}</strong>${
          t.addressedToMuse ? " • 🔔 Addressed to Muse" : ""
        }</div>
            <div>${escapeHtml(t.text)}</div>
          </div>
        `;
      })
      .join("");
    els.transcriptList.innerHTML = html;
    els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
  }

  // Notes
  if (s.notes !== undefined) {
    els.meetingNotes.value = s.notes;
  }
}

// --- Audio Output Routing (supports VB-Cable virtual mic via setSinkId) ---
async function loadAudioOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    els.outputSelect.innerHTML = '<option value="">Default Speakers</option>';
    for (const dev of outputs) {
      if (!dev.deviceId || dev.deviceId === "default") continue;
      const opt = document.createElement("option");
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Audio Output (${dev.deviceId.slice(0, 6)})`;
      if (dev.deviceId === selectedSinkId) opt.selected = true;
      els.outputSelect.appendChild(opt);
    }
  } catch (err) {
    console.warn("Could not enumerate audio devices:", err);
  }
}

async function playAudioBase64(base64, mimeType) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);

  els.ttsPlayer.src = url;
  if (selectedSinkId && typeof els.ttsPlayer.setSinkId === "function") {
    try {
      await els.ttsPlayer.setSinkId(selectedSinkId);
    } catch (e) {
      console.warn("setSinkId failed, using default output:", e);
    }
  }
  try {
    await els.ttsPlayer.play();
  } catch (e) {
    console.warn("Autoplay blocked; click anywhere on the page once to enable audio playback.", e);
  }
  els.ttsPlayer.onended = () => URL.revokeObjectURL(url);
}

function speakBrowserFallback(text) {
  if (!("speechSynthesis" in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  window.speechSynthesis.speak(utter);
}

// --- UI Actions ---
async function handleSpeak() {
  const text = els.replyInput.value.trim();
  if (!text) return;
  els.speakBtn.disabled = true;
  els.speakBtn.textContent = "🔊 Speaking...";
  try {
    await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speaker: "Muse" }),
    });
    els.replyInput.value = "";
  } finally {
    els.speakBtn.disabled = false;
    els.speakBtn.textContent = "🔊 Speak in Google Meet";
  }
}

els.speakBtn.addEventListener("click", handleSpeak);
els.replyInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    handleSpeak();
  }
});

els.outputSelect.addEventListener("change", () => {
  selectedSinkId = els.outputSelect.value;
  localStorage.setItem("muse_sink_id", selectedSinkId);
});

els.refreshDevicesBtn.addEventListener("click", async () => {
  // Request brief mic permission if labels are hidden by browser privacy rules
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}
  await loadAudioOutputs();
});

els.saveSettingsBtn.addEventListener("click", async () => {
  const payload = {
    wakeWord: els.wakeWordInput.value.trim() || "muse",
    voice: els.voiceSelect.value,
    autoReply: els.autoReplyToggle.checked,
    meetingContext: els.contextInput.value.trim(),
  };
  if (els.apiKeyInput.value.trim()) {
    payload.geminiApiKey = els.apiKeyInput.value.trim();
    els.apiKeyInput.value = "";
  }
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  els.saveSettingsBtn.textContent = "Saved ✅";
  setTimeout(() => (els.saveSettingsBtn.textContent = "Save Settings"), 1500);
});

els.generateNotesBtn.addEventListener("click", async () => {
  els.generateNotesBtn.disabled = true;
  els.generateNotesBtn.textContent = "✨ Generating...";
  try {
    await fetch("/api/notes", { method: "POST" });
  } finally {
    els.generateNotesBtn.disabled = false;
    els.generateNotesBtn.textContent = "✨ Generate Notes";
  }
});

els.copyNotesBtn.addEventListener("click", async () => {
  if (!els.meetingNotes.value) return;
  await navigator.clipboard.writeText(els.meetingNotes.value);
  els.copyNotesBtn.textContent = "Copied ✅";
  setTimeout(() => (els.copyNotesBtn.textContent = "Copy Notes"), 1500);
});

els.copyTranscriptBtn.addEventListener("click", async () => {
  if (!currentState?.transcript?.length) return;
  const text = currentState.transcript
    .map((t) => `[${t.time}] ${t.speaker}: ${t.text}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  els.copyTranscriptBtn.textContent = "Copied ✅";
  setTimeout(() => (els.copyTranscriptBtn.textContent = "Copy Transcript"), 1500);
});

els.clearBtn.addEventListener("click", async () => {
  await fetch("/api/clear", { method: "POST" });
});

els.demoBtn.addEventListener("click", async () => {
  await fetch("/api/demo", { method: "POST" });
});

// --- Local Microphone Test Mode (works even without Chrome Extension / Google Meet) ---
let localStream = null;
let localRecorderTimer = null;
let localMicActive = false;

async function startLocalMic() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await loadAudioOutputs();
  localMicActive = true;
  els.localMicBtn.classList.add("active");
  els.localMicBtn.textContent = "⏹️ Stop Local Mic";
  await fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "LISTENING" }),
  });

  const recordSlice = () => {
    if (!localMicActive || !localStream) return;
    const chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(localStream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < 2500) return; // skip tiny/silent blobs
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = String(reader.result).split(",")[1];
        if (!base64) return;
        await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: base64, mimeType: "audio/webm" }),
        });
      };
      reader.readAsDataURL(blob);
    };

    recorder.start();
    localRecorderTimer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
      if (localMicActive) recordSlice();
    }, 5500);
  };

  recordSlice();
}

function stopLocalMic() {
  localMicActive = false;
  clearTimeout(localRecorderTimer);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  els.localMicBtn.classList.remove("active");
  els.localMicBtn.textContent = "🎤 Test Local Mic";
  fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "IDLE" }),
  });
}

els.localMicBtn.addEventListener("click", () => {
  if (localMicActive) stopLocalMic();
  else startLocalMic().catch((e) => alert("Microphone error: " + e.message));
});

// Init
connectWS();
loadAudioOutputs();
