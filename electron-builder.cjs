/* electron-builder configuration.
 *
 * Windows-only. cue ships as an NSIS installer that produces
 * cue-win-x64.exe. Kept out of package.json so the build config lives in one
 * obvious place and can't be silently shadowed by a stray "build" field.
 */

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.cue.overlay",
  productName: "cue",
  asar: false,
  // Never auto-publish: with GH_TOKEN present, electron-builder would otherwise
  // upload the freshly built asset over whatever is attached to the release.
  publish: null,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  // An allowlist, so anything new has to be added here or it simply is not in
  // the shipped app — and the only symptom is a require() that throws at
  // launch, in a build that ran fine from source.
  files: ["main.js", "preload.js", "src/**/*", "renderer/**/*", "vendor/**/*"],
  directories: { buildResources: "build-resources" },
  afterPack: "scripts/after-pack.js",
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "${productName}-win-${arch}.${ext}",
  },
  // A per-user install with a visible directory step: cue is a personal overlay,
  // not a machine-wide service, so it should never need an elevation prompt.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "cue",
  },
};
