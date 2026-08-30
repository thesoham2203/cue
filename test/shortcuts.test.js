const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, ACTIONS, resolveShortcuts, findConflicts, isValid, acceleratorLabel } = require('../src/shortcuts');

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Return');
  assert.ok(DEFAULTS.leetcode);
  assert.ok(DEFAULTS.quit);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+L' });
  assert.strictEqual(map.leetcode, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'leetcode') || (a === 'leetcode' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});

test('ACTIONS and DEFAULTS describe exactly the same set of actions', () => {
  const actionIds = ACTIONS.map((a) => a.id).sort();
  const defaultIds = Object.keys(DEFAULTS).sort();
  assert.deepStrictEqual(actionIds, defaultIds);
  // Every action carries a label + hint for the settings UI.
  for (const a of ACTIONS) {
    assert.ok(a.label && a.hint, `missing metadata for ${a.id}`);
  }
});

test('every default accelerator is itself valid and conflict-free', () => {
  for (const [id, accel] of Object.entries(DEFAULTS)) {
    assert.ok(isValid(accel), `default for ${id} is invalid: ${accel}`);
  }
  assert.strictEqual(findConflicts(DEFAULTS).length, 0);
});

test('acceleratorLabel renders Windows modifier words and key glyphs', () => {
  assert.strictEqual(acceleratorLabel('CommandOrControl+Shift+Return'), 'Ctrl+Shift+↵');
  assert.strictEqual(acceleratorLabel('CommandOrControl+H'), 'Ctrl+H');
  assert.strictEqual(acceleratorLabel('CommandOrControl+Alt+Shift+K'), 'Ctrl+Alt+Shift+K');
  assert.strictEqual(acceleratorLabel('Alt+Left'), 'Alt+←');
  assert.strictEqual(acceleratorLabel(''), '');
});