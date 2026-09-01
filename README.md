# cue

**A free, open-source AI copilot that floats invisibly over your screen — sees what you see, hears your meetings, and stays hidden from screen shares.**

A self-hosted alternative to Cluely for **Windows**. Bring your own AI key — OpenAI · Anthropic · Google Gemini · Azure · Groq · Ollama · and any OpenAI-compatible endpoint.

<img src="docs/tutorial.png" width="620" alt="cue first-run tutorial" />

---

> [!IMPORTANT]
> **Please read this first.** cue tries to stay out of screen recordings and screen shares, but this is **best-effort, not guaranteed** — on Windows 10 builds older than 2004 it degrades to a black box instead of true exclusion, and a phone camera pointed at your screen will always see it. Using a hidden assistant during a **proctored exam, a recorded meeting, or any session where the rules prohibit outside assistance** may violate that platform's terms and, in some places, consent laws. cue is built for legitimate uses — personal study, interview practice, accessibility, and real-time coaching on content you already own. **You are responsible for how you use it.**

---

## Features

- **Screen-aware** — takes a screenshot only when a feature needs it; no continuous recording
- **Two-channel audio** — captures your microphone ("You") and meeting audio ("Them") separately so the AI knows who said what
- **Real-time transcription** — local whisper.cpp (private, offline) or cloud (OpenAI · Deepgram · Gemini)
- **Context-aware coaching** — detects the interview question category (behavioral, technical, motivation, compensation, situational) and tailors the answer using your resume, STAR stories, and job description
- **Invisible by default** — hidden from Zoom, Teams, Meet, and any recorder that uses WDA_EXCLUDEFROMCAPTURE (Windows 10 build 19041+)
- **No server, no accounts** — everything runs locally except the LLM/STT call to your chosen provider
- **Bring your own key** — pay only your AI provider for what you use; cue collects nothing

---

## What it does

| Feature | Trigger | Inputs |
|---|---|---|
| **Assist** | `Ctrl Enter` | Screen + recent conversation |
| **What should I say?** | Button | Meeting transcript |
| **Answer this question** | Click any transcript turn | That specific question |
| **Follow-up questions** | Button | Full conversation |
| **Recap** | Button | Full conversation |
| **Ask anything** | Type + `Enter` | Screen + conversation |
| **Solve coding problem** | `Ctrl H` | Screen only |
| **Smart** toggle | Pill in toolbar | Switches to a smarter (slower) model |

---

## Requirements

- **Windows 10 version 2004 (build 19041)** or later, or **Windows 11**
  - The "hidden from screen shares" flag (`WDA_EXCLUDEFROMCAPTURE`) requires build 19041+. Older Windows still runs cue but shows a black box in captures instead of hiding the window.
