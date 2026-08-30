const assert = require('node:assert/strict');
const test = require('node:test');
const { CloudBatchTranscriber } = require('../src/cloud-batch-transcriber');

// A segmenter stand-in that emits one utterance per push, so tests exercise the
// queue/transcribe/publish path without the real VAD.
const emitOnPush = (options) => ({
  push(pcm) { options.onUtterance(options.channel, Buffer.from(pcm)); },
  stop() {}
});

test('routes utterances to onTranscript tagged with their channel', async () => {
  const transcripts = [];
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: async (pcm) => ({ text: pcm.toString(), provider: 'fake' }) },
    segmenterFactory: emitOnPush,
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('hello there'));
  transcriber.push('them', Buffer.from('general kenobi'));
  await transcriber.stop();

  assert.equal(transcripts.length, 2);
  assert.deepEqual(transcripts.find((t) => t.channel === 'you'), { channel: 'you', text: 'hello there' });
  assert.deepEqual(transcripts.find((t) => t.channel === 'them'), { channel: 'them', text: 'general kenobi' });
});

test('routes error results to onError and never to onTranscript', async () => {
  const transcripts = [];
  const errors = [];
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: async () => ({ text: '', error: { provider: 'groq', status: 429, message: 'quota' } }) },
    segmenterFactory: emitOnPush,
    onTranscript: (channel, text) => transcripts.push({ channel, text }),
    onError: (error) => errors.push(error)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('anything'));
  await transcriber.stop();

  assert.deepEqual(transcripts, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].provider, 'groq');
  assert.equal(errors[0].status, 429);
});

test('drops empty, single-character, and punctuation-only transcripts', async () => {
  const transcripts = [];
  const replies = ['', '.', 'a', '  ', '…', 'ok']; // only 'ok' survives the publish guard
  let index = 0;
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: async () => ({ text: replies[index++], provider: 'fake' }) },
    segmenterFactory: emitOnPush,
    onTranscript: (channel, text) => transcripts.push(text)
  });

  await transcriber.start();
  for (let n = 0; n < replies.length; n++) transcriber.push('you', Buffer.from('x'));
  await transcriber.stop();

  assert.deepEqual(transcripts, ['ok']);
});

test('preserves per-channel order while letting channels overlap', async () => {
  let active = 0;
  let maxConcurrency = 0;
  const order = [];
  const transcriber = new CloudBatchTranscriber({
    stt: {
      async transcribe(pcm) {
        active += 1;
        maxConcurrency = Math.max(maxConcurrency, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { text: pcm.toString(), provider: 'fake' };
      }
    },
    segmenterFactory: emitOnPush,
    onTranscript: (channel, text) => order.push(`${channel}:${text}`)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('a1'));
  transcriber.push('you', Buffer.from('a2'));
  transcriber.push('them', Buffer.from('c1'));
  await transcriber.stop();

  assert.deepEqual(order.filter((o) => o.startsWith('you:')), ['you:a1', 'you:a2']);
  assert.ok(order.includes('them:c1'));
  assert.equal(maxConcurrency, 2); // you and them run at the same time, but each channel stays serial
});

test('flushes a trailing utterance on stop and drains it', async () => {
  const transcripts = [];
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: async (pcm) => ({ text: pcm.toString(), provider: 'fake' }) },
    segmenterFactory: (options) => ({
      push() {},
      stop() { options.onUtterance(options.channel, Buffer.from('tail-' + options.channel)); }
    }),
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  await transcriber.stop();

  assert.equal(transcripts.length, 2);
  assert.ok(transcripts.some((t) => t.channel === 'you' && t.text === 'tail-you'));
  assert.ok(transcripts.some((t) => t.channel === 'them' && t.text === 'tail-them'));
});

test('builds each channel segmenter with its tuned VAD options', async () => {
  const captured = [];
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: async () => ({ text: '' }) },
    segmenterFactory: (options) => { captured.push(options); return { push() {}, stop() {} }; }
  });

  await transcriber.start();
  const you = captured.find((o) => o.channel === 'you');
  const them = captured.find((o) => o.channel === 'them');
  assert.deepEqual(you.vadOptions, { onsetThreshold: 220, offsetThreshold: 130, silenceFrames: 18 });
  assert.deepEqual(them.vadOptions, { onsetThreshold: 200, offsetThreshold: 120, silenceFrames: 20 });
  await transcriber.stop();
});

test('drains within a timeout and discards a slow in-flight transcription', async () => {
  const transcripts = [];
  const errors = [];
  let resolveSlow;
  const transcriber = new CloudBatchTranscriber({
    stt: { transcribe: () => new Promise((resolve) => { resolveSlow = resolve; }) },
    segmenterFactory: emitOnPush,
    drainTimeoutMs: 0,
    onTranscript: (channel, text) => transcripts.push({ channel, text }),
    onError: (error) => errors.push(error)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('slow'));
  await transcriber.stop(); // 0 ms drain window → gives up and marks pending jobs discardable

  resolveSlow({ text: 'late result', provider: 'fake' }); // resolves only after stop() returned
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transcripts, []); // a result that lands after "stopped" is suppressed
  assert.deepEqual(errors, []);
});

test('requires an stt with a transcribe method', () => {
  assert.throws(() => new CloudBatchTranscriber({ stt: {} }), /transcribe/);
});
