#!/usr/bin/env node
/* A lesson opened part-way, in Arabic: the question had been answered wrongly and showed the answer in red
 * and one button, "أحاولُ ثانيـةً" ("I try again"). The tool knew Try Again only in the imperative
 * ("حاول ثانية"), so it saw neither Submit nor Try Again, took the question for a fresh one, and pressed
 * cards the page had locked. Now the first-person wording is Try Again, and the run presses it, answers
 * again, and tells the model what was marked wrong.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'fixture-locked.html').split(path.sep).join('/');
const PORT = 9378;
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
  const profile = scratch.mkdtemp('alef-locked-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1500,1000', 'about:blank',
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
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });

  // The model is scripted: one choice index per call.
  async function load(query = '', script = [1]) {
    await s.goto(PAGE + query);
    await s.eval(`
      window.__asked = []; window.__stored = {}; window.__script = ${JSON.stringify(script)};
      window.chrome = { runtime: { sendMessage: m => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload); const i = window.__asked.length - 1; return Promise.resolve({ index: window.__script[i] ?? 0, letter: 'X', confidence: 0.6, why: 'scripted' }); }
          return Promise.resolve({ error: 'no capture in tests' }); }, onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: o => { Object.assign(window.__stored, o); return Promise.resolve(); } }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));
  const ev = expr => s.eval(expr);

  console.log('=== the page as it was left: answered wrongly, one button ===');
  await load('');
  check('(fixture) the marked card is locked: a press on another card changes nothing', await (async () => {
    await ev(`document.querySelectorAll('.lib-mcq-option-container')[3].click(); 'ok'`);
    return await ev(`window.__chosen`) === 2;
  })());
  check('the button is found as Try Again', await ev(`(() => { const b = window.__alefSolver.findButton('retry', null); return !!b && /ثاني/.test(b.textContent); })()`) === true);
  check('and there is no Submit and no Next', await ev(`window.__alefSolver.findButton('submit', null, { requireEnabled: false }) === null && window.__alefSolver.findButton('next', null, { requireEnabled: false }) === null`) === true);
  check('the question still reads as a four-choice question', await J(`window.__alefSolver.report()`).then(r => r.kind === 'choice' && r.options.length === 4));

  console.log('\n=== answering it again, as a run does ===');
  await load('', [1]);
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  const asked = await J(`window.__asked`);
  check('Try Again was pressed once, and the locked cards were never pressed', await ev(`window.__retryClicks`) === 1 && await ev(`window.__presses`) === 1, `retryClicks=${await ev(`window.__retryClicks`)} presses=${await ev(`window.__presses`)}`);
  check('the model was asked once, and told card C was already marked wrong', asked.length === 1 && Array.isArray(asked[0].tried) && asked[0].tried.some(t => /^C\. /.test(t.label || '') && /فإنَّ العلمَ/.test(t.label || '')), JSON.stringify(asked[0] && asked[0].tried));
  check('the answer (B) went in, Submit was pressed, and the page took it', await ev(`window.__chosen`) === 1 && await ev(`window.__submitClicks`) === 1 && await ev(`window.__graded`) === 'right', `chosen=${await ev(`window.__chosen`)} graded=${await ev(`window.__graded`)}`);

  console.log('\n=== the marked card shows it by its classes only ===');
  await load('?noaria=1', [1]);
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  const askedNo = await J(`window.__asked`);
  check('it is still recorded as the answer that was wrong', askedNo.length === 1 && askedNo[0].tried.some(t => /^C\. /.test(t.label || '')), JSON.stringify(askedNo[0] && askedNo[0].tried));
  check('and the question is answered', await ev(`window.__graded`) === 'right');

  console.log('\n=== the new answer is wrong too: Try Again is pressed in Arabic again ===');
  await load('', [3, 1]);
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  const asked2 = await J(`window.__asked`);
  check('it asked twice, the second time knowing both answers that were wrong', asked2.length === 2 && asked2[1].tried.length === 2 && asked2[1].tried.some(t => /^C\. /.test(t.label)) && asked2[1].tried.some(t => /^D\. /.test(t.label)), JSON.stringify(asked2.map(a => a.tried)));
  check('Try Again was pressed twice, and the second answer was taken as right', await ev(`window.__retryClicks`) === 2 && await ev(`window.__graded`) === 'right', `retryClicks=${await ev(`window.__retryClicks`)} graded=${await ev(`window.__graded`)}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
