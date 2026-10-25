#!/usr/bin/env node
/* A picture-choice question ("Which of the following graphs…"): each answer card holds a picture and a
 * magnifier button ("Zoom In"). Choosing an answer clicked the magnifier too — the first button in the
 * card — which opened the picture; the Submit press that followed was lost behind it, and the page
 * changing as the viewer closed was taken for the answer being taken. "It pressed the zoom in button."
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'fixture-pictures.html').replace(/\\/g, '/');
const PORT = 9374;
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
  const profile = scratch.mkdtemp('alef-pics-');
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

  async function load(query = '') {
    await s.goto(PAGE + query);
    await s.eval(`
      window.chrome = { runtime: { sendMessage: () => Promise.resolve({ error: 'unstubbed' }), onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));

  console.log('=== a picture-choice question ===');
  await load('');
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as multiple choice, four cards', rep.kind === 'choice' && rep.options.length === 4, `kind=${rep.kind} options=${rep.options.length}`);
  check('the cards are distinct elements and the grouping is sane', await J(`(() => { const p = window.__alefSolver.scrape(); return p.optionsSane && new Set(p.options.map(o => o.el)).size === 4; })()`) === true);
  check('(fixture) the first button inside a card is the magnifier — the trap', await s.eval(`document.querySelector('.lib-mcq-option-container').querySelector('button').getAttribute('aria-label')`) === 'Zoom In');

  console.log('\n=== choosing an answer, then Submit ===');
  const out = await J(`window.__alefSolver.commit(0, { autoSubmit: true, answerDelay: 60 })`);
  check('the magnifier was never pressed', await s.eval(`window.__zoomClicks`) === 0, `zoomClicks=${await s.eval(`window.__zoomClicks`)}`);
  check('the page recorded the first picture as chosen', await s.eval(`window.__selection`) === 0);
  check('Submit was pressed, and the page took the answer', out.submitted === true && await s.eval(`window.__graded`) === true, out.error || '');
  check('it was Submit Answer that was pressed', /^submit answer/i.test(out.submitLabel || ''), JSON.stringify(out.submitLabel));

  console.log('\n=== a picture viewer left open ===');
  await load('');
  await s.eval(`document.querySelector('.lib-btn-img-zoom').click(); 'ok'`, { awaitPromise: false });
  check('(fixture) the viewer is open', await s.eval(`document.getElementById('zoom').classList.contains('open')`) === true);
  const out2 = await J(`window.__alefSolver.commit(2, { autoSubmit: true, answerDelay: 60 })`);
  check('it closed the viewer first, and says so', out2.closedDialog === true && await s.eval(`document.getElementById('zoom').classList.contains('open')`) === false);
  check('and then Submit worked', out2.submitted === true && await s.eval(`window.__graded`) === true && await s.eval(`window.__selection`) === 2, out2.error || '');

  console.log('\n=== the page moved but the answer was not taken ===');
  await load('?swallow=1');
  const out3 = await J(`window.__alefSolver.commit(1, { autoSubmit: true, answerDelay: 60 })`);
  check('Submit was pressed and the page changed…', await s.eval(`window.__submitPresses`) >= 1 && await s.eval(`document.getElementById('submit').classList.contains('pressed')`) === true);
  check('…but it is NOT reported as submitted, and says why', out3.submitted === false && /not taken/.test(out3.error || ''), JSON.stringify(out3.error));

  console.log('\n=== a card whose own box has no handler: only the picture area inside it does ===');
  await load('?inner=1');
  await s.eval(`document.querySelector('.lib-mcq-option-container').dispatchEvent(new MouseEvent('click', { bubbles: true })); 'ok'`, { awaitPromise: false });
  check('(fixture) a click aimed at the card\'s own box does nothing', await s.eval(`window.__selection`) === -1 && await s.eval(`window.__cardPresses`) === 0);
  const outIn = await J(`window.__alefSolver.commit(1, { autoSubmit: true, answerDelay: 60 })`);
  check('it chose the card: the press landed where a person\'s would, on the picture', await s.eval(`window.__selection`) === 1, JSON.stringify(outIn.trail));
  check('the first way tried was the one that worked, and the magnifier was never pressed', JSON.stringify(outIn.trail) === '["pressed where a person would: it took"]' && await s.eval(`window.__zoomClicks`) === 0, JSON.stringify(outIn.trail));
  check('and Submit went in and was taken', outIn.submitted === true && await s.eval(`window.__graded`) === true, outIn.error || '');

  console.log('\n=== a card that only answers the keyboard ===');
  await load('?keys=1');
  const outKeys = await J(`window.__alefSolver.commit(2, { autoSubmit: true, answerDelay: 60 })`);
  check('it chose the card with Space, after the presses did nothing', await s.eval(`window.__selection`) === 2 && /pressed Space on it: it took$/.test((outKeys.trail || []).slice(-1)[0] || ''), JSON.stringify(outKeys.trail));
  check('and Submit went in', outKeys.submitted === true && await s.eval(`window.__graded`) === true, outKeys.error || '');

  console.log('\n=== a card nothing works on ===');
  await load('?dead=1');
  const outDead = await J(`window.__alefSolver.commit(0, { autoSubmit: true, answerDelay: 60 })`);
  check('it says so, and lists what it tried', outDead.selected === false && outDead.submitted === false && /never showed as chosen/.test(outDead.error || '') && /pressed the card itself: no change/.test(outDead.error || '') && /pressed Space on it: no change/.test(outDead.error || ''), JSON.stringify(outDead.error));
  check('and says how the card looked (not chosen)', /aria-checked=false/.test(outDead.error || ''), JSON.stringify(outDead.error));

  console.log('\n=== Submit was already enabled, and the press did nothing ===');
  await load('?dead=1&armed=1');
  const outArmed = await J(`window.__alefSolver.commit(0, { autoSubmit: false, answerDelay: 60 })`);
  check('an enabled Submit left over from before is not taken as the card having been chosen', outArmed.selected === false && (outArmed.trail || []).length >= 4 && (outArmed.trail || []).every(t => /no change$/.test(t)), JSON.stringify(outArmed.trail));

  console.log('\n=== the magnifier is where a press would land first ===');
  await load('?zoomcenter=1');
  check('(fixture) the element at the middle of a card is the magnifier', await s.eval(`(() => { const r = document.querySelector('.lib-mcq-option-container').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e.closest('.lib-btn-img-zoom'); })()`) === true);
  const outZc = await J(`window.__alefSolver.commit(3, { autoSubmit: true, answerDelay: 60 })`);
  check('it chose the card without pressing the magnifier', await s.eval(`window.__selection`) === 3 && await s.eval(`window.__zoomClicks`) === 0, JSON.stringify(outZc.trail) + ' zoomClicks=' + await s.eval(`window.__zoomClicks`));
  check('and Submit went in and was taken', outZc.submitted === true && await s.eval(`window.__graded`) === true, outZc.error || '');

  // When no model on the list could read the picture, the answer is a guess from the words, and the
  // page's status line must say so — otherwise a wrong graph answer looks like a model that cannot
  // read graphs, and nothing says which model to change.
  console.log('\n=== an answer given without the picture says so ===');
  const askWith = async reply => {
    await load('');
    await s.eval(`
      window.__huds = [];
      // The status line is rewritten twice in the same instant ("→ B …" then "submitting…"), so read
      // each text as it is added, not the element afterwards.
      new MutationObserver(recs => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 3 && /^alef · /.test(n.textContent)) window.__huds.push(n.textContent); })
        .observe(document.documentElement, { subtree: true, childList: true });
      window.chrome.runtime.sendMessage = m => Promise.resolve(m && m.type === 'ask' ? ${JSON.stringify(reply)} : { error: 'no capture in tests' });
      'ok'`, { awaitPromise: false });
    const r = await J(`window.__alefSolver.solveOne(true)`);
    return { r, huds: await J(`window.__huds`) };
  };
  let b = await askWith({ index: 1, letter: 'B', confidence: 0.4, why: 'blind', imageDropped: true });
  check('the question was answered and submitted', b.r.ok === true && b.r.commit.submitted === true, JSON.stringify(b.r.reason || ''));
  check('and the status line said the picture was not seen, beside the answer', b.huds.some(t => /→ B · \d+ms · ⚠ could not see the picture/.test(t)), JSON.stringify(b.huds.filter(t => /→/.test(t))));
  b = await askWith({ index: 1, letter: 'B', confidence: 0.9, why: 'sees' });
  check('an answer from a model that did see it carries no such note', b.r.ok === true && b.huds.some(t => /→ B/.test(t)) && !b.huds.some(t => /could not see/.test(t)), JSON.stringify(b.huds.filter(t => /→/.test(t))));

  // ------------------------------------------------------------------------------------------------
  // When a screenshot is taken. The popup's Screenshot setting decides, and "smart" is
  // the fast mode: a picture only when the words are not enough, the words for everything else.
  console.log('\n=== which Screenshot setting takes a picture: the rules ===');
  const wants = (mode, q) => J(`window.__alefSolver.wantsScreenshot(${JSON.stringify(mode)}, ${JSON.stringify({ kind: 'choice', imageCount: 0, passageLen: 0, stem: 'What is 2 + 3?', instruction: '', optionTexts: ['4', '5', '6'], ...q })})`);
  await load('');
  for (const [mode, q, want, why] of [
    // always / never / nothing sensible
    ['always', {}, true, 'always: a plain question'],
    ['always', { kind: 'cloze', passageLen: 900 }, true, 'always: even a fill-in with a passage read'],
    ['never', { imageCount: 3 }, false, 'never: not even for a figure'],
    ['bogus', { imageCount: 3 }, false, 'a setting nobody defined takes none'],
    [undefined, { imageCount: 3 }, false, 'and neither does no setting at all'],
    // auto is what it always was
    ['auto', {}, true, 'auto: a choice question whose passage was not read'],
    ['auto', { passageLen: 249 }, true, 'auto: a passage just under the limit counts as not read'],
    ['auto', { passageLen: 250 }, false, 'auto: a passage that was read makes it unnecessary'],
    ['auto', { imageCount: 2, passageLen: 900 }, true, 'auto: a figure always justifies one'],
    ['auto', { kind: 'cloze' }, false, 'auto: a fill-in carries its instructions in the text'],
    ['auto', { kind: 'cloze', imageCount: 1 }, true, 'auto: unless it has a figure'],
    // smart: the ordinary question goes without ...
    ['smart', {}, false, 'smart: a plain question with a stem and worded answers goes without — the case it exists for'],
    ['smart', { stem: 'ما ناتج ٢ + ٣؟', optionTexts: ['٤', '٥'] }, false, 'smart: and so does an Arabic one'],
    ['smart', { kind: 'cloze', stem: '' }, false, 'smart: a fill-in with its words in its own parts'],
    ['smart', { kind: 'drag', stem: '' }, false, 'smart: and drag and drop'],
    ['smart', { stem: 'Which tablet is cheaper?' }, false, 'smart: "tablet" is not "table"'],
    ['smart', { stem: 'Describe the imagery in line 3.' }, false, 'smart: nor "imagery" "image"'],
    ['smart', { stem: 'Choose the answer from the options below.' }, false, 'smart: "below" alone says nothing about a figure'],
    // ... and anything that says the words are not enough takes one
    ['smart', { imageCount: 1 }, true, 'smart: a figure'],
    ['smart', { kind: 'cloze', imageCount: 1 }, true, 'smart: a fill-in with a figure'],
    ['smart', { stem: '' }, true, 'smart: an empty stem — the question is in a picture'],
    ['smart', { stem: '  ' }, true, 'smart: a blank one'],
    ['smart', { stem: 'Select the correct answers.', instruction: 'Select the correct answers.' }, true, 'smart: a stem that is only the instruction'],
    ['smart', { optionTexts: ['MCQOption 1: Image content 🔍', 'MCQOption 2: Image content 🔍'] }, true, 'smart: answers that are pictures'],
    ['smart', { optionTexts: ['4', '', '6'] }, true, 'smart: an answer with no words'],
    ['smart', { stem: 'Which graph shows a linear function?' }, true, 'smart: a stem that names a graph'],
    ['smart', { stem: 'Use the table to find the mean.' }, true, 'smart: ... a table'],
    ['smart', { stem: 'ادرس الشكل ثم أجب.' }, true, 'smart: ... a figure, in Arabic'],
    ['smart', { stem: 'ما الجدول الصحيح؟' }, true, 'smart: ... a table, in Arabic'],
    ['smart', { kind: 'cloze', stem: 'Complete the sentences using the diagram.' }, true, 'smart: ... even for a fill-in'],
    ['smart', { stem: 'According to the passage, who spoke first?' }, true, 'smart: a passage that was not read'],
    ['smart', { stem: 'According to the passage, who spoke first?', passageLen: 900 }, false, 'smart: the same once the passage has been read'],
    ['smart', { stem: 'ما الفكرة الرئيسة في الفقرة؟' }, true, 'smart: ... in Arabic'],
    ['smart', { stem: 'ما الفكرة الرئيسة في الفقرة؟', passageLen: 900 }, false, 'smart: ... and once it has been read'],
  ]) {
    check(why, await wants(mode, q) === want, `${mode} ${JSON.stringify(q)}`);
  }

  // The same rules, fed what the page script really finds on the pages the author captured.
  console.log('\n=== which Screenshot setting takes a picture: on real captured pages ===');
  const FIX = f => 'file:///' + path.join(__dirname, f).replace(/\\/g, '/');
  const decideOn = async (file, mode) => {
    await s.goto(FIX(file));
    await s.eval(`
      window.chrome = { runtime: { sendMessage: () => Promise.resolve({}), onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
    return J(`(() => { const a = window.__alefSolver; const p = a.scrape();
      return a.wantsScreenshot(${JSON.stringify(mode)}, { kind: p.kind, imageCount: p.images.length, passageLen: p.passage.length,
        stem: p.stem, instruction: p.instruction, optionTexts: p.options.map(o => o.text) }); })()`);
  };
  for (const [file, auto, smart, what] of [
    ['fixture-multi.html', true, false, 'a plain algebra question with worded answers (no passage)'],
    ['fixture-lesson.html', true, true, 'a question about a passage that was not read'],
    ['fixture-table.html', false, false, 'the same question once the passage has been read'],
    ['fixture-locked.html', true, true, 'an Arabic question about a passage that was not read'],
    ['fixture-pictures.html', true, true, 'a picture-choice question: no stem, answers that are pictures'],
    ['fixture-cloze.html', false, false, 'a fill-in-the-blank'],
    ['fixture-dropdown.html', false, false, 'a drop-down question'],
  ]) {
    check(`auto on ${what}: ${auto ? 'takes one' : 'goes without'}`, await decideOn(file, 'auto') === auto, file);
    check(`smart on ${what}: ${smart ? 'takes one' : 'goes without'}`, await decideOn(file, 'smart') === smart, file);
  }

  // End to end on the picture question: does solving it ask the page for a capture, and say how long?
  console.log('\n=== which Screenshot setting takes a picture: solving the picture question ===');
  const solveIn = async mode => {
    await s.goto(PAGE);
    await s.eval(`
      window.__sent = [];
      window.chrome = { runtime: {
          sendMessage: m => { window.__sent.push(m); return Promise.resolve(m && m.type === 'ask' ? { index: 1, letter: 'B', confidence: 0.9, why: 'x' } : { error: 'no capture in tests' }); },
          onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => { const v = ${JSON.stringify(mode ? { screenshot: mode } : {})}; return cb ? cb(v) : Promise.resolve(v); }, set: () => Promise.resolve() }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
    const r = await J(`window.__alefSolver.solveOne(true)`);
    const sent = await J(`window.__sent`);
    return { r, captures: sent.filter(m => m.type === 'capture').length, ask: sent.find(m => m.type === 'ask') };
  };
  for (const [mode, expectCapture] of [['auto', true], ['smart', true], ['always', true], ['never', false]]) {
    const t = await solveIn(mode);
    check(`Screenshot "${mode}" ${expectCapture ? 'asks' : 'does not ask'} the page for a capture, and the question is still answered`,
      (t.captures > 0) === expectCapture && !!t.ask && t.r.ok === true, `captures=${t.captures} answered=${!!t.ask} ok=${t.r.ok}`);
    check(`...and the question carries a capture time ("${mode}")${expectCapture ? '' : ' of zero'}`,
      Number.isFinite(t.ask?.payload?.shotMs) && (expectCapture || t.ask.payload.shotMs === 0), JSON.stringify(t.ask?.payload?.shotMs));
  }

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
