#!/usr/bin/env node
/* The shortcuts can be set to any key, with or without Ctrl / Alt / Shift.
 *
 * Three pieces have to agree, so each is tested on its own and then against the
 * others' contract:
 *   - the page script (content.js) listens in EVERY frame — a key pressed inside an
 *     iframe never reaches the top window — and asks the background to run the action;
 *   - the background (background.js) turns that request into the message the frames
 *     understand;
 *   - the Options page records a combination from a real key press and stores it.
 * Plus: the three places that spell out the default shortcuts must say the same thing.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const OPTIONS = 'file:///' + (process.env.ALEF_OPTIONS || path.join(ROOT, 'options.html')).replace(/\\/g, '/');
const BLANK = 'data:text/html,' + encodeURIComponent('<!doctype html><body><p>Nothing here.</p><input id="field"></body>');
const PORT = 9344;
process.env.CDP_PORT = String(PORT);

process.on('uncaughtException', e => { console.error('\n✗ UNCAUGHT:', e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('\n✗ UNHANDLED REJECTION:', e && e.stack || e); process.exit(1); });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const chromeExe = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => p && fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = (code, key, mods = '') => ({ code, key, ctrl: /c/.test(mods), shift: /s/.test(mods), alt: /a/.test(mods), meta: /m/.test(mods) });

/* The runtime the page script talks to: records what it sends, serves settings from
   a store, and keeps the storage-change listener so a test can change a setting live. */
const CONTENT_STUB = `
  window.__sent = [];
  window.__store = {};
  window.__changed = null;
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: m => { window.__sent.push(m); return Promise.resolve({ ok: true }); },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get: (k, cb) => { const o = {}; for (const x of [].concat(k)) if (x in window.__store) o[x] = window.__store[x]; return cb ? cb(o) : Promise.resolve(o); },
        set: o => { Object.assign(window.__store, o); return Promise.resolve(); },
      },
      onChanged: { addListener: fn => { window.__changed = fn; } },
    },
  };
  'ok'`;

