#!/usr/bin/env node
/* Drives the drag-and-drop type against the REAL @dnd-kit/core — the library the
   live site is built on (its hidden "Draggable item … was dropped over droppable
   area …" text is dnd-kit's own wording) — rather than against an imitation of it.

   test-drag.js uses a hand-written page, so it can only confirm what I already
   assumed about the library. This one shows whether synthetic pointer events
   actually start a real PointerSensor / MouseSensor drag, whether the drop target
   it picks is the gap we aimed at, and whether the markup the library renders by
   itself (attributes on a draggable, screen-reader instructions, live region)
   confuses the detector. It does so under each activation rule and collision
   strategy an app can configure.

   Needs a one-off:  node tools/dndkit/setup.js   (installs into .tmp, not C:) */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
// ALEF_CONTENT runs the suite against a deliberately broken copy, to prove a check
// would really have caught the thing it is there for.
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = path.join(__dirname, 'dndkit', 'page.html');
const BUNDLE = path.join(scratch.dir, 'dndkit', 'app.js');
if (!fs.existsSync(BUNDLE)) {
  console.error('✗ the dnd-kit page is not built yet. Run once:  node tools/dndkit/setup.js');
  process.exit(3);
}
const PORT = 9340;
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

const ITEMS = ['quantity', 'tuition fees', 'consumerism', 'vision', 'wages', 'hire'];
const EXPECTED = ['tuition fees', 'hire', 'vision'];

// What an app can configure: how a drag may start, and how the target is chosen.
const VARIANTS = [
  ['PointerSensor, no activation rule',              '?sensor=pointer'],
  ['PointerSensor, must move 8px first',             '?sensor=distance'],
  ['PointerSensor, must be held 250ms first',        '?sensor=delay'],
  ['MouseSensor + TouchSensor',                      '?sensor=mouse'],
  ['8px rule, pointerWithin, DragOverlay',           '?sensor=distance&collision=pointer&overlay=1'],
  ['8px rule, closestCenter',                        '?sensor=distance&collision=center'],
  ['the keyboard only (no pointer sensor)',          '?sensor=keyboard'],
  ['an overlay only as wide as the label (the live page)', '?sensor=distance&overlay=chip'],
  ['the same, with the keyboard only',               '?sensor=keyboard&overlay=chip'],
  ['gaps with no border at all',                     '?sensor=distance&zones=plain'],
];

