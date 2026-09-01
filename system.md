# Cue — System Documentation

> **Purpose:** This file documents every architecturally significant decision, every module's role, and the end-to-end flow of audio and data through the application. It is the authoritative reference for understanding *why* the code is structured the way it is.

---

## 1. What Cue Is

Cue is a **Windows desktop overlay application** for interview preparation. It sits on top of any app (including video conferencing tools) and helps users practice and get real-time feedback on their interview performance.

**Core capabilities:**
- **Screen capture** — captures the current screen or a selected window to feed to the LLM for context-aware questions
- **Audio capture** — captures microphone (you) and system audio (interviewer/them) separately
- **Real-time transcription** — converts both audio channels to text using local whisper.cpp or cloud STT providers (OpenAI Whisper, Deepgram, Gemini)
- **LLM-powered coaching** — asks the configured LLM (OpenAI, Gemini, Anthropic, Azure OpenAI, or any OpenAI-compatible endpoint) to generate interview questions, evaluate answers, explain concepts, or watch a LeetCode problem and comment on approach

**Target user:** anyone preparing for interviews — the app is designed to give everyone an equal chance by removing friction and providing instant, judgment-free feedback.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Framework | Electron 33.2.1 |
| Runtime | Node.js >= 22.12.0 (CommonJS, `require`/`module.exports`) |
| Local STT | whisper.cpp v1.9.1 via a custom HTTP sidecar (`whisper-server.exe`) |
| Cloud STT | OpenAI Whisper API, Deepgram, Google Gemini |
| Streaming STT | OpenAI Realtime API (WebSocket) or Deepgram Nova-2 streaming |
| VAD | Custom energy-based `AdaptiveVAD` (main process) + `@ricky0123/vad-web` Silero VAD (renderer, browser-side) |
| Build | electron-builder (NSIS installer on Windows) |
| Tests | Node's built-in `node:test` + `node:assert/strict` |

---

## 3. Architecture Overview

```
renderer/                  Browser UI (HTML/CSS/JS)
  index.html               Settings UI, overlay controls
  renderer.js              UI logic, audio capture (getUserMedia/getDisplayMedia)
  styles.css               Overlay styling

preload.js                 contextBridge — exposes safe IPC APIs to renderer

main.js                    Electron main process — window, IPC handlers,
                          capture orchestration, LLM feature runner

src/
  vad.js                   AdaptiveVAD (energy-based, runs in main process)
  utterance-segmenter.js   Bounds PCM audio into utterance chunks using VAD
  local-whisper-transcriber.js   Local whisper.cpp transcription pipeline
  whisper-runtime.js       Locates whisper-server.exe on disk
  whisper-model-manager.js Downloads/verifies/deletes ggml model files
  whisper-model-catalog.js Defines all 27 available whisper.cpp models
  whisper-server-session.js Manages the whisper-server.exe child process
  cloud-batch-transcriber.js Cloud STT pipeline (Deepgram/OpenAI/Gemini)
  stt.js                   Cloud STT factory (non-streaming)
  stt-streaming.js         OpenAI Realtime API / Deepgram streaming STT
  wav.js                   PCM → WAV conversion utility
  llm.js                   LLM factory (OpenAI/Gemini/Anthropic/Azure/OpenAI-compatible)
  prompts.js               Mode definitions (ask, answerThis, leetcode, etc.)
  interview-context.js     Builds LLM prompt context from transcript
  resume.js                PDF resume text extraction
  profile-context.js       Job description / resume storage
  screen.js                Desktop screenshot capture via Electron
  shortcuts.js             Global shortcut registration
  store.js                 Persistent settings (electron-store)
  applink-state.js         AppLink state machine
  applink.js               AppLink protocol (out-of-process consent flow)
```

---

## 4. Core Design Decisions

### 4.1 Windows-Only, Toolbar Window

Cue is Windows-only by design. On Windows, the BrowserWindow is created with `type: 'toolbar'`, which sets `WS_EX_TOOLWINDOW`. This removes the window from **Alt+Tab** and the **taskbar** while keeping it visible as an overlay. This is critical: users do not want the overlay itself to appear in screen shares.

