import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3456);
const TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-2.5-flash";
const NOTES_MODEL = process.env.GEMINI_NOTES_MODEL || "gemini-2.5-flash";
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const BRIDGE_API_KEY = (process.env.BRIDGE_API_KEY || "").trim();

const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const mcpSessions = new Map(); // sessionId -> { createdAt, protocolVersion }

let apiKey = process.env.GEMINI_API_KEY || "";
const isValidKey = (k) => Boolean(k && k.trim() && !k.includes("your_gemini_api_key"));

function getAI() {
  if (!isValidKey(apiKey)) {
    throw new Error("GEMINI_API_KEY is not configured. Add it in .env or via the Console settings.");
  }
  return new GoogleGenAI({ apiKey });
}

// --- In-memory meeting state & event buffer (for Muse polling & long-poll) ---
let eventSeq = 0;
const questionWaiters = new Set(); // resolvers waiting for a new question addressed to Muse

const state = {
  status: "IDLE", // IDLE | LISTENING | WAITING_FOR_MUSE | SPEAKING
  wakeWord: (process.env.WAKE_WORD || "muse").toLowerCase(),
  voice: process.env.GEMINI_VOICE || "Kore",
  autoReply: false,
  meetingContext: "",
  transcript: [], // { event_id, id, time, speaker, text, addressedToMuse }
  latestQuestion: null, // { event_id, id, time, text, answered }
  notes: "",
  lastError: null,
  isSpeaking: false,
  lastSpokeAt: 0,
};

function addTranscriptEntry({ speaker, text, addressedToMuse = false, time = nowTime() }) {
  eventSeq += 1;
  const entry = {
    event_id: eventSeq,
    id: eventSeq,
    time,
    speaker,
    text,
    addressedToMuse,
  };
  state.transcript.push(entry);

  if (addressedToMuse) {
    state.latestQuestion = {
      event_id: eventSeq,
      id: eventSeq,
      time,
      text,
      answered: false,
    };
    state.status = "WAITING_FOR_MUSE";
    // Wake any Muse long-poll wait_for_question calls immediately
    for (const resolve of questionWaiters) {
      resolve(entry);
    }
    questionWaiters.clear();
  }
  return entry;
}

function getUpdatesSince(sinceEventId = 0) {
  const since = Number(sinceEventId) || 0;
  const newLines = state.transcript.filter((t) => (t.event_id || 0) > since);
  const newQuestions = newLines.filter((t) => t.addressedToMuse);
  return {
    status: state.status,
    wake_word: state.wakeWord,
    since_event_id: since,
    next_since_event_id: eventSeq,
    has_new_updates: newLines.length > 0,
    has_pending_question: Boolean(state.latestQuestion && !state.latestQuestion.answered),
    latest_question: state.latestQuestion,
    new_questions: newQuestions,
    new_transcript_lines: newLines,
    total_transcript_lines: state.transcript.length,
  };
}

// Wrap raw 24kHz 16-bit mono PCM from Gemini TTS into a playable WAV buffer
function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function nowTime() {
  return new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// --- Express + WebSocket Server ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function broadcastState() {
  broadcast({
    type: "state",
    state: {
      ...state,
      hasApiKey: isValidKey(apiKey),
    },
  });
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "state",
      state: {
        ...state,
        hasApiKey: isValidKey(apiKey),
      },
    })
  );
});

// --- Helper: Synthesize speech via Gemini TTS ---
async function synthesizeSpeech(text, voiceName = state.voice) {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [
      {
        parts: [
          {
            text: `Speak the following meeting response clearly, naturally, and concisely:\n\n${text}`,
          },
        ],
      },
    ],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName || "Kore",
          },
        },
      },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new Error("Gemini TTS returned no audio data.");
  }

  const rawBuffer = Buffer.from(part.inlineData.data, "base64");
  const mime = (part.inlineData.mimeType || "").toLowerCase();

  // If Gemini already returned wav/mp3/ogg, pass through; otherwise wrap raw PCM in WAV
  if (mime.includes("wav") || mime.includes("mpeg") || mime.includes("ogg")) {
    return {
      audioBase64: rawBuffer.toString("base64"),
      mimeType: part.inlineData.mimeType,
    };
  }

  const wavBuffer = pcmToWavBuffer(rawBuffer, 24000, 1, 16);
  return {
    audioBase64: wavBuffer.toString("base64"),
    mimeType: "audio/wav",
  };
}