- **Microphone permission** — the only OS permission cue needs. Screenshots and meeting audio require no extra permission.
- **An API key** from at least one AI provider (see [Step 2](#step-2--add-your-ai-key-bring-your-own)).

---

## Install

### Option A — Download the installer

Go to the [**Releases**](../../releases) page and download **cue-win-x64.exe**, then run it. Per-user install, no admin rights needed.

The installer is **unsigned**, so Windows SmartScreen may show a **"Windows protected your PC" / "Unknown publisher"** warning. Click **More info → Run anyway** to proceed.

### Option B — Run from source

Requires [Node.js](https://nodejs.org) **22.12+**. No Visual Studio build tools needed — cue deliberately avoids native modules.

```bash
git clone https://github.com/thesoham2203/cue.git
cd cue
npm install
npm start
```

To build a standalone app:

```bash
npm run pack        # unpacked app   → dist/win-unpacked/cue.exe
npm run dist:win    # NSIS installer → dist/cue-win-x64.exe
```

When running from source with **Local** transcription, prepare the whisper.cpp runtime once:

```bash
npm run prepare:whisper
```

This downloads `whisper-server.exe` (~8 MB, SHA-256 verified from the pinned whisper.cpp v1.9.1 release) to `.cache/whisper-runtime/win32-x64/`. It persists across restarts.

---

## First launch — 2-minute setup

### Step 1 — Grant the microphone

cue can't hear you until Windows allows it. When you first use a listening feature you'll be prompted — click **Allow**. If no prompt appears, grant access manually:

**Settings → Privacy & security → Microphone → turn on "Microphone access" and "Let desktop apps access your microphone."**

Screenshots and meeting audio need **no permission** — they work immediately via Windows loopback capture.

### Step 2 — Add your AI key (bring your own)

Click the **···** button in the input box (or press `Ctrl ,`) to open **Settings**, pick a provider, and paste your key:

| Provider | Get a key | Notes |
|---|---|---|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | One key does chat + transcription — but for listening features the key must have **Whisper / audio** access. A restricted project key that only allows chat will 403 on transcription. |
| **Anthropic (Claude)** | [console.anthropic.com](https://console.anthropic.com) | Excellent for screen & coding help. Claude has no speech-to-text API, so add an OpenAI or Gemini key too if you want listening. |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | One key does both chat and transcription. Free-tier available. |
| **Groq** | [console.groq.com](https://console.groq.com) | Fast and free-tier friendly. Works for both chat and transcription (Whisper large-v3-turbo). |
| **Azure AI Foundry** | [ai.azure.com](https://ai.azure.com) | Paste your **endpoint** and key in Settings. Azure OpenAI: `https://<resource>.openai.azure.com/openai`. AI Foundry: `https://<host>.cognitiveservices.azure.com` (cue appends `/openai/v1` itself). Model fields = deployment names. No built-in STT — add OpenAI or Gemini for listening. |
| **Ollama** | [ollama.com](https://ollama.com) | Local LLM server. Paste `http://localhost:11434` as the "key" field. No API cost. |
| **Custom** | Your endpoint or gateway | Any OpenAI-compatible Chat Completions endpoint. |

Your key is stored **only on your computer** (`cue-data.json`) and is sent **only** to your chosen provider. cue has no server and collects nothing.

### Step 3 — Optional: transcribe locally with whisper.cpp

Open **Settings → Audio**, choose **Local**, and download a model. All 27 models from the official whisper.cpp catalog are available — multilingual, quantized, turbo, and TinyDiarize variants included.

| Model | Size | Notes |
|---|---|---|
| `large-v3-turbo` | 1.6 GB | **Recommended default** — best accuracy + speed balance |
| `large-v3` | 3.1 GB | Highest accuracy, slower |
| `large-v3-turbo-q5_k_m` | 547 MB | Quantized turbo — good accuracy, lower memory |
| `medium.en` | 769 MB | English-only, fast |
| `base.en` | 148 MB | Fast English-only, lower accuracy |
| `tiny.en` | 39 MB | Fastest, lowest accuracy |
| Multilingual variants | 74 MB – 3.1 GB | Hindi, Marathi, Bengali, Tamil, Telugu, Kannada, Gujarati, Punjabi, Malayalam, and more |

Local mode is independent from your chat provider — use local STT with any LLM. Audio never leaves your machine and is never written to disk. A local failure is always reported; audio is never silently rerouted to a cloud fallback.

### Step 4 — Optional: tailor answers to your profile

Open **Settings** and fill in the **Profile** and **Interview Prep** tabs:

| Field | What it does |
|---|---|
| **Résumé / background** | Paste your CV text. cue grounds career answers in your actual experience. |
| **Job description** | Paste the JD. cue tailors every answer to the target role. |
| **STAR stories** | 3–5 behavioral stories in plain English. cue uses these for "tell me about a time…" questions — no invented examples. |
| **Why this company** | Your genuine answer for motivation questions. |
| **Why leaving** | Your answer for "why are you leaving your current role?" |
| **Work style** | How you work, what you value — used for culture-fit and situational questions. |
| **Salary target** | e.g. `$150k–$180k base + equity`. Shown when compensation questions come up. |
| **Questions to ask** | Your prepared interviewer questions. Surfaced when "Do you have any questions?" is detected. |
| **AI style rules** | Optional: tell the AI how to write — "no em-dashes", "use bullet points", "casual tone". Applied to all modes except LeetCode. |

> [!TIP]
> You and the interviewer's words are **both** captured. Your own words ("You" channel) give the AI context about answers you've already given — so it won't repeat them, can reference what you said, and can build coherent multi-turn follow-ups. Both channels feed the conversation history sent to the LLM.

### Step 5 — The Zoom setting (only needed for Zoom)

cue hides itself from most screen-share tools automatically — **Google Meet, Microsoft Teams, and QuickTime need nothing.** Zoom needs one setting:

> **Zoom → Settings → Share Screen → Advanced → Screen capture mode → "Advanced capture with window filtering"**

<div align="center"><img src="docs/zoom-setting.png" width="560" alt="Zoom screen capture mode setting" /></div>

---

## Using cue

| Action | How |
|---|---|
| **Assist** (do the smart thing) | `Ctrl Enter` |
| **Solve coding problem** | `Ctrl H` |
| **Start / stop listening** | The ▢ button in the top bar (green dot = live) |
| **Ask a question** | Type in the box + `Enter` |
| **Answer a specific question** | Click any "Them" turn in the transcript |
| **Smart mode** | Toggle the **Smart** pill for a more thorough model |
| **Hide** | Collapse to top bar only — drag by the top pill |
| **Quit** | `Ctrl Shift X` |

The panel is transparent and click-through — blank space around it never blocks the app behind it.

---

## How it works

cue is an [Electron](https://www.electronjs.org/) app. Everything runs locally except the AI provider call.

**Three inputs, kept completely separate:**

- **Screen** — captured with Electron's `desktopCapturer` (full-resolution screenshots, taken only when a feature needs one, never continuously recorded)
- **Microphone ("You")** — `getUserMedia` → downsampled to 16 kHz PCM → voice-activity detected → transcribed
- **Meeting audio ("Them")** — `getDisplayMedia` system-audio loopback → same pipeline, separate channel

Both audio streams run through an adaptive energy-based VAD (voice activity detection) that segments speech into utterances with a 300 ms pre-roll buffer so the first word is never cut off. Utterances are passed to the selected transcription backend: a persistent `whisper-server.exe` child process for local mode, or a cloud STT API for cloud mode.

The full conversation (both "You" and "Them" turns) is fed to the LLM as context. cue detects the current question category — behavioral, technical, situational, motivation, compensation — and automatically injects the right subset of your profile: STAR stories for behavioral, resume skills for technical, salary target for compensation, etc.

**Invisibility** is a single Windows API call — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — which tells the OS compositor to exclude the window from every screen capture path. The window title is also set to `"Microsoft Edge Update"` when protection is active, making it indistinguishable from a background Windows process in task lists.

```
main process ───┬── overlay window (frameless, transparent, always-on-top, content-protected)
                ├── screenshot capture (desktopCapturer)
                ├── speech-to-text (Whisper / Gemini / Deepgram / Groq)  ── "You" + "Them" channels
                └── LLM streaming (OpenAI / Anthropic / Gemini / Azure / Groq / Ollama / Custom)
renderer ───────┴── glass UI + mic capture (getUserMedia) + system-audio loopback (getDisplayMedia)
```

---

## Troubleshooting

**The whisper runtime shows "Not prepared" even after running `npm run prepare:whisper`.**
This was a bug in dev mode where Electron's `app.isPackaged` incorrectly returned `true`, causing cue to look in the wrong directory. It is now fixed — the runtime is always found at `.cache/whisper-runtime/` regardless of how cue is launched. Pull the latest changes and restart.

**Local transcription says the model is missing.**
Open **Settings → Audio**, select the model, and click **Download**. A cancelled download can be resumed. If verification fails repeatedly, delete the model from the same screen and re-download.

**A large local model is slow or runs out of memory.**
Try `base.en`, `tiny.en`, or a quantized `q5` / `q8` model. Model size shown in Settings is the download size — runtime RAM use is higher.

**cue has no taskbar icon — how do I quit?**
Press **Ctrl Shift X**. If the shortcut didn't register, end the `cue` or `electron` process in Task Manager.

**`npm start` crashes with `Cannot read properties of undefined (reading 'getPath')`.**
Something in your environment has set `ELECTRON_RUN_AS_NODE=1` — VS Code's integrated terminal sometimes does this. That flag makes Electron boot as plain Node, so `require('electron')` returns a path string instead of the real module. Clear it:
```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```
Then relaunch from that terminal.

**A feature returns "403" / "no access to model".**
Your API key is restricted. Most commonly an OpenAI **project key that only allows chat models** — it works for screen/coding help but 403s on transcription (Whisper). Fix: enable audio/Whisper access on the key, use an unrestricted key, or add a Gemini key (used as the transcription fallback).

**Listening does nothing / no transcript appears.**
- Check that Settings shows a transcription-capable key (OpenAI with Whisper enabled, Groq, or Gemini).
- Make sure **"Let desktop apps access your microphone"** is on — the top-level Microphone toggle alone is not enough.
- If using Local mode, make sure the model is downloaded (Settings → Audio).

**A Custom provider request cannot connect.**
Confirm the Base URL includes the endpoint's `/v1` path where required, the selected model ID exists on that endpoint, and the local gateway is running.

**cue shows up in my Zoom share.**
Set Zoom's **Screen capture mode** to **"Advanced capture with window filtering"** (see Step 5 above).

**The microphone loopback warning appeared.**
If the captured meeting audio consists of all-silent or all-identical samples (which indicates a digital loopback of your own microphone through the speakers rather than actual meeting audio), cue shows a one-time warning. Re-enable "Share audio" in the screen-share bar to restore the "Them" channel.

---

## Privacy

- No cue accounts, hosted service, or telemetry. **cue collects nothing.**
- API keys live only in `cue-data.json` on your machine and are sent only to the provider you chose.
- Profile data (résumé, job description, STAR stories) lives in `cue-data.json` and is sent with each LLM request to your selected AI provider.
- In Local transcription mode, all audio stays on your computer. In cloud transcription modes, audio utterances are sent only to the selected STT provider.
- Audio utterances and the transcript are kept in memory during a session. cue does not write captured audio to disk.
- Screenshots are sent to your chat provider only when a feature explicitly needs the screen.

---

## Development

```bash
npm test         # run all tests (node:test)
npm run lint     # ESLint
npm run pack     # build unpacked app → dist/win-unpacked/
npm run dist:win # build NSIS installer → dist/
CUE_NO_PROTECT=1 npm start  # dev mode: overlay is visible in screen captures
```

cue is intentionally small and readable:
- `main.js` — Electron main process: window, IPC, capture orchestration, LLM runner
- `renderer/` — the glass UI (HTML/CSS/JS, no framework, no build step)
- `src/` — modular Node.js: LLM factory, STT factory, VAD, utterance segmenter, whisper session, store

Tests live in `test/` and use Node's built-in `node:test` runner — no external test framework.

Issues and PRs welcome.

---

## Credits & license

Built as an open-source study of how tools like **Cluely** and **Interview Coder** work. Inspired by open-source clones [pickle-com/glass](https://github.com/pickle-com/glass) and [sohzm/cheating-daddy](https://github.com/sohzm/cheating-daddy).

Local transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), distributed under the MIT License. Its license notice is included in packaged runtimes.

**License: [GPL-3.0-or-later](LICENSE)**
