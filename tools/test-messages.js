#!/usr/bin/env node
/* Tests what the page script says back to the popup, and what it leaves in storage
   for "Copy last report".

   Two real-life failures drove this: a popup that said "No question found" for a tab
   that simply hadn't been reloaded, a page with no question, and a script that threw
   — three different situations, one message — and "Copy last report" handing back a
   STALE report because a miss saved nothing new. So every miss must save a fresh,
   stamped report, a thrown error must be reported rather than swallowed, and the
   page must say which build it is. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const DRAG = 'file:///' + path.join(__dirname, 'fixture-drag.html').replace(/\\/g, '/');
const LESSON = 'file:///' + path.join(__dirname, 'fixture-lesson.html').replace(/\\/g, '/');
const BLANK = 'data:text/html,' + encodeURIComponent('<!doctype html><body><p>Nothing to answer here.</p></body>');
const PORT = 9341;
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

// The extension runtime, as much of it as the page script touches: it records the
// message listener so a test can play the popup, and keeps what is saved to storage.
const STUB = `
  window.__store = {};
  window.__listener = null;
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: m => {
        // Play the background: a shortcut press becomes the message the frames answer.
        const type = m && m.type === 'hotkey' && ({ solve: 'do-solve', lesson: 'do-lesson', stop: 'do-stop', dump: 'do-dump' })[m.action];
        if (type && window.__listener) window.__listener({ type }, {}, () => {});
        return Promise.resolve({ error: 'unstubbed' });
      },
      onMessage: { addListener: fn => { window.__listener = fn; } },
    },
    storage: {
      local: {
        // Settings come from the same store the page script saves reports into.
        get: (k, cb) => { const o = {}; for (const x of [].concat(k)) if (x in window.__store) o[x] = window.__store[x]; return cb ? cb(o) : Promise.resolve(o); },
        set: o => { Object.assign(window.__store, o); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
  // Play the popup: send a message, wait for the page script's answer.
  window.__call = msg => new Promise(res => {
    let done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    window.__listener(msg, {}, finish);
    setTimeout(() => finish({ __timeout: true }), 6000);
  });
  'ok'`;

(async () => {
  const profile = scratch.mkdtemp('alef-msg-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
    try { child.kill(); } catch { }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }); } catch { }
  };
  process.on('exit', cleanup);

  let v;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { v = await version(); break; } catch { }
  }
  if (!v) { console.error('✗ headless chrome never started'); process.exit(2); }
  console.log(`headless: ${v.Browser}\n`);

  const page = await findPage(/about:blank/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });

  async function load(url) {
    await s.goto(url);
    await s.eval(STUB, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 250));
  }
  const call = msg => s.eval(`window.__call(${JSON.stringify(msg)})`);
  const stored = () => s.eval(`window.__store.lastReport`);
  const seedStale = () => s.eval(`window.__store.lastReport = 'OLD REPORT'; window.__store.lastReportAt = 1; 'ok'`, { awaitPromise: false });
  const devMode = on => s.eval(`window.__store.devMode = ${on}; 'ok'`, { awaitPromise: false });
  const hudText = () => s.eval(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`);

  /* ------------------------------------------------------------------ 1 */
  console.log('=== a page with no question on it ===');
  await load(BLANK);
  await seedStale();
  let r = await call({ type: 'do-ping' });
  check('ping: names its version and says there is no question', r.build === '9.9.9' && r.kind === null && r.summary === 'no question', JSON.stringify(r));
  check('ping leaves storage alone', await stored() === 'OLD REPORT');

  r = await call({ type: 'do-solve' });
  check('solve: not handled, and says a fresh report was saved', r.handled === false && r.saved === true && r.build === '9.9.9', JSON.stringify(r));
  let rep = await stored();
  check('the stale report was replaced by a fresh, stamped one',
    rep !== 'OLD REPORT' && /stage:\s+no-question/.test(rep) && /build:\s+9\.9\.9/.test(rep), JSON.stringify(rep.slice(0, 120)));
  check('and it is dated now', Date.now() - await s.eval(`window.__store.lastReportAt`) < 15000);

  await seedStale();
  r = await call({ type: 'do-lesson' });
  check('whole-lesson is answered the same way, and also replaces the stale report',
    r.handled === false && r.saved === true && await stored() !== 'OLD REPORT', JSON.stringify(r));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== a drag-and-drop question ===');
  await load(DRAG + '?mode=pointer');
  await devMode(true);
  await seedStale();
  r = await call({ type: 'do-ping' });
  check('ping: says what it sees',r.kind === 'drag' && /drag and drop \(3 gaps, 6 items\)/.test(r.summary || ''), JSON.stringify(r));
  r = await call({ type: 'do-dump' });
  rep = await stored();
  check('dump: ok, and the saved dump carries the build, the time and the detector section',
    r.ok === true && r.build === '9.9.9' && /build\s+9\.9\.9/.test(rep) && /taken\s+\d{4}-\d\d-\d\dT/.test(rep) && /drag-and-drop detector/.test(rep),
    JSON.stringify(rep.slice(0, 160)));
  check('and says how it sees Next, Finish and Submit — found or not, enabled or not, and why',
    /lesson navigation/.test(rep) && /next\s+(button|a|div|none)/.test(rep) && /finish\s+none found/.test(rep) && /content screen\s+no/.test(rep), JSON.stringify((rep.match(/--- lesson navigation[\s\S]{0,400}/) || [''])[0]));
  check('and the dump lists what the detector worked from', /draggable-marked/.test(rep) && /dashed boxes\s+3/.test(rep) && /holes in text/.test(rep));

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== the page says "drag" but there is nothing to drag ===');
  await load(DRAG + '?mode=pointer');
  await s.eval(`document.getElementById('tray').remove(); 'ok'`, { awaitPromise: false });
  await seedStale();
  r = await call({ type: 'do-ping' });
  check('ping: no question, and says why', r.kind === null && /fewer items than gaps/.test(r.why || ''), JSON.stringify(r));
  r = await call({ type: 'do-solve' });
  rep = await stored();
  check('solve: says why', r.handled === false && r.saved === true && /fewer items than gaps/.test(r.why || ''), JSON.stringify(r));
  check('the saved report holds the dashed boxes and an outline of the page around the instruction',
    /dashed boxes\s+3/.test(rep) && /border:dashed/.test(rep) && /page outline/.test(rep), JSON.stringify(rep.slice(0, 100)));

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== the page script itself throws ===');
  await load(DRAG + '?mode=pointer');
  await devMode(true);
  await seedStale();
  await s.eval(`window.__realQSA = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = Document.prototype.querySelectorAll = function () { throw new Error('boom'); }; 'ok'`, { awaitPromise: false });
  r = await call({ type: 'do-solve' });
  rep = await stored();
  check('solve: reports the error instead of going quiet', r.handled === false && /boom/.test(r.error || '') && r.build === '9.9.9', JSON.stringify(r));
  check('and saves a fresh report that names it', rep !== 'OLD REPORT' && /stage:\s+exception/.test(rep) && /boom/.test(rep), JSON.stringify(rep.slice(0, 140)));

  await seedStale();
  r = await call({ type: 'do-dump' });
  check('dump: reports the error too, and replaces the stale report', r.ok === false && /boom/.test(r.error || '') && await stored() !== 'OLD REPORT', JSON.stringify(r));

  await seedStale();
  await s.eval(`window.__alefSolver.dump(); 'ok'`, { awaitPromise: false });       // what Ctrl+Shift+D runs
  check('the Ctrl+Shift+D path also leaves a fresh report when the dump throws', await stored() !== 'OLD REPORT');
  await s.eval(`Element.prototype.querySelectorAll = Document.prototype.querySelectorAll = window.__realQSA; 'ok'`, { awaitPromise: false });

  /* ------------------------------------------------------------------ 5 */
  // Dump and Copy last report are behind the Developer mode setting. A report is
  // still saved either way — turning the setting on later must find one waiting.
  const press = code => s.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', ctrlKey: true, shiftKey: true, bubbles: true })); 'ok'`, { awaitPromise: false });
  console.log('\n=== Developer mode off (the default) ===');
  await load(DRAG + '?mode=pointer');
  await seedStale();
  r = await call({ type: 'do-dump' });
  check('dump (popup or command): refused, and says why', r.ok === false && r.devOff === true && r.build === '9.9.9', JSON.stringify(r));
  check('and it did not touch the saved report', await stored() === 'OLD REPORT');
  check('and the page says Developer mode is off', /Developer mode is off/.test(await hudText()), JSON.stringify(await hudText()));

  await s.eval(`document.getElementById('alef-solver-hud').textContent = ''; 'ok'`, { awaitPromise: false });
  await press('KeyD');
  await new Promise(r => setTimeout(r, 300));
  check('Ctrl+Shift+D does nothing but say so', await stored() === 'OLD REPORT' && /Developer mode is off/.test(await hudText()), JSON.stringify(await hudText()));

  await load(BLANK);
  await seedStale();
  r = await call({ type: 'do-solve' });
  check('a miss still saves a fresh report', r.saved === true && await stored() !== 'OLD REPORT');
  check('and the page says how to get at it, without pointing at a button that is hidden',
    /Developer mode/.test(await hudText()) && !/Copy last report/.test(await hudText()), JSON.stringify(await hudText()));

  // A slide (a picture to explore, Next already enabled) is not a question. Pressing
  // Solve on one should say what it is, not just "no question detected".
  console.log('\n=== a slide with no question on it ===');
  await load(LESSON + '?slides=1');
  await seedStale();
  r = await call({ type: 'do-ping' });
  check('ping: no question, and says it is a slide', r.kind === null && /slide/i.test(r.why || '') && /whole lesson/i.test(r.why || ''), JSON.stringify(r));
  r = await call({ type: 'do-solve' });
  check('solve: not handled, a report saved, and the reason names the slide', r.handled === false && r.saved === true && /slide/i.test(r.why || ''), JSON.stringify(r));
  check('and the page says so in words', /slide/i.test(await hudText()) || /no question detected/i.test(await hudText()), JSON.stringify(await hudText()));
  await load(LESSON + '?slides=1&ghost=1');
  r = await call({ type: 'do-ping' });
  check('a screen with a disabled Submit is not called a slide', r.kind === null && !/slide/i.test(r.why || ''), JSON.stringify(r));

  // An activity's opening screen: a title and a Start in the player's footer. A whole-lesson
  // run can begin there — before this, pressing Solve whole lesson on it did nothing at all,
  // though the popup said it would.
  console.log('\n=== the activity\'s opening screen (title and Start) ===');
  await load(LESSON + '?splash=start');
  r = await call({ type: 'do-ping' });
  check('ping: no question, and says it is an opening screen that a lesson run presses Start on',
    r.kind === null && /opening screen/i.test(r.why || '') && /Start/.test(r.why || ''), JSON.stringify(r));
  r = await call({ type: 'do-solve' });
  check('one answer: nothing to answer there, so not handled — and the reason is given', r.handled === false && /opening screen/i.test(r.why || ''), JSON.stringify(r));
  await load(LESSON + '?splash=start');
  r = await call({ type: 'do-lesson' });
  check('Solve whole lesson on it is taken up, not refused', r.handled === true && r.kind === 'slide', JSON.stringify(r));
  await new Promise(r => setTimeout(r, 4500));        // the run first waits 1.5 s for a question, then looks for a screen to go past
  check('and it pressed Start', await s.eval(`window.__splashStarts`) === 1, JSON.stringify(await s.eval(`window.__splashStarts`)));
  await load(LESSON + '?slides=1');
  r = await call({ type: 'do-lesson' });
  check('the same for a plain slide', r.handled === true && r.kind === 'slide', JSON.stringify(r));
  await load(LESSON + '?slides=1&ghost=1');
  r = await call({ type: 'do-lesson' });
  check('but not on a screen with a Submit on it — that wants an answer, not a Next', r.handled === false, JSON.stringify(r));

  // A question of a type that cannot be read, but that offers "I'll try later": it is skipped,
  // and the popup should say that rather than "no question detected" with no reason.
  await load(LESSON + '?later=1&plain=1');
  r = await call({ type: 'do-ping' });
  check('ping: unreadable but skippable — says it will be skipped, whatever its wording', r.kind === null && /skipped/i.test(r.why || '') && /try later/i.test(r.why || ''), JSON.stringify(r));
  await load(LESSON + '?later=1&plain=1');
  r = await call({ type: 'do-solve' });
  check('one answer there: taken up (it will press the button), kind says skippable', r.handled === true && r.kind === 'skippable', JSON.stringify(r));
  await load(LESSON + '?plain=1');
  r = await call({ type: 'do-ping' });
  check('ping: unreadable with no button — no promise to skip it', r.kind === null && !/try later/i.test(r.why || ''), JSON.stringify(r));

  // The "For You" page: a list of tasks, with the site's own profile menu ("Select Language") in
  // the header. Pressing Solve there once clicked the person's name and tried to change the language.
  const loadWith = async (url, settings) => {
    await s.goto(url);
    await s.eval(STUB, { awaitPromise: false });
    await s.eval(`Object.assign(window.__store, ${JSON.stringify(settings)}); 'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await new Promise(res => setTimeout(res, 250));
  };
  await load(LESSON + '?home=1&chrome=1&course=3');
  r = await call({ type: 'do-ping' });
  check('ping on the task list: no question (the menu\'s "Select Language" is not a drop-down), and it says what the page is',
    r.kind === null && /list of tasks/i.test(r.why || '') && /Go to the next lesson/.test(r.why || ''), JSON.stringify(r));
  r = await call({ type: 'do-solve' });
  check('one answer there: not handled, and the site\'s menu was not clicked', r.handled === false && await s.eval(`window.__chromeClicks`) === 0, JSON.stringify(r));
  r = await call({ type: 'do-lesson' });
  check('a whole-lesson run there without the next-lesson switch: not handled either, nothing started',
    r.handled === false && await s.eval(`window.__startClicks`) === 0 && await s.eval(`window.__chromeClicks`) === 0, JSON.stringify(r));
  await loadWith(LESSON + '?home=1&chrome=1&course=3', { autoNextLesson: true });
  r = await call({ type: 'do-lesson' });
  check('with the switch on it is taken up, as a screen it can go past', r.handled === true && r.kind === 'slide', JSON.stringify(r));
  await new Promise(res => setTimeout(res, 4500));
  check('and it started the lesson and left the menu alone',
    await s.eval(`window.__startClicks`) === 1 && await s.eval(`window.__chromeClicks`) === 0);

  // A list of lessons already begun — each says Continue, as all four rows of the live list did — is
  // the same as one of new ones: it is what a lesson run starts from.
  await load(LESSON + '?home=1&course=2&begun=1');
  r = await call({ type: 'do-ping' });
  check('ping on a list of begun lessons: a list of tasks, and how to have a run start one',
    r.kind === null && /list of tasks/i.test(r.why || '') && /Go to the next lesson/.test(r.why || ''), JSON.stringify(r));
  await loadWith(LESSON + '?home=1&course=2&begun=1', { autoNextLesson: true });
  r = await call({ type: 'do-lesson' });
  check('with the switch on a run there is taken up, and presses the first Continue', r.handled === true && r.kind === 'slide', JSON.stringify(r));
  await new Promise(res => setTimeout(res, 4500));
  check('which opened that lesson', await s.eval(`window.__startClicks`) === 1);

  // The lesson's rating box has a text area. It is not a question, and the popup says what it is.
  await load(LESSON + '?ratenow=1');
  r = await call({ type: 'do-ping' });
  check('ping: the "Rate your lesson!" box is not a question, and is named', r.kind === null && /rating box/i.test(r.why || ''), JSON.stringify(r));
  r = await call({ type: 'do-solve' });
  check('one answer there: not handled, and nothing typed into its text area', r.handled === false && await s.eval(`window.__ratingTyped`) === 0, JSON.stringify(r));

  // A typed answer the script cannot read (a math editor keeps its real text area out of sight): the
  // dump has to show what is there, hidden or not, and where the "Type…" placeholder sits.
  console.log('\n=== the dump for a typed answer it cannot read ===');
  await load(BLANK);
  await s.eval(`document.body.innerHTML = '<div id="q"><p>The vertex is:</p><div class="mq-editable-field" style="border:1px solid #333;padding:6px;width:120px;position:relative"><span class="ph">Type...</span><textarea style="position:absolute;width:1px;height:1px;padding:0;border:0;opacity:.01"></textarea></div></div>'; 'ok'`, { awaitPromise: false });
  await devMode(true);
  r = await call({ type: 'do-dump' });
  rep = await stored();
  check('the dump says what a typed answer could go into, and marks the hidden text area as not visible',
    /everything a typed answer could go into/.test(rep) && /textarea[^\n]*NOT visible/.test(rep) && /mq-editable-field/.test(rep), JSON.stringify((rep.match(/everything a typed answer[\s\S]{0,400}/) || [''])[0]));
  check('and where the "Type…" placeholder sits', /"Type…" placeholders/.test(rep) && /span\.ph/.test(rep) && /mq-editable-field/.test((rep.match(/"Type…" placeholders[\s\S]{0,300}/) || [''])[0]), JSON.stringify((rep.match(/"Type…" placeholders[\s\S]{0,300}/) || [''])[0]));

  console.log('\n=== Developer mode on ===');
  await load(DRAG + '?mode=pointer');
  await devMode(true);
  await seedStale();
  await press('KeyD');
  await new Promise(r => setTimeout(r, 400));
  check('Ctrl+Shift+D dumps', await stored() !== 'OLD REPORT' && /alef-solver dump/.test(await stored()), JSON.stringify((await stored()).slice(0, 60)));
  await load(BLANK);
  await devMode(true);
  r = await call({ type: 'do-solve' });
  check('a miss points at Copy last report', /Copy last report/.test(await hudText()), JSON.stringify(await hudText()));

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
