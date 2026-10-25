const KEYS = ['autoSubmit', 'openPassage', 'screenshot', 'apiKey', 'provider', 'geminiKey', 'openaiKey', 'deepseekToken', 'advance', 'cachePassage', 'devMode', 'hotkeys', 'autoNextLesson', 'skipLater'];

// Developer mode (set in Options) shows Dump and Copy last report. Reports are saved
// either way; the switch only decides whether there is a button to copy one.
let dev = false;

// The shortcuts as they were before they could be changed; Options and the page script
// keep the same table (a test checks all three agree). `null` is "no shortcut".
const DEFAULT_HOTKEYS = {
  solve:  { code: 'KeyS', key: 's', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+S' },
  lesson: null,
  stop:   { code: 'KeyX', key: 'x', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+X' },
  dump:   { code: 'KeyD', key: 'd', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+D' },
};
let hotkeys = DEFAULT_HOTKEYS;
/** The text for an action's shortcut ('' when it has none), for showing beside its button. */
const keyLabel = action => ((action in hotkeys ? hotkeys[action] : DEFAULT_HOTKEYS[action]) || {}).label || '';
const withKey = (text, action) => (keyLabel(action) ? `${text} (${keyLabel(action)})` : text);

const copyHint = () => (dev ? 'click "Copy last report" and paste it into a bug report' : 'turn on Developer mode in Options to copy it');

// The page script reports the same number, so a tab left on an older copy after
// the extension was reloaded can be told apart from a page with no question on it.
const BUILD = chrome.runtime.getManifest().version;
const say = text => { document.getElementById('last').textContent = text; };

async function load() {
  const s = await chrome.storage.local.get(KEYS);
  document.getElementById('autoSubmit').checked = s.autoSubmit !== false;
  document.getElementById('openPassage').checked = s.openPassage !== false;
  document.getElementById('screenshot').value = s.screenshot || 'auto';
  document.getElementById('advance').checked = s.advance !== false;
  document.getElementById('cachePassage').checked = s.cachePassage !== false;
  document.getElementById('autoNextLesson').checked = s.autoNextLesson === true;     // off until switched on
  document.getElementById('skipLater').checked = s.skipLater !== false;              // on unless switched off
  // The warning is about the credential of the service that is chosen: a Gemini key does nothing for OpenRouter.
  const cred = s.provider === 'gemini' ? s.geminiKey
             : s.provider === 'openai' ? s.openaiKey
             : s.provider === 'deepseek' ? s.deepseekToken
             : s.apiKey;
  document.getElementById('warn').classList.toggle('on', !cred);
  document.getElementById('warn').textContent = s.provider === 'deepseek'
    ? 'No DeepSeek token set. Open Options and copy one from the site.'
    : 'No API key set. Open Options and paste your key.';
  document.getElementById('ver').textContent = ` · v${BUILD}`;
  dev = s.devMode === true;
  document.getElementById('dump').hidden = !dev;
  document.getElementById('report').hidden = !dev;

  hotkeys = s.hotkeys || DEFAULT_HOTKEYS;
  document.getElementById('hk').textContent = keyLabel('solve') ? `· ${keyLabel('solve')}` : '';
  document.getElementById('run').textContent = withKey('Solve this question', 'solve');
  document.getElementById('dump').textContent = withKey('Dump page structure', 'dump');
}

for (const [id, key, prop] of [
  ['autoSubmit', 'autoSubmit', 'checked'],
  ['openPassage', 'openPassage', 'checked'],
  ['screenshot', 'screenshot', 'value'],
  ['advance', 'advance', 'checked'],
  ['cachePassage', 'cachePassage', 'checked'],
  ['autoNextLesson', 'autoNextLesson', 'checked'],
  ['skipLater', 'skipLater', 'checked'],
]) {
  document.getElementById(id).addEventListener('change', e => {
    chrome.storage.local.set({ [key]: e.target[prop] });
  });
}

/** Send a command to the active tab and say how it went. `reachable: false` means
 *  nothing there answered — which is what a tab that was open when the extension
 *  was reloaded looks like (its old script is cut off from the new one). */
async function toTab(type, opt, timeout = 5000) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { reachable: false, tab: null, why: 'no active tab' };
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ reachable: false, tab, why: 'the page script did not answer' }), timeout);
    chrome.tabs.sendMessage(tab.id, { type, ...opt }, res => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      resolve(err ? { reachable: false, tab, why: err.message } : { reachable: true, tab, res });
    });
  });
}