// --- Helper: Speak text into the meeting ---
async function speakInMeeting(text, speakerLabel = "Muse") {
  const cleanText = String(text || "").trim();
  if (!cleanText) return { ok: false, error: "Empty text" };

  state.isSpeaking = true;
  state.status = "SPEAKING";
  state.lastError = null;
  if (state.latestQuestion && !state.latestQuestion.answered) {
    state.latestQuestion.answered = true;
  }

  // Record in transcript
  addTranscriptEntry({
    speaker: speakerLabel,
    text: cleanText,
    addressedToMuse: false,
  });
  broadcastState();

  try {
    const { audioBase64, mimeType } = await synthesizeSpeech(cleanText, state.voice);
    state.lastSpokeAt = Date.now();
    broadcast({
      type: "play_audio",
      audioBase64,
      mimeType,
      text: cleanText,
    });
    return { ok: true, mode: "gemini_tts" };
  } catch (err) {
    console.warn("Gemini TTS failed, falling back to browser speech:", err.message);
    state.lastSpokeAt = Date.now();
    broadcast({
      type: "play_speech_fallback",
      text: cleanText,
    });
    return { ok: true, mode: "browser_tts_fallback", warning: err.message };
  } finally {
    // Brief cooldown to avoid echo pickup
    setTimeout(() => {
      state.isSpeaking = false;
      state.status = "LISTENING";
      broadcastState();
    }, 2500);
  }
}

// --- Routes ---

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: state.status,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get("/api/state", (_req, res) => {
  res.json({
    ...state,
    hasApiKey: isValidKey(apiKey),
  });
});

app.post("/api/config", (req, res) => {
  const { wakeWord, voice, autoReply, meetingContext, geminiApiKey } = req.body || {};
  if (typeof wakeWord === "string" && wakeWord.trim()) {
    state.wakeWord = wakeWord.trim().toLowerCase();
  }
  if (typeof voice === "string" && voice.trim()) {
    state.voice = voice.trim();
  }
  if (typeof autoReply === "boolean") {
    state.autoReply = autoReply;
  }
  if (typeof meetingContext === "string") {
    state.meetingContext = meetingContext;
  }
  if (typeof geminiApiKey === "string" && geminiApiKey.trim()) {
    apiKey = geminiApiKey.trim();
  }
  state.lastError = null;
  broadcastState();
  res.json({ ok: true, hasApiKey: isValidKey(apiKey) });
});

app.post("/api/status", (req, res) => {
  const { status } = req.body || {};
  if (status) {
    state.status = status;
    broadcastState();
  }
  res.json({ ok: true });
});

// Receive audio chunk from Chrome Extension or Local Test Mic
app.post("/api/audio", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm" } = req.body || {};
    if (!audioBase64) {
      return res.status(400).json({ ok: false, error: "Missing audioBase64" });
    }

    // Echo guard: ignore chunks arriving while Muse is actively speaking
    if (state.isSpeaking || Date.now() - state.lastSpokeAt < 1800) {
      return res.json({ ok: true, skipped: "echo_guard" });
    }

    state.status = "LISTENING";
    const ai = getAI();

    const prompt = [
      "Transcribe the spoken human speech in this short meeting audio clip accurately.",
      "If there is only silence, background noise, breathing, or unintelligible sound, return an empty string for text.",
      `Also check if the speaker is directly addressing the AI assistant named "${state.wakeWord}" (e.g., "Hey ${state.wakeWord}", "${state.wakeWord}", or asking ${state.wakeWord} a question).`,
      'Return ONLY valid JSON with this exact shape: {"text": "...", "addressedToMuse": true/false}',
    ].join(" ");

    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const rawText = response.text?.trim() || "{}";
    let parsed = { text: "", addressedToMuse: false };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { text: rawText, addressedToMuse: false };
    }

    const transcriptText = String(parsed.text || "").trim();
    if (!transcriptText) {
      return res.json({ ok: true, skipped: "silence" });
    }

    const wakeRegex = new RegExp(`\\b${state.wakeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const addressed = Boolean(parsed.addressedToMuse || wakeRegex.test(transcriptText));

    const entry = addTranscriptEntry({
      speaker: "Meeting",
      text: transcriptText,
      addressedToMuse: addressed,
    });
    state.lastError = null;

    broadcastState();

    // Optional Auto-Reply mode (uses Gemini directly if enabled)
    if (addressed && state.autoReply) {
      const recentHistory = state.transcript
        .slice(-15)
        .map((t) => `[${t.time}] ${t.speaker}: ${t.text}`)
        .join("\n");

      const replyPrompt = [
        `You are Muse, a helpful AI assistant participating live in a Google Meet call.`,
        state.meetingContext ? `Meeting context: ${state.meetingContext}` : "",
        `Recent transcript:\n${recentHistory}`,
        `Respond directly to the latest question in 1-3 short, natural spoken sentences (no markdown or bullet points).`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const replyResp = await ai.models.generateContent({
        model: TRANSCRIBE_MODEL,
        contents: replyPrompt,
      });

      const autoAnswer = replyResp.text?.trim();
      if (autoAnswer) {
        await speakInMeeting(autoAnswer, "Muse (Auto)");
      }
    }

    res.json({ ok: true, entry });
  } catch (err) {
    console.error("Audio transcription error:", err);
    state.lastError = err.message;
    broadcastState();
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Speak Muse's reply into the meeting
app.post("/api/speak", async (req, res) => {
  try {
    const { text, speaker = "Muse" } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ ok: false, error: "Text is required" });
    }
    const result = await speakInMeeting(text, speaker);
    res.json(result);
  } catch (err) {
    console.error("Speak error:", err);
    state.lastError = err.message;
    broadcastState();
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Helper: Generate structured meeting notes
async function generateNotesText() {
  if (state.transcript.length === 0) {
    throw new Error("Transcript is empty.");
  }
  const ai = getAI();
  const fullTranscript = state.transcript
    .map((t) => `[${t.time}] ${t.speaker}: ${t.text}`)
    .join("\n");

  const notesPrompt = [
    "You are an expert executive meeting note-taker.",
    state.meetingContext ? `Meeting context: ${state.meetingContext}` : "",
    "Based on the meeting transcript below, produce clean, well-structured Markdown notes with:",
    "1. **Executive Summary** (3-4 bullet points)",
    "2. **Key Discussion Points**",
    "3. **Decisions Made**",
    "4. **Action Items** (with owner if mentioned, and clear next steps)",
    "5. **Open Questions / Follow-ups**",
    "",
    "Transcript:",
    fullTranscript,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await ai.models.generateContent({
    model: NOTES_MODEL,
    contents: notesPrompt,
  });

  state.notes = response.text?.trim() || "";
  state.lastError = null;
  broadcastState();
  return state.notes;
}

// Generate structured meeting notes from the transcript
app.post("/api/notes", async (_req, res) => {
  try {
    const notes = await generateNotesText();
    res.json({ ok: true, notes });
  } catch (err) {
    console.error("Notes error:", err);
    state.lastError = err.message;
    broadcastState();
    res.status(err.message === "Transcript is empty." ? 400 : 500).json({ ok: false, error: err.message });
  }
});

// Load a realistic demo meeting state so users can preview the UI immediately
app.post("/api/demo", (_req, res) => {
  eventSeq = 0;
  state.transcript = [];
  state.latestQuestion = null;
  state.meetingContext = "Q4 Product Launch & AI Meeting Assistant Demo";

  addTranscriptEntry({
    time: "10:02:14",
    speaker: "Meeting",
    text: "Welcome everyone! Today we need to finalize the launch date for the Muse Meet integration and confirm who owns the Chrome extension testing.",
    addressedToMuse: false,
  });
  addTranscriptEntry({
    time: "10:02:48",
    speaker: "Meeting",
    text: "Nitin will handle the Windows VB-Cable audio routing check, and Priya will review the post-meeting notes template by Friday.",
    addressedToMuse: false,
  });
  addTranscriptEntry({
    time: "10:03:19",
    speaker: "Muse",
    text: "Got it — I have noted Nitin's audio check and Priya's Friday deadline for the notes template.",
    addressedToMuse: false,
  });
  addTranscriptEntry({
    time: "10:03:52",
    speaker: "Meeting",
    text: "Hey Muse, can you quickly summarize our open action items and suggest a launch date for next week?",
    addressedToMuse: true,
  });

  state.notes = [
    "### Executive Summary",
    "- Team aligned on launching the **Muse Meet Bridge** integration next week.",
    "- Audio routing and meeting note templates were assigned with clear owners.",
    "",
    "### Action Items",
    "- **Nitin:** Verify Windows VB-Cable audio routing for Google Meet.",
    "- **Priya:** Review post-meeting notes template by Friday.",
    "- **Muse:** Propose a launch date for next week and circulate final notes.",
  ].join("\n");
  state.lastError = null;
  broadcastState();
  res.json({ ok: true });
});

// Clear meeting state
function clearSession() {
  eventSeq = 0;
  state.transcript = [];
  state.latestQuestion = null;
  state.notes = "";
  state.lastError = null;
  state.status = "IDLE";
  broadcastState();
}

app.post("/api/clear", (_req, res) => {
  clearSession();
  res.json({ ok: true });
});

// --- MCP Streamable HTTP Endpoint (Muse Custom Connector Spec) ---
// Supports:
//  - Protocol versions: 2025-11-25, 2025-06-18, 2025-03-26
//  - Session header: Mcp-Session-Id (created on initialize, echoed on each call)
//  - Auth: Authorization: Bearer <BRIDGE_API_KEY> or x-api-key header
//  - Event-buffered get_meeting_updates(since_event_id) + 25s long-poll wait_for_question
function stripQuotesAndBearer(val) {
  let s = String(val || "").trim();
  // Strip accidental surrounding quotes
  s = s.replace(/^["']|["']$/g, "").trim();
  // Strip one or more leading "Bearer " prefixes (case-insensitive)
  while (/^bearer\s+/i.test(s)) {
    s = s.replace(/^bearer\s+/i, "").trim();
  }
  return s.replace(/^["']|["']$/g, "").trim();
}

function checkMcpAuth(req) {
  const expected = stripQuotesAndBearer(BRIDGE_API_KEY);
  if (!expected) return true;
  const authHeader = req.headers.authorization || "";
  const apiKeyHeader = req.headers["x-api-key"] || "";
  const bearer = stripQuotesAndBearer(authHeader);
  const xKey = stripQuotesAndBearer(apiKeyHeader);
  const ok = bearer === expected || xKey === expected;
  if (!ok) {
    console.warn(
      `[MCP 401] Auth mismatch (auth header present: ${Boolean(authHeader)}, len: ${bearer.length}, expected len: ${expected.length})`
    );
  }
  return ok;
}

const MCP_TOOLS = [
  {
    name: "get_meeting_updates",
    description:
      "Buffered delta tool for scheduled meeting loops. Returns all new Google Meet transcript lines, questions addressed to Muse, and status since since_event_id, plus next_since_event_id for your next call.",
    inputSchema: {
      type: "object",
      properties: {
        since_event_id: {
          type: "number",
          description:
            "Cursor from the previous call's next_since_event_id (use 0 on the first call).",
        },
      },
      required: [],
    },
  },
  {
    name: "wait_for_question",
    description:
      "Long-poll tool (default 25s, max 35s — safe under 40s client timeout). Returns immediately as soon as someone in Google Meet addresses Muse with a question, or returns any new buffered updates when the wait window ends.",
    inputSchema: {
      type: "object",
      properties: {
        since_event_id: {
          type: "number",
          description: "Cursor from the previous call's next_since_event_id (default 0).",
        },
        timeout_seconds: {
          type: "number",
          description: "How long to wait for a new Muse question before returning (5 to 35, default 25).",
        },
      },
      required: [],
    },
  },
  {
    name: "speak_in_meeting",
    description:
      "Speak a natural voice reply aloud into the active Google Meet call as Muse using Gemini TTS, and mark the latest pending question as answered.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Concise, natural spoken text to say aloud in Google Meet (plain speech, no markdown).",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "generate_meeting_notes",
    description:
      "Generate structured Markdown meeting notes (Executive Summary, Key Discussion Points, Decisions Made, Action Items) from the full Google Meet transcript.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_live_transcript",
    description: "Retrieve the full or most recent Google Meet transcript lines.",
    inputSchema: {
      type: "object",
      properties: {
        last_n: {
          type: "number",
          description: "Optional number of most recent transcript lines to return (default: all).",
        },
      },
      required: [],
    },
  },
  {
    name: "clear_meeting_session",
    description: "Clear the buffered transcript, pending questions, and notes after a meeting ends.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// Streamable HTTP spec: GET /mcp returns 405 if server does not offer standalone SSE streams
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST /mcp (Streamable HTTP)." });
});

app.delete("/mcp", (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sid) mcpSessions.delete(String(sid));
  res.status(204).end();
});

app.post("/mcp", async (req, res) => {
  if (!checkMcpAuth(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Invalid or missing BRIDGE_API_KEY" },
      id: req.body?.id ?? null,
    });
  }

  const { jsonrpc = "2.0", id, method, params = {} } = req.body || {};
  let sessionId = req.headers["mcp-session-id"] ? String(req.headers["mcp-session-id"]) : null;

  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    const negotiatedVersion = SUPPORTED_MCP_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : "2025-03-26";
    sessionId = crypto.randomUUID();
    mcpSessions.set(sessionId, { createdAt: Date.now(), protocolVersion: negotiatedVersion });
    res.setHeader("Mcp-Session-Id", sessionId);
    return res.json({
      jsonrpc,
      id,
      result: {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "muse-meet-bridge", version: "1.1.0" },
      },
    });
  }

  // Echo Mcp-Session-Id on subsequent calls if provided
  if (sessionId) {
    res.setHeader("Mcp-Session-Id", sessionId);
  }

  // JSON-RPC notifications (no id) -> 202 Accepted
  if (method === "notifications/initialized" || method === "notifications/cancelled" || id === undefined) {
    return res.status(202).end();
  }

  if (method === "ping") {
    return res.json({ jsonrpc, id, result: {} });
  }

  if (method === "tools/list") {
    return res.json({
      jsonrpc,
      id,
      result: { tools: MCP_TOOLS },
    });
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const args = params.arguments || {};
    try {
      let textResult = "";

      if (toolName === "get_meeting_updates") {
        textResult = JSON.stringify(getUpdatesSince(args.since_event_id), null, 2);
      } else if (toolName === "wait_for_question") {
        const since = Number(args.since_event_id) || 0;
        const timeoutSec = Math.min(35, Math.max(5, Number(args.timeout_seconds) || 25));

        // If an unanswered question newer than `since` already exists, return immediately!
        const initial = getUpdatesSince(since);
        if (initial.new_questions.length > 0) {
          textResult = JSON.stringify({ woke_early: true, ...initial }, null, 2);
        } else {
          await new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              questionWaiters.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, timeoutSec * 1000);
            questionWaiters.add(finish);
            req.on("close", finish);
          });
          const after = getUpdatesSince(since);
          textResult = JSON.stringify(
            { woke_early: after.new_questions.length > 0, ...after },
            null,
            2
          );
        }
      } else if (toolName === "get_live_transcript") {
        const list =
          typeof args.last_n === "number" && args.last_n > 0
            ? state.transcript.slice(-args.last_n)
            : state.transcript;
        textResult =
          list.length === 0
            ? "No transcript captured yet."
            : list.map((t) => `[#${t.event_id} ${t.time}] ${t.speaker}: ${t.text}`).join("\n");
      } else if (toolName === "speak_in_meeting") {
        const result = await speakInMeeting(args.text, "Muse");
        textResult = result.ok
          ? `Spoke in Google Meet (${result.mode}): "${args.text}"`
          : `Failed to speak: ${result.error}`;
      } else if (toolName === "generate_meeting_notes") {
        textResult = await generateNotesText();
      } else if (toolName === "clear_meeting_session") {
        clearSession();
        textResult = "Meeting session cleared.";
      } else {
        return res.json({
          jsonrpc,
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
      }

      return res.json({
        jsonrpc,
        id,
        result: {
          content: [{ type: "text", text: textResult }],
        },
      });
    } catch (err) {
      return res.json({
        jsonrpc,
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Error: ${err.message}` }],
        },
      });
    }
  }

  return res.json({
    jsonrpc,
    id: id ?? null,
    error: { code: -32601, message: `Unsupported MCP method: ${method}` },
  });
});

server.listen(PORT, () => {
  console.log(`\n🎙️  Muse Meet Bridge running at http://localhost:${PORT}`);
  console.log(`🔌 MCP Streamable HTTP Endpoint: http://localhost:${PORT}/mcp`);
  console.log(`🔐 MCP Bearer Auth: ${BRIDGE_API_KEY ? "Enabled ✅" : "Open (set BRIDGE_API_KEY in .env to require Bearer token)"}`);
  console.log(`🔑 Gemini API Key: ${isValidKey(apiKey) ? "Configured ✅" : "Missing ⚠️  (Add GEMINI_API_KEY in .env or Console UI)"}`);
  console.log(`👂 Wake word: "${state.wakeWord}" | 🗣️  Voice: "${state.voice}"\n`);
});
