// Configurable global shortcuts. Kept dependency-free so it is unit-testable and
// can be required from both the main process and the preload bridge.
// Accelerator strings follow Electron's format, e.g. 'CommandOrControl+Return'.

// The single source of truth for every action cue binds to a global shortcut.
// These MUST match the handlers wired up in main.js (SHORTCUT_HANDLERS). Only
// actions listed here are registered — there is deliberately no aspirational
// entry that nothing listens to.
const DEFAULTS = {
  assist: 'CommandOrControl+Return',
  say: 'CommandOrControl+Shift+Return',
  leetcode: 'CommandOrControl+H',
  hide: 'CommandOrControl+Shift+/',
  quit: 'CommandOrControl+Shift+X'
};

// Human-facing metadata for the settings UI, in display order. Keys line up with
// DEFAULTS / SHORTCUT_HANDLERS.
const ACTIONS = [
  { id: 'assist', label: 'Assist', hint: 'Scan screen + conversation and help' },
  { id: 'say', label: 'What should I say?', hint: 'Suggest your next line' },
  { id: 'leetcode', label: 'Coding problem', hint: 'Solve the problem on screen' },
  { id: 'hide', label: 'Show / hide window', hint: 'Toggle the overlay' },
  { id: 'quit', label: 'Quit cue', hint: 'Close the app' }
];

// Every action that maps to a shortcut. Values = defaults; can be overridden via
// settings. Unknown or empty override keys fall back to the default.
function resolveShortcuts(overrides = {}) {
  const out = {};
  for (const [action, def] of Object.entries(DEFAULTS)) {
    const v = (overrides && overrides[action]) || def;
    out[action] = v;
  }
  return out;
}

// Detect collisions between configured accelerators (a global shortcut can only be
// registered once). Returns an array of [actionA, actionB, accelerator] pairs.
function findConflicts(map) {
  const seen = new Map();
  const conflicts = [];
  for (const [action, accel] of Object.entries(map)) {
    if (!accel) continue;
    const key = accel.trim().toLowerCase();
    if (seen.has(key)) conflicts.push([seen.get(key), action, accel]);
    else seen.set(key, action);
  }
  return conflicts;
}

const MODIFIERS = new Set(['CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']);

// Basic validity check: must contain at least a non-modifier key and plausible modifiers.
function isValid(accel) {
  if (!accel || typeof accel !== 'string') return false;
  const parts = accel.split('+').map((s) => s.trim());
  if (parts.some((p) => !p)) return false;
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  return keys.length >= 1;
}

// Pretty-print an accelerator for display as word+glyph (e.g. Ctrl+Shift+↵).
// Shared by the settings UI and the in-panel action hints so they never disagree.
const MOD_LABELS = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Super: 'Win', Meta: 'Win', Alt: 'Alt', Option: 'Alt', AltGr: 'Alt', Shift: 'Shift' };
const KEY_SYMBOLS = { Return: '↵', Enter: '↵', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: '␣', Escape: 'Esc', Backspace: '⌫', Delete: 'Del', Tab: '⇥', Plus: '+' };
// Windows convention orders modifiers Ctrl, Alt, Shift, then the Windows key.
const MOD_ORDER = ['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Command', 'Cmd', 'Super', 'Meta'];

function acceleratorLabel(accel) {
  if (!accel || typeof accel !== 'string') return '';
  const parts = accel.split('+').map((s) => s.trim()).filter(Boolean);
  const mods = parts.filter((p) => MODIFIERS.has(p));
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  const keyStr = keys.map((k) => KEY_SYMBOLS[k] || (k.length === 1 ? k.toUpperCase() : k)).join('+');
  const seen = new Set();
  const modStr = MOD_ORDER
    .filter((m) => mods.includes(m))
    .map((m) => MOD_LABELS[m])
    .filter((s) => (seen.has(s) ? false : seen.add(s)));
  return [...modStr, keyStr].filter(Boolean).join('+');
}

module.exports = { DEFAULTS, ACTIONS, resolveShortcuts, findConflicts, isValid, acceleratorLabel };
