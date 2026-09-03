const path = require('path');

const WHISPER_CPP_VERSION = '1.9.1';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}`;

// Every runtime target uses a pinned upstream *release asset* with a stable
// checksum. Windows is what cue ships for; the Linux entries exist only so the
// download/extract pipeline can be smoke-tested cheaply in CI on an Ubuntu
// runner. There is deliberately no macOS entry — cue is Windows-only.
const RUNTIME_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'zip',
    filename: 'whisper-bin-x64.zip',
    bytes: 7982101,
    sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
    executable: 'whisper-server.exe'
  }),
  // CUDA 12.4 build — requires NVIDIA driver >= 551.78 on Windows.
  // Gives 5-10x speedup over CPU on supported GPUs.
  'win32-x64-cuda-12.4.0': Object.freeze({
    kind: 'archive',
    archiveType: 'zip',
    filename: 'whisper-cublas-12.4.0-bin-x64.zip',
    bytes: 677887125,
    sha256: '106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b',
    executable: 'whisper-server.exe'
  }),
  // CUDA 11.8 build — for older NVIDIA drivers (>= 452.39).
  'win32-x64-cuda-11.8.0': Object.freeze({
    kind: 'archive',
    archiveType: 'zip',
    filename: 'whisper-cublas-11.8.0-bin-x64.zip',
    bytes: 278557654,
    sha256: 'aecdce0e4d4bb758a7c72a31f3f9f19a7b6d861405fd2da743cd86398633c963',
    executable: 'whisper-server.exe'
  }),
  'linux-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-x64.tar.gz',
    bytes: 9379235,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    executable: 'whisper-server'
  }),
  'linux-arm64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-arm64.tar.gz',
    bytes: 4555819,
    sha256: 'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3',
    executable: 'whisper-server'
  })
});

function getRuntimeTarget(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`;
  const target = RUNTIME_TARGETS[key];
  if (!target) throw new Error(`Local Whisper is not packaged for ${key}.`);
  return {
    ...target,
    key,
    url: `${RELEASE_BASE_URL}/${target.filename}`
  };
}

/**
 * Get the CUDA-accelerated runtime target for a given platform and CUDA version.
 * Returns null if no CUDA build is available for the platform.
 */
function getCudaRuntimeTarget(platform = process.platform, architecture = process.arch, cudaVersion = '12.4.0') {
  const key = `${platform}-${architecture}-cuda-${cudaVersion}`;
  const target = RUNTIME_TARGETS[key];
  if (!target) return null;
  return {
    ...target,
    key,
    url: `${RELEASE_BASE_URL}/${target.filename}`
  };
}

function getRuntimeExecutablePath(runtimeDirectory, platform = process.platform, architecture = process.arch) {
  return path.join(runtimeDirectory, getRuntimeTarget(platform, architecture).executable);
}

module.exports = {
  WHISPER_CPP_VERSION,
  RUNTIME_TARGETS,
  getRuntimeTarget,
  getCudaRuntimeTarget,
  getRuntimeExecutablePath
};
