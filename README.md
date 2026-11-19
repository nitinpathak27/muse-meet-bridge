# 🎙️ Muse Meet Bridge — Ears & Voice for Muse.ai in Google Meet

A lightweight, ultra-low-cost bridge (powered by **Gemini 2.5 Flash** + **Gemini TTS**) that gives **Muse.ai** (or any browser AI agent like Claude/ChatGPT) live **ears**, a **voice**, and **meeting note-taking** inside Google Meet.

---

## How It Works

1. **Ears (Meet → Muse):** The Chrome Extension captures live audio from your Google Meet tab (skipping silence to save cost) and transcribes it in real time with **Gemini 2.5 Flash**. Whenever someone says *"Muse..."*, the question is highlighted in the **Latest Question for Muse** box.
2. **Voice (Muse → Meet):** Muse opens the **Muse Console** (`http://localhost:3456`) in its browser, reads the live transcript/question, types its reply, and clicks **Speak in Google Meet**. Gemini TTS speaks it out loud — routed directly into Google Meet's microphone via a free virtual audio cable (VB-Cable).
3. **Notes:** Click **Generate Notes** (or let Muse click it) to turn the full transcript into structured Markdown notes, decisions, and action items.

---

## 1. Quick Start

1. Open `.env` and paste your Gemini API key (from [Google AI Studio](https://aistudio.google.com/apikey)):
   ```env
   GEMINI_API_KEY=your_actual_key_here
   ```
2. Install dependencies and start the bridge:
   ```bash
   npm install
   npm start
   ```
3. Open **http://localhost:3456** in Chrome.
   - You can immediately click **🎤 Test Local Mic** and say *"Hey Muse, can you hear me?"* to test transcription, wake-word detection, voice output, and notes without even joining a Google Meet!

---

## 2. Load the Chrome Extension (for Google Meet Audio)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension` folder inside this project.
4. Join your Google Meet call, click the **Muse Meet Bridge** extension icon, and click **▶ Start Listening to This Tab**.

---

## 3. Connect Muse.ai to the Console

Because Muse has no webhook/API and works directly in a browser, you have two easy ways to connect it:

- **Option A — Muse Chrome Extension (Easiest):**
  Open `http://localhost:3456` in a Chrome tab and open the Muse Chrome Extension side panel. Tell Muse:
  > *"Watch this Muse Meet Bridge tab. Whenever a new question appears in 'Latest Question for Muse', type a concise spoken reply into the Muse Reply Input and click 'Speak in Google Meet'. After the meeting, click 'Generate Notes' and save/send the notes."*

- **Option B — Muse Cloud Browser (`muse.ai`):**
  Expose your local console temporarily with a free Cloudflare quick tunnel:
  ```bash
  npx cloudflared tunnel --url http://localhost:3456
  ```
  Give Muse the generated `https://....trycloudflare.com` URL and it can read/speak in your live Google Meet from its cloud browser!

---

## 4. Let People in Google Meet Hear Muse's Voice (Windows)

By default, Muse's voice plays through your speakers. To pipe Muse's voice cleanly into Google Meet as a microphone:

1. Install free **VB-Cable** ([vb-audio.com/Cable](https://vb-audio.com/Cable/)) and reboot.
2. In the **Muse Meet Console** (`http://localhost:3456`), click 🔄 next to **Output Audio To** and select **CABLE Input (VB-Audio Virtual Cable)**.
3. In **Google Meet** → Settings → Audio → Microphone, select **CABLE Output (VB-Audio Virtual Cable)** (or join from a second Chrome profile using CABLE Output as its mic so your own mic stays free!).

---

## Optional: Instant Auto-Reply Mode

If you want instant replies without waiting for Muse to click in the browser, enable **"Auto-Reply with Gemini"** in the Console Settings.
