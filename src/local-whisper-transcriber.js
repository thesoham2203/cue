const { UtteranceSegmenter } = require('./utterance-segmenter');
const { WhisperServerSession } = require('./whisper-server-session');

const CHANNELS = Object.freeze(['you', 'them']);
const DEFAULT_DRAIN_TIMEOUT_MS = 15000;

// Rolling-window interim transcription settings.
// While speech is ongoing, send partial audio for interim results every INTERIM_INTERVAL_MS.
// This gives the "Google Gboard" feel of words appearing as you speak.
const INTERIM_INTERVAL_MS = 1500;  // Send interim every 1.5s during speech
const MIN_INTERIM_BYTES = 16000;   // ~500ms of audio minimum for interim (16kHz * 2 bytes * 0.5s)

class LocalWhisperTranscriber {
  /** Coordinate two audio channels through one sequential, persistent model session. */
  constructor({
    sessionOptions,
    sessionFactory = (options) => new WhisperServerSession(options),
    segmenterFactory = (options) => new UtteranceSegmenter(options),
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    onTranscript = () => {},
    onInterim = () => {},
    onSpeechState = () => {},
    onStatus = () => {},
    onError = () => {}
  }) {
    this.session = sessionFactory({ ...sessionOptions, onState: onStatus });
    this.segmenterFactory = segmenterFactory;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onTranscript = onTranscript;
    this.onInterim = onInterim;
    this.onSpeechState = onSpeechState;
    this.onStatus = onStatus;
    this.onError = onError;
    this.segmenters = new Map();
    this.queueTail = Promise.resolve();
    this.pendingJobs = 0;
    this.acceptingAudio = false;
    this.discardPendingJobs = false;

    // Per-channel interim state: accumulates PCM while speech is ongoing and
    // periodically transcribes it for partial results.
    this._interimState = new Map();
    this._interimBusy = false; // true while an interim inference is in flight
  }

  async start() {
    this.discardPendingJobs = false;
    await this.session.start();
    for (const channel of CHANNELS) {
      const isRemoteAudio = channel === 'them';
      this.segmenters.set(channel, this.segmenterFactory({
        channel,
        vadOptions: {
          onsetThreshold: isRemoteAudio ? 200 : 220,
          offsetThreshold: isRemoteAudio ? 120 : 130,
          silenceFrames: isRemoteAudio ? 20 : 18
        },
        onSpeechState: (speechChannel, speaking, durationMs) => {
          this.onSpeechState(speechChannel, speaking, durationMs);
          // Manage interim state on speech transitions
          if (speaking) {
            this._startInterim(speechChannel);
          } else {
            this._stopInterim(speechChannel);
          }
        },
        onUtterance: (utteranceChannel, pcm, startTs) => this._enqueue(utteranceChannel, pcm, startTs)
      }));
      this._interimState.set(channel, {
        active: false,
        chunks: [],
        totalBytes: 0,
        timer: null,
        lastInterimText: ''
      });
    }
    this.acceptingAudio = true;
  }

  push(channel, pcm) {
    if (!this.acceptingAudio) return;
    const segmenter = this.segmenters.get(channel);
    if (!segmenter) throw new Error(`Unknown local Whisper channel: ${channel}`);

    // Feed audio to interim accumulator while speech is ongoing
    const iState = this._interimState.get(channel);
    if (iState && iState.active) {
      iState.chunks.push(Buffer.from(pcm));
      iState.totalBytes += pcm.length;
    }

    segmenter.push(pcm);
  }

  async stop() {
    this.acceptingAudio = false;
    // Stop all interim timers
    for (const channel of CHANNELS) this._stopInterim(channel);

    for (const segmenter of this.segmenters.values()) segmenter.stop();

    const drained = await this._drainQueue();
    if (!drained) {
      this.discardPendingJobs = true;
      this.session.abortInferences();
    }
    await this.session.stop({ force: !drained });
    this.segmenters.clear();
    this._interimState.clear();
    this.onStatus({ status: 'off', message: 'Local Whisper stopped.' });
  }

  forceStop() {
    this.acceptingAudio = false;
    this.discardPendingJobs = true;
    // Stop all interim timers
    for (const channel of CHANNELS) this._stopInterim(channel);
    this.session.abortInferences();
    return this.session.stop({ force: true });
  }

  // ---- Interim (rolling-window) transcription ----------------------------
  // While the user is speaking, periodically send accumulated audio to
  // whisper-server for partial results. This gives the real-time feel of
  // words appearing as speech progresses.

  _startInterim(channel) {
    const iState = this._interimState.get(channel);
    if (!iState || iState.active) return;
    iState.active = true;
    iState.chunks = [];
    iState.totalBytes = 0;
    iState.lastInterimText = '';
    iState.timer = setInterval(() => this._fireInterim(channel), INTERIM_INTERVAL_MS);
  }

  _stopInterim(channel) {
    const iState = this._interimState.get(channel);
    if (!iState) return;
    if (iState.timer) {
      clearInterval(iState.timer);
      iState.timer = null;
    }
    iState.active = false;
    iState.chunks = [];
    iState.totalBytes = 0;
    // Clear interim text when speech ends (final transcript will replace it)
    if (iState.lastInterimText) {
      iState.lastInterimText = '';
      this.onInterim(channel, '');
    }
  }

  async _fireInterim(channel) {
    // Skip if another interim inference is already in flight (don't queue them up)
    if (this._interimBusy || this.discardPendingJobs || !this.acceptingAudio) return;

    const iState = this._interimState.get(channel);
    if (!iState || !iState.active || iState.totalBytes < MIN_INTERIM_BYTES) return;

    // Snapshot the accumulated audio
    const audioSnapshot = Buffer.concat(iState.chunks, iState.totalBytes);

    this._interimBusy = true;
    try {
      const text = await this.session.transcribe(audioSnapshot);
      if (this.discardPendingJobs || !this.acceptingAudio) return;
      if (text && text.trim() && text.trim() !== iState.lastInterimText) {
        iState.lastInterimText = text.trim();
        this.onInterim(channel, text.trim());
      }
    } catch (_error) {
      // Interim failures are non-fatal — the final transcription will still work
      // Log but don't propagate
    } finally {
      this._interimBusy = false;
    }
  }

  // ---- Final transcription queue -----------------------------------------

  _enqueue(channel, pcm, startTs) {
    this.pendingJobs += 1;
    this.onStatus({ status: 'transcribing', channel, pending: this.pendingJobs });

    const job = this.queueTail.then(async () => {
      // Check discard flag BEFORE the await to avoid race: stop() sets discard after
      // the drain timeout fires but before queueTail resolves.
      if (this.discardPendingJobs) return;
      const text = await this.session.transcribe(pcm);
      if (this.discardPendingJobs) return; // re-check after await
      if (text) this.onTranscript(channel, text, startTs);
    });

    this.queueTail = job
      .catch((error) => {
        if (!this.discardPendingJobs) this.onError(error);
      })
      .finally(() => {
        this.pendingJobs -= 1;
        if (this.acceptingAudio && this.pendingJobs === 0) {
          this.onStatus({ status: 'ready', message: 'Local Whisper is ready.' });
        }
      });
    return job;
  }

  async _drainQueue() {
    let timeout = null;
    try {
      return await Promise.race([
        this.queueTail.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), this.drainTimeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

module.exports = { LocalWhisperTranscriber, CHANNELS, DEFAULT_DRAIN_TIMEOUT_MS };
