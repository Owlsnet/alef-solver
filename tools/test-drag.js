#!/usr/bin/env node
/* Tests the drag-and-drop gap-fill type: finding the dashed gaps and the tray
   of items (with decoys), rebuilding the sentence, then getting each word into
   its gap.

   How a site wants an item moved isn't knowable from outside, so the fixture
   behaves four ways — plain pointer drag, grip-only drag with a minimum
   distance, native HTML5 drag-and-drop, click-then-click — and the tool has to
   find the one that works. A fifth page ignores synthetic events; that has to
   end in an honest failure. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
// ALEF_CONTENT runs the suite against a deliberately broken copy, to prove a check
// would really have caught the thing it is there for.
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-drag.html');
const PORT = 9338;
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
const FILLS = [1, 5, 3];          // the item index for each gap that gives EXPECTED

(async () => {
  const profile = require('./scratch.js').mkdtemp('alef-drag-');
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

  async function load(query, file = FIXTURE) {
    await s.goto('file:///' + file.replace(/\\/g, '/') + query);
    await s.eval(`
      window.__asked = []; window.__fills = [1, 5, 3];
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ fills: window.__fills, confidence: 0.9, why: 'scripted' }); }
          return Promise.resolve({ error: 'unstubbed' }); },
        onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() },
                   onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 250));
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));

  /* ------------------------------------------------------------ detection */
  console.log('=== detection ===');
  await load('?mode=pointer');
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as a drag-and-drop question', rep.kind === 'drag', `kind=${rep.kind} ${JSON.stringify(rep.dragDiag)}`);
  check('3 gaps found', rep.dragGaps.length === 3, `${rep.dragGaps.length}`);
  check('6 items found, in order, decoys included', JSON.stringify(rep.dragItems) === JSON.stringify(ITEMS), JSON.stringify(rep.dragItems));
  const text = rep.dragText;
  check('3 blank markers', (text.match(/\[BLANK \d\]/g) || []).length === 3, text.slice(0, 80));
  check('grammar around each gap preserved',
    /Rising\s+\[BLANK 1\]\s+create significant pressure/.test(text) &&
    /Companies\s+\[BLANK 2\]\s+specialists/.test(text) &&
    /A clear\s+\[BLANK 3\]\s+can shape/.test(text), JSON.stringify(text));
  check('the tray items are NOT in the sentence text', !/tuition fees|consumerism|wages/.test(text), JSON.stringify(text));
  check('page chrome is not in the text', !/check my understanding|go back|submit answer/i.test(text));
  check('page outline available for a failure report', /\n/.test(rep.skeleton) && rep.skeleton.length > 100);

  // Seen on the live page:
  check('no reading passage was invented out of the page frame', rep.passageLen === 0,
    `passageLen=${rep.passageLen} ${JSON.stringify((rep.passageHead || '').slice(0, 60))}`);
  check('screen-reader text (instructions, drop announcements) is not in the sentence text',
    !/Draggable item|press the space bar/i.test(text), JSON.stringify(text.slice(-100)));
  check('the sidebar title and its question list are not in the sentence text', !/Sample Lesson|Question \d/.test(text));

  /* -------------------------------- gaps drawn so a dashed border check can't see them */
  // drag-and-drop libraries put no marker on a drop area, and the dashed look can
  // be a pseudo-element, a background image or nothing at all. The gaps must be
  // found as holes in the sentences.
  for (const zones of ['pseudo', 'bg', 'plain']) {
    console.log(`\n=== gaps drawn as: ${zones} ===`);
    await load(`?mode=pointer&zones=${zones}`);
    const rz = await J(`window.__alefSolver.report()`);
    check('still recognised as a drag-and-drop question', rz.kind === 'drag', `kind=${rz.kind} ${JSON.stringify(rz.dragDiag)}`);
    check('found by the holes in the text, not by a border', rz.dragDiag && rz.dragDiag.via === 'gaps in the text', JSON.stringify(rz.dragDiag));
    check('3 gaps and 6 items', rz.dragGaps.length === 3 && rz.dragItems.length === 6);
    check('the sentence text is intact around each gap',
      /Rising\s+\[BLANK 1\]\s+create/.test(rz.dragText) && /Companies\s+\[BLANK 2\]\s+specialists/.test(rz.dragText) && /A clear\s+\[BLANK 3\]\s+can shape/.test(rz.dragText),
      JSON.stringify(rz.dragText));
    const oz = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
    check('placed all three and submitted', oz.placed.length === 3 && oz.placed.every(p => p.ok) && oz.submitted === true, oz.error || '');
    check('the right word is in each gap',
      JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(EXPECTED), JSON.stringify(await s.eval(`window.__filled`)));
    check('page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
  }

  /* ------------------------- gaps that hold text only a screen reader reads */
  // An SVG <title>, an aria-label and a clipped label make a gap's textContent
  // non-empty, but a person looking at the page sees an empty box.
  for (const [label, query] of [['dashed border', '?mode=pointer&hidden=1'], ['no border at all', '?mode=pointer&hidden=1&zones=plain']]) {
    console.log(`\n=== gaps with a screen-reader label and an SVG title (${label}) ===`);
    await load(query);
    const rh = await J(`window.__alefSolver.report()`);
    check('still recognised as a drag-and-drop question', rh.kind === 'drag', `kind=${rh.kind} ${JSON.stringify(rh.dragDiag)}`);
    check('3 gaps found', rh.dragGaps.length === 3, `${rh.dragGaps.length}`);
    const oh = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
    check('placed all three and submitted', oh.placed.length === 3 && oh.placed.every(p => p.ok) && oh.submitted === true, oh.error || '');
    check('the right word is in each gap',
      JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(EXPECTED), JSON.stringify(await s.eval(`window.__filled`)));
  }

  /* ------------------------------ items marked the way dnd-kit marks them */
  console.log('\n=== items as <button aria-roledescription="draggable"> (dnd-kit) ===');
  await load('?mode=pointer&attrs=dndkit');
  const rk = await J(`window.__alefSolver.report()`);
  check('recognised, with the items found by their markers', rk.kind === 'drag' && rk.dragDiag.itemsVia === 'markers', JSON.stringify(rk.dragDiag));
  check('3 gaps and the 6 items, in order', rk.dragGaps.length === 3 && JSON.stringify(rk.dragItems) === JSON.stringify(ITEMS), JSON.stringify(rk.dragItems));
  check('the tray buttons are not in the sentence text', !/tuition fees|consumerism|wages/.test(rk.dragText), JSON.stringify(rk.dragText));
  const ok2 = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
  check('all three placed and submitted', ok2.placed.length === 3 && ok2.placed.every(p => p.ok) && ok2.submitted === true, ok2.error || '');
  check('the right word is in each gap',
    JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(EXPECTED), JSON.stringify(await s.eval(`window.__filled`)));

  /* ------------------------------------------- an Arabic lesson, right to left */
  // From the live page: the instruction says "أسحبُ" with its vowel marks and the
  // page never says "drag" in English, so a detector that wakes up only on that word
  // saw nothing — "no question detected". Items are long sentences in tall buttons,
  // and Submit reads "أُرسلُ إجابتي".
  const AR = path.join(__dirname, 'fixture-drag-ar.html');
  for (const [label, query] of [['items marked draggable (dnd-kit)', '?attrs=dndkit'], ['items with no marker at all', '?attrs=none']]) {
    console.log(`\n=== Arabic page, no English "drag" on it: ${label} ===`);
    await load(query, AR);
    check('(fixture) the page really has no English "drag" in its visible text',
      await s.eval(`!/\\bdrag\\b/i.test(document.body.innerText)`) === true);
    const arItems = await s.eval(`ITEMS`);
    const ra = await J(`window.__alefSolver.report()`);
    check('recognised as a drag-and-drop question', ra.kind === 'drag', `kind=${ra.kind} ${JSON.stringify(ra.dragDiag)}`);
    check('one gap and the four items, in order', ra.dragGaps.length === 1 && JSON.stringify(ra.dragItems) === JSON.stringify(arItems),
      JSON.stringify(ra.dragItems));
    // The whole button is what gets dragged. A label inside it would also fit the size
    // limits of a chip when the chips are shorter than these, which is what made this
    // look fine while the real (taller) buttons were being skipped.
    check('the items are the whole buttons, not a label inside them',
      await s.eval(`window.__alefSolver.scrape().drag.items.every(i => i.el.tagName === 'BUTTON')`) === true);
    check('the sentence ends in the blank, after "هو:"', /هو:\s*\[BLANK 1\]\s*$/.test(ra.dragText), JSON.stringify(ra.dragText.slice(-60)));
    check('the tray sentences are not in the question text', !/غرضُـهُ/.test(ra.dragText.split('[BLANK 1]')[1] || '') && !ra.dragText.includes(arItems[1]));
    check('the sidebar title is not in the question text', !/درسٌ تجريبيٌّ|السؤال \d/.test(ra.dragText));
    const oa =await J(`window.__alefSolver.commitDrag([0], { autoSubmit: true, answerDelay: 50 })`);
    check('placed the item and submitted', oa.placed.length === 1 && oa.placed[0].ok && oa.submitted === true, oa.error || '');
    check('it was "أُرسلُ إجابتي" that got clicked, not the sidebar button',
      /جابتي/.test(oa.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0, JSON.stringify(oa.submitLabel));
    check('the page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
  }

  console.log('\n=== Arabic page, two gaps on one line: reading order is right to left ===');
  await load('?gaps=2', AR);
  const r2 = await J(`window.__alefSolver.report()`);
  check('two gaps, four items', r2.kind === 'drag' && r2.dragGaps.length === 2 && r2.dragItems.length === 4, `kind=${r2.kind} gaps=${r2.dragGaps.length}`);
  check('BLANK 1 is the gap that is read first (the right-hand one)',
    /هو:\s*\[BLANK 1\]\s*ونوعُهُ\s*\[BLANK 2\]/.test(r2.dragText), JSON.stringify(r2.dragText.slice(-70)));
  const o2 = await J(`window.__alefSolver.commitDrag([0, 2], { autoSubmit: true, answerDelay: 50 })`);
  check('item 0 went into the first-read gap, item 2 into the second',
    JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(await s.eval(`EXPECTED`)) && o2.submitted === true,
    JSON.stringify(await s.eval(`window.__filled`)));

  /* --------------------------------------------- Arabic button labels */
  // "أُرسلُ إجابتي" is the one seen on the live page; the others are the usual wording
  // for the buttons a lesson run depends on, so they are matched ignoring vowel marks.
  console.log('\n=== Arabic button labels are recognised for what they do ===');
  await load('?attrs=dndkit', AR);
  const found = async (kind, label) => await s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = '<button style="padding:6px 12px">' + ${JSON.stringify(label)} + '</button>';
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton(${JSON.stringify(kind)}, null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove();
    return ok;
  })()`);
  const SHOULD = {
    submit: ['أُرسلُ إجابتي', 'إرسال', 'أرسل الإجابة', 'تحقّق من إجابتي', 'تأكيد'],
    next: ['التالي', 'التالي ›', 'السؤال التالي', 'متابعة', 'استمرار'],
    finish: ['إنهاء', 'إنهاء الدرس'],
    // "أحاولُ ثانيـةً" ("I try again", first person, with a stretched letter) is the one on the live page.
    retry: ['حاول مرة أخرى', 'حاول مجدّدًا', 'أعد المحاولة', 'إعادة المحاولة', 'أحاولُ ثانيـةً', 'أحاول ثانية', 'أحاول مرة أخرى', 'أحاول مجددًا', 'أحاول من جديد'],
  };
  for (const [kind, labels] of Object.entries(SHOULD)) {
    const missed = [];
    for (const l of labels) if (!(await found(kind, l))) missed.push(l);
    check(`${kind}: every Arabic wording is found`, missed.length === 0, missed.length ? `missed ${JSON.stringify(missed)}` : '');
  }
  const wrong = [];
  for (const [kind, l] of [['submit', 'إرسال ملاحظة'], ['submit', 'أرسل رسالة إلى المعلم'], ['next', 'السؤال السابق'], ['retry', 'أرسل إجابتي'], ['retry', 'سأحاول لاحقًا'], ['retry', 'أحاول الإجابة عن السؤال التالي'], ['submit', 'حاول مرة أخرى'], ['submit', 'أحاولُ ثانيـةً'], ['finish', 'إنهاء الدرس وحفظ التقدم في الملف']]) {
    if (await found(kind, l)) wrong.push(`${kind}:${l}`);
  }
  check('unrelated Arabic buttons are not mistaken for them', wrong.length === 0, JSON.stringify(wrong));

  /* ---------------------------------------- each way an item can be moved */
  for (const mode of ['pointer', 'handle', 'html5', 'click', 'delay']) {
    console.log(`\n=== drag behaviour: ${mode} ===`);
    await load(`?mode=${mode}`);
    const t0 = Date.now();
    const out = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, ways used: ${out.placed.map(p => p.strategy).join(',')}`);
    check('placed all three words', out.placed.length === 3 && out.placed.every(p => p.ok), out.error || '');
    check('the page holds the right word in each gap',
      JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(EXPECTED), JSON.stringify(await s.eval(`window.__filled`)));
    check('Submit became available and was pressed', out.selected === true && out.submitted === true, out.error || '');
    check('it was Submit Answer that got clicked, never the sidebar button',
      /^submit answer/i.test(out.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0, JSON.stringify(out.submitLabel));
    check('page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
    check('the decoys were left in the tray', await s.eval(`document.querySelectorAll('#tray .item').length`) === 3);
    if (mode === 'handle') {
      check('the plain drag failed first and the grip drag was found',
        out.placed[0].via === 'drag by its grip' && out.placed[0].tried.some(t => t.startsWith('drag the item')), JSON.stringify(out.placed[0]));
    }
    if (mode === 'delay') {
      check('the page cancelled the plain drag, and a press-and-hold got through',
        out.placed[0].via === 'press, hold, then drag' && out.placed[0].tried.some(t => t.startsWith('drag the item')), JSON.stringify(out.placed[0]));
      check('the next two went straight to the way that worked',
        out.placed.slice(1).every(p => p.via === 'press, hold, then drag' && p.tried.length === 0), JSON.stringify(out.placed.slice(1).map(p => p.tried)));
    }
  }

  /* ------------------------------------------- end to end via the model */
  console.log('\n=== solveOne with a scripted model reply ===');
  await load('?mode=pointer');
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solveOne reported ok', res.ok === true, res.reason || '');
  check('page graded it correct', await s.eval(`window.__dragCorrect === true`) === true);
  const sent = await J(`window.__asked[0]`);
  check('model was sent kind=drag with the text and every item',
    sent.kind === 'drag' && sent.drag.blanks === 3 && JSON.stringify(sent.drag.items) === JSON.stringify(ITEMS) && /\[BLANK 1\]/.test(sent.drag.text));
  check('the exercise text was not mistaken for a reading passage', !sent.passage, JSON.stringify((sent.passage || '').slice(0, 40)));
  check('no screenshot taken for a text-complete item', !sent.image);
  check('the instructions reached the model without the sidebar text',
    /Drag each item to the correct place/.test(sent.drag.intro || '') && !/Sample Lesson|Question \d/.test(sent.drag.intro || ''),
    JSON.stringify(sent.drag.intro));
  check('and the sentence text reached it without screen-reader text',
    !/Draggable item|press the space bar/i.test(sent.drag.text || ''), JSON.stringify((sent.drag.text || '').slice(-80)));

  console.log('\n=== answers map to different words ===');
  await load('?mode=pointer');
  await s.eval(`window.__alefSolver.commitDrag([0,2,4], { autoSubmit: true, answerDelay: 50 })`);
  check('[0,2,4] put quantity / consumerism / wages in the gaps',
    JSON.stringify(await s.eval(`window.__filled`)) === JSON.stringify(['quantity', 'consumerism', 'wages']));
  check('and the page graded that as incorrect', await s.eval(`window.__dragCorrect === false`) === true);

  /* ------------------------------------------------------------ refusals */
  console.log('\n=== refusals ===');
  await load('?mode=pointer');
  const dup = await J(`window.__alefSolver.commitDrag([1,1,3], { autoSubmit: false })`);
  check('refuses the same item twice', dup.selected !== true && /different/.test(dup.error || ''), dup.error || '');
  const range = await J(`window.__alefSolver.commitDrag([1,5,9], { autoSubmit: false })`);
  check('refuses an item that does not exist', range.selected !== true && /existing/.test(range.error || ''), range.error || '');
  const few = await J(`window.__alefSolver.commitDrag([1,5], { autoSubmit: false })`);
  check('refuses the wrong number of answers', few.selected !== true && /mismatch/.test(few.error || ''), few.error || '');
  check('and none of them touched the page', await s.eval(`window.__filled.every(v => v == null)`) === true);

  console.log('\n=== not a drag question ===');
  await load('?mode=pointer');
  await s.eval(`document.getElementById('tray').remove(); 'ok'`, { awaitPromise: false });
  const gone = await J(`window.__alefSolver.report()`);
  check('with the tray gone it is not called a drag question', gone.kind !== 'drag', `kind=${gone.kind}`);
  check('and the report says what the detector saw',
    gone.dragDiag && gone.dragDiag.guard === true && /fewer items than gaps/.test(gone.dragDiag.result), JSON.stringify(gone.dragDiag));
  check('and lists the dashed boxes and the draggable markers it had to work with',
    gone.dragEvidence && gone.dragEvidence.dashedTotal === 3 && /border/.test(gone.dragEvidence.dashed[0]) && gone.dragEvidence.marked === 0,
    JSON.stringify(gone.dragEvidence));

  // The drag detector runs before the others whenever the page says "drag", so
  // it must not take a typed fill-in (dashed, empty, box-sized inputs next to a
  // tray of equal-sized words) for one of its own.
  console.log('\n=== a fill-in page that only mentions "drag" ===');
  await load('?mode=pointer');
  await s.eval(`(() => {
    const box = 'width:150px;height:40px;border:1.5px dashed #555;box-sizing:border-box;margin:0 4px;vertical-align:middle';
    const chip = w => '<div style="width:140px;height:40px;border:1px solid #6aa0f0;margin:2px 0">' + w + '</div>';
    document.body.innerHTML = '<div id="root"><p>Drag or type the words from the bank into the blanks. Profits <input style="' + box +
      '"> by 4 points, then <input style="' + box + '"> sharply.</p><div>' + ['rose', 'fell', 'grew', 'shrank'].map(chip).join('') +
      '</div><button>Submit Answer</button></div>';
    return 'ok'; })()`, { awaitPromise: false });
  const typedPage = await J(`window.__alefSolver.report()`);
  check('typed blanks are not taken for drop zones', typedPage.kind === 'cloze', `kind=${typedPage.kind} ${JSON.stringify(typedPage.dragDiag)}`);

  /* --------------------------------------------------- a page that ignores us */
  console.log('\n=== page ignoring synthetic events (?strict=1) ===');
  await load('?mode=pointer&strict=1');
  const t1 = Date.now();
  const strict = await J(`window.__alefSolver.commitDrag([1,5,3], { autoSubmit: true, answerDelay: 50 })`);
  console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s, error=${JSON.stringify(strict.error).slice(0, 140)}`);
  check('does not claim success', strict.selected !== true && strict.submitted !== true);
  check('names the ways it tried', /tried: drag the item/.test(strict.error || '') && /click the item/.test(strict.error || ''), strict.error || '');
  check('the page really did ignore it', await s.eval(`window.__ignored >= 1 && window.__filled.every(v => v == null)`) === true);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
