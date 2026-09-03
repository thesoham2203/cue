const fs = require('fs');
const path = require('path');
const { getRuntimeTarget, getCudaRuntimeTarget, WHISPER_CPP_VERSION } = require('./whisper-runtime-manifest');
const { detectCudaGpu } = require('./gpu-detect');

/**
 * Locate a whisper runtime, preferring the CUDA build when an NVIDIA GPU is detected.
 * Falls back to the CPU build if no GPU or CUDA runtime is found.
 * Never fetches code — only checks prepackaged or explicitly prepared runtimes.
 */
function locateWhisperRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env
}) {
  // Try CUDA-accelerated runtime first
  const cudaResult = _locateCudaRuntime({ isPackaged, resourcesPath, appPath, platform, architecture, environment });
  if (cudaResult && cudaResult.available) return cudaResult;

  // Fall back to CPU runtime
  return _locateCpuRuntime({ isPackaged, resourcesPath, appPath, platform, architecture, environment });
}

function _locateCudaRuntime({ isPackaged, resourcesPath, appPath, platform, architecture, environment }) {
  // Skip CUDA if user explicitly set CUE_NO_GPU
  if (environment.CUE_NO_GPU) return null;

  const gpu = detectCudaGpu();
  if (!gpu.available) return null;

  const cudaVersion = gpu.recommendedCuda || '12.4.0';
  const cudaTarget = getCudaRuntimeTarget(platform, architecture, cudaVersion);
  if (!cudaTarget) return null;

  const candidates = [];
  if (environment.CUE_WHISPER_RUNTIME_CUDA) {
    candidates.push(path.resolve(environment.CUE_WHISPER_RUNTIME_CUDA));
  }
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'whisper-runtime-cuda'));
  }
  if (appPath) {
    candidates.push(path.join(appPath, '.cache', 'whisper-runtime', cudaTarget.key));
  }

  for (const runtimeDirectory of candidates) {
    const executablePath = path.join(runtimeDirectory, cudaTarget.executable);
    if (fs.existsSync(executablePath)) {
      return {
        available: true,
        version: WHISPER_CPP_VERSION,
        target: cudaTarget.key,
        runtimeDirectory,
        executablePath,
        gpu: true,
        gpuName: gpu.gpuName,
        vramMb: gpu.vramMb,
        cudaVersion
      };
    }
  }

  // CUDA GPU detected but runtime not installed — return info for the UI
  // to prompt the user to download it.
  return {
    available: false,
    version: WHISPER_CPP_VERSION,
    target: cudaTarget.key,
    runtimeDirectory: candidates[0] || null,
    executablePath: null,
    gpu: true,
    gpuName: gpu.gpuName,
    vramMb: gpu.vramMb,
    cudaVersion,
    message: `NVIDIA GPU detected (${gpu.gpuName}, ${gpu.vramMb} MB VRAM) but the CUDA ${cudaVersion} runtime is not installed. ` +
      (isPackaged
        ? 'Reinstall cue with GPU support to enable acceleration.'
        : `Run: npm run prepare:whisper -- --platform ${platform} --arch ${architecture} --cuda ${cudaVersion}`)
  };
}

function _locateCpuRuntime({ isPackaged, resourcesPath, appPath, platform, architecture, environment }) {
  const target = getRuntimeTarget(platform, architecture);
  const candidates = [];

  if (environment.CUE_WHISPER_RUNTIME) {
    candidates.push(path.resolve(environment.CUE_WHISPER_RUNTIME));
  }
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'whisper-runtime'));
  }
  // Always check .cache as a fallback — this covers dev mode (where isPackaged is
  // incorrectly true) and the standard non-packaged development path.
  if (appPath) {
    candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
  }

  for (const runtimeDirectory of candidates) {
    const executablePath = path.join(runtimeDirectory, target.executable);
    if (fs.existsSync(executablePath)) {
      return {
        available: true,
        version: WHISPER_CPP_VERSION,
        target: target.key,
        runtimeDirectory,
        executablePath,
        gpu: false
      };
    }
  }

  return {
    available: false,
    version: WHISPER_CPP_VERSION,
    target: target.key,
    runtimeDirectory: candidates[0] || null,
    executablePath: null,
    gpu: false,
    message: isPackaged
      ? `The packaged Whisper runtime for ${target.key} is missing.`
      : 'Run npm run prepare:whisper before using local transcription from source.'
  };
}

module.exports = { locateWhisperRuntime };
