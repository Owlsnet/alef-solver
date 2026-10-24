#!/usr/bin/env node
/* Tests the fill-in-the-blank path: finding the blanks and the Word Bank,
   rebuilding the sentence with [BLANK n] markers, and typing into controlled
   inputs so the page actually keeps the values. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
// ALEF_CONTENT lets a test run against a deliberately broken copy, to prove a
// check really would have caught the bug it's there for.
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const BACKGROUND_JS = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-cloze.html');
const PORT = 9335;
process.env.CDP_PORT = String(PORT);

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

(async () => {
  const profile = require('./scratch.js').mkdtemp('alef-cloze-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    // child.kill() ends only the browser process; its GPU and crash-handler
    // helpers keep the profile open. Take down the whole tree.
    try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
    try { child.kill(); } catch { }
    // Synchronous on purpose: this also runs from an 'exit' handler, where a
    // timer never fires — deferring the delete leaked a profile on every run
    // until the disk filled. Retries cover Chrome still releasing its files.
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
  await s.goto('file:///' + FIXTURE.replace(/\\/g, '/'));

  /* Stub the runtime, and route 'ask' through a scripted reply so the whole
     scrape -> ask -> type -> submit path runs without a live API call. */
  await s.eval(`
    window.__asked = [];
    window.chrome = { runtime: {
      sendMessage: (m) => {
        if (m && m.type === 'ask') { window.__asked.push(m.payload);
          return Promise.resolve({ words: ['increased','decreased','increase','decrease'],
                                   confidence: 0.92, why: 'scripted' }); }
        return Promise.resolve({ error: 'unstubbed' }); },
      onMessage: { addListener(){} } },
      storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}) },
                 onChanged: { addListener(){} } } };
    'ok'`, { awaitPromise: false });

  await s.eval(CONTENT_JS, { awaitPromise: false });
  await new Promise(r => setTimeout(r, 300));

  const api = await s.eval(`JSON.stringify(Object.keys(window.__alefSolver || {}))`);
  const keys = JSON.parse(api);
  check('commitCloze is exported', keys.includes('commitCloze'),
    keys.filter(k => /cloze|Cloze/i.test(k)).join(',') || 'no cloze exports');

  const rep = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));

  console.log('detection');
  check('recognised as a cloze question', rep.kind === 'cloze', `kind=${rep.kind}`);
  check('found 4 blanks', rep.clozeBlanks === 4, `${rep.clozeBlanks}`);

  console.log('\nword bank');
  const bank = rep.clozeWords || [];
  check('found the Word Bank', bank.length >= 5, `${bank.length} terms`);
  check('bank includes verb and noun forms',
    bank.includes('increased') && bank.includes('increase') &&
    bank.includes('decreased') && bank.includes('decrease'), bank.join(', '));

  console.log('\nsentence reconstruction');
  const text = rep.clozeText || '';
  console.log('  ' + text);
  check('blank markers present', (text.match(/\[BLANK \d\]/g) || []).length === 4,
    `${(text.match(/\[BLANK \d\]/g) || []).length} markers`);
  check('markers are numbered in order',
    ['[BLANK 1]', '[BLANK 2]', '[BLANK 3]', '[BLANK 4]'].every(m => text.includes(m)));
  check('includes the figures the blanks depend on',
    /18%.*20%.*19%.*17%/s.test(text.replace(/\s+/g, ' ')) || /Use these figures/.test(text),
    '');
  check('word bank terms are NOT inside the sentence',
    !/equal\s+stable/.test(text));
  check('surrounding grammar preserved',
    /employment\s+\[BLANK 1\]\s+in technology/.test(text) &&
    /largest\s+\[BLANK 3\]/.test(text));
  // Page chrome must not leak into what the model reads.
  check('footer buttons excluded from the text',
    !/go back/i.test(text) && !/submit answer/i.test(text),
    text.slice(-60));
  // Markers are padded with spaces, so the closing period sits on its own token:
  // "[BLANK 4] ." — accept either spacing.
  check('text ends at the question, not at the button bar',
    /\bbiggest\s+\[BLANK 4\]\s*\.?\s*$/.test(text), JSON.stringify(text.slice(-40)));

  // The live page has a sidebar button, "Check My Understanding", that is always
  // enabled — while Submit Answer is disabled until the answers register. A
  // prefix match on "check" took the sidebar button for Submit and clicked it.
  console.log('\nthe sidebar button is not Submit');
  const found = await s.eval(`(() => {
    const b = window.__alefSolver.findButton('submit', null, { requireEnabled: false });
    return b ? b.textContent.trim() : null; })()`);
  check('the Submit finder picks "Submit Answer", not the sidebar', /^submit answer/i.test(found || ''), JSON.stringify(found));

  console.log('\ntyping into controlled inputs');
  const typed = await s.eval(`
    window.__alefSolver.commitCloze(['increased','decreased','increase','decrease'],
                                    { autoSubmit: true, answerDelay: 60 })
  `);
  check('all four blanks accepted the text', typed?.selected === true,
    JSON.stringify(typed?.filled?.map(f => f.landed)));
  check('submitted', typed?.submitted === true, typed?.submitLabel || '');
  check('what it clicked was Submit Answer', /^submit answer/i.test(typed?.submitLabel || ''), JSON.stringify(typed?.submitLabel));
  check('the sidebar button was never clicked', await s.eval(`window.__sideClicks`) === 0);

  const pageAnswers = await s.eval(`JSON.stringify(window.__clozeAnswers)`);
  check('page state holds the typed words (not reverted)',
    pageAnswers === '["increased","decreased","increase","decrease"]', pageAnswers);
  check('page graded it correct', await s.eval(`window.__clozeCorrect`) === true);

  console.log('\nblank count mismatch is caught');
  const bad = await s.eval(`
    window.__alefSolver.commitCloze(['increased','decreased'], { autoSubmit: false })
  `);
  check('refuses when the count does not match', bad?.selected !== true && /mismatch/.test(bad?.error || ''),
    bad?.error || '');

  /* --- handler bound to a WRAPPER: must still reach it -------------------
     This is the "filled but didn't submit" symptom. The button is enabled, but
     the site listens on its container, so clicking the button itself does
     nothing unless we escalate. */
  console.log('\nreproducing "filled but did not submit"');
  await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + '?wrapper');
  await s.eval(`
    window.__asked = []; window.chrome = { runtime: {
      sendMessage: (m) => (m && m.type === 'ask')
        ? Promise.resolve({ words: ['increased','decreased','increase','decrease'], confidence: .9 })
        : Promise.resolve({ error: 'unstubbed' }),
      onMessage: { addListener(){} } },
      storage: { local: { get: (k,cb) => cb ? cb({}) : Promise.resolve({}) }, onChanged: { addListener(){} } } };
    'ok'`, { awaitPromise: false });
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await new Promise(r => setTimeout(r, 200));

  const wrapped = await s.eval(`
    window.__alefSolver.commitCloze(['increased','decreased','increase','decrease'],
                                    { autoSubmit: true, answerDelay: 50 })
  `);
  check('reached a handler bound to the wrapper', wrapped?.submitted === true,
    wrapped?.error || '');
  check('page recorded the submission', await s.eval(`window.__clozeSubmitted === true`) === true);

  /* --- the hard case: handler ignores untrusted events ------------------- */
  console.log('\nhandler ignoring synthetic events (?strict=1)');
  await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + '?strict=1');
  await s.eval(`
    window.__asked = []; window.chrome = { runtime: {
      sendMessage: (m) => (m && m.type === 'ask')
        ? Promise.resolve({ words: ['increased','decreased','increase','decrease'], confidence: .9 })
        : Promise.resolve({ error: 'unstubbed' }),
      onMessage: { addListener(){} } },
      storage: { local: { get: (k,cb) => cb ? cb({}) : Promise.resolve({}) }, onChanged: { addListener(){} } } };
    'ok'`, { awaitPromise: false });
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await new Promise(r => setTimeout(r, 200));

  const strictRes = await s.eval(`
    window.__alefSolver.commitCloze(['increased','decreased','increase','decrease'],
                                    { autoSubmit: true, answerDelay: 50 })
  `);
  const trusted = await s.eval(`window.__clozeSubmitted === true`);
  console.log(`  submitted=${strictRes?.submitted} error=${JSON.stringify(strictRes?.error)}`);
  // Either outcome is informative; what must NOT happen is a silent false success.
  check('does not report success when the page ignored the click',
    !(strictRes?.submitted === true && trusted !== true),
    `submitted=${strictRes?.submitted} pageAccepted=${trusted}`);

  /* --- "graded" must not be fooled by class names ------------------------- */
  console.log('\nresume check ignores class-name noise');
  const noisy = await s.eval(`(() => {
    const d = document.createElement('div');
    d.className = 'score correct-count incorrect feedback';
    d.textContent = '3 correct so far';
    document.body.prepend(d);
    return window.__alefSolver.isGraded();
  })()`);
  check('an unanswered page with "correct" in a class is NOT treated as graded', noisy === false,
    `isGraded=${noisy}`);

  /* --- a stopped run must leave a report the user can paste ---------------- */
  console.log('\nfailure report (submit ignored by the page)');
  await s.eval(`
    window.__saved = null;
    window.chrome.storage.local.set = o => { window.__saved = o; return Promise.resolve(); };
    'ok'`, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`);
  const saved = await s.eval(`window.__saved ? window.__saved.lastReport : null`);
  check('a report was saved', typeof saved === 'string' && saved.length > 200, `${(saved || '').length} chars`);
  check('report names the stage that failed', /stage:\s+submit/.test(saved || ''));
  check('report carries the real cause, not "not graded"',
    /click had no effect/.test(saved || '') && !/not graded/.test(saved || ''));
  check('report includes the page dump', /=== alef-solver dump ===/.test(saved || '') &&
    /submit button detail/.test(saved || ''));
  check('run released the busy flag', await s.eval(`window.__alefSolverRunning === false`) === true);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