The tradeoff is that `type: 'toolbar'` is Windows-specific, which is why `isWindows` guards are spread throughout the codebase.

### 4.2 Screen-Share Invisibility via `setContentProtection`

When `WDA_EXCLUDEFROMCAPTURE` is active (set by `win.setContentProtection(true)`), Windows tells the desktop compositor to exclude this window from screen capture. This makes the overlay invisible in Zoom/Teams/Meet screen shares.

**Limitation:** `WDA_EXCLUDEFROMCAPTURE` requires **Windows 10 build 19041+** (May 2020 Update). The app detects the Windows build number at startup and skips the call silently on older builds, notifying the renderer so it can warn the user.

`CUE_NO_PROTECT=1` environment variable disables this feature intentionally, so the overlay is visible during development.

### 4.3 Same-Title Trick

Most screen-share apps hide windows based on their title. Cue's window title is set to `"Microsoft Edge Update"` when content protection is active, making it indistinguishable from a real Edge Update background process in a screen share. This is reverted to `"cue"` when `CUE_NO_PROTECT=1`.

### 4.4 Audio Capture: Renderer-Side, Not Main-Process

Microphone and system audio loopback are captured inside the **renderer process** using `getUserMedia` (mic) and `getDisplayMedia` with `{ selfBrowserSurface: 'include' }` (system audio). This is deliberate — these browser APIs only run in the renderer. The captured PCM is then sent to the main process via IPC for transcription.

The implication is that the renderer must be trusted for audio capture. This is acceptable because the renderer is a local HTML file (`file://` protocol), not remote content.

### 4.5 Two-Channel Audio Architecture

