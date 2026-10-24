#!/usr/bin/env node
/* Tests what the popup tells the person. It loads the real popup.html and popup.js
   in headless Chrome against a scripted `chrome` API and checks the status line in
   each situation that used to read, misleadingly, "No question found in this tab":

     - the tab was open when the extension was reloaded (nothing there answers)
     - the tab runs an older copy of the page script
     - the page has no question on it (and a fresh report was saved)
     - the page script threw an error
     - it is not an Alef tab at all

   plus the ones that always worked: a question that is taken up, and the copy
   button — which now says how old the report it copied is. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
// ALEF_POPUP points at a deliberately broken copy, to prove a check can fail.
const POPUP = 'file:///' + (process.env.ALEF_POPUP || path.join(ROOT, 'popup.html')).replace(/\\/g, '/');
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const PORT = 9342;
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

const V = MANIFEST_VERSION;
const GONE = { error: 'Could not establish connection. Receiving end does not exist.' };
const WHY = '3 gaps, 0 items — fewer items than gaps';

/** The extension API the popup talks to, scripted per scenario: `replies` maps a
 *  message type to what that tab sends back (or an error, or silence). */
const makeStub = spec => `(() => {
  const spec = ${JSON.stringify(spec)};
  const tab = { id: 7, url: spec.url || 'https://moe.alefed.com/#/lesson/1' };
  const store = Object.assign({ apiKey: 'sk-test' }, spec.store || {});
  window.__sent = []; window.__closed = false; window.__copied = null;
  window.close = () => { window.__closed = true; };
  window.chrome = {
    runtime: { getManifest: () => ({ version: ${JSON.stringify(V)} }), lastError: undefined, openOptionsPage() {} },
    tabs: {
      query: async () => [tab],
      update: async () => tab,
      sendMessage: (id, msg, cb) => {
        window.__sent.push(msg.type);
        const r = (spec.replies || {})[msg.type];
        if (!r || r.silent) return;                       // nothing answers
        if (r.error) { chrome.runtime.lastError = { message: r.error }; try { cb(undefined); } finally { chrome.runtime.lastError = undefined; } return; }
        cb(r.res);
      },
    },
    storage: { local: {
      get: async keys => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = store[k]; return o; },
      set: async o => { Object.assign(store, o); },
    } },
  };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true });
})();`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = scratch.mkdtemp('alef-popup-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=600,900', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
    try { child.kill(); } catch { }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }); } catch { }
  };
  process.on('exit', cleanup);

  let v;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { v = await version(); break; } catch { }
  }
  if (!v) { console.error('✗ headless chrome never started'); process.exit(2); }
  console.log(`headless: ${v.Browser}   manifest version: ${V}\n`);

  const page = await findPage(/about:blank/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });
  s.on('Runtime.exceptionThrown', e => console.error('  [popup exception]', e?.exceptionDetails?.exception?.description || e?.exceptionDetails?.text));

  let scriptId = null;
  async function open(spec) {
    if (scriptId) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    ({ identifier: scriptId } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: makeStub(spec) }));
    await s.goto(POPUP);
  }
  const text = () => s.eval(`document.getElementById('last').textContent`);
  async function settled(ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      const t = await text();
      if (t && t !== 'working…') return t;
      if (Date.now() - t0 > ms) return t;
      await sleep(80);
    }
  }
  const click = async id => { await s.eval(`document.getElementById('${id}').click(); 'ok'`, { awaitPromise: false }); return settled(); };
  const flag = name => s.eval(`window.${name}`);

  const ok = res => ({ res: { build: V, ...res } });

  /* --------------------------------------------------------- on opening */
  console.log('=== on opening ===');
  await open({ replies: { 'do-ping': ok({ kind: 'drag', summary: 'drag and drop (3 gaps, 6 items)', why: '' }) } });
  let t = await settled();
  check('shows the version', (await s.eval(`document.getElementById('ver').textContent`)).includes(`v${V}`));
  check('says what the page script sees', t === `page script v${V} · sees: drag and drop (3 gaps, 6 items)`, JSON.stringify(t));

  await open({ replies: { 'do-ping': ok({ kind: null, summary: 'no question', why: WHY }) } });
  t = await settled();
  check('says when it sees nothing, and why', t === `page script v${V} · no question detected (${WHY})`, JSON.stringify(t));

  await open({ replies: { 'do-ping': GONE } });
  t = await settled();
  check('a tab nothing answers in: says to press F5, not "no question"', /isn't running the extension/.test(t) && /press F5/.test(t) && !/No question/.test(t), JSON.stringify(t));

  await open({ url: 'https://example.com/', replies: { 'do-ping': GONE } });
  t = await settled();
  check('a tab that is not Alef at all: says so', /isn't an Alef tab/.test(t) && !/F5/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': { silent: true } } });
  t = await settled(6000);
  check('a script that never answers is treated like an unreachable tab', /isn't running the extension/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': { res: { build: '0.1.0', kind: null } } } });
  t = await settled();
  check('a tab on an older copy: names both versions and says F5', t.includes('older copy (v0.1.0') && t.includes(`popup is v${V}`) && /F5/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': ok({ error: 'boom' }) } });
  t = await settled();
  check('a script that fails while reading the page: shows the error', /failed while reading the page: boom/.test(t), JSON.stringify(t));

  /* ------------------------------------------- the key warning follows the service */
  console.log('\n=== the missing-key warning is about the service that is chosen ===');
  const warns = async store => { await open({ store, replies: { 'do-ping': ok({ kind: null, summary: 'no question', why: WHY }) } }); await settled(); return s.eval(`document.getElementById('warn').classList.contains('on')`); };
  check('an OpenRouter key and nothing chosen: no warning', await warns({ apiKey: 'sk-test' }) === false);
  check('no key at all: warning', await warns({ apiKey: '' }) === true);
  check('Gemini chosen, with a Gemini key: no warning', await warns({ provider: 'gemini', apiKey: '', geminiKey: 'AIza-test' }) === false);
  check('Gemini chosen, with only an OpenRouter key: warning (it is not the key that will be used)', await warns({ provider: 'gemini', apiKey: 'sk-test', geminiKey: '' }) === true);
  check('OpenRouter chosen, with only a Gemini key: warning', await warns({ provider: 'openrouter', apiKey: '', geminiKey: 'AIza-test' }) === true);
  check('OpenAI chosen, with an OpenAI key: no warning', await warns({ provider: 'openai', apiKey: '', geminiKey: '', openaiKey: 'sk-test' }) === false);
  check('OpenAI chosen, with only the other services\' keys: warning', await warns({ provider: 'openai', apiKey: 'sk-or-test', geminiKey: 'AIza-test', openaiKey: '' }) === true);
  check('the warning does not name one service', !/OpenRouter/.test(await s.eval(`document.getElementById('warn').textContent`)));

  /* --------------------------------------------------- Solve this question */
  console.log('\n=== Solve this question ===');
  await open({ replies: { 'do-ping': ok({ kind: 'drag', summary: 'x' }), 'do-solve': ok({ handled: true, kind: 'drag' }) } });
  await settled();
  t = await click('run');
  check('taken up: says solving, and closes', t === 'solving…' && await flag('__closed') === true, JSON.stringify(t));

  await open({ store: { devMode: true }, replies: { 'do-ping': ok({ kind: null, why: WHY }), 'do-solve': ok({ handled: false, saved: true, why: WHY }) } });
  await settled();
  t = await click('run');
  check('no question: says so with the reason, and that a fresh report was saved',
    t.includes('No question detected on this tab') && t.includes(WHY) && t.includes('fresh report was saved') && t.includes('Copy last report'), JSON.stringify(t));
  check('and stays open so the report can be copied', await flag('__closed') === false);

  await open({ replies: { 'do-ping': ok({ kind: null }), 'do-solve': ok({ handled: false, error: 'boom' }) } });
  await settled();
  t = await click('run');
  check('the script threw: shows the error and says a report was saved', /page script failed: boom/.test(t) && /report was saved/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': GONE, 'do-solve': GONE } });
  await settled();
  t = await click('run');
  check('a tab nothing answers in: says to press F5', /isn't running the extension/.test(t) && /F5/.test(t) && !/No question/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': ok({ kind: null }), 'do-solve': { res: { handled: false, score: 2, kind: null } } } });
  await settled();
  t = await click('run');
  check('an older script that found nothing (no build in its answer): says it is older', /older copy \(v\?/.test(t), JSON.stringify(t));

  /* ------------------------------------------------------------ the rest */
  console.log('\n=== Whole lesson, Dump and Copy last report ===');
  await open({ replies: { 'do-ping': ok({ kind: 'drag', summary: 'x' }), 'do-lesson': ok({ handled: true, kind: 'drag' }) } });
  await settled();
  t = await click('lesson');
  check('lesson taken up: says so and closes', /running the lesson/.test(t) && await flag('__closed') === true, JSON.stringify(t));

  await open({ replies: { 'do-ping': ok({ kind: null }), 'do-lesson': ok({ handled: false, saved: true, why: WHY }) } });
  await settled();
  t = await click('lesson');
  check('lesson with no question: same explanation as a single question', /No question detected on this tab/.test(t) && t.includes(WHY), JSON.stringify(t));

  await open({ store: { devMode: true }, replies: { 'do-ping': ok({ kind: null }), 'do-dump': ok({ ok: true }) } });
  await settled();
  t = await click('dump');
  check('dump: says to copy it now, not "see the console"', t === 'dumped — now click "Copy last report"', JSON.stringify(t));

  await open({ store: { devMode: true }, replies: { 'do-ping': ok({ kind: null }), 'do-dump': ok({ ok: false, error: 'boom' }) } });
  await settled();
  t = await click('dump');
  check('dump that failed: shows the error', /page script failed: boom/.test(t), JSON.stringify(t));

  await open({ store: { devMode: true, lastReport: 'REPORT TEXT', lastReportAt: Date.now() - 2 * 60e3 }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  t = await click('report');
  check('copies the report, and says how old it is', await flag('__copied') === 'REPORT TEXT' && /2 min ago/.test(t) && /paste it into a bug report/.test(t), JSON.stringify(t));

  await open({ store: { devMode: true, lastReport: 'REPORT TEXT', lastReportAt: Date.now() - 30 * 60e3 }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  t = await click('report');
  check('warns when the report is an old one', /30 min ago/.test(t) && /OLD one/.test(t), JSON.stringify(t));

  await open({ store: { devMode: true }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  t = await click('report');
  check('says so when there is no report', /No report saved yet/.test(t), JSON.stringify(t));

  /* ------------------------------------------------------ Developer mode */
  console.log('\n=== Developer mode ===');
  const shown = id => s.eval(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
  await open({ replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('off (the default): Dump and Copy last report are hidden', !(await shown('dump')) && !(await shown('report')));
  check('and the buttons you use are still there',
    (await shown('run')) && (await shown('lesson')) && (await shown('stop')) && (await shown('opts')));

  await open({ store: { devMode: false }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('explicitly off: hidden too', !(await shown('dump')) && !(await shown('report')));

  await open({ store: { devMode: true }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('on: both are shown', (await shown('dump')) && (await shown('report')));

  await open({ replies: { 'do-ping': ok({ kind: null, why: WHY }), 'do-solve': ok({ handled: false, saved: true, why: WHY }) } });
  await settled();
  t = await click('run');
  check('off: a miss still says a report was saved, but not to click a button that is hidden',
    /fresh report was saved/.test(t) && /Developer mode in Options/.test(t) && !/Copy last report/.test(t), JSON.stringify(t));

  /* ----------------------------------------------- go on to the next lesson */
  console.log('\n=== the next-lesson switch ===');
  const checked = id => s.eval(`document.getElementById('${id}').checked`);
  await open({ replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('off until switched on (it presses Done, so it is never a default)', (await checked('autoNextLesson')) === false);
  await s.eval(`const c = document.getElementById('autoNextLesson'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); 'ok'`, { awaitPromise: false });
  await sleep(100);
  check('switching it on is saved', (await s.eval(`chrome.storage.local.get('autoNextLesson')`)).autoNextLesson === true);
  await open({ store: { autoNextLesson: true }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('and shown as on when the popup is opened again', (await checked('autoNextLesson')) === true);
  await open({ store: { autoNextLesson: false }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('and as off when it was switched off', (await checked('autoNextLesson')) === false);

  console.log('\n=== the "I\'ll try later" switch ===');
  await open({ replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('on by default (skipping a question the page lets you skip saves tokens and time)', (await checked('skipLater')) === true);
  await s.eval(`const c = document.getElementById('skipLater'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); 'ok'`, { awaitPromise: false });
  await sleep(100);
  check('switching it off is saved', (await s.eval(`chrome.storage.local.get('skipLater')`)).skipLater === false);
  await open({ store: { skipLater: false }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('and shown as off when the popup is opened again', (await checked('skipLater')) === false);
  check('the label says what it does', /try later/i.test(await s.eval(`document.querySelector('label[for=skipLater]').textContent`)));

  /* ------------------------------------------------------------ shortcuts */
  console.log('\n=== the popup shows the shortcuts that are set ===');
  const txt = id => s.eval(`document.getElementById('${id}').textContent`);
  const key = (code, label) => ({ code, key: label, ctrl: false, shift: false, alt: false, meta: false, label });
  await open({ replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('by default: the old ones', (await txt('run')) === 'Solve this question (Ctrl+Shift+S)' && (await txt('hk')) === '· Ctrl+Shift+S', `${await txt('run')} | ${await txt('hk')}`);

  await open({ store: { devMode: true, hotkeys: { solve: key('F8', 'F8'), dump: key('F9', 'F9'), stop: key('KeyQ', 'Q'), lesson: null } }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('after a change: the new ones, on the button and in the title',
    (await txt('run')) === 'Solve this question (F8)' && (await txt('hk')) === '· F8' && (await txt('dump')) === 'Dump page structure (F9)', `${await txt('run')} | ${await txt('hk')} | ${await txt('dump')}`);

  await open({ store: { hotkeys: { solve: null } }, replies: { 'do-ping': ok({ kind: null }) } });
  await settled();
  check('with the solve shortcut cleared: no empty brackets', (await txt('run')) === 'Solve this question' && (await txt('hk')) === '', `${JSON.stringify(await txt('run'))} | ${JSON.stringify(await txt('hk'))}`);

  await open({ store: { hotkeys: { stop: key('KeyQ', 'Q') } }, replies: { 'do-ping': ok({ kind: null }), 'do-lesson': ok({ handled: true, kind: 'drag' }) } });
  await settled();
  t = await click('lesson');
  check('a running lesson names the stop shortcut that is set', /press Q to stop/.test(t), JSON.stringify(t));

  await open({ store: { hotkeys: { stop: null } }, replies: { 'do-ping': ok({ kind: null }), 'do-lesson': ok({ handled: true, kind: 'drag' }) } });
  await settled();
  t = await click('lesson');
  check('with no stop shortcut it says to use the Stop button instead', /Stop/.test(t) && !/Ctrl\+Shift/.test(t), JSON.stringify(t));

  await open({ replies: { 'do-ping': ok({ kind: null }), 'do-solve': ok({ handled: false, error: 'boom' }) } });
  await settled();
  t = await click('run');
  check('off: a script error says the same', /page script failed: boom/.test(t) && /Developer mode in Options/.test(t) && !/Copy last report/.test(t), JSON.stringify(t));

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
