const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');

// -------- global exception handlers (must be registered before anything else) --------
process.on('uncaughtException', (err) => {
  console.error('[cue] uncaughtException:', err && err.message ? err.message : String(err));
  recordEvent({ level: 'fatal', event: 'uncaught_exception', msg: err && err.message ? err.message : String(err), stack: err && err.stack || null });
  // Give the logger a moment to flush before exiting
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  console.error('[cue] unhandledRejection:', reason && (reason.message || reason.reason) ? (reason.message || reason.reason) : String(reason));
  recordEvent({ level: 'error', event: 'unhandled_rejection', msg: reason && (reason.message || reason.reason) ? (reason.message || reason.reason) : String(reason) });
});

const { resolveShortcuts } = require('./src/shortcuts');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');
const { CloudBatchTranscriber } = require('./src/cloud-batch-transcriber');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, hide: false, quit: false };
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// -------- sttDisabled recovery --------
// sttDisabled is permanently set after a 403/429/401 so the API is not hammered.
// After STT_COOLDOWN_MS, allow one retry — if it fails again, re-disable.
const STT_COOLDOWN_MS = 60_000; // 1 minute
let _sttDisabledAt = 0; // 0 means not disabled

const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
let conversationSummary = ''; // summarized dropped (trimmed) turns for LLM reference
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
let whisperModelManager = null;
let localWhisperTranscriber = null;
let cloudBatchTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)

function isSttDisabled() {
  if (!sttDisabled) return false;
  if (_sttDisabledAt === 0) _sttDisabledAt = Date.now();
  // Allow one retry after cooldown
  if (Date.now() - _sttDisabledAt >= STT_COOLDOWN_MS) {
    sttDisabled = false;
    _sttDisabledAt = 0;
    return false;
  }
  return true;
}

let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};

function pushTranscript(turn) {
  transcript.push(turn);
  // Trim excess immediately so transcript.length never exceeds MAX_TRANSCRIPT_TURNS.
  if (transcript.length > MAX_TRANSCRIPT_TURNS) {
    const dropped = transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
    conversationSummary = summarizeDroppedTurns(dropped);
  }
}

/**
 * Summarizes dropped (trimmed) turns for LLM reference when later context is needed.
 * Returns a brief string like "[Earlier: 3 you turns, 5 interviewer questions about X, Y, Z]"
 * or an empty string if there are no dropped turns.
 */
function summarizeDroppedTurns(drops) {
  if (!drops || drops.length === 0) return '';
  const you = drops.filter(t => t.channel === 'you');
  const them = drops.filter(t => t.channel === 'them');
  const parts = [];
  if (you.length > 0) parts.push(`${you.length} you ${you.length === 1 ? 'turn' : 'turns'}`);
  if (them.length > 0) {
    // Sample a few distinct topics from 'them' to give the LLM orientation.
    const sample = them.slice(0, 5).map(t => t.text).filter(Boolean);
    const topicHint = sample.length > 0 ? `: ${sample.join(', ')}` : '';
    parts.push(`${them.length} interviewer ${them.length === 1 ? 'question' : 'questions'}${topicHint}`);
  }
  return `[Earlier: ${parts.join('; ')}]`;
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text, startTs) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: startTs || Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'large-v3-turbo');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        _sttDisabledAt = Date.now(); // start cooldown so isSttDisabled() can recover
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    // Find the display that contains the saved position (handles multi-monitor setups).
    // Falls back to primary display if the saved position doesn't land on any display.
    const allDisplays = screen.getAllDisplays();
    const targetDisplay = allDisplays.find((d) => {
      const b = d.workArea;
      return savedSettings.windowX >= b.x && savedSettings.windowX < b.x + b.width &&
             savedSettings.windowY >= b.y && savedSettings.windowY < b.y + b.height;
    }) || screen.getPrimaryDisplay();
    const area = targetDisplay.workArea;
    const clampedX = Math.max(area.x - W + 100, Math.min(savedSettings.windowX, area.x + area.width - 100));
    const clampedY = Math.max(area.y, Math.min(savedSettings.windowY, area.y + area.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: type:'toolbar' sets WS_EX_TOOLWINDOW, which removes the window from
  // Alt+Tab AND the taskbar entirely.
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  const shouldProtect = !process.env.CUE_NO_PROTECT;
  if (shouldProtect) {
    if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  // Apply the same-title trick only when content protection is active.
  // When CUE_NO_PROTECT=1 the overlay is intentionally visible, so use the real name.
  const appTitle = (shouldProtect && WIN_SUPPORTS_CONTENT_PROTECTION) ? 'Microsoft Edge Update' : 'cue';
  win.setTitle(appTitle); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle(appTitle);
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- cloud batch STT (used when streaming is unavailable) --------
// Feeds speech-aligned utterances (via UtteranceSegmenter, inside CloudBatchTranscriber)
// to the createSTT chain rather than blind 900 ms wall-clock fragments. The chain is
// built once per capture so its quota backoff (disabledUntil) persists across
// utterances instead of resetting on every flush.
async function startCloudBatch(settings) {
  const stt = createSTT(settings);
  if (!stt.available) {
    if (!sttDisabled) {
      sttDisabled = true;
      send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' });
    }
    return;
  }
  cloudBatchTranscriber = new CloudBatchTranscriber({
    stt,
    onTranscript: publishTranscript,
    onSpeechState: (channel, speaking, durationMs) => {
      send('vad:state', { channel, speaking, durationMs });
    },
    onError: (error) => handleSttError(error, settings)
  });
  await cloudBatchTranscriber.start();
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (isSttDisabled()) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  _sttDisabledAt = Date.now();
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startCloudBatch(settings).catch((e) => console.log('[cloud-batch] start error', e && e.message));
        } else if (!isSttDisabled()) {
          sttDisabled = true;
          _sttDisabledAt = Date.now();
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  // Local and cloud-batch paths each own a segmenter with its own VAD, so they take
  // the audio before main's VAD — which would otherwise double-drive vad:state.
  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }
  if (cloudBatchTranscriber) {
    cloudBatchTranscriber.push(channel, buf);
    return;
  }

  // Streaming mode: main's VAD drives the speaking indicator and raw PCM streams to
  // the socket. If no provider is active the audio is simply dropped.
  if (streamingMode && streamingSTT[channel]) {
    vad[channel].processChunk(buf);
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else if (!localWhisperTranscriber && !cloudBatchTranscriber && !streamingMode) {
    // Log to help debug why audio is being silently dropped.
    console.log('[cue] routeAudio: no active STT provider, dropping audio on channel:', channel);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    // Reset VAD state from any previous capture session before starting a new one.
    vad.you.reset();
    vad.them.reset();
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      await startCloudBatch(settings);
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopStreamingSTT();
  vad.you.reset(); vad.them.reset();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  const stoppingCloudTranscriber = cloudBatchTranscriber;
  cloudBatchTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  if (stoppingCloudTranscriber) {
    try {
      await stoppingCloudTranscriber.stop();
    } catch (error) {
      console.log('[cloud-batch] stop error', error && error.message);
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        send('status', { message: 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.' });
      }
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, transcript, conversationSummary);
    const system = def.buildSystem ? def.buildSystem(contextBlock, settingsForPrompt.aiRules || '') : (def.system || '');
    const built = def.build({ transcript, userText: userText || '' });

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    try {
      await Promise.race([
        llm.stream({
          system,
          turns: [{ role: 'user', text: built }],
          imageDataUrl,
          onToken: (t) => { if (streamSettled) return; rearm(); send('llm:token', { text: t }); }
        }),
        stalled
      ]);
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    // Defence in depth: ensure streamSettled is always true after the outer
    // try/catch regardless of which path threw or returned.
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const next = store.setSettings(patch);
  if (patch && patch.shortcuts) reRegisterShortcuts();
  return next;
});
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('loopback:warning', () => { send('status', { message: 'System-audio loopback was disabled. Re-enable "Share audio" in the screen-share bar to continue capturing meeting audio.' }); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- shortcuts --------
// Action -> handler. Keys line up with DEFAULTS in src/shortcuts.js, which is the
// single source of truth for the accelerators (overridable via settings.shortcuts).
const SHORTCUT_HANDLERS = {
  assist: () => runFeature('assist', ''),
  say: () => runFeature('say', ''),
  leetcode: () => runFeature('leetcode', ''),
  hide: () => send('hide:toggle', {}),
  quit: () => app.quit()
};

function registerShortcuts() {
  const overrides = (store.getSettings() || {}).shortcuts || {};
  const map = resolveShortcuts(overrides);
  for (const [name, handler] of Object.entries(SHORTCUT_HANDLERS)) {
    const accel = map[name];
    let ok = false;
    // register() throws on a malformed accelerator and returns false when another
    // application already owns the combo — treat both as "not held" and carry on.
    if (accel) { try { ok = globalShortcut.register(accel, handler); } catch (_) { ok = false; } }
    shortcutState[name] = ok;
    if (!ok) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'could not register the ' + name + ' shortcut (' + accel + ')', frame: 'registerShortcuts', context: { shortcut: name, accelerator: accel } });
      // Notify the renderer so the user sees which shortcut failed.
      send('status', { message: `Could not register the ${name} shortcut (${accel}). It may be in use by another application.` });
    }
  }
}

// Called when the user edits shortcuts in Settings. globalShortcut has no
// per-accelerator replace, so drop everything cue holds and rebind from scratch.
function reRegisterShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_) { /* nothing registered yet */ }
  registerShortcuts();
}

// -------- launch --------
function launchApp() {
  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // The callback is one-shot — Electron throws "callback was called more than
    // once" if both branches fire. Passing an invalid `audio` value makes the
    // first callback throw synchronously, which drops us into .catch and calls
    // it a second time. Guard so at most one response is ever delivered.
    let responded = false;
    const respond = (arg) => { if (responded) return; responded = true; callback(arg); };
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return respond();
      // 'loopback' captures what is playing on this PC (Zoom/Meet/etc.). A bare
      // boolean is rejected by Electron 33+ and throws — it must be the string.
      respond({ video: sources[0], audio: 'loopback' });
    }).catch(() => respond());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
}

// -------- lifecycle --------
app.whenReady().then(() => {
  app.setName('MicrosoftEdgeUpdate');
  process.title = 'MicrosoftEdgeUpdate';
  launchApp();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
  if (cloudBatchTranscriber) cloudBatchTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', () => {
  app.quit();
});