const isAlef = tab => /^https:\/\/([^/]*\.)?alefed\.com\//.test(tab?.url || '');

const unreachable = r => (isAlef(r.tab)
  ? `⚠ This tab isn't running the extension (v${BUILD}) yet — press F5 on it, then try again.`
  : 'This isn\'t an Alef tab — open the lesson tab first.');

const olderCopy = p => `⚠ This tab runs an older copy (v${p.build ?? '?'}; the popup is v${BUILD}) — press F5 on it.`;

/** What to tell the person when a command was not taken up. */
function notHandled(r) {
  if (!r.reachable) return unreachable(r);
  const p = r.res || {};
  if (p.build !== BUILD) return olderCopy(p);
  if (p.error) return `⚠ The page script failed: ${p.error}. A report was saved — ${copyHint()}.`;
  if (p.saved) {
    return `No question detected on this tab${p.why ? ` (${p.why})` : ''}. A fresh report was saved — ${copyHint()}.`;
  }
  if (p.devOff) return 'Developer mode is off — turn it on in Options to dump the page.';
  return 'No question found in this tab — make sure an item is open.';
}

const ago = ms => (ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`);

document.getElementById('run').addEventListener('click', async () => {
  say('working…');
  const r = await toTab('do-solve');
  if (r.reachable && r.res?.handled) { say('solving…'); window.close(); return; }
  say(notHandled(r));
});

document.getElementById('lesson').addEventListener('click', async () => {
  say('working…');
  const r = await toTab('do-lesson');
  if (r.reachable && r.res?.handled) {
    say(`running the lesson — ${keyLabel('stop') ? `press ${keyLabel('stop')}` : 'open this popup and press Stop'} to stop`);
    window.close();
    return;
  }
  say(notHandled(r));
});

document.getElementById('stop').addEventListener('click', async () => {
  await toTab('do-stop');
  say('stopping…');
});

document.getElementById('dump').addEventListener('click', async () => {
  say('working…');
  const r = await toTab('do-dump');
  say(r.reachable && r.res?.ok && r.res.build === BUILD ? 'dumped — now click "Copy last report"' : notHandled(r));
});

// The page can't write the clipboard without a user gesture, so dumps and
// failure reports are parked in storage and copied from here, on a real click.
document.getElementById('report').addEventListener('click', async () => {
  const { lastReport, lastReportAt } = await chrome.storage.local.get(['lastReport', 'lastReportAt']);
  if (!lastReport) { say('No report saved yet — click "Dump page structure" first.'); return; }
  const age = Date.now() - (lastReportAt || 0);
  try {
    await navigator.clipboard.writeText(lastReport);
    say(`copied the report from ${new Date(lastReportAt).toLocaleTimeString()} (${ago(age)})` +
      (age > 10 * 60e3 ? ' — that is an OLD one: click "Dump page structure" first for a fresh one' : ' — paste it into a bug report'));
  } catch (e) {
    say(`copy failed: ${e.message}`);
  }
});

document.getElementById('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

/** On opening: is this tab running this version, and what does it see on screen? */
async function ping() {
  const r = await toTab('do-ping', undefined, 2500);
  if (!r.reachable) { say(unreachable(r)); return; }
  const p = r.res || {};
  if (p.build !== BUILD) { say(olderCopy(p)); return; }
  if (p.error) { say(`⚠ The page script failed while reading the page: ${p.error}`); return; }
  say(p.kind
    ? `page script v${p.build} · sees: ${p.summary}`
    : `page script v${p.build} · no question detected${p.why ? ` (${p.why})` : ''}`);
}

load();
ping();
