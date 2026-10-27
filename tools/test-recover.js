#!/usr/bin/env node
/* Getting going again by itself.
 *
 * A run that hits trouble — the model service failing, a reply that cannot be read — asks again on
 * the same question, waiting a little longer each time. When that does not help it reloads the page
 * and carries on where it was, with nobody pressing anything. Recovery is only switched on inside the
 * extension (chrome.runtime.id), so these pages give the stub an id.
 *
 * Runs the real content script against fixture-lesson.html. The model is scripted.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-lesson.html');
const PORT = 9351;
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

(async () => {
  const profile = scratch.mkdtemp('alef-recover-');
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
  for (let i = 0; i < 60; i++) { await sleep(250); try { v = await version(); break; } catch { } }
  if (!v) { console.error('✗ headless chrome never started'); process.exit(2); }
  console.log(`headless: ${v.Browser}\n`);

  const page = await findPage(/about:blank/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  /** The stub chrome, as the extension would give it. `failures`: how many questions the model
   *  answers with an error before it starts answering. Kept in sessionStorage so a reload keeps it. */
  const stub = (cfg, failures) => `
    window.__asked = window.__asked || [];
    if (sessionStorage.getItem('__fails') == null) sessionStorage.setItem('__fails', '${failures}');
    window.__cfg = ${JSON.stringify(cfg)};
    window.chrome = {
      runtime: {
        id: 'test-extension',
        sendMessage: (msg) => {
          if (msg && msg.type === 'ask') {
            const left = Number(sessionStorage.getItem('__fails'));
            if (left > 0) { sessionStorage.setItem('__fails', String(left - 1)); return new Promise(r => setTimeout(() => r({ error: 'deepseek-expert: unparseable reply "need answer JSON"' }), Number(sessionStorage.getItem('__slow') || 0))); }
            window.__asked.push(msg.payload);
            return Promise.resolve({ index: 0, letter: 'A', confidence: 0.9, why: 'scripted' });
          }
          return Promise.resolve({ error: 'not stubbed: ' + (msg && msg.type) });
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get: (k, cb) => cb ? cb(window.__cfg) : Promise.resolve(window.__cfg),
          set: () => Promise.resolve(),
        },
        onChanged: { addListener() {} },
      },
    };
    'ok'`;

  async function fresh(query, cfg, failures) {
    await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + query);
    await s.eval(`sessionStorage.clear(); 'ok'`);
    await s.eval(stub(cfg, failures), { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(200);
  }
  const hudText = () => s.eval(`(document.querySelector('#alef-solver-hud, .alef-hud, [id*=alef]') || {}).textContent || ''`);
  async function waitIdle(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(250);
      if (await s.eval(`!!window.__alefSolver && !window.__alefSolverRunning`)) return true;
    }
    return false;
  }

  console.log('=== the model fails twice, then answers ===');
  await fresh('', {}, 2);
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  check('the run finished', await waitIdle(60000));
  let asked = await s.eval(`window.__asked.length`);
  check('it asked again by itself and answered all three questions', asked === 3, `answered=${asked}`);
  check('nothing was left waiting for a reload', await s.eval(`sessionStorage.getItem('alefSolverResume')`) === null);

  console.log('\n=== the model keeps failing: reload, then carry on by itself ===');
  await fresh('', {}, 4);                // three asks again on the first question and the first ask all fail
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  // Ask + 3 more = 4 failures, then the reload.
  let reloaded = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await sleep(500);
    let gone;
    try { gone = await s.eval(`!window.__alefSolver`); } catch { gone = true; }
    if (gone) { reloaded = true; break; }
  }
  check('after asking again three times it reloads the page', reloaded);
  await sleep(1000);
  const saved = JSON.parse(await s.eval(`sessionStorage.getItem('alefSolverResume')`) || 'null');
  check('and leaves word to carry on after the reload', !!saved && saved.pending === true && saved.reloads === 1, JSON.stringify(saved));
  // The extension puts the script back into the reloaded page; here that is done by hand.
  await s.eval(stub({}, 0), { awaitPromise: false });
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await sleep(2500);                     // it looks a moment after the page loads
  check('the reloaded page starts the run by itself', await s.eval(`!!window.__alefSolverRunning`) || (await s.eval(`window.__asked.length`)) > 0);
  check('which then finishes', await waitIdle(60000));
  asked = await s.eval(`window.__asked.length`);
  check('and answers all three questions', asked === 3, `answered=${asked}`);
  check('and clears its note when done', await s.eval(`sessionStorage.getItem('alefSolverResume')`) === null);

  console.log('\n=== the tab crashes mid-run ===');
  await fresh('', {}, 0);
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  for (let i = 0; i < 40 && (await s.eval(`window.__asked.length`)) < 1; i++) await sleep(250);
  const noted = JSON.parse(await s.eval(`sessionStorage.getItem('alefSolverResume')`) || 'null');
  check('a running lesson leaves word that it is running', !!noted && noted.active === true, JSON.stringify(noted));
  await s.send('Page.reload', {});                    // no warning, no Stop: the page is simply gone
  await sleep(1500);
  await s.eval(stub({}, 0), { awaitPromise: false });
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await sleep(2500);
  check('the reloaded tab picks the run up by itself', await s.eval(`!!window.__alefSolverRunning`) || (await s.eval(`window.__asked.length`)) > 0);
  check('which then finishes', await waitIdle(60000));
  asked = await s.eval(`window.__asked.length`);
  check('and answers the lesson', asked === 3, `answered=${asked}`);
  check('and clears its note when done', await s.eval(`sessionStorage.getItem('alefSolverResume')`) === null);

  console.log('\n=== a lesson that keeps failing is left for the next one ===');
  // Every question fails, every time. After three reloads have not helped, the run must not stop:
  // it leaves the lesson (remembering it, so its card is passed over) for the class's lesson list.
  await fresh('?course=3', { autoNextLesson: true, maxLessons: 3 }, 999);
  const lessonBefore = await s.eval(`(location.hash.split('/lesson/')[1] || '').split('/')[0]`);
  // This page puts its own lesson back in the address when it loads, so the address is read as it is left.
  await s.eval(`addEventListener('beforeunload', () => sessionStorage.setItem('__leftFrom', location.hash)); 'ok'`);
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  let reloadsSeen = 0, left = null;
  for (let round = 0; round < 6 && !left; round++) {
    const t1 = Date.now();
    let gone = false;
    while (Date.now() - t1 < 30000) {
      await sleep(300);
      try { gone = await s.eval(`!window.__alefSolver`); } catch { gone = true; }
      if (gone) break;
    }
    if (!gone) break;
    reloadsSeen++;
    await sleep(800);
    const st = JSON.parse(await s.eval(`sessionStorage.getItem('alefSolverResume')`) || 'null');
    if (st && st.abandons >= 1) { left = { st, hash: await s.eval(`sessionStorage.getItem('__leftFrom')`) }; break; }
    await s.eval(`addEventListener('beforeunload', () => sessionStorage.setItem('__leftFrom', location.hash)); 'ok'`);
    await s.eval(stub({ autoNextLesson: true, maxLessons: 3 }, 999), { awaitPromise: false });     // the extension puts the script back
    await s.eval(CONTENT_JS, { awaitPromise: false });
  }
  check('three reloads first, then on the fourth it leaves the lesson', reloadsSeen === 4 && !!left, `reloads=${reloadsSeen}`);
  check('the lesson is remembered, so its card is passed over', !!left && left.st.skip.includes(lessonBefore), JSON.stringify(left && left.st));
  check('and the run is left waiting to carry on from the list', !!left && left.st.pending === true && left.st.lessons === 2, JSON.stringify(left && left.st));
  check('it went to the lesson list, not the same lesson', !!left && !/\/lesson\//.test(left.hash), left && left.hash);
  await s.eval(`sessionStorage.clear(); 'ok'`);

  console.log('\n=== switched off ===');
  await fresh('', { autoRecover: false }, 1);
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  check('the run finished', await waitIdle(20000));
  asked = await s.eval(`window.__asked.length`);
  check('it stops on the first failure, as before', asked === 0, `answered=${asked}`);

  console.log('\n=== Stop while it asks again ===');
  await fresh('', {}, 9);
  await s.eval(`sessionStorage.setItem('__slow', '1500'); 'ok'`);      // a slow service, so Stop lands while it asks again
  await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
  await sleep(2000);
  await s.eval(`window.__alefSolver.stop()`);
  check('the run ends', await waitIdle(20000));
  check('and no reload is left to pick it up again', await s.eval(`sessionStorage.getItem('alefSolverResume')`) === null);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
