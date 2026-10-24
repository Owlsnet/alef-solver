#!/usr/bin/env node
/* A "Select the correct answers" question: eight cards, each a role=checkbox in a role=selectgroup,
 * the choices drawn as formulas by MathJax. The tool took none of it for a question ("no question
 * found"): it only knew single-choice cards (role=radio). Now it reads the cards, asks the model for
 * every correct one, ticks exactly those — a card is a switch, so each is pressed once and only if it
 * is not already as wanted — and presses Submit.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'fixture-multi.html').replace(/\\/g, '/');
const PORT = 9375;
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
  const profile = scratch.mkdtemp('alef-multi-');
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

  // The model is stubbed: it records what it was asked and answers with window.__answer — or, when a
  // queue of replies is given, with the next one of those, one per question asked.
  async function load(query = '', answer = { indices: [1, 4], confidence: 0.9, why: 'both forms of the set', raw: '' }, queue = []) {
    await s.goto(PAGE + query);
    await s.eval(`
      window.__asked = []; window.__stored = {}; window.__answer = ${JSON.stringify(answer)}; window.__queue = ${JSON.stringify(queue)};
      window.chrome = { runtime: { sendMessage: m => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload); return Promise.resolve(window.__queue.length ? window.__queue.shift() : window.__answer); }
          return Promise.resolve({ error: 'no capture in tests' }); }, onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: o => { Object.assign(window.__stored, o); return Promise.resolve(); } }, onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await sleep(250);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));
  const ev = expr => s.eval(expr);

  console.log('=== reading the question ===');
  await load('');
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as a multiple-choice question with eight cards', rep.kind === 'choice' && rep.options.length === 8, `kind=${rep.kind} options=${rep.options.length}`);
  check('…and as one where several answers are ticked', rep.multi === true);
  const p = await J(`(() => { const x = window.__alefSolver.scrape(); return { stem: x.stem, instruction: x.instruction, multi: x.multi, sane: x.optionsSane, texts: x.options.map(o => o.text), distinct: new Set(x.options.map(o => o.el)).size }; })()`);
  check('the cards are distinct elements and the grouping is sane', p.sane && p.distinct === 8);
  check('the instruction line is read', p.instruction === 'Select the correct answers.', JSON.stringify(p.instruction));
  check('the question has its power ("2x^2"), not the page\'s own stray-digit text', /2x\^2 \+ 3x − 8 ≥ 0/.test(p.stem) && !/𝑥/.test(p.stem), JSON.stringify(p.stem));
  check('the stem is only the question, not the cards', p.stem.length < 200 && !/∪/.test(p.stem), `len=${p.stem.length}`);
  check('card B reads as an interval with its brackets and signs', p.texts[1] === '(−∞, −2.89] ∪ [1.39, ∞)', JSON.stringify(p.texts[1]));
  check('the card with one character in it ("ℝ") is a choice too, with its own text', p.texts.length === 8 && p.texts[7] === 'ℝ', JSON.stringify(p.texts[7]));
  check('card E reads as a set with a condition', p.texts[4] === '{x| x ≤ −2.89 or x ≥ 1.39}' || /x ≤ −2\.89 or x ≥ 1\.39/.test(p.texts[4]), JSON.stringify(p.texts[4]));
  check('a sign opening a number stays attached to it ("−2", not "− 2")', /−2 ≤ x ≤ 0\.5/.test(p.texts[0]), JSON.stringify(p.texts[0]));
  check('no card text carries the page\'s stray formatted letters', p.texts.every(t => t && !/𝑥/.test(t)));

  console.log('\n=== ticking the right ones, then Submit ===');
  const out = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('the page has B and E ticked when Submit went in', JSON.stringify(await ev(`window.__submitted`)) === '[1,4]', JSON.stringify(await ev(`window.__submitted`)));
  check('each was pressed once — a second press would have turned it off', JSON.stringify(await ev(`window.__presses`)) === '[1,4]', JSON.stringify(await ev(`window.__presses`)));
  check('Submit was pressed and the page took it', out.submitted === true && await ev(`window.__correct`) === true, out.error || '');
  check('it was Submit Answer that was pressed', /^submit answer/i.test(out.submitLabel || ''), JSON.stringify(out.submitLabel));
  check('it says what is ticked', out.ticked === 'BE', JSON.stringify(out.ticked));

  console.log('\n=== cards already ticked ===');
  await load('?pre=0,1');
  const outPre = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('A (wrong, already on) was turned off, B (right, already on) left alone, E turned on', JSON.stringify(await ev(`window.__presses`).then(x => [...x].sort())) === '[0,4]', JSON.stringify(await ev(`window.__presses`)));
  check('only B and E went in', JSON.stringify(await ev(`window.__submitted`)) === '[1,4]' && outPre.submitted === true, outPre.error || '');

  console.log('\n=== a page that is slow to show the tick ===');
  await load('?lag=1');
  const outLag = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('no card was pressed twice while waiting for it to show', JSON.stringify(await ev(`window.__presses`)) === '[1,4]', JSON.stringify(await ev(`window.__presses`)));
  check('and the right two went in', JSON.stringify(await ev(`window.__submitted`)) === '[1,4]' && outLag.submitted === true, outLag.error || '');

  console.log('\n=== a card whose own button does the ticking ===');
  await load('?inner=1');
  const outIn = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('it pressed the card, saw nothing, and pressed the button inside once', JSON.stringify(await ev(`window.__presses`)) === '[1,4]', JSON.stringify(await ev(`window.__presses`)));
  check('the right two went in', JSON.stringify(await ev(`window.__submitted`)) === '[1,4]' && outIn.submitted === true, outIn.error || '');

  console.log('\n=== a card the page will not keep ticked ===');
  await load('?stick=3');
  const outStick = await J(`window.__alefSolver.commitMulti([1, 3], { autoSubmit: true, answerDelay: 60 })`);
  check('it reports the failure and names the card', outStick.selected === false && /\bD\b/.test(outStick.error || '') && /did not keep/.test(outStick.error || ''), JSON.stringify(outStick.error));
  check('and does not press Submit on a half-made answer', await ev(`window.__submitPresses`) === 0 && outStick.submitted === false);

  console.log('\n=== the site\'s own switches are not answers ===');
  await load('?header=1');
  const repH = await J(`window.__alefSolver.report()`);
  check('the cards are still the choices (eight, not the header\'s two)', repH.kind === 'choice' && repH.options.length === 8 && repH.multi === true, `options=${repH.options.length}`);
  await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('the header switches were left as they were', await ev(`document.querySelector('[data-sw=dark]').getAttribute('aria-checked')`) === 'false' && await ev(`document.querySelector('[data-sw=sound]').getAttribute('aria-checked')`) === 'true');
  await load('?header=1&bare=1');
  const repBare = await J(`window.__alefSolver.report()`);
  check('with no answer cards on the page, two header switches are not taken for a question', repBare.kind === null && repBare.multi === false, `kind=${repBare.kind} options=${repBare.options.length}`);

  console.log('\n=== asking the model, end to end ===');
  await load('');
  const r = await J(`window.__alefSolver.solveOne(true)`);
  const asked = await J(`window.__asked[0]`);
  check('it asked once, as a tick-all question', (await J(`window.__asked.length`)) === 1 && asked.multi === true && asked.kind === 'choice');
  check('the model was given the instruction and the formulas as text', asked.instruction === 'Select the correct answers.' && /2x\^2/.test(asked.stem) && asked.options.length === 8 && /∪/.test(asked.options[1].text), JSON.stringify(asked.options[1]));
  check('the answer went in: B and E ticked, submitted, and the page marked it right', r.ok === true && r.commit.submitted === true && await ev(`window.__correct`) === true, r.reason || '');
  check('the attempt is recorded as both answers (for a retry)', /^B\. .* \+ E\. /.test(r.attempt || ''), JSON.stringify(r.attempt));

  console.log('\n=== a reply that names a card that is not there ===');
  await load('', { indices: [1, 9], confidence: 0.5, why: 'x', raw: '' });
  const rBad = await J(`window.__alefSolver.solveOne(true)`);
  check('it is refused, and nothing is pressed', rBad.ok === false && rBad.reason === 'range' && (await J(`window.__presses.length`)) === 0 && await ev(`window.__submitPresses`) === 0, JSON.stringify(rBad.reason));

  console.log('\n=== a failure report shows what happened ===');
  await load('?pre=2');
  await ev(`window.__alefSolver.dump(); 'ok'`);
  await sleep(150);
  const report = await ev(`window.__stored.lastReport || ''`);
  check('the report says it is a tick-all question, its instruction, and what is ticked now', /multi-select\s+yes — instruction "Select the correct answers\.", ticked now: C/.test(report), (report.match(/multi-select.*/) || [''])[0]);

  // The live page took two ticks on a question with two right answers and quietly ignored a third. It
  // never says how many it takes, so the model answered with three and the run stopped.
  console.log('\n=== a page that takes only as many ticks as there are right answers ===');
  await load('?max=2');
  const outMax = await J(`window.__alefSolver.commitMulti([0, 1, 4], { autoSubmit: false, answerDelay: 60 })`);
  const refusedMax = await ev(`window.__refused`);
  check('(fixture) the page took A and B and ignored every press on E', refusedMax.length > 0 && refusedMax.every(x => x === 4), JSON.stringify(refusedMax));
  check('it is not a success, and it works out the page takes 2', outMax.selected === false && outMax.limit === 2, JSON.stringify({ selected: outMax.selected, limit: outMax.limit, ticked: outMax.ticked }));
  check('and the message says so', /only 2 ticks/.test(outMax.error || ''), outMax.error);

  await load('?max=2', undefined, [{ indices: [0, 1, 4], confidence: 0.95 }, { indices: [1, 4], confidence: 0.9 }]);
  const rMax = await J(`window.__alefSolver.solveOne(true)`);
  const askedMax = await J(`window.__asked`);
  check('the model is asked again, and told the page takes 2', askedMax.length === 2 && askedMax[0].maxPicks === undefined && askedMax[1].maxPicks === 2, JSON.stringify(askedMax.map(a => a.maxPicks)));
  check('the new answer is put in: the extra tick is switched off, the other one on', JSON.stringify(await ev(`window.__submitted`)) === '[1,4]', JSON.stringify(await ev(`window.__submitted`)));
  check('Submit was pressed once, and the page took it as right', rMax.ok === true && rMax.commit.submitted === true && await ev(`window.__submitPresses`) === 1 && await ev(`window.__correct`) === true, rMax.reason || '');

  await load('?max=2', undefined, [{ indices: [0, 1, 4] }, { indices: [0, 1, 4] }]);
  const rStill = await J(`window.__alefSolver.solveOne(true)`);
  check('a model that still gives three is asked only once more, then it stops and says why', (await J(`window.__asked.length`)) === 2 && rStill.ok === false && /only 2 ticks/.test(rStill.reason || '') && await ev(`window.__submitPresses`) === 0, JSON.stringify(rStill.reason));

  await load('?max=2&pre=3,5');
  const outPre2 = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: false, answerDelay: 60 })`);
  check('wrong ticks are switched off before right ones go on, so a page at its limit has room', outPre2.selected === true && (await ev(`window.__refused`)).length === 0 && outPre2.ticked === 'BE', JSON.stringify({ sel: outPre2.selected, refused: await ev(`window.__refused`), ticked: outPre2.ticked }));

  // The other way round: on another question the live page kept Submit greyed out until two were ticked,
  // and the model gave one. Nothing was wrong with the tick — the page was waiting for more.
  console.log('\n=== a page that keeps Submit off until enough are ticked ===');
  await load('?need=2');
  const outNeed = await J(`window.__alefSolver.commitMulti([1], { autoSubmit: true, answerDelay: 60 })`);
  check('one tick goes in, but Submit never enables, and the page was not asked to submit', outNeed.selected === true && outNeed.submitted === false && await ev(`window.__submitPresses`) === 0, JSON.stringify({ sel: outNeed.selected, sub: outNeed.submitted }));
  check('it works out the page wants at least 2, and says so', outNeed.needMore === 2 && /may want more/.test(outNeed.error || ''), JSON.stringify({ needMore: outNeed.needMore, error: outNeed.error }));

  await load('?need=2', undefined, [{ indices: [1], confidence: 0.9 }, { indices: [1, 4], confidence: 0.9 }]);
  const rNeed = await J(`window.__alefSolver.solveOne(true)`);
  const askedNeed = await J(`window.__asked`);
  check('the model is asked again, and told the page wants at least 2', askedNeed.length === 2 && askedNeed[0].minPicks === undefined && askedNeed[1].minPicks === 2, JSON.stringify(askedNeed.map(a => a.minPicks)));
  check('the second tick goes in beside the first, Submit enables and is pressed once, and the page takes it as right', rNeed.ok === true && rNeed.commit.submitted === true && JSON.stringify(await ev(`window.__submitted`)) === '[1,4]' && await ev(`window.__submitPresses`) === 1 && await ev(`window.__correct`) === true, rNeed.reason || '');

  await load('?need=2', undefined, [{ indices: [1] }, { indices: [1] }, { indices: [1] }]);
  const rStuck = await J(`window.__alefSolver.solveOne(true)`);
  check('a model that keeps giving one is asked only once more, then it stops with the reason', (await J(`window.__asked.length`)) === 2 && rStuck.commit.submitted === false && /Submit stays off with 1 ticked/.test(rStuck.reason || '') && await ev(`window.__submitPresses`) === 0, JSON.stringify(rStuck.reason));

  await load('?need=3&max=3', undefined, [{ indices: [1] }, { indices: [1, 4] }, { indices: [1, 4, 5] }]);
  const rTwice = await J(`window.__alefSolver.solveOne(true)`);
  const askedTwice = await J(`window.__asked`);
  check('a page that wants three needs two more questions, and no more than that', askedTwice.length === 3 && askedTwice[1].minPicks === 2 && askedTwice[2].minPicks === 3 && JSON.stringify(await ev(`window.__submitted`)) === '[1,4,5]', JSON.stringify(askedTwice.map(a => a.minPicks)));

  await load('?need=9', undefined, [{ indices: [1] }, { indices: [1, 4] }, { indices: [1, 4, 5] }, { indices: [1, 4, 5, 6] }, { indices: [1, 4, 5, 6, 7] }]);
  const rNever = await J(`window.__alefSolver.solveOne(true)`);
  check('a page whose Submit never enables costs two more questions at most, however many ticks it is given', (await J(`window.__asked.length`)) === 3 && rNever.commit.submitted === false && await ev(`window.__submitPresses`) === 0, `asked=${await J(`window.__asked.length`)}`);

  await load('?need=2');
  const outAll = await J(`window.__alefSolver.commitMulti([1, 4], { autoSubmit: true, answerDelay: 60 })`);
  check('an ordinary page (or a right count) is not asked again: Submit goes in as before', outAll.submitted === true && outAll.needMore === undefined);

  // A question the live run met whose page text held no question at all, only "Select the correct answers.".
  // The model was left to guess and thought itself out of room; the report showed nothing to tell why.
  console.log('\n=== a question whose own text is missing from the page ===');
  await load('');
  const repFull = await J(`window.__alefSolver.report()`);
  check('an ordinary question: no page outline in the report (it is not needed)', !repFull.skeleton, `len=${(repFull.skeleton || '').length}`);
  await load('?nostem=1', undefined, [{ indices: [1, 4] }]);
  const repNoText = await J(`window.__alefSolver.report()`);
  check('(fixture) the only "question" found is the instruction line', repNoText.kind === 'choice' && repNoText.multi === true && repNoText.stem === repNoText.instruction, JSON.stringify({ stem: repNoText.stem, instruction: repNoText.instruction }));
  check('the report then carries the page outline, which is what shows where the question went', typeof repNoText.skeleton === 'string' && repNoText.skeleton.length > 200 && /lib-options-list-container/.test(repNoText.skeleton), `len=${(repNoText.skeleton || '').length}`);
  const rNoText = await J(`window.__alefSolver.solveOne(true)`);
  const askedNoText = await J(`window.__asked`);
  check('and it is still answered: the model is sent the (empty) question as the instruction line, and the picture if there is one', rNoText.ok === true && askedNoText.length === 1 && askedNoText[0].stem === askedNoText[0].instruction && rNoText.commit.submitted === true, rNoText.reason || '');

  console.log('\n=== single choice is unchanged ===');
  await load('?radio=1');
  const repR = await J(`window.__alefSolver.report()`);
  check('radio cards are still a single-choice question', repR.kind === 'choice' && repR.multi === false && repR.options.length === 8, `multi=${repR.multi}`);
  const outR = await J(`window.__alefSolver.commit(1, { autoSubmit: true, answerDelay: 60 })`);
  check('and pick the one card and submit', JSON.stringify(await ev(`window.__submitted`)) === '[1]' && outR.submitted === true, outR.error || '');

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
