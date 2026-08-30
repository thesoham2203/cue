const assert = require('node:assert/strict');
const test = require('node:test');

const pkg = require('../package.json');

// Regression test for the actual incident behind the "cue is damaged and
// can't be opened" bug reports: package.json used to carry its own legacy
// "build" field, and electron-builder picked that up INSTEAD OF
// electron-builder.cjs, so every release was built from the wrong config.
// Fixed in 1a86a6c ("remove stale package.json build field so dist uses
// electron-builder.cjs"). If a "build" field ever comes back, it silently
// reintroduces the exact same failure mode.
test('package.json has no "build" field shadowing electron-builder.cjs', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'build'), false);
});

test('dist/pack scripts do not pass an inline --config that could bypass electron-builder.cjs', () => {
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/electron-builder/.test(script)) continue;
    assert.ok(!/--config/.test(script), `${name} script unexpectedly overrides config: ${script}`);
  }
});

test('electron-builder config is Windows-only and never auto-publishes', () => {
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const builder = require('../electron-builder.cjs');

  // publish:null is what stops electron-builder auto-publishing a freshly
  // built asset over a real release asset just because GH_TOKEN is set.
  assert.equal(builder.publish, null);

  // The Windows NSIS installer is the only shipped target — cue is Windows-only,
  // so there must be no mac or linux packaging blocks.
  assert.deepEqual(builder.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(builder.mac, undefined);
  assert.equal(builder.linux, undefined);

  // A per-user install with a visible directory step never needs elevation.
  assert.equal(builder.nsis.oneClick, false);
  assert.equal(builder.nsis.perMachine, false);
});