(async () => {
  const profile = scratch.mkdtemp('alef-dndkit-');
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
  s.on('Runtime.exceptionThrown', e => console.error('  [page exception]', e?.exceptionDetails?.exception?.description || e?.exceptionDetails?.text));

  async function load(query) {
    await s.goto('file:///' + PAGE.replace(/\\/g, '/') + query);
    for (let i = 0; i < 40; i++) {                                   // React renders a moment after load
      if (await s.eval(`!!document.querySelector('#submit') && document.querySelectorAll('#tray .item').length === 6`)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await s.eval(`
      window.__asked = [];
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ fills: [1, 5, 3], confidence: 0.9, why: 'scripted' }); }
          return Promise.resolve({ error: 'unstubbed' }); },
        onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() },
                   onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 250));
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));

  for (const [name, query] of VARIANTS) {
    console.log(`=== ${name} ===`);
    await load(query);

    const rep = await J(`window.__alefSolver.report()`);
    check('recognised as a drag-and-drop question', rep.kind === 'drag', `kind=${rep.kind} ${JSON.stringify(rep.dragDiag)}`);
    check('3 gaps, and the 6 items found by dnd-kit\'s own markers',
      rep.dragGaps.length === 3 && rep.dragDiag.itemsVia === 'markers' && JSON.stringify(rep.dragItems) === JSON.stringify(ITEMS),
      `${rep.dragGaps.length} gaps, items by ${rep.dragDiag && rep.dragDiag.itemsVia}: ${JSON.stringify(rep.dragItems)}`);
    check('the sentence text has its blanks and none of the library\'s hidden text',
      (rep.dragText.match(/\[BLANK \d\]/g) || []).length === 3 && !/Draggable item|press the space bar|droppable area/i.test(rep.dragText),
      JSON.stringify(rep.dragText.slice(-90)));
    check('no reading passage was invented out of the page frame', rep.passageLen === 0, `passageLen=${rep.passageLen}`);

    const t0 = Date.now();
    const out = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, ways used: ${out.placed.map(p => p.via).join(' | ')}`);
    check('placed all three words', out.placed.length === 3 && out.placed.every(p => p.ok), out.error || '');
    check('the page state holds the right word in each gap',
      JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(EXPECTED), JSON.stringify(await s.eval(`window.__filled`)));
    check('dnd-kit itself reported each drop over the gap we aimed at',
      /dropped over droppable area gap-\d/.test(await s.eval(`(document.querySelector('[role="status"]') || {}).textContent || ''`)),
      JSON.stringify(await s.eval(`(document.querySelector('[role="status"]') || {}).textContent || ''`)));
    check('Submit Answer was pressed, and the sidebar button never was',
      out.submitted === true && /^submit answer/i.test(out.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0, JSON.stringify(out.submitLabel));
    check('page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
    check('the decoys were left in the tray', await s.eval(`document.querySelectorAll('#tray .item').length`) === 3);

    // Before each pointer release the item has rested on the gap, so a page that is slow to work out
    // "over what?" still has it right (the live page dropped "over nothing" when released at once).
    const gaps = await s.eval(`window.__restBeforeUp || []`);
    if (!name.includes('keyboard')) {
      check('every release came after the item had rested on the gap for 150ms or more',
        gaps.length >= 3 && gaps.every(g => g >= 150), JSON.stringify(gaps.map(g => Math.round(g))));
    }

    if (name.includes('250ms')) {
      check('the plain drag was cancelled by the library and a press-and-hold got through',
        out.placed[0].via === 'press, hold, then drag' && out.placed[0].tried.some(t => t.startsWith('drag the item')), JSON.stringify(out.placed[0]));
    } else if (name.includes('keyboard')) {
      check('with no pointer sensor at all, the keyboard (Space, arrows, Space) put every word in its gap',
        out.placed.every(p => p.via === 'keyboard'), JSON.stringify(out.placed.map(p => [p.via, p.tried.length])));
      check('and the failed pointer tries said what the page saw (nothing dropped over a gap)',
        out.placed[0].tried.length >= 3 && out.placed[0].tried.every(t => /^[a-z ,]+/.test(t)), JSON.stringify(out.placed[0].tried));
    } else {
      check('the plain drag worked first time, for every word', out.placed.every(p => p.via === 'drag the item' && p.tried.length === 0),
        JSON.stringify(out.placed.map(p => [p.via, p.tried])));
    }
    console.log('');
  }

  console.log('=== end to end: solveOne with a scripted model reply ===');
  await load('?sensor=distance');
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solveOne reported ok', res.ok === true, res.reason || '');
  check('page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
  const sent = await J(`window.__asked[0]`);
  check('model was sent the instructions, the sentences with blanks, and every item',
    sent.kind === 'drag' && /Drag each item to the correct place/.test(sent.drag.intro) && sent.drag.blanks === 3 &&
    /\[BLANK 1\]/.test(sent.drag.text) && JSON.stringify(sent.drag.items) === JSON.stringify(ITEMS), JSON.stringify(sent.drag).slice(0, 160));
  check('with no sidebar text and no invented passage',
    !/Sample Lesson|Question \d/.test(sent.drag.intro + sent.drag.text) && !sent.passage, JSON.stringify(sent.drag.intro));

  // A word in the tray that begins "next" — "next steps", on the live page — was taken for the Next
  // button. A lesson run then saw "an answered question" (a Next, and no enabled Submit), pressed
  // it, and stopped with "Next button clicked but nothing changed". The tray's items are dnd-kit
  // draggables, marked as such by the library itself.
  console.log('=== a tray item that reads "next steps" ===');
  await load('?sensor=pointer&nextword=1');
  const nrep = await J(`window.__alefSolver.report()`);
  check('(fixture) the first item is "next steps"', nrep.dragItems[0] === 'next steps', JSON.stringify(nrep.dragItems));
  check('it is a draggable the library has marked, with the role of a button',
    await s.eval(`(() => { const e = [...document.querySelectorAll('#tray .item')].find(x => /next steps/.test(x.textContent)); return !!e && e.getAttribute('aria-roledescription') === 'draggable' && e.getAttribute('role') === 'button'; })()`) === true);
  check('it is not taken for the Next button', await s.eval(`window.__alefSolver.findButton('next', null) === null`));
  check('so the unanswered question is not taken for an answered one', await s.eval(`window.__alefSolver.isGraded()`) === false);
  check('and the page is still read as a drag-and-drop question', nrep.kind === 'drag', `kind=${nrep.kind}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
