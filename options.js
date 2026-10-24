const FIELDS = ['provider', 'apiKey', 'model', 'fallbackModel', 'geminiKey', 'geminiModel', 'geminiFallbackModel',
                'answerDelay', 'stepDelay', 'retries', 'devMode', 'hotkeys', 'maxLessons'];
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/* ------------------------------------------------------------- shortcuts */

// The shortcuts as they were before they could be changed; the page script and the popup
// keep the same table (a test checks all three agree). `null` is "no shortcut".
const DEFAULT_HOTKEYS = {
  solve:  { code: 'KeyS', key: 's', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+S' },
  lesson: null,
  stop:   { code: 'KeyX', key: 'x', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+X' },
  dump:   { code: 'KeyD', key: 'd', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+D' },
};
const ACTIONS = [
  ['solve', 'Solve this question'],
  ['lesson', 'Solve whole lesson'],
  ['stop', 'Stop'],
  ['dump', 'Dump page structure (needs Developer mode)'],
];
const clone = o => JSON.parse(JSON.stringify(o));

let hotkeys = clone(DEFAULT_HOTKEYS);
let recording = null;                 // the action whose box is waiting for a key press

// A shortcut is stored as the key itself, not as text, so the page can match it exactly:
// `code` is the physical key (so it does not move with the keyboard layout), the four
// flags are the modifiers, `label` is what to show.
const MODIFIER_KEY = /^(Control|Shift|Alt|AltGraph|Meta|OS)(Left|Right)?$/;
const KEY_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};
const keyName = code => KEY_NAMES[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');

function fromEvent(e) {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  return { code: e.code, key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
           label: [...mods, keyName(e.code)].join('+') };
}
const sameKey = (a, b) => a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;

function renderKeys() {
  const host = document.getElementById('keys');
  host.textContent = '';
  for (const [action, name] of ACTIONS) {
    const b = hotkeys[action];
    const row = document.createElement('div');
    row.className = 'keyrow';

    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;

    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'keybox' + (recording === action ? ' rec' : '') + (!b && recording !== action ? ' unset' : '');
    box.dataset.action = action;
    box.textContent = recording === action ? 'Press the keys… (Esc cancels)' : b ? b.label : 'Not set';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear';
    clear.dataset.clear = action;
    clear.textContent = 'Clear';
    clear.disabled = !b;

    row.append(label, box, clear);
    host.append(row);
  }
}

document.getElementById('keys').addEventListener('click', e => {
  const box = e.target.closest('[data-action]');
  const clear = e.target.closest('[data-clear]');
  e.stopPropagation();                                 // the click-away handler below must not cancel what this starts
  if (box) { recording = box.dataset.action; renderKeys(); return; }
  if (clear) { hotkeys[clear.dataset.clear] = null; recording = null; renderKeys(); status('Shortcut cleared — press Save to keep it.'); }
});

document.getElementById('resetKeys').addEventListener('click', () => {
  hotkeys = clone(DEFAULT_HOTKEYS);
  recording = null;
  renderKeys();
  status('Shortcuts reset — press Save to keep them.');
});

// Clicking anywhere else gives up on a recording.
document.addEventListener('click', () => { if (recording) { recording = null; renderKeys(); } });

// While a box is waiting, the next key press is the shortcut — it must not also do what
// that key normally does here.
document.addEventListener('keydown', e => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recording = null; renderKeys(); return; }
  if (!e.code || MODIFIER_KEY.test(e.code) || MODIFIER_KEY.test(e.key)) return;      // wait for the key itself
  const b = fromEvent(e);
  const action = recording;
  const clash = ACTIONS.find(([a]) => a !== action && hotkeys[a] && sameKey(hotkeys[a], b));
  recording = null;
  if (clash) {
    status(`${b.label} is already the shortcut for “${clash[1]}”. Clear that one first.`, 'bad');
  } else {
    hotkeys[action] = b;
    status('Shortcut changed — press Save to keep it.');
  }
  renderKeys();
}, true);

/* --------------------------------------------------------------- the rest */

async function load() {
  const s = await chrome.storage.local.get(FIELDS);
  // Settings saved before shortcuts could be changed name none; an action they do not
  // name keeps its default, and one saved as null stays unset.
  hotkeys = { ...clone(DEFAULT_HOTKEYS), ...(s.hotkeys || {}) };
  renderKeys();
  document.getElementById('provider').value = s.provider === 'gemini' ? 'gemini' : 'openrouter';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('model').value = s.model || 'deepseek/deepseek-v4.1-flash';
  document.getElementById('fallbackModel').value = s.fallbackModel || '';
  document.getElementById('geminiKey').value = s.geminiKey || '';
  document.getElementById('geminiModel').value = s.geminiModel || DEFAULT_GEMINI_MODEL;
  document.getElementById('geminiFallbackModel').value = s.geminiFallbackModel || '';
  showProvider();
  document.getElementById('answerDelay').value = s.answerDelay ?? 120;
  document.getElementById('stepDelay').value = s.stepDelay ?? 250;
  document.getElementById('retries').value = s.retries ?? 3;
  document.getElementById('maxLessons').value = s.maxLessons ?? 5;
  document.getElementById('devMode').checked = s.devMode === true;
}

/** Show the fields of the service that is chosen, and only those. */
function showProvider() {
  const gemini = document.getElementById('provider').value === 'gemini';
  document.getElementById('openrouterFields').hidden = gemini;
  document.getElementById('geminiFields').hidden = !gemini;
}
document.getElementById('provider').addEventListener('change', () => { showProvider(); status('Press Save to switch.'); });

function status(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

function read() {
  const num = (id, max) => {
    const el = document.getElementById(id);
    return Math.max(0, Math.min(max, parseInt(el.value, 10) || 0));
  };
  return {
    provider: document.getElementById('provider').value === 'gemini' ? 'gemini' : 'openrouter',
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim() || 'deepseek/deepseek-v4.1-flash',
    fallbackModel: document.getElementById('fallbackModel').value.trim(),
    geminiKey: document.getElementById('geminiKey').value.trim(),
    geminiModel: document.getElementById('geminiModel').value.trim() || DEFAULT_GEMINI_MODEL,
    geminiFallbackModel: document.getElementById('geminiFallbackModel').value.trim(),
    answerDelay: num('answerDelay', 3000),
    stepDelay: num('stepDelay', 5000),
    retries: num('retries', 10),
    maxLessons: Math.max(1, num('maxLessons', 50)),
    devMode: document.getElementById('devMode').checked,
    hotkeys: clone(hotkeys),
  };
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set(read());
  status('Saved.', 'ok');
});

/** Ask Google which models this key may use, and offer exactly those. Best effort: the test
 *  already passed, and the suggestions in the page stay if this cannot be read. Returns how
 *  many were found. */
async function listGeminiModels(key) {
  try {
    const res = await fetch(`${GEMINI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) return 0;
    const j = await res.json();
    const names = (j.models || [])
      .filter(m => /gemini/i.test(m.name || '') && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || '' }));
    if (!names.length) return 0;
    const list = document.getElementById('geminiModels');
    list.textContent = '';
    for (const { id, label } of names) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = label ? `${id} — ${label}` : id;
      list.append(o);
    }
    return names.length;
  } catch { return 0; }
}

async function testGemini() {
  const { geminiKey, geminiModel } = read();
  if (!geminiKey) { status('Paste a Gemini key first.', 'bad'); return; }
  status('Testing…');
  try {
    const model = geminiModel.replace(/^models\//, '');
    const res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { maxOutputTokens: 256 },       // room for a model that thinks first
      }),
    });
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      status(`HTTP ${res.status} — ${d}`, 'bad');
      return;
    }
    const j = await res.json();
    const reply = (j?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim() || '(empty)';
    const n = await listGeminiModels(geminiKey);
    status(`✓ ${model} responded: "${reply}"${n ? ` · ${n} models available to this key are in the list` : ''}`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}

document.getElementById('test').addEventListener('click', async () => {
  if (document.getElementById('provider').value === 'gemini') { await testGemini(); return; }
  const { apiKey, model } = read();
  if (!apiKey) { status('Paste a key first.', 'bad'); return; }
  status('Testing…');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
      }),
    });
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      status(`HTTP ${res.status} — ${d}`, 'bad');
      return;
    }
    const j = await res.json();
    const reply = j?.choices?.[0]?.message?.content?.trim() || '(empty)';
    status(`✓ ${model} responded: "${reply}"`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
});

renderKeys();
load();
