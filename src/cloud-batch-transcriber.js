const { UtteranceSegmenter } = require('./utterance-segmenter');

const CHANNELS = Object.freeze(['you', 'them']);
const DEFAULT_DRAIN_TIMEOUT_MS = 10000;

// Mirrors the publish guard the old blind-flush path used (main.js flushChannel):
// drop empty, single-character, and punctuation-only transcripts. Cloud text is
// already hallucination-filtered inside createSTT(), so this is only cleanup.
function isPublishable(text) {
  const trimmed = (text || '').trim();
  return trimmed.length > 1 && !/^[?!.,;:\-…]+$/.test(trimmed);
}

class CloudBatchTranscriber {
  /**
   * Feed speech-aligned utterances to a cloud STT chain instead of blind 900 ms
   * wall-clock fragments. Structurally mirrors LocalWhisperTranscriber, but the
   * backend is a createSTT(settings) result: transcribe(pcm) returns
   * { text, provider } or { text:'', error } and never throws for provider errors.
   *
   * `you` and `them` run on independent per-channel queues, so the two channels
   * overlap (max concurrency 2) while order is preserved within each channel. Both
   * channels share one `stt`, so a 429 backs both off together via its internal
   * quota window — which is why the chain is built once and injected here.
   */
  constructor({
    stt,
    segmenterFactory = (options) => new UtteranceSegmenter(options),
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    onTranscript = () => {},
    onSpeechState = () => {},
    onStatus = () => {},
    onError = () => {}
  }) {
    if (!stt || typeof stt.transcribe !== 'function') {
      throw new Error('CloudBatchTranscriber requires an stt with a transcribe(pcm) method.');
    }
    this.stt = stt;
    this.segmenterFactory = segmenterFactory;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onTranscript = onTranscript;
    this.onSpeechState = onSpeechState;
    this.onStatus = onStatus;
    this.onError = onError;
    this.segmenters = new Map();
    this.queueTails = new Map(CHANNELS.map((channel) => [channel, Promise.resolve()]));
    this.pendingJobs = 0;
    this.acceptingAudio = false;
    this.discardPendingJobs = false;
  }

  async start() {
    this.discardPendingJobs = false;
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
        },
        onUtterance: (utteranceChannel, pcm) => this._enqueue(utteranceChannel, pcm)
      }));
    }
    this.acceptingAudio = true;
  }

  push(channel, pcm) {
    if (!this.acceptingAudio) return;
    const segmenter = this.segmenters.get(channel);
    if (!segmenter) throw new Error(`Unknown cloud batch channel: ${channel}`);
    segmenter.push(pcm);
  }

  async stop() {
    this.acceptingAudio = false;
    // Finalizing a segmenter emits its trailing utterance synchronously, so every
    // final job is enqueued before we snapshot the tails to drain.
    for (const segmenter of this.segmenters.values()) segmenter.stop();

    const drained = await this._drainQueues();
    if (!drained) this.discardPendingJobs = true;
    this.segmenters.clear();
    this.onStatus({ status: 'off', message: 'Cloud transcription stopped.' });
  }

  forceStop() {
    this.acceptingAudio = false;
    this.discardPendingJobs = true;
    // No child process or socket to tear down — in-flight fetches simply have their
    // results discarded when they resolve.
    return Promise.resolve();
  }

  _enqueue(channel, pcm) {
    this.pendingJobs += 1;
    this.onStatus({ status: 'transcribing', channel, pending: this.pendingJobs });

    const tail = this.queueTails.get(channel) || Promise.resolve();
    const job = tail.then(async () => {
      if (this.discardPendingJobs) return;
      const result = await this.stt.transcribe(pcm);
      // Re-check after the await: stop() may have fired while this fetch was in flight,
      // and a stray transcript printed after "stopped" would confuse the user.
      if (this.discardPendingJobs) return;
      if (result && result.error) {
        this.onError(result.error);
        return;
      }
      if (result && isPublishable(result.text)) {
        this.onTranscript(channel, result.text.trim());
      }
    });

    this.queueTails.set(channel, job
      .catch((error) => {
        if (!this.discardPendingJobs) this.onError(error);
      })
      .finally(() => {
        this.pendingJobs -= 1;
        if (this.acceptingAudio && this.pendingJobs === 0) {
          this.onStatus({ status: 'ready' });
        }
      }));
    return job;
  }

  async _drainQueues() {
    let timeout = null;
    try {
      return await Promise.race([
        Promise.all(CHANNELS.map((channel) => this.queueTails.get(channel))).then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), this.drainTimeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

module.exports = { CloudBatchTranscriber, CHANNELS, DEFAULT_DRAIN_TIMEOUT_MS, isPublishable };
