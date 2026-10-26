#!/usr/bin/env node
/* End-to-end test of the lesson run loop: submit -> Next -> repeat -> stop.
 *
 * Fake answers are injected so the test proves the CONTROL FLOW (does it submit,
 * does it advance, does it stop, does it reuse the passage) independent of what
 * any model would say. A separate scripted-answers option lets each question get
 * a different pick, which is what catches "it always clicks the first choice".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
// ALEF_CONTENT points at a deliberately broken copy, to prove a check can fail.
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-lesson.html');
const PORT = 9334;
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
  const profile = require('./scratch.js').mkdtemp('alef-lesson-');
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

  /* The fixture must sit at a /lesson/<id> path so lessonKey() works. */
  const url = 'file:///' + FIXTURE.replace(/\\/g, '/') + '?p=/lesson/abc-123';
  await s.goto(url);
  console.log('loaded fixture-lesson.html (3 questions, one passage)\n');

  /* Stub chrome.runtime before injecting — the scraper isn't an extension here. */
  await s.eval(`
    window.__asked = [];
    window.__scripted = [1, 2, 0];   // different answer per question, on purpose
    window.chrome = {
      runtime: {
        sendMessage: (msg) => {
          if (msg && msg.type === 'ask') {
            window.__asked.push(msg.payload);
            const i = window.__asked.length - 1;
            return Promise.resolve({ index: window.__scripted[i] ?? 0, letter: 'X', confidence: 0.9, why: 'scripted' });
          }
          return Promise.resolve({ error: 'not stubbed: ' + (msg && msg.type) });
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => {}, },
        onChanged: { addListener() {} },
      },
    };
    'ok'
  `, { awaitPromise: false });

  await s.eval(CONTENT_JS, { awaitPromise: false });
  check('scraper loaded with a stubbed runtime', await s.eval(`typeof window.__alefSolver === 'object'`) === true);

  /* Lesson key must come from the URL. */
  const lk = await s.eval(`window.__alefSolver.lessonKey()`);
  check('lessonKey reads the lesson id from the URL', lk === 'abc-123', `got "${lk}"`);

  const rep = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));
  check('found the first question', rep.options.length === 4, `${rep.options.length} choices`);

  /* --- the run loop, driven exactly as the extension drives it ----------- */

  console.log('\nlesson run');
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });

  // Wait for the run to finish: 3 submissions then no further Next.
  let done = false;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 250));
    const n = await s.eval(`window.__lessonSubmissions.length`);
    const finished = await s.eval(`!window.__alefSolverRunning`);
    if (n >= 3 && finished !== false) { done = true; break; }
  }
  // give the loop a moment to exit
  await new Promise(r => setTimeout(r, 1200));

  const subs = await s.eval(`JSON.stringify(window.__lessonSubmissions)`);
  const advanced = await s.eval(`window.__advanced`);
  const opens = await s.eval(`window.__passageOpens || 0`);
  const asked = await s.eval(`window.__asked.length`);
  const grids = await s.eval(`JSON.stringify(window.__asked.map(p => p.options.length))`);
  const passages = await s.eval(`JSON.stringify(window.__asked.map(p => (p.passage || '').length))`);
  const stems = await s.eval(`JSON.stringify(window.__asked.map(p => (p.stem || '').slice(0, 34)))`);

  console.log(`  submissions:   ${subs}`);
  console.log(`  advanced:      ${advanced}`);
  console.log(`  passage opens: ${opens}`);
  console.log(`  api calls:     ${asked}`);
  console.log(`  stems:         ${stems}`);
  console.log(`  passage lens:  ${passages}`);

  const chosen = JSON.parse(subs);
  check('submitted 3 answers', chosen.length === 3, `${chosen.length}`);
  check('each question got its own scripted pick',
    JSON.stringify(chosen) === '[1,2,0]', `expected [1,2,0], got ${subs}`);
  check('advanced twice (Next clicked 2 of 3 questions)', advanced === 2, `${advanced}`);
  check('the sidebar "Check My Understanding" button was never clicked',
    await s.eval(`window.__sideClicks`) === 0);
  check('stopped at the end — no third Next', advanced === 2);

  // The last question ends with "Done", not "Next". It must be recognised as the
  // way out, reported plainly, left for the person to press — and never taken
  // for a Submit button.
  const hudText = await s.eval(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`);
  check('says it was the last question and names the Done button',
    /last question/i.test(hudText) && /Done/.test(hudText), JSON.stringify(hudText));
  check('did not press Done by itself', await s.eval(`window.__doneClicks`) === 0);
  check('"Done" is not mistaken for Submit',
    await s.eval(`(() => { const b = window.__alefSolver.findButton('submit', null, { requireEnabled: false });
                           return !b || !/done/i.test(b.textContent); })()`) === true);
  check('"Done" is found as the finish button',
    await s.eval(`(() => { const b = window.__alefSolver.findButton('finish', null); return !!b && /done/i.test(b.textContent); })()`) === true);
  check('asked the model 3 times, once per question', asked === 3, `${asked}`);
  check('each question was read with 4 choices', JSON.parse(grids).every(n => n === 4), grids);

  // The whole point of the cache: the passage is fetched once, reused thereafter.
  check('passage opened from the button exactly once', opens === 1, `${opens} opens`);
  const plens = JSON.parse(passages);
  check('every question was sent a passage', plens.every(n => n > 200), passages);
  check('passage text identical across questions (cached)',
    new Set(plens).size === 1, `${new Set(plens).size} distinct lengths`);

  // Distinct stems prove it really moved through the lesson.
  check('three different questions were solved',
    new Set(JSON.parse(stems)).size === 3, stems);

  /* --- a second run on the same lesson reuses the cache immediately ------ */

  console.log('\nsecond run (cache warm)');
  await s.eval(`window.__lessonSubmissions = []; window.__advanced = 0; window.__passageOpens = 0;`);
  await s.eval(`location.reload()`, { awaitPromise: false });
  await new Promise(r => setTimeout(r, 1500));
  await s.send('Runtime.enable');
  await s.eval(`
    window.__asked = []; window.__scripted = [1,2,0];
    window.chrome = { runtime: { sendMessage: (m) => {
      if (m && m.type === 'ask') { window.__asked.push(m.payload);
        const i = window.__asked.length - 1;
        return Promise.resolve({ index: window.__scripted[i] ?? 0, confidence: 0.9 }); }
      return Promise.resolve({ error: 'unstubbed' }); }, onMessage: { addListener(){} } },
      storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}) }, onChanged: { addListener(){} } } };
    'ok'`);
  await s.eval(CONTENT_JS, { awaitPromise: false });

  const rep2 = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));
  check('page reloaded back to question 1', rep2.options.length === 4);

  /* --- a lesson that moves on by itself: no Next button after Submit ------- */
  // The live case: the run answered question 1, found no Next button, and stopped with "nothing more to do
  // here" — over a fresh, unanswered question the page had put up by itself.
  console.log('\na lesson that moves on after Submit by itself');
  await s.goto(url + '&auto=1');
  await s.eval(`
    window.__asked = []; window.__scripted = [1,2,0];
    window.chrome = { runtime: { sendMessage: (m) => {
      if (m && m.type === 'ask') { window.__asked.push(m.payload);
        const i = window.__asked.length - 1;
        return Promise.resolve({ index: window.__scripted[i] ?? 0, confidence: 0.9 }); }
      return Promise.resolve({ error: 'unstubbed' }); }, onMessage: { addListener(){} } },
      storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (o) => { window.__stored = o; return Promise.resolve(); } }, onChanged: { addListener(){} } } };
    'ok'`);
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  for (let i = 0; i < 160; i++) {
    await new Promise(r => setTimeout(r, 250));
    if ((await s.eval(`window.__lessonSubmissions.length`)) >= 3) break;
  }
  // After the last answer the run waits a few seconds for a Next that is never coming, and only then looks for Done.
  for (let i = 0; i < 60; i++) {
    if (/last question/i.test(await s.eval(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`))) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const autoSubs = await s.eval(`JSON.stringify(window.__lessonSubmissions)`);
  const autoHud = await s.eval(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`);
  check('(fixture) the page moved on by itself, with no Next button pressed', await s.eval(`window.__autoAdvanced`) === 2 && await s.eval(`window.__advanced`) === 0, `autoAdvanced=${await s.eval(`window.__autoAdvanced`)} advanced=${await s.eval(`window.__advanced`)}`);
  check('all three questions were answered', autoSubs === '[1,2,0]', autoSubs);
  check('the model was asked once per question', (await s.eval(`window.__asked.length`)) === 3);
  check('it stopped at the last question, naming the Done button — not at the first', /last question/i.test(autoHud) && /Done/.test(autoHud), JSON.stringify(autoHud));

  // And when a lesson really does end with nothing to press, the stop says so AND leaves a fresh report: it used
  // to leave none, so "Copy last report" handed back one from an older run on another page.
  console.log('\na lesson that ends with nothing to press');
  await s.goto(url + '&auto=1&nodone=1');
  await s.eval(`
    window.__asked = []; window.__scripted = [1,2,0]; window.__stored = null;
    window.chrome = { runtime: { sendMessage: (m) => {
      if (m && m.type === 'ask') { window.__asked.push(m.payload);
        const i = window.__asked.length - 1;
        return Promise.resolve({ index: window.__scripted[i] ?? 0, confidence: 0.9 }); }
      return Promise.resolve({ error: 'unstubbed' }); }, onMessage: { addListener(){} } },
      storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (o) => { window.__stored = Object.assign(window.__stored || {}, o); return Promise.resolve(); } }, onChanged: { addListener(){} } } };
    'ok'`);
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await s.eval(`!!(window.__stored && window.__stored.lastReport)`)) break;
  }
  const noNextReport = await s.eval(`String((window.__stored || {}).lastReport || '')`);
  check('all three were answered before it stopped', (await s.eval(`window.__lessonSubmissions.length`)) === 3);
  check('a fresh report was saved, naming the stage and what the page looked like', /stage:\s+no-next/.test(noNextReport) && /answered, but there is no Next button/.test(noNextReport) && /=== alef-solver dump ===/.test(noNextReport), noNextReport.slice(0, 160).replace(/\n/g, ' | '));
  check('and the status line points at it', /Copy last report|Developer mode/.test(await s.eval(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`)));

  /* ------------------------------------------------------------------ a rate limit mid-lesson */
  // A service saying it is limiting the account is not a failure to end the run on: wait for it to
  // clear, with the time left on the status line, and ask the same question again. Stop still works.
  const limitedStub = (script) => `
    window.__asked = []; window.__scripted = [1,2,0]; window.__stored = null; window.__huds = []; window.__calls = 0;
    ${script}
    new MutationObserver(recs => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 3 && /^alef · /.test(n.textContent)) window.__huds.push(n.textContent); })
      .observe(document.documentElement, { subtree: true, childList: true });
    window.chrome = { runtime: { sendMessage: (m) => {
      if (m && m.type === 'ask') {
        window.__calls++;
        const turned = window.__turnAway && window.__turnAway(window.__asked.length);
        if (turned) return Promise.resolve(turned);
        window.__asked.push(m.payload);
        const i = window.__asked.length - 1;
        return Promise.resolve({ index: window.__scripted[i] ?? 0, confidence: 0.9 }); }
      return Promise.resolve({ error: 'unstubbed' }); }, onMessage: { addListener(){} } },
      storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (o) => { window.__stored = Object.assign(window.__stored || {}, o); return Promise.resolve(); } }, onChanged: { addListener(){} } } };
    'ok'`;
  const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

  console.log('\na rate limit in the middle of a lesson is waited out');
  await s.goto(url);
  await s.eval(limitedStub(`
    let left = 2;                                   // the second question is turned away twice first
    window.__turnAway = (answered) => (answered === 1 && left-- > 0)
      ? { error: 'the Gemini site is limiting this account (HTTP 429)', rateLimited: true, retryAfterMs: 40, limitNote: 'the Gemini site is limiting this account (error 1095)' }
      : null;`));
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  await until(async () => (await s.eval(`window.__lessonSubmissions.length`)) >= 3 && (await s.eval(`!window.__alefSolverRunning`)));
  check('the run carried on past it and answered all three questions', (await s.eval(`JSON.stringify(window.__lessonSubmissions)`)) === '[1,2,0]', await s.eval(`JSON.stringify(window.__lessonSubmissions)`));
  check('the turned-away question was asked three times in all: twice refused, then answered', (await s.eval(`window.__calls`)) === 5 && (await s.eval(`window.__asked.length`)) === 3, `calls=${await s.eval(`window.__calls`)}`);
  const hudsA = await s.eval(`JSON.stringify(window.__huds)`);
  check('the status line counted the wait down, naming the reason', /⏳ the Gemini site is limiting this account \(error 1095\) — trying again in 0:\d\d \(Stop cancels\)/.test(hudsA), hudsA.slice(0, 200));
  check('and no failure report was saved for it', !(await s.eval(`!!(window.__stored && window.__stored.lastReport)`)));

  console.log('\nStop during the wait ends the run quietly');
  await s.goto(url);
  await s.eval(limitedStub(`window.__turnAway = () => ({ error: 'limited', rateLimited: true, limitNote: 'DeepSeek is rate-limiting this account' });`));
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  const counting = await until(async () => /⏳ DeepSeek is rate-limiting this account — trying again in 0:1[45]/.test(await s.eval(`JSON.stringify(window.__huds)`)), 8000);
  check('with no Retry-After it starts at the first wait of the schedule, fifteen seconds', counting, (await s.eval(`JSON.stringify(window.__huds)`)).slice(0, 160));
  const tStop = Date.now();
  await s.eval(`window.__alefSolver.stop(); 'ok'`);
  const ended = await until(async () => await s.eval(`!window.__alefSolverRunning`), 6000);
  check('Stop ends it within a couple of seconds, not at the end of the wait', ended && Date.now() - tStop < 4000, `${Date.now() - tStop}ms`);
  check('it had asked once, and nothing was submitted', (await s.eval(`window.__calls`)) === 1 && (await s.eval(`window.__lessonSubmissions.length`)) === 0);
  check('no failure report was saved: a Stop is not a failure', !(await s.eval(`!!(window.__stored && window.__stored.lastReport)`)));
  check('and the status line says it was stopped', /stopped/i.test(await s.eval(`JSON.stringify(window.__huds.slice(-3))`)), await s.eval(`JSON.stringify(window.__huds.slice(-3))`));

  console.log('\nany other error still ends the run with a report');
  await s.goto(url);
  await s.eval(limitedStub(`window.__turnAway = () => ({ error: 'the account\\'s default model: HTTP 500 boom' });`));
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  await until(async () => await s.eval(`!!(window.__stored && window.__stored.lastReport)`), 8000);
  check('a failure that is not a rate limit is not waited out', (await s.eval(`window.__calls`)) === 1, `calls=${await s.eval(`window.__calls`)}`);
  check('and it leaves its report, naming the stage', /stage:\s+answer/.test(await s.eval(`String((window.__stored || {}).lastReport || '')`)));

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
