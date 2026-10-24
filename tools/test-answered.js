#!/usr/bin/env node
/* A lesson opened part-way: its drop-down question had been answered, wrongly, and the page shows the
 * answer, a red mark and Try Again. The drop-down finder looked for the "Select…" every unanswered
 * drop-down starts with — there is none once a value is in — so the page held "no question" and the
 * run stopped with "no next lesson button appeared after Done". The control is found the way a person
 * finds it now: by the combobox it holds, whatever it shows.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'fixture-answered.html').replace(/\\/g, '/');
const PORT = 9376;
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
  const profile = scratch.mkdtemp('alef-answered-');
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

  async function load(query = '', answer = { picks: [2], confidence: 0.9, why: 'scripted', raw: '' }) {
    await s.goto(PAGE + query);
    await s.eval(`
      window.__asked = []; window.__stored = {};
      window.chrome = { runtime: { sendMessage: m => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload); return Promise.resolve(${JSON.stringify(answer)}); }
          return Promise.resolve({ error: 'no capture in tests' }); }, onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: o => { Object.assign(window.__stored, o); return Promise.resolve(); } }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));
  const ev = expr => s.eval(expr);

  console.log('=== a drop-down that already holds a (wrong) answer ===');
  await load('');
  check('(fixture) there is no "Select…" anywhere on the page, only the value', await ev(`!/select/i.test(document.querySelector('.lib-dropdown-container-wrapper').innerText)`) === true);
  check('(fixture) the combobox input is there but not visible, as on the live page', await ev(`(() => { const r = document.getElementById('react-select-3-input').getBoundingClientRect(); return r.width === 0 && r.height === 0; })()`) === true);
  const rep = await J(`window.__alefSolver.report()`);
  check('it is read as a drop-down question, with one blank', rep.kind === 'dropdown', `kind=${rep.kind}`);
  const p = await J(`(() => { const x = window.__alefSolver.scrape(); return { blanks: x.dropdown && x.dropdown.blanks.length, shows: x.dropdown && x.dropdown.blanks.map(b => b.shows), text: x.dropdown && x.dropdown.text }; })()`);
  check('the blank is the visible control (it shows "5"), not the hidden input', p.blanks === 1 && p.shows[0] === '5', JSON.stringify(p.shows));
  check('the sentence has the gap where it belongs', /The function has \[BLANK 1\] real zeros/.test(p.text || ''), JSON.stringify(p.text));

  console.log('\n=== answering it again, as a run does ===');
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  check('Try Again was pressed once', await ev(`window.__retryClicks`) === 1, `retryClicks=${await ev(`window.__retryClicks`)}`);
  const asked = await J(`window.__asked`);
  check('the model was asked once, as a drop-down', asked.length === 1 && asked[0].kind === 'dropdown', `asked=${asked.length}`);
  check('and told the answer that was already marked wrong ("5")', Array.isArray(asked[0].tried) && asked[0].tried.some(t => t && /\b5\b/.test(t.label || '')), JSON.stringify(asked[0].tried));
  check('it saw the menu\'s own options, in order', JSON.stringify(asked[0].dropdown.menus) === '[["2","3","4","5","6"]]', JSON.stringify(asked[0].dropdown.menus));
  check('the new answer ("4") was chosen and Submit pressed, and the page took it', await ev(`window.__value`) === '4' && await ev(`window.__submitClicks`) === 1 && await ev(`window.__graded`) === 'right', `value=${await ev(`window.__value`)} graded=${await ev(`window.__graded`)} submits=${await ev(`window.__submitClicks`)} hud=${JSON.stringify(await ev(`(document.getElementById('alef-solver-hud')||{}).textContent||''`))} report=${JSON.stringify((await ev(`window.__stored.lastReport||''`)).slice(0,300))}`);

  console.log('\n=== the ordinary, unanswered state still works ===');
  await load('?fresh=1');
  check('it is a drop-down question, found once (not twice)', (await J(`window.__alefSolver.scrape().dropdown.blanks.length`)) === 1);
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  check('no Try Again was needed, and the right answer went in', await ev(`window.__retryClicks`) === 0 && await ev(`window.__value`) === '4' && await ev(`window.__graded`) === 'right');

  console.log('\n=== two short drop-downs with the whole player around them (the "factored form" question) ===');
  await load('?two=1', { picks: [0, 0], confidence: 1, why: 'scripted', raw: '' });
  const reg = await J(`(() => { const d = window.__alefSolver.scrape().dropdown, m = document.getElementById('main'), all = document.getElementById('template-container'); return { blanks: d.blanks.length, regionHoldsFooter: d.region.contains(m), submitFoundWithWholePlayer: !!window.__alefSolver.findButton('submit', all, { requireEnabled: false }), submitFoundWithout: !!window.__alefSolver.findButton('submit', null, { requireEnabled: false }) }; })()`);
  check('the area taken for the question stops short of the footer, however little text there is', reg.blanks === 2 && reg.regionHoldsFooter === false, JSON.stringify(reg));
  check('and the footer Submit is found even when handed an area that holds the whole player', reg.submitFoundWithWholePlayer === true && reg.submitFoundWithout === true, JSON.stringify(reg));
  await s.eval(`window.__alefSolver.solve()`);
  await sleep(300);
  const hud2 = await ev(`(document.getElementById('alef-solver-hud') || {}).textContent || ''`);
  check('both answers went in and Submit was pressed', JSON.stringify(await ev(`window.__values`)) === '["(x − 1)(2x − 3) = 0","1 and 3/2"]' && await ev(`window.__submitClicks`) === 1, `values=${JSON.stringify(await ev(`window.__values`))} submits=${await ev(`window.__submitClicks`)} hud=${JSON.stringify(hud2)}`);
  check('and the page took it as right', await ev(`window.__graded`) === 'right', `graded=${await ev(`window.__graded`)}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
