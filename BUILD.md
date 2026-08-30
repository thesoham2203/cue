# Building & Running cue (Windows)

This is the complete guide to running cue from source, building a standalone
`.exe`, and cutting a release. cue is **Windows-only**.

- [1. Prerequisites](#1-prerequisites)
- [2. Get the code](#2-get-the-code)
- [3. Run it in development](#3-run-it-in-development)
- [4. Tests & linting](#4-tests--linting)
- [5. Build an `.exe`](#5-build-an-exe)
- [6. Bundle the local whisper runtime (optional)](#6-bundle-the-local-whisper-runtime-optional)
- [7. What the build produces](#7-what-the-build-produces)
- [8. Install & run the built app](#8-install--run-the-built-app)
- [9. Cutting a release (GitHub Actions)](#9-cutting-a-release-github-actions)
- [10. Code signing (optional)](#10-code-signing-optional)
- [11. Build troubleshooting](#11-build-troubleshooting)

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Windows** | 11, or 10 version 2004 (build 19041)+ | Older Windows 10 runs, but the screen-share invisibility degrades to a black box. |
| **Node.js** | **22.12.0 or newer** | Enforced by `engines` in `package.json`. Get it from [nodejs.org](https://nodejs.org). |
| **npm** | Ships with Node | Used for every command below. |
| **Git** | Any recent | To clone the repo. |

**No Visual Studio / C++ build tools are required.** cue deliberately avoids
native Node modules, so there is nothing to compile. The bundled speech-to-text
engine (whisper.cpp) is downloaded as a **prebuilt, checksum-verified binary**
— not compiled locally.

Verify your toolchain:

```bash
node --version   # must be >= 22.12.0
npm --version
```

---

## 2. Get the code

```bash
git clone https://github.com/Blueturboguy07/cue.git
cd cue
npm install
```

`npm install` runs a `postinstall` step (`scripts/rename-electron.js`) that
renames the local Electron binary so the running process presents a neutral
name instead of `electron.exe`. This is expected and only touches files inside
`node_modules`.

---

## 3. Run it in development

```bash
npm start
```

This launches the app directly with Electron (`electron .`). No build step is
needed for the source — the UI is plain HTML/CSS/JS in `renderer/`, and the
main process is `main.js`.

### First run

- Grant the **microphone** when Windows prompts (the only OS permission cue
  needs). Screenshots and meeting audio need no permission.
- Add an AI provider key in **Settings** (the `...` button, or `Ctrl` `,`).
  See the [README](README.md#step-2--add-your-ai-key-bring-your-own).

### Useful environment variables

| Variable | Effect |
|---|---|
| `CUE_NO_PROTECT=1` | Disables `setContentProtection` so the window is visible in captures — handy when screen-sharing your dev session to debug the UI. |
| `CUE_BUNDLE_WHISPER=1` | Include the local whisper runtime when packaging (see [section 6](#6-bundle-the-local-whisper-runtime-optional)). |

Setting an env var for a single command:

```bash
# Git Bash
CUE_NO_PROTECT=1 npm start
```

```powershell
# PowerShell
$env:CUE_NO_PROTECT = "1"; npm start
```

---

## 4. Tests & linting

```bash
npm test        # node --test over test/*.test.js
npm run lint     # eslint over the whole project
```

Both are fast and require no network. Run them before building or opening a PR.
CI (`.github/workflows/ci.yml`) runs the same on every push and pull request.

---

## 5. Build an `.exe`

cue is packaged with [electron-builder](https://www.electron.build/). All build
configuration lives in **`electron-builder.cjs`** (kept out of `package.json`
on purpose, so a stray `build` field can never silently override it).

### The installer (what you ship)

```bash
npm run dist:win
```

Produces a Windows **NSIS installer** at:

```
dist/cue-win-x64.exe
```

This is a **per-user** installer: it never asks for administrator rights,
installs cue for the current user, lets the user pick the install directory,
and creates a Start-menu shortcut named **cue**.

### The unpacked app (for quick local testing)

```bash
npm run pack
```

Produces a runnable, uninstalled build at:

```
dist/win-unpacked/cue.exe
```

Use this to smoke-test a packaged build without going through installation.
(`npm run pack:win` is the same thing stated explicitly as `--win --dir`.)

### First build note

On its first run, electron-builder downloads its own toolchain (NSIS and the
Windows code-sign helper) into `%LOCALAPPDATA%\electron-builder\Cache`. That
first build needs network access; later builds are offline-capable. If that
download hits a symlink-permission error, see
[section 11](#11-build-troubleshooting).

---

## 6. Bundle the local whisper runtime (optional)

By default, packaged builds do **not** include the local whisper.cpp runtime —
local transcription is one optional provider among several, and bundling it
would make every build depend on the network. Users who want local mode can let
the app download models on demand.

### For development

Prepare the runtime once into the local cache so **Settings → Audio → Local**
works while running from source:

```bash
npm run prepare:whisper
```

This downloads the pinned, checksum-verified `whisper-server` binary for
Windows x64. Verify it launches:

```bash
npm run verify:whisper-runtime
```

### To include it in the installer

Set `CUE_BUNDLE_WHISPER=1` when building. The `afterPack` hook
(`scripts/after-pack.js`) then copies the prepared runtime into the packaged
app's `resources/whisper-runtime`.

```bash
# Git Bash
CUE_BUNDLE_WHISPER=1 npm run dist:win
```

```powershell
# PowerShell
$env:CUE_BUNDLE_WHISPER = "1"; npm run dist:win
```

---

## 7. What the build produces

Everything lands in `dist/` (git-ignored):

| Path | What it is |
|---|---|
| `dist/cue-win-x64.exe` | The NSIS installer — the file you distribute. |
| `dist/cue-win-x64.exe.blockmap` | Delta-update map electron-builder emits next to the installer. |
| `dist/latest.yml` | Update metadata (version + hashes). Upload it alongside the installer if you use auto-update. |
| `dist/win-unpacked/` | The unpacked app; `cue.exe` inside runs without installing. |

---

## 8. Install & run the built app

1. Run `cue-win-x64.exe`.
2. Because the installer is **unsigned**, Windows SmartScreen may show
   **"Windows protected your PC" / Unknown publisher**. Click
   **More info → Run anyway**.
3. Launch **cue** from the Start menu.

To remove it: **Settings → Apps → Installed apps → cue → Uninstall** (or the
Start-menu uninstaller). Per-user install means no admin prompt on the way out
either.

---

## 9. Cutting a release (GitHub Actions)

Releases are automated by `.github/workflows/release.yml`. Pushing a tag that
starts with `v` triggers a Windows runner that builds the installer and uploads
it to the matching GitHub Release.

```bash
# bump "version" in package.json first, then:
git tag v0.2.3
git push origin v0.2.3
```

The workflow runs `npm ci` → `npm run dist:win` and attaches `dist/*.exe` and
`dist/latest.yml` to the release. `publish: null` in `electron-builder.cjs`
guarantees the build step itself never uploads anything — the workflow's upload
step is the only thing that publishes, so a local `dist:win` can't clobber a
release asset.

---

## 10. Code signing (optional)

The project ships **unsigned** — hence the SmartScreen prompt. If you obtain an
Authenticode certificate, electron-builder will sign automatically when it sees
the standard env vars, with no config change:

| Variable | Meaning |
|---|---|
| `CSC_LINK` | Path to your `.pfx` file, or its base64 contents. |
| `CSC_KEY_PASSWORD` | The certificate's password. |

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "..."
npm run dist:win
```

A signed installer removes the "Unknown publisher" warning (SmartScreen
reputation still builds over time/downloads). Never commit the certificate or
its password.

---

## 11. Build troubleshooting

**`Cannot create symbolic link … A required privilege is not held by the client`** (during the first `dist:win`).
electron-builder extracts its Windows code-sign helper using symlinks, which
Windows restricts by default. Fix once, either way:
- Enable **Developer Mode**: Settings → Privacy & security → For developers →
  **Developer Mode → On**, then rebuild; **or**
- Run the build once from an **elevated** terminal (Run as administrator).

**`npm start` crashes with `Cannot read properties of undefined (reading 'getPath')`.**
Your environment has `ELECTRON_RUN_AS_NODE=1` set (VS Code's integrated terminal
is a common culprit). It makes Electron boot as plain Node, so `require('electron')`
returns a path string instead of the module. Clear it:
- PowerShell: `Remove-Item Env:\ELECTRON_RUN_AS_NODE`
- Git Bash: `unset ELECTRON_RUN_AS_NODE`

**The build fails writing to `dist/` (`EPERM` / `EBUSY`).**
An antivirus scanner or a still-running `cue.exe` is holding a file open. Close
any running build of cue, and if your AV quarantines fresh unsigned executables,
add the repo's `dist/` folder to its exclusions.

**`prepare:whisper` or `verify:whisper-runtime` fails.**
These need network access to fetch the pinned upstream release. Re-run once
connectivity is back; the download is checksum-verified and resumes cleanly.

**Node version errors from `npm install`.**
The `engines` field requires Node **22.12.0+**. Upgrade Node — nvm-windows or
the installer from nodejs.org both work.
