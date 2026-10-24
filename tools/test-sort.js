#!/usr/bin/env node
/* The ordering question: "Arrange the items in the correct order." A list of items to put in
 * order by dragging, built on the real @dnd-kit/sortable (the library the live site uses).
 *
 * The live page (from a failure report) marks each item aria-roledescription="sortable" and
 * greys Submit out until the list has been changed. How a drag may start is the thing a page
 * hides, so the page runs in several configurations — a pointer drag that starts at once, one
 * that needs 8px of movement first, one that needs a press-and-hold, one that only the grip
 * image can start, and one that allows only the keyboard — and the tool has to find the way
 * that works and check the list really ended up in the order it was asked for.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'dndkit', 'sort.html').replace(/\\/g, '/');
const BUNDLE = path.join(ROOT, '.tmp', 'dndkit', 'sort.js');
const PORT = 9347;
process.env.CDP_PORT = String(PORT);

process.on('uncaughtException', e => { console.error('\n✗ UNCAUGHT:', e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('\n✗ UNHANDLED REJECTION:', e && e.stack || e); process.exit(1); });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

if (!fs.existsSync(BUNDLE)) { console.error('✗ run `node tools/dndkit/setup.js` first (it builds the dnd-kit page)'); process.exit(2); }

const chromeExe = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => p && fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = 'falling tone on eighty to state total';
const B = 'rising tone on dirhams for the question';
const C = 'flat tone on receipt showing more follows';

(async () => {
  const profile = scratch.mkdtemp('alef-sort-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1400,900', 'about:blank',
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

  async function load(query = '', answer = [1, 0, 2]) {
    await s.goto(PAGE + query);
    await s.eval(`
      window.__asked = []; window.__answer = ${JSON.stringify(answer)};
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ pairs: window.__answer, confidence: 0.9, why: 'scripted' }); }
          return Promise.resolve({ error: 'unstubbed' }); },
        onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() },
                   onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(300);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));
  const order = () => J(`window.__order`);

  /* ------------------------------------------------------------ detection */
  console.log('=== detection ===');
  await load();
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as an ordering question', rep.kind === 'sort', `kind=${rep.kind}`);
  check('the three items, in the order they are shown now', JSON.stringify(rep.sortItems) === JSON.stringify([A, B, C]), JSON.stringify(rep.sortItems));
  check('the instruction is what was above the list', /Put these pitch patterns in the order they occur/.test(rep.sortIntro) && /Arrange the items in the correct order/.test(rep.sortIntro), JSON.stringify(rep.sortIntro));
  check('and nothing else: not the items, the sidebar or the buttons',
    !/falling tone|rising tone|flat tone|Sample Lesson|Need Help|Play audio|Go Back/i.test(rep.sortIntro), JSON.stringify(rep.sortIntro));
  check('it is not mistaken for a drag-and-drop or multiple-choice question', rep.dragItems.length === 0 && rep.options.length === 0);
  check('the report says how it was found, and outlines the page from its main area', /lib-sort-item/.test(rep.skeleton) || /sortable/.test(rep.skeleton), rep.skeleton.slice(0, 80).replace(/\n/g, ' | '));

  /* ---------------------------------------- each way an item can be picked up */
  const CONFIGS = [
    ['a pointer drag that starts at once', '?sensor=pointer', 'drag the item'],
    ['a pointer drag that needs 8px of movement first', '?sensor=distance', 'drag the item'],
    ['a pointer drag that needs a press and hold (250ms)', '?sensor=delay', 'press, hold, then drag'],
    ['only the grip image starts a drag', '?sensor=pointer&handle=1', 'drag by its handle'],
    ['the keyboard only (Space, then the arrows)', '?sensor=keyboard', 'keyboard'],
  ];
  for (const [label, query, via] of CONFIGS) {
    console.log(`\n=== ${label} ===`);
    await load(query);
    const t0 = Date.now();
    const out = await J(`window.__alefSolver.commitSort([1, 0, 2], { autoSubmit: true, answerDelay: 50 })`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, moves: ${out.moves.map(m => `${m.item.slice(0, 12)}…→${m.to} via ${m.via}`).join(' ; ')}`);
    check('the list ends up in the order asked for', JSON.stringify(await order()) === JSON.stringify([B, A, C]), JSON.stringify(await order()));
    check('Submit became available and was pressed', out.selected === true && out.submitted === true, out.error || '');
    check('the page graded it correct', await s.eval(`window.__sortCorrect === true`) === true);
    check(`found the way that works: ${via}`, out.moves.length > 0 && out.moves.every(m => m.via === via), JSON.stringify(out.moves.map(m => m.via)));
    check('it was Submit Answer that got clicked, never the sidebar button', /^submit answer/i.test(out.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0, JSON.stringify(out.submitLabel));
  }

  /* ------------------------------------------------------- other orderings */
  console.log('\n=== other orders ===');
  for (const [want, label] of [[[2, 1, 0], 'reversed'], [[0, 2, 1], 'only the last two swapped'], [[1, 2, 0], 'a rotation']]) {
    await load('?sensor=pointer');
    const out = await J(`window.__alefSolver.commitSort(${JSON.stringify(want)}, { autoSubmit: true, answerDelay: 50 })`);
    const texts = [A, B, C];
    check(`${label} (${want.join(',')})`, JSON.stringify(await order()) === JSON.stringify(want.map(i => texts[i])) && out.submitted === true, `${JSON.stringify(await order())} ${out.error || ''}`);
  }

  await load('?sensor=pointer');
  const same = await J(`window.__alefSolver.commitSort([0, 1, 2], { autoSubmit: true, answerDelay: 50 })`);
  check('already in the order asked for: Submit is greyed out until something changes, so it nudges the list and still submits',
    same.submitted === true && await s.eval(`window.__sortSubmitted === true`) === true, same.error || '');
  check('and puts the list back as it was', JSON.stringify(await order()) === JSON.stringify([A, B, C]), JSON.stringify(await order()));

  /* ------------------------------------------------ end to end via the model */
  console.log('\n=== solveOne with a scripted model reply ===');
  await load('?sensor=pointer', [1, 0, 2]);
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solveOne reported ok', res.ok === true, res.reason || '');
  check('the page graded it correct', await s.eval(`window.__sortCorrect === true`) === true);
  const sent = await J(`window.__asked[0]`);
  check('the model was sent kind=sort with the instruction and the items, numbered in the order shown',
    sent.kind === 'sort' && JSON.stringify(sent.sort.items) === JSON.stringify([A, B, C]) && /Arrange the items in the correct order/.test(sent.sort.intro), JSON.stringify(sent.sort));
  check('no reading passage was invented, and the model is told no wrong answers yet', !sent.passage && (!sent.tried || sent.tried.length === 0));
  check('the attempt is described in words, for a retry', /rising tone on dirhams.* → .*falling tone on eighty.* → .*flat tone/.test(res.attempt || ''), JSON.stringify(res.attempt));

  await load('?sensor=pointer', [1, 0]);
  const short = await J(`window.__alefSolver.solveOne(true)`);
  check('a reply that orders only two of three items is refused, not guessed at', short.ok === false && short.reason === 'sort-count', JSON.stringify(short));
  check('and the list was not touched', JSON.stringify(await order()) === JSON.stringify([A, B, C]));

  /* ------------------------------------------- the page offers "I'll try later" */
  // The live ordering question (a writing activity's "arrange the ideas") had the button, and
  // it was solved: the skip was once pressed only where the wording began "Listen".
  console.log('\n=== the question offers "I\'ll try later" ===');
  await load('?sensor=pointer&later=1');
  await s.eval(`window.__alefSolver.solve()`, { awaitPromise: false });
  for (let i = 0; i < 40 && await s.eval(`window.__alefSolverRunning`); i++) await sleep(250);
  await sleep(300);
  check('an ordering question that offers it: the button was pressed, once', await s.eval(`window.__later`) === 1, JSON.stringify(await s.eval(`window.__later`)));
  check('the model was never asked, and nothing was submitted', (await J(`window.__asked.length`)) === 0 && !(await s.eval(`window.__sortSubmitted`)), JSON.stringify(await J(`window.__asked.length`)));
  check('the page moved on (the question is gone)', await s.eval(`!!document.getElementById('skipped')`) === true);

  await load('?sensor=pointer');
  await s.eval(`window.__alefSolver.solve()`, { awaitPromise: false });
  for (let i = 0; i < 40 && await s.eval(`window.__alefSolverRunning`); i++) await sleep(250);
  await sleep(300);
  check('the same question with no button on it is solved as before', (await J(`window.__asked.length`)) === 1 && await s.eval(`window.__sortCorrect === true`) === true, JSON.stringify(await J(`window.__asked.length`)));

  /* ---------------------------------------------------------------- refusals */
  console.log('\n=== refusals ===');
  await load('?sensor=pointer');
  const dup = await J(`window.__alefSolver.commitSort([0, 0, 1], { autoSubmit: false })`);
  check('the same item twice', dup.selected !== true && /exactly once/.test(dup.error || ''), dup.error || '');
  const range = await J(`window.__alefSolver.commitSort([0, 1, 7], { autoSubmit: false })`);
  check('an item that does not exist', range.selected !== true && /exactly once/.test(range.error || ''), range.error || '');
  const few = await J(`window.__alefSolver.commitSort([0, 1], { autoSubmit: false })`);
  check('too few items', few.selected !== true && /exactly once/.test(few.error || ''), few.error || '');
  check('and none of them touched the list', JSON.stringify(await order()) === JSON.stringify([A, B, C]));

  console.log('\n=== not an ordering question ===');
  await load('?sensor=pointer');
  await s.eval(`document.querySelectorAll('[aria-roledescription="sortable"]').forEach(e => e.removeAttribute('aria-roledescription')); 'ok'`, { awaitPromise: false });
  const gone = await J(`window.__alefSolver.report()`);
  check('with the sortable markers gone it is not called an ordering question', gone.kind !== 'sort', `kind=${gone.kind}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