(async () => {
  /* -------------------------------- the defaults are spelled out in three places */
  console.log('=== the default shortcuts agree everywhere ===');
  const defaultsIn = file => {
    const src = read(file);
    const at = src.indexOf('const DEFAULT_HOTKEYS =');
    if (at < 0) return null;
    let i = src.indexOf('{', at), depth = 0, end = i;
    for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
    return vm.runInNewContext('(' + src.slice(i, end + 1) + ')');
  };
  const dc = defaultsIn('content.js'), dp = defaultsIn('popup.js'), dop = defaultsIn('options.js');
  check('content.js, popup.js and options.js each define DEFAULT_HOTKEYS', !!dc && !!dp && !!dop);
  const same = JSON.stringify(dc) === JSON.stringify(dp) && JSON.stringify(dc) === JSON.stringify(dop);
  check('and they are identical', same, same ? '' : JSON.stringify([dc, dp, dop]));
  check('the old shortcuts are still the defaults: Ctrl+Shift+S solves, +X stops, +D dumps',
    dc && dc.solve.label === 'Ctrl+Shift+S' && dc.stop.label === 'Ctrl+Shift+X' && dc.dump.label === 'Ctrl+Shift+D' &&
    dc.solve.code === 'KeyS' && dc.solve.ctrl && dc.solve.shift && !dc.solve.alt, JSON.stringify(dc && dc.solve));
  check('whole-lesson has no default shortcut', dc && dc.lesson === null);

  /* ------------------------------------------------------------- the background */
  console.log('\n=== the background turns a shortcut into the message the frames understand ===');
  const sentToTab = [];
  let listener = null;
  const ctx = vm.createContext({
    console, fetch: async () => { throw new Error('no network'); },
    chrome: {
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: async () => ({}) } },
      tabs: { sendMessage: (id, msg, cb) => { sentToTab.push({ id, type: msg.type }); if (cb) cb(); } },
    },
  });
  // ALEF_BACKGROUND points at a deliberately broken copy, to prove a check can fail.
  vm.runInContext(process.env.ALEF_BACKGROUND ? fs.readFileSync(process.env.ALEF_BACKGROUND, 'utf8') : read('background.js'), ctx, { filename: 'background.js' });
  const press = (action, tab = { id: 7 }) => { sentToTab.length = 0; listener({ type: 'hotkey', action }, { tab }, () => {}); return sentToTab.slice(); };
  for (const [action, type] of [['solve', 'do-solve'], ['lesson', 'do-lesson'], ['stop', 'do-stop'], ['dump', 'do-dump']]) {
    const r = press(action);
    check(`${action} → ${type}, sent to the tab (every frame answers for itself)`, r.length === 1 && r[0].type === type && r[0].id === 7, JSON.stringify(r));
  }
  check('an action it does not know is ignored, not turned into a solve', press('explode').length === 0);
  check('a copy of the page script from before this version (no action) still solves',
    (() => { sentToTab.length = 0; listener({ type: 'hotkey' }, { tab: { id: 3 } }, () => {}); return sentToTab.length === 1 && sentToTab[0].type === 'do-solve'; })());
  check('a message with no tab is ignored', press('solve', null).length === 0);

  /* ------------------------------------------------------------------- Chrome */
  const profile = scratch.mkdtemp('alef-hotkeys-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=900,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
    try { child.kill(); } catch { }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }); } catch { }
  };
  process.on('exit', cleanup);

  let v;
  for (let i = 0; i < 60; i++) { await sleep(250); try { v = await version(); break; } catch { } }
  if (!v) { console.error('✗ headless chrome never started'); process.exit(2); }
  console.log(`\nheadless: ${v.Browser}`);

  const page = await findPage(/about:blank/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });

  /* ----------------------------------------------------------- the page script */
  async function loadPage(store = {}) {
    await s.goto(BLANK);
    await s.eval(CONTENT_STUB);
    await s.eval(`Object.assign(window.__store, ${JSON.stringify(store)}); 'ok'`);
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(200);                                       // the settings load asynchronously
  }
  // Press a key; resolves what the page did with it.
  const press1 = (init, target = 'document.body') => s.eval(`(() => {
    window.__sent.length = 0;
    const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}));
    (${target}).dispatchEvent(e);
    return { sent: window.__sent.map(m => m.type + ':' + m.action), prevented: e.defaultPrevented };
  })()`);
  const K = (code, key, mods = '') => ({ code, key, ctrlKey: /c/.test(mods), shiftKey: /s/.test(mods), altKey: /a/.test(mods), metaKey: /m/.test(mods) });

  console.log('\n=== default shortcuts, page script ===');
  await loadPage();
  let r = await press1(K('KeyS', 'S', 'cs'));
  check('Ctrl+Shift+S asks for a solve, and the page does not also act on the key', r.sent[0] === 'hotkey:solve' && r.prevented, JSON.stringify(r));
  r = await press1(K('KeyX', 'X', 'cs'));
  check('Ctrl+Shift+X asks for a stop', r.sent[0] === 'hotkey:stop', JSON.stringify(r));
  r = await press1(K('KeyD', 'D', 'cs'));
  check('Ctrl+Shift+D asks for a dump', r.sent[0] === 'hotkey:dump', JSON.stringify(r));
  r = await press1(K('KeyS', 's', 'c'));
  check('Ctrl+S (no Shift) is left alone — the browser\'s own', r.sent.length === 0 && !r.prevented, JSON.stringify(r));
  r = await press1(K('KeyS', 'S', 'csa'));
  check('Ctrl+Alt+Shift+S is not Ctrl+Shift+S', r.sent.length === 0, JSON.stringify(r));
  r = await press1(K('KeyL', 'L', 'cs'));
  check('whole-lesson has no shortcut until one is set', r.sent.length === 0 && !r.prevented, JSON.stringify(r));
  r = await press1({ ...K('KeyS', 'S', 'cs'), repeat: true });
  check('holding the key does not fire it again', r.sent.length === 0, JSON.stringify(r));

  console.log('\n=== any key, set in Options ===');
  await loadPage({ hotkeys: {
    solve: { ...b('F8', 'F8'), label: 'F8' },
    lesson: { ...b('Backquote', '`', 'a'), label: 'Alt+`' },
    stop: { ...b('KeyQ', 'q'), label: 'Q' },
    dump: null,
  } });
  r = await press1(K('F8', 'F8'));
  check('a bare F8 solves', r.sent[0] === 'hotkey:solve' && r.prevented, JSON.stringify(r));
  r = await press1(K('KeyS', 'S', 'cs'));
  check('and the old Ctrl+Shift+S no longer does', r.sent.length === 0 && !r.prevented, JSON.stringify(r));
  r = await press1(K('Backquote', '`', 'a'));
  check('Alt+` starts a whole lesson', r.sent[0] === 'hotkey:lesson', JSON.stringify(r));
  r = await press1(K('KeyQ', 'q'));
  check('a bare Q stops, on the page', r.sent[0] === 'hotkey:stop', JSON.stringify(r));
  r = await press1(K('KeyQ', 'Q', 's'));
  check('Shift+Q is a different key from Q', r.sent.length === 0, JSON.stringify(r));
  r = await press1(K('KeyD', 'D', 'cs'));
  check('a shortcut that was cleared does nothing, and the default does not come back', r.sent.length === 0 && !r.prevented, JSON.stringify(r));
  r = await press1(K('KeyQ', 'q'), `document.getElementById('field')`);
  check('a bare key is ignored while typing in a field (so an answer can contain a "q")', r.sent.length === 0 && !r.prevented, JSON.stringify(r));
  r = await press1(K('F8', 'F8'), `document.getElementById('field')`);
  check('but a function key types nothing, so it works in a field', r.sent[0] === 'hotkey:solve', JSON.stringify(r));

  console.log('\n=== a combination with Ctrl or Alt works inside a field ===');
  await loadPage({ hotkeys: { solve: { ...b('KeyK', 'k', 'c'), label: 'Ctrl+K' } } });
  r = await press1(K('KeyK', 'k', 'c'), `document.getElementById('field')`);
  check('Ctrl+K solves while typing', r.sent[0] === 'hotkey:solve', JSON.stringify(r));
  check('settings that only name some actions: the others keep their defaults (Ctrl+Shift+X still stops)',
    (await press1(K('KeyX', 'X', 'cs'))).sent[0] === 'hotkey:stop');
  r = await press1(K('KeyS', 'S', 'cs'));
  check('…and the one that was moved has left its default', r.sent.length === 0, JSON.stringify(r));

  console.log('\n=== changed while the page is open ===');
  await loadPage();
  await s.eval(`window.__changed({ hotkeys: { newValue: { solve: ${JSON.stringify({ ...b('F9', 'F9'), label: 'F9' })} } } }, 'local'); 'ok'`);
  r = await press1(K('F9', 'F9'));
  check('the new shortcut works at once, no reload', r.sent[0] === 'hotkey:solve', JSON.stringify(r));
  r = await press1(K('KeyS', 'S', 'cs'));
  check('and the old one stops at once', r.sent.length === 0, JSON.stringify(r));

  console.log('\n=== a key pressed inside an iframe ===');
  // A key event in a child frame never reaches the top window, so each frame listens
  // for itself and asks the background — which sends the job to all frames.
  await s.goto(BLANK);
  await s.eval(`new Promise(res => { const f = document.createElement('iframe'); f.id = 'f';
    f.srcdoc = '<!doctype html><body><p>question lives here</p></body>'; f.onload = () => res(true); document.body.appendChild(f); })`);
  await s.eval(`(() => { const w = document.getElementById('f').contentWindow;
    w.eval(${JSON.stringify(CONTENT_STUB)}); w.eval(${JSON.stringify(CONTENT_JS)}); return 'ok'; })()`, { awaitPromise: false });
  await sleep(250);
  r = await s.eval(`(() => { const w = document.getElementById('f').contentWindow;
    w.__sent.length = 0;
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'KeyS', key: 'S', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    return w.__sent.map(m => m.type + ':' + m.action); })()`);
  check('the frame asks for the solve itself', r[0] === 'hotkey:solve', JSON.stringify(r));

  /* ------------------------------------------------------------- the Options page */
  console.log('\n=== Options: recording a shortcut ===');
  const OPT_STUB = (store = {}) => `
    window.__store = ${JSON.stringify(store)};
    window.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) },
      storage: { local: {
        get: async k => { const o = {}; for (const x of [].concat(k)) if (x in window.__store) o[x] = window.__store[x]; return o; },
        set: async o => { Object.assign(window.__store, o); },
      } } };`;
  let scriptId = null;
  async function openOptions(store) {
    if (scriptId) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    ({ identifier: scriptId } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: OPT_STUB(store) }));
    await s.goto(OPTIONS);
    await sleep(150);
  }
  const box = a => s.eval(`(document.querySelector('[data-action="${a}"]') || {}).textContent || null`);
  const labels = async () => ({ solve: await box('solve'), lesson: await box('lesson'), stop: await box('stop'), dump: await box('dump') });
  const startRecording = a => s.eval(`document.querySelector('[data-action="${a}"]').click(); 'ok'`, { awaitPromise: false });
  const pressOpt = init => s.eval(`(() => { const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}));
    document.dispatchEvent(e); return e.defaultPrevented; })()`);
  const status = () => s.eval(`document.getElementById('status').textContent`);
  const save = async () => { await s.eval(`document.getElementById('save').click(); 'ok'`, { awaitPromise: false }); await sleep(120); return s.eval(`window.__store.hotkeys`); };

  await openOptions({});
  let L = await labels();
  check('shows the defaults, and "Not set" for the lesson', L.solve === 'Ctrl+Shift+S' && L.stop === 'Ctrl+Shift+X' && L.dump === 'Ctrl+Shift+D' && /not set/i.test(L.lesson), JSON.stringify(L));

  await startRecording('solve');
  check('clicking a box says it is waiting for keys', /press/i.test(await box('solve')), JSON.stringify(await box('solve')));
  await pressOpt({ code: 'ShiftLeft', key: 'Shift', shiftKey: true });
  check('a modifier on its own does not finish the recording', /press/i.test(await box('solve')), JSON.stringify(await box('solve')));
  const swallowed = await pressOpt(K('F8', 'F8'));
  L = await labels();
  check('F8 is recorded as F8, and the key press is not passed on to the page', L.solve === 'F8' && swallowed === true, JSON.stringify(L.solve));

  await startRecording('lesson');
  await pressOpt(K('Backquote', '`', 'a'));
  check('Alt+` is recorded', (await labels()).lesson === 'Alt+`', JSON.stringify((await labels()).lesson));

  await startRecording('stop');
  await pressOpt(K('Space', ' ', 'c'));
  check('Ctrl+Space', (await labels()).stop === 'Ctrl+Space', JSON.stringify((await labels()).stop));

  await startRecording('dump');
  await pressOpt(K('Digit1', '1', 'csa'));
  check('Ctrl+Alt+Shift+1', (await labels()).dump === 'Ctrl+Alt+Shift+1', JSON.stringify((await labels()).dump));

  await startRecording('solve');
  await pressOpt(K('Escape', 'Escape'));
  check('Esc cancels and keeps what was there', (await labels()).solve === 'F8' && !/press/i.test(await box('solve')), JSON.stringify((await labels()).solve));

  await startRecording('solve');
  await pressOpt(K('Space', ' ', 'c'));
  L = await labels();
  check('a combination already used is refused, and says which action has it',
    L.solve === 'F8' && L.stop === 'Ctrl+Space' && /stop/i.test(await status()), `${JSON.stringify(L.solve)} ${JSON.stringify(await status())}`);

  let saved = await save();
  check('Save stores every shortcut as a full description of the key',
    saved && saved.solve.code === 'F8' && saved.solve.ctrl === false && saved.solve.label === 'F8' &&
    saved.lesson.code === 'Backquote' && saved.lesson.alt === true && saved.lesson.ctrl === false &&
    saved.stop.code === 'Space' && saved.stop.ctrl === true &&
    saved.dump.code === 'Digit1' && saved.dump.ctrl && saved.dump.shift && saved.dump.alt, JSON.stringify(saved));

  console.log('\n=== Options: lessons per run ===');
  const lessonsBox = () => s.eval(`document.getElementById('maxLessons').value`);
  check('defaults to 5', (await lessonsBox()) === '5', JSON.stringify(await lessonsBox()));
  await s.eval(`document.getElementById('maxLessons').value = '12'; 'ok'`, { awaitPromise: false });
  check('a number is saved as a number', (await save(), await s.eval(`window.__store.maxLessons`)) === 12);
  await s.eval(`document.getElementById('maxLessons').value = '0'; 'ok'`, { awaitPromise: false });
  check('zero is raised to one lesson', (await save(), await s.eval(`window.__store.maxLessons`)) === 1);
  await s.eval(`document.getElementById('maxLessons').value = '999'; 'ok'`, { awaitPromise: false });
  check('and a huge number is capped at 50', (await save(), await s.eval(`window.__store.maxLessons`)) === 50);
  await openOptions({ maxLessons: 8 });
  check('reopening shows what was saved', (await lessonsBox()) === '8', JSON.stringify(await lessonsBox()));
  await openOptions({ hotkeys: saved });

  console.log('\n=== Options: clear, reset, reopen ===');
  await s.eval(`document.querySelector('[data-clear="lesson"]').click(); 'ok'`, { awaitPromise: false });
  check('Clear unsets it', /not set/i.test((await labels()).lesson));
  saved = await save();
  check('and Save stores "unset" as null (so the default does not come back)', saved.lesson === null && saved.solve.code === 'F8', JSON.stringify(saved && saved.lesson));

  await openOptions({ hotkeys: saved });
  L = await labels();
  check('reopening shows what was saved', L.solve === 'F8' && /not set/i.test(L.lesson) && L.stop === 'Ctrl+Space', JSON.stringify(L));

  await s.eval(`document.getElementById('resetKeys').click(); 'ok'`, { awaitPromise: false });
  L = await labels();
  check('Reset puts the defaults back', L.solve === 'Ctrl+Shift+S' && L.stop === 'Ctrl+Shift+X' && L.dump === 'Ctrl+Shift+D' && /not set/i.test(L.lesson), JSON.stringify(L));

  await openOptions({ hotkeys: { solve: { ...b('F2', 'F2'), label: 'F2' } } });
  L = await labels();
  check('settings that only name some actions: the rest show their defaults', L.solve === 'F2' && L.stop === 'Ctrl+Shift+X', JSON.stringify(L));

  await openOptions({});
  await startRecording('solve');
  await s.eval(`document.body.click(); 'ok'`, { awaitPromise: false });
  await sleep(100);
  check('clicking away stops recording', !/press/i.test(await box('solve')), JSON.stringify(await box('solve')));
  const nothing = await pressOpt(K('KeyZ', 'z'));
  check('and keys are no longer swallowed', nothing === false && (await labels()).solve === 'Ctrl+Shift+S');

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
