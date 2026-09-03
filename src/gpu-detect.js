// GPU detection for local Whisper acceleration.
// Detects NVIDIA CUDA GPUs on Windows by checking nvidia-smi availability
// and CUDA toolkit presence. Used to decide whether to download the CUDA
// build of whisper.cpp and to pass `--gpu-layers` to whisper-server.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let _cached = null;

/**
 * Detect whether an NVIDIA CUDA GPU is available.
 * Returns { available, gpuName, cudaVersion, vram } or { available: false }.
 * Result is cached after first call since GPU hardware doesn't change at runtime.
 */
function detectCudaGpu() {
  if (_cached !== null) return _cached;
  _cached = _detect();
  return _cached;
}

function _detect() {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'CUDA detection only supported on Windows' };
  }

  // Try nvidia-smi first (most reliable)
  try {
    const nvidiaSmi = _findNvidiaSmi();
    if (!nvidiaSmi) {
      return { available: false, reason: 'nvidia-smi not found' };
    }
    const output = execFileSync(nvidiaSmi, [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ], { timeout: 5000, windowsHide: true, encoding: 'utf8' });

    const line = (output || '').trim().split('\n')[0];
    if (!line) return { available: false, reason: 'nvidia-smi returned empty output' };
    const parts = line.split(',').map((s) => s.trim());
    const gpuName = parts[0] || 'Unknown NVIDIA GPU';
    const vramMb = parseInt(parts[1], 10) || 0;
    const driverVersion = parts[2] || '';

    return {
      available: true,
      gpuName,
      vramMb,
      driverVersion,
      // CUDA 12.4 runtime needs driver >= 550.54.14 (Linux) / 551.78 (Windows).
      // CUDA 11.8 needs driver >= 452.39 on Windows.
      // We default to CUDA 12.4 build and fall back to 11.8 if driver is old.
      recommendedCuda: _recommendCudaVersion(driverVersion)
    };
  } catch (e) {
    return { available: false, reason: 'nvidia-smi failed: ' + (e.message || String(e)) };
  }
}

function _findNvidiaSmi() {
  // Standard paths on Windows
  const candidates = [];

  // System32 (usually symlinked)
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
  candidates.push(sys32);

  // Program Files
  const nvidiaDir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI');
  candidates.push(path.join(nvidiaDir, 'nvidia-smi.exe'));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found, try next
    }
  }

  // Fallback: try PATH
  try {
    execFileSync('nvidia-smi', ['--version'], { timeout: 3000, windowsHide: true });
    return 'nvidia-smi';
  } catch {
    return null;
  }
}

/**
 * Recommend CUDA toolkit version based on NVIDIA driver version.
 * CUDA 12.4 requires driver >= 551.78 on Windows.
 * CUDA 11.8 requires driver >= 452.39 on Windows.
 */
function _recommendCudaVersion(driverVersion) {
  if (!driverVersion) return '11.8.0';
  const major = parseInt(driverVersion.split('.')[0], 10);
  if (isNaN(major)) return '11.8.0';
  // Driver 552+ supports CUDA 12.4
  if (major >= 552) return '12.4.0';
  // Driver 520+ supports CUDA 12.x but we're conservative
  if (major >= 520) return '12.4.0';
  // Older drivers: fall back to CUDA 11.8
  return '11.8.0';
}

/** Reset the cache (useful for testing). */
function resetGpuCache() {
  _cached = null;
}

module.exports = { detectCudaGpu, resetGpuCache };
