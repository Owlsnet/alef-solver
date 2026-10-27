#!/usr/bin/env node
/* A question with several boxes, marked wrong. The retry asked the model again, and it changed every box
 * — turning a right one wrong, so the question never came out right (a live report, build 0.6.54). Now:
 * how the page marked each box is read before Try Again; a box marked right keeps its answer; and the
 * model is told which to keep and which to change. Also: the player's own "Loading…" spinner is waited
 * for, not taken for an empty screen.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, execSync } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const CONTENT_JS = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const PORT = 9355;
process.env.CDP_PORT = String(PORT);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ------------------------------------------------------------ the prompt (no browser) */
  console.log('what the model is told on a retry');
  const ctx = vm.createContext({ console, fetch: async () => { throw new Error('no'); }, chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } } } });
  vm.runInContext(BG, ctx);
  const base = { kind: 'dropdown', stem: 'x', dropdown: { text: 'a [BLANK 1] b [BLANK 2] c [BLANK 3]', menus: [['p', 'q'], ['r', 's'], ['t', 'u']] }, options: [], images: [], image: null, imageCount: 0 };
  let txt = ctx.buildText({ ...base, tried: [{ label: 'p / r / t', blanks: [{ value: 'p', mark: 'right' }, { value: 'r', mark: 'wrong' }, { value: 't', mark: 'right' }] }] });
  check('each box is listed with how the page marked it', /BLANK 1: p — marked CORRECT: keep exactly this/.test(txt) && /BLANK 2: r — marked WRONG/.test(txt), txt.split('\n').slice(-5).join(' | '));
  check('and it is told to change only the wrong ones', /change only the ones marked wrong/.test(txt));
  txt = ctx.buildText({ ...base, tried: [{ label: 'p / r / t', blanks: [{ value: 'p', mark: '' }, { value: 'r', mark: '' }, { value: 't', mark: '' }] }] });
  check('with no marks, it is told to change as little as possible', /do not change everything/.test(txt));
  txt = ctx.buildText({ ...base, kind: 'choice', options: [{ text: 'a' }, { text: 'b' }], tried: [{ label: 'A. a' }] });
  check('a single-answer question is told what was wrong, as before', /PREVIOUS ATTEMPTS/.test(txt) && /A\. a/.test(txt));

  /* ------------------------------------------------------------ in the page */
  const profile = scratch.mkdtemp('alef-marks-');
  const child = spawn(path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(250); try { await version(); break; } catch {} }
  const s = await Session.attach((await findPage(/about:blank/)).webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.eval(`document.body.innerHTML = \`
    <div class="lib-dropdown-input-field-container lib-correct"><div class="box" id="b1" style="width:90px;height:40px">p</div></div>
    <div class="lib-dropdown-input-field-container lib-incorrect"><div class="box" id="b2" style="width:90px;height:40px">r</div></div>
    <div class="text-right pull-right"><div class="box" id="b3" style="width:90px;height:40px">t</div></div>
    <div><span aria-label="Incorrect answer"></span><div class="box" id="b4" style="width:90px;height:40px">u</div></div>
    <div><div class="box" id="b5" aria-invalid="true" style="width:90px;height:40px">v</div></div>
    <div class="player-flex"><div data-testid="spinner-container" style="width:24px;height:24px"></div><p>Loading...</p></div>\`;
    window.chrome = { runtime: { sendMessage: () => Promise.resolve({}), onMessage: { addListener() {} } }, storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } } }; 'ok'`);
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await sleep(300);
  const marks = JSON.parse(await s.eval(`JSON.stringify(['b1','b2','b3','b4','b5'].map(id => window.__alefSolver.blankMark(document.getElementById(id))))`));
  check('a box inside lib-correct is read as marked right', marks[0] === 'right', marks[0]);
  check('lib-incorrect as marked wrong (not "correct")', marks[1] === 'wrong', marks[1]);
  check('a layout class like text-right is NOT taken for a mark', marks[2] === '', marks[2]);
  check('an icon labelled "Incorrect" beside it marks it wrong', marks[3] === 'wrong', marks[3]);
  check('aria-invalid marks it wrong', marks[4] === 'wrong', marks[4]);

  const kept = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.keepMarkedRight(['q', 's', 'u'], [{ label: 'p / r / t', blanks: [{ value: 'p', mark: 'right' }, { value: 'r', mark: 'wrong' }, { value: 't', mark: '' }] }]))`));
  check('a box marked right keeps its answer though the model changed it; the others take the new answer', JSON.stringify(kept) === JSON.stringify(['p', 's', 'u']), JSON.stringify(kept));
  const first = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.keepMarkedRight(['q', 's'], []))`));
  check('the first try is left as the model gave it', JSON.stringify(first) === JSON.stringify(['q', 's']));

  check('the player\'s "Loading…" spinner is seen', await s.eval(`window.__alefSolver.activityLoading()`) === true);
  await s.eval(`document.querySelector('.player-flex').style.display = 'none'; 'ok'`);
  check('and gone when it is gone', await s.eval(`window.__alefSolver.activityLoading()`) === false);

  s.close(); try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e.message || e); process.exit(1); });
