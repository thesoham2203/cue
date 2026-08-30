# Repository Guidelines

## Project Structure & Module Organization

`main.js` is the Electron main process and wires windows, IPC, capture, shortcuts, transcription, and LLM flows. Shared Node/CommonJS modules live in `src/` and should stay small and testable. Browser UI files live in `renderer/` (`index.html`, `styles.css`, renderer scripts, and the audio worklet). Tests are in `test/*.test.js` and mirror the module names they cover. Build and packaging helpers live in `scripts/`; installer configuration is in `electron-builder.cjs`. User-facing docs and images are in `docs/`, and vendored app-link code is isolated under `vendor/app-link/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies and run the Electron rename postinstall step.
- `npm start`: launch the app with Electron for local development.
- `npm test`: run Node's built-in test runner over `test/*.test.js`.
- `npm run lint`: run ESLint over the repo.
- `npm run pack`: create an unpacked local build in `dist/win-unpacked/`.
- `npm run dist:win`: build the Windows NSIS installer.
- `npm run prepare:whisper`: download the pinned local whisper runtime when needed.

Use Node.js `>=22.12.0` for local work, matching `package.json`.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) in Node-facing code. Keep indentation at two spaces, use semicolons, and prefer concise helper functions over large inline blocks. File names use lowercase kebab-case, such as `whisper-model-manager.js`; tests should use the same base name plus `.test.js`. Browser globals are limited by `eslint.config.js`; expose renderer APIs through `preload.js` rather than reaching into Electron directly.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add focused tests beside related coverage in `test/`, especially for provider routing, Windows behavior, shortcuts, transcription, and packaging config. Run `npm test` and `npm run lint` before submitting. For whisper runtime changes, also run `npm run prepare:whisper` and `npm run verify:whisper-runtime` when network access and platform support are available.

## Commit & Pull Request Guidelines

Recent history uses short, imperative subjects with optional Conventional Commit scopes, for example `fix(gemini): propagate the current default model` or `test: cover the Gemini 404/429 mapping`. Keep commits narrowly scoped and explain user-visible behavior changes. Pull requests should include a summary, linked issue when applicable, test evidence, and screenshots or recordings for renderer/UI changes.

## Security & Configuration Tips

Do not commit API keys, local model files, generated `dist/` output, or runtime caches. Keep provider credentials local to user settings. When debugging screen capture behavior, prefer `CUE_NO_PROTECT=1 npm start` so the overlay is visible during development.
