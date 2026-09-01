// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, CURRENT_GEMINI_DEFAULT } = require('./llm');

const BASE_VOCAB = 'CI/CD, Docker, Kubernetes, Terraform, Jenkins, AWS, Azure, GCP, ' +
  'CodeCommit, CodePipeline, CodeBuild, CodeDeploy, DevOps, SRE, microservices, deployment, ' +
  'pipeline, container, orchestration, Ansible, Prometheus, Grafana, Helm, EKS, ECS, Lambda, ' +
  'S3, EC2, IAM, GitHub Actions, GitLab, Kafka, PostgreSQL, Redis, MongoDB, REST API, gRPC';

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

function buildVocabPrompt(settings) {
  const s = settings || {};
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  let prompt = BASE_VOCAB + (proper.length ? ', ' + proper.slice(0, 60).join(', ') : '');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    // No `language` → Whisper auto-detects per utterance (Hindi / Marathi / English / …).
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  // Validate against known providers; fall back to 'auto' for unknown values.
  // 'local' is a valid sttProvider value meaning "use local Whisper" — it should
  // not build a cloud STT chain, so we include it here so it is recognised as valid
  // rather than falling through to 'auto'.
  // 'deepgram' is intentionally absent here — it is streaming-only in this codebase
  // (handled by stt-streaming.js). If it's selected as sttProvider, we fall back to
  // 'auto' so the batch chain still runs with whatever keys are available.
  const KNOWN_PROVIDERS = new Set(['auto', 'openai', 'groq', 'gemini', 'local']);
  const effectiveProvider = KNOWN_PROVIDERS.has(selectedProvider) ? selectedProvider : 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  if ((effectiveProvider === 'auto' || effectiveProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel, undefined, vocabPrompt) });
  }
  if ((effectiveProvider === 'auto' || effectiveProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(keys.groq, wav, 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((effectiveProvider === 'auto' || effectiveProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }


  let disabledUntil = 0;
  let lastProvider = null;
  // AbortController shared across all transcribe() calls in this chain.
  let abortController = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      // Create a new AbortController for this call; stored as `abortController` so
      // stop() can interrupt in-flight requests.
      abortController = new AbortController();
      const { signal } = abortController;
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        if (signal.aborted) return { text: '', error: { provider: c.p, message: 'transcribe aborted' } };
        try {
          const text = await c.fn(wav);
          if (signal.aborted) return { text: '', error: { provider: c.p, message: 'transcribe aborted' } };
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          if (signal.aborted) return { text: '', error: { provider: c.p, message: 'transcribe aborted' } };
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          const quota = isQuotaError(e);
          const message = formatProviderErrorMessage(e, c.p);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p };
          if (quota) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            break;
          }
        }
      }
      return { text: '', error: lastErr };
    },
    abort() {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    }
  };
}

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt };
