let mediaStream = null;
let audioCtx = null;
let sliceTimer = null;
let active = false;
let currentBridgeUrl = "http://localhost:3456";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "OFFSCREEN_START") {
    currentBridgeUrl = msg.bridgeUrl || "http://localhost:3456";
    startCapture(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_STOP") {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }
});

async function startCapture(streamId) {
  stopCapture();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Route tab audio back to speakers so the user still hears Google Meet normally
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  source.connect(audioCtx.destination);

  const timeData = new Uint8Array(analyser.fftSize);
  let peakRmsInSlice = 0;

  const meterInterval = setInterval(() => {
    if (!active) {
      clearInterval(meterInterval);
      return;
    }
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeData.length);
    if (rms > peakRmsInSlice) peakRmsInSlice = rms;
  }, 150);

  active = true;
  fetch(`${currentBridgeUrl}/api/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "LISTENING" }),
  }).catch(() => {});

  const recordSlice = () => {
    if (!active || !mediaStream) return;
    peakRmsInSlice = 0;
    const chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(mediaStream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      // Skip completely silent slices to save Gemini API cost
      if (chunks.length === 0 || peakRmsInSlice < 0.008) return;

      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < 2500) return;

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = String(reader.result).split(",")[1];
        if (!base64) return;
        fetch(`${currentBridgeUrl}/api/audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: base64, mimeType: "audio/webm" }),
        }).catch((err) => console.warn("Bridge POST failed:", err));
      };
      reader.readAsDataURL(blob);
    };

    recorder.start();
    sliceTimer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
      if (active) recordSlice();
    }, 5500);
  };

  recordSlice();
}

function stopCapture() {
  active = false;
  clearTimeout(sliceTimer);
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  fetch(`${currentBridgeUrl}/api/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "IDLE" }),
  }).catch(() => {});
}