Cue captures **two separate audio channels:**
- **`you`** — microphone audio (the user)
- **`them`** — system audio loopback (the interviewer's questions)

This separation is critical because:
1. The two channels have different VAD tuning (different onset/offset thresholds and silence-frame counts)
2. The LLM needs to know who said what
3. Each channel gets its own VAD instance in the main process

### 4.6 Local whisper.cpp vs. Cloud STT

Cue supports two transcription backends:

**Local (whisper.cpp):**
- Runs `whisper-server.exe` as a **child process** HTTP server on a random localhost port
- Main process sends WAV audio via HTTP POST, receives text
- No API key required, works offline
- Model downloaded to `%APPDATA%/cue/whisper-models/`
- Runtime (the `whisper-server.exe` binary) downloaded to `%LOCALAPPDATA%/cue/cache/whisper-runtime/`
- Supports 27 models: `base.en`, `small.en`, `medium.en`, `large-v3-turbo` (default), `large-v3-turbo-q5_k_m`, and multilingual variants including large-v3, distil-large-v2, etc.

**Cloud STT (Deepgram / OpenAI / Gemini):**
- Requires an API key configured in Settings
- `createSTT()` factory picks the first available provider
- Supports both **batch** (utterance-segmented) and **streaming** (WebSocket) modes
- Streaming mode uses OpenAI Realtime API (`gpt-realtime-whisper`) or Deepgram Nova-2

**Decision:** Default is cloud STT (`'auto'`). User can switch to `'local'` in Settings.

### 4.7 Default Model: `large-v3-turbo`

The default whisper model was changed from `base.en` to `large-v3-turbo` in Session 3. This model is:
- Multilingual (not English-only)
- Significantly more accurate than `base.en` or `small.en`
- Fast enough for real-time use on modern hardware
- Default in: `whisper-model-catalog.js`, `store.js`, and `renderer.js` fallback references

### 4.8 VAD Pipeline

```
Microphone PCM (16kHz, 16-bit mono)
    │
    ▼
main.js: vad[you].processChunk(pcm)    ←── AdaptiveVAD (energy-based)
main.js: vad[them].processChunk(pcm)   ←── AdaptiveVAD (energy-based)
    │
    ▼ (speech onset → speech end events)
AdaptiveVAD → onSpeechStart() / onSpeechEnd()
    │
    ▼
UtteranceSegmenter._beginUtterance()
    │  Captures pre-roll audio (up to 300ms before speech onset)
    │  from the AudioRingBuffer
    │
    ▼ (speech end → _finalizeUtterance)
Buffer.concat(utteranceChunks)
    │
    ▼
onUtterance(channel, pcm, startTs)     ←── startTs = VAD speech-onset timestamp
    │
    ├─→ LocalWhisperTranscriber._enqueue()
    │       whisper-server.exe (HTTP POST)
    │
    └─→ CloudBatchTranscriber._onUtterance()
            createSTT() → OpenAI/Deepgram/Gemini batch API
```

**Key design decisions in the VAD:**
- **Energy-based, not ML-based (main process):** The `AdaptiveVAD` in `vad.js` uses RMS energy thresholds with hysteresis. It is lightweight and deterministic, running synchronously on every PCM chunk. It does not require a separate ML model.
- **Adaptive thresholds:** The noise floor is continuously estimated during silence and used to adjust onset/offset thresholds dynamically (`dynamicOnset = max(onsetThreshold, noiseFloor * 2.5)`). This makes the VAD robust to different microphone environments.
- **Separate VAD per channel:** The `you` channel uses onset=220, offset=130, silenceFrames=18. The `them` channel uses onset=200, offset=120, silenceFrames=20. The `them` channel is more sensitive because remote audio is typically quieter and needs more forgiveness for ambient noise.
- **Pre-roll buffer:** `AudioRingBuffer` (300ms) captures audio before the speech onset is detected, so the first word is never cut off. The pre-roll is read and prepended when the utterance begins.
- **Long-speech split:** Utterances exceeding 25 seconds are split at the boundary with 300ms overlap, preventing very long utterances from timing out the STT provider.

### 4.9 Speech-Onset Timestamp Capture

The speech-onset timestamp is captured at two places:

1. **VAD:** `AdaptiveVAD._speechStartTime = Date.now()` set when energy first crosses the onset threshold (line ~87 in `vad.js`)
2. **UtteranceSegmenter:** `this._utteranceStartTs = this.vad.getSpeechStartTime()` captured at `_beginUtterance()` (line ~83 in `utterance-segmenter.js`) — this is done **before** the ring buffer is cleared, ensuring the timestamp corresponds to the actual start of speech, not the time the segmenter decided to start collecting

The timestamp is passed as `startTs` through `_emit(pcm, startTs)` and eventually to `publishTranscript(channel, text, startTs)` where it becomes `turn.ts` in the transcript array.

**Limitation:** The streaming STT path (stt-streaming.js) does **not** receive VAD timestamps. When using OpenAI Realtime API or Deepgram streaming, the `turn.ts` is set to `Date.now()` at the time the transcript is received, not the actual time the user started speaking. This is a known limitation of the streaming STT architecture — the VAD in the main process is not connected to the streaming STT pipeline.

### 4.10 Transcript Management

- Transcript is an in-memory array of `{ channel, text, ts }` objects
- Capped at `MAX_TRANSCRIPT_TURNS = 200` (approximately 30–40 minutes of conversation)
- When capped, older turns are **dropped** and passed to `summarizeDroppedTurns()`
- `summarizeDroppedTurns()` creates a brief string like `"[Earlier: 3 you turns; 5 interviewer questions about X, Y, Z]"` that is prepended to the LLM context block via `buildInterviewContext`
- This allows the LLM to have awareness of dropped conversation without sending the full text

### 4.11 Loopback Audio Detection

System audio loopback (`getDisplayMedia` with loopback) can sometimes capture the wrong audio source — for example, picking up the user's own microphone through the speakers instead of the interviewer's voice.

`checkLoopback()` in `renderer.js` detects a specific audio pattern (any segment of 15+ consecutive identical Int16 samples, which is impossible in real audio) as a proxy for "this is a digital loopback of silence or near-silence." If detected, `cue.loopbackWarning()` is called, which sends an IPC message to main process and eventually shows a warning in the UI. This is called once per capture session.

### 4.12 Settings Storage

Settings are stored via `electron-store` in `%APPDATA%/cue/config.json`. Key settings:
- `modelId` — selected whisper model (default: `large-v3-turbo`)
- `sttProvider` — `'auto'`, `'local'`, `'openai'`, `'deepgram'`, `'gemini'`
- `provider` / `apiKey` — LLM provider and key
- `shortcuts` — global shortcut bindings
- `windowX`, `windowY` — last window position

---

## 5. Module-by-Module Decisions

### `src/whisper-runtime.js` — Runtime Discovery Bug Fix

**Problem:** Running `npm start` (which uses `npx electron`) sets `app.isPackaged = true`. The original `locateWhisperRuntime()` only checked the `.cache` fallback path when `!isPackaged`:

```javascript
// BROKEN — skip cache when isPackaged is true
if (!isPackaged && appPath) {
  candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
}
```

Since `isPackaged` was always `true` in dev mode, `.cache` was never checked, and the whisper runtime was not found even when present at `%LOCALAPPDATA%/cue/cache/whisper-runtime/`.

**Fix:** Always check `.cache` as a fallback regardless of `isPackaged`:

```javascript
// Always check .cache as a fallback — this covers dev mode (where isPackaged is
// incorrectly true) and the standard non-packaged development path.
if (appPath) {
  candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
}
```

### `src/store.js` — Default Model

Default `modelId` was changed from `'base.en'` to `'large-v3-turbo'` to match the catalog default.

### `renderer/renderer.js` — Fallback Defaults

Three fallback references to `'base.en'` (used when `settings.localWhisper` is undefined) were updated to `'large-v3-turbo'` at lines 1550, 1749, 1768, and 1870.

### `src/vad.js` — `_speechStartTime` and `getSpeechStartTime()`

Added `_speechStartTime` field and `getSpeechStartTime()` method to support timestamp capture. Reset clears `_speechStartTime`.

### `src/utterance-segmenter.js` — Timestamp Propagation

`_utteranceStartTs` field captures `this.vad.getSpeechStartTime()` at the moment `_beginUtterance()` is called. This value is passed through `_appendChunk()` (for 25-second splits) and `_emit()` to `onUtterance(channel, pcm, startTs)`.

The `_finalizeUtterance()` method does **not** pass a timestamp (called without `startTs`), which is acceptable because the utterance already has its `startTs` from `_beginUtterance()`.

### `src/local-whisper-transcriber.js` — Signature Change

`onUtterance` callback signature changed from `(channel, pcm)` to `(channel, pcm, startTs)` to carry the speech-onset timestamp through to `publishTranscript`.

### `src/cloud-batch-transcriber.js` — Same Pattern

Same `(channel, pcm, startTs)` signature change as local-whisper-transcriber.

### `src/interview-context.js` — Dropped Turns Parameter

`buildInterviewContext()` gained a 4th parameter `conversationSummary` (the output of `summarizeDroppedTurns()`). When non-empty, it is prepended to the "Recent conversation" block as context for the LLM.

### `main.js` — `publishTranscript` and `summarizeDroppedTurns`

- `publishTranscript` uses `startTs || Date.now()` so speech-onset timestamps are preserved when available
- `summarizeDroppedTurns()` creates a human-readable summary of trimmed transcript turns
- `buildInterviewContext` is called with 4 arguments (previously 3)
- `loopback:warning` IPC handler added
- STT cooldown mechanism: `sttDisabled` flag with 60-second cooldown before retry

### `preload.js` — Loopback Warning IPC

Added `loopbackWarning: () => ipcRenderer.send('loopback:warning')` to expose the loopback detection signal to the renderer.

### `renderer/index.html` — Indian Language Support

Added 9 Indian language options to the whisper-language dropdown: Hindi (hi), Marathi (mr), Bengali (bn), Tamil (ta), Telugu (te), Kannada (kn), Gujarati (gu), Punjabi (pa), Malayalam (ml). This enables users to conduct interviews in their native language.

---

## 6. Known Limitations

### 6.1 Streaming STT Lacks VAD Timestamps

When using OpenAI Realtime API or Deepgram streaming, `turn.ts` is set to `Date.now()` at the time the transcript text is received from the WebSocket, not the actual speech-onset timestamp from the VAD. This is because the streaming STT path (`stt-streaming.js`) receives raw audio directly from the renderer via `streamingSTT[channel].sendAudio(pcmBuffer)` in `routeAudio()`, bypassing the utterance segmentation pipeline that captures `startTs`.

The VAD in the main process (`vad[channel]`) drives the speaking indicator in streaming mode but is not connected to the streaming STT's timestamp logic.

### 6.2 Pre-Existing Test Failure

`test/applink.test.js` has one pre-existing failure related to socket leak (not addressed — `state.server` is not closed in the test). This was present before any modifications.

**123/124 tests pass** as of the current state.

### 6.3 `app.isPackaged` in Dev Mode

`npx electron` (which the app uses for `npm start`) sets `app.isPackaged = true` even in development mode. This is a known Electron behavior and is the reason `whisper-runtime.js` now always checks the `.cache` directory regardless of the `isPackaged` flag.

### 6.4 Windows Only

The application is Windows-only. `isWindows` guards exist throughout, and the `type: 'toolbar'` window option only works on Windows.

---

## 7. Build and Run Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies + run Electron rename postinstall step |
| `npm start` | Launch the app with Electron for local development |
| `npm test` | Run `node:test` over `test/*.test.js` |
| `npm run lint` | Run ESLint over the repository |
| `npm run pack` | Create unpacked local build in `dist/win-unpacked/` |
| `npm run dist:win` | Build the Windows NSIS installer |
| `npm run prepare:whisper` | Download the pinned local whisper runtime when needed |

**Note:** Use `CUE_NO_PROTECT=1 npm start` during development so the overlay is visible in screen captures.

---

## 8. Future Work

The user has explicitly stated there are **no future plans** — the priority is to get all basic functions working flawlessly first. Known items to address eventually:

1. **Fix streaming STT timestamp gap** — connect the VAD's speech-onset timestamp to the streaming STT path so `turn.ts` reflects actual speech onset, not transcript arrival time
2. **Fix `applink.test.js` socket leak** — close `state.server` after each test
3. **Verify all 27 whisper models** download and work correctly with the current runtime
4. **Comprehensive E2E testing** of the capture → transcription → LLM flow

---

## 9. File Map

| File | Role |
|---|---|
| `main.js` | Electron main process: window, IPC, capture orchestration, LLM runner |
| `preload.js` | `contextBridge` API surface for renderer |
| `renderer/index.html` | Settings UI HTML |
| `renderer/renderer.js` | UI logic, audio capture, loopback detection |
| `renderer/styles.css` | Overlay visual styles |
| `src/vad.js` | `AdaptiveVAD` (energy-based VAD) + `AudioRingBuffer` |
| `src/utterance-segmenter.js` | `UtteranceSegmenter` — bounds PCM into utterances |
| `src/local-whisper-transcriber.js` | Local whisper.cpp pipeline |
| `src/whisper-runtime.js` | Locates `whisper-server.exe` |
| `src/whisper-model-manager.js` | Model download/verify/delete/import |
| `src/whisper-model-catalog.js` | 27-model catalog with hashes |
| `src/whisper-server-session.js` | Child process management for whisper-server.exe |
| `src/cloud-batch-transcriber.js` | Cloud STT (Deepgram/OpenAI/Gemini) batch pipeline |
| `src/stt.js` | Cloud STT factory (non-streaming) |
| `src/stt-streaming.js` | OpenAI Realtime API / Deepgram streaming |
| `src/wav.js` | PCM → WAV conversion |
| `src/llm.js` | LLM factory (all providers) |
| `src/prompts.js` | Mode definitions and prompt builders |
| `src/interview-context.js` | LLM context builder from transcript |
| `src/resume.js` | PDF resume text extraction |
| `src/profile-context.js` | Job description / resume settings |
| `src/screen.js` | Screenshot capture |
| `src/shortcuts.js` | Global shortcut registration |
| `src/store.js` | Persistent settings (electron-store) |
| `src/applink.js` / `src/applink-state.js` | AppLink out-of-process consent |
| `vendor/app-link/` | Vendored AppLink protocol library |
