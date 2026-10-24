#!/usr/bin/env node
/* Tests the matching question type: finding the two columns (and not the
   progress ticks or the help bulb), then making the links.

   How a site wants a link made is not knowable from outside, so the fixture can
   behave four ways and the tool has to find the one that works. A fifth page
   ignores synthetic events entirely; that has to end in an honest failure. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-match.html');
const PORT = 9337;
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

const LEFT = ['Manufacturing: 20% → 16%', 'Renewable energy: 10% → 24%', 'Education: 16% → 18%',
              'Fossil fuels: 22% → 14%', 'Healthcare: 18% → 23%'];
const RIGHT = ['Rose to 23%.', 'Fell by 8 points.', 'Rose by 14 points.', 'Rose slightly.', 'Fell by 4 points.'];
const RIGHT_ANSWERS = [4, 2, 3, 1, 0];

(async () => {
  const profile = require('./scratch.js').mkdtemp('alef-match-');
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

  async function load(query) {
    await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + query);
    await s.eval(`
      window.__asked = []; window.__pairs = [4, 2, 3, 1, 0];
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ pairs: window.__pairs, confidence: 0.9, why: 'scripted' }); }
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
  await load('?mode=click');
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as a matching question', rep.kind === 'match', `kind=${rep.kind}`);
  check('5 items on the left', rep.matchLeft.length === 5, `${rep.matchLeft.length}`);
  check('5 items on the right', rep.matchRight.length === 5, `${rep.matchRight.length}`);
  check('left items in reading order', JSON.stringify(rep.matchLeft) === JSON.stringify(LEFT), JSON.stringify(rep.matchLeft));
  check('right items in reading order, text not marker', JSON.stringify(rep.matchRight) === JSON.stringify(RIGHT), JSON.stringify(rep.matchRight));
  check('progress ticks and the help bulb are not items',
    !rep.matchLeft.concat(rep.matchRight).some(t => /need help|5\/5/i.test(t)));
  check('instructions kept, items removed from them',
    /Match each set of employment figures/.test(rep.matchIntro) && !/Manufacturing/.test(rep.matchIntro),
    JSON.stringify(rep.matchIntro.slice(0, 90)));
  check('page outline is available for a failure report', /\n/.test(rep.skeleton) && rep.skeleton.length > 200);

  /* --------------------------- the dots may be drawn any way at all */
  // A first version looked for round "dot" elements and found nothing on the
  // real page. Items must be found by the layout of the rows, not by how the
  // site draws its dots.
  for (const marks of ['svg', 'input', 'pseudo']) {
    console.log(`\n=== dots drawn as: ${marks} ===`);
    await load(`?mode=click&marks=${marks}`);
    const r2 = await J(`window.__alefSolver.report()`);
    check('still recognised as a matching question', r2.kind === 'match', `kind=${r2.kind} ${JSON.stringify(r2.matchDiag)}`);
    check('left and right items found in order',
      JSON.stringify(r2.matchLeft) === JSON.stringify(LEFT) && JSON.stringify(r2.matchRight) === JSON.stringify(RIGHT));
    const o2 = await J(`window.__alefSolver.commitMatch([4,2,3,1,0], { autoSubmit: true, answerDelay: 50 })`);
    check('linked and submitted', o2.selected === true && o2.submitted === true, o2.error || '');
    check('the page recorded the intended links',
      JSON.stringify(await s.eval(`Array.from({length:5}, (_, i) => window.__links[i])`)) === JSON.stringify(RIGHT_ANSWERS));
    check('page graded it correct', await s.eval(`window.__matchCorrect === true`) === true);
  }

  console.log('\n=== a page that says "match" but is not a matching question ===');
  await load('?mode=click');
  await s.eval(`document.getElementById('right').remove(); 'ok'`, { awaitPromise: false });
  const gone = await J(`window.__alefSolver.report()`);
  check('with one column gone it is no longer called a matching question', gone.kind !== 'match', `kind=${gone.kind}`);
  check('and the report says what the detector saw',
    gone.matchDiag && gone.matchDiag.guard === true && /no two aligned columns/.test(gone.matchDiag.result),
    JSON.stringify(gone.matchDiag));
  check('and outlines the page around the instruction line',
    /Match each set|Employment/.test(gone.skeleton || ''), (gone.skeleton || '').slice(0, 60));

  /* ------------------------------------------------- each way to link */
  for (const mode of ['click', 'clickdot', 'pointer', 'html5']) {
    console.log(`\n=== linking style: ${mode} ===`);
    await load(`?mode=${mode}`);
    const t0 = Date.now();
    const out = await J(`window.__alefSolver.commitMatch([4,2,3,1,0], { autoSubmit: true, answerDelay: 50 })`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, ways used: ${out.links.map(l => l.strategy).join(',')}`);
    check('made all five links', out.links.length === 5 && out.links.every(l => l.ok), out.error || '');
    check('found a way that works', out.links[0]?.ok === true, out.links[0]?.via || '');
    check('the page recorded exactly the intended links',
      JSON.stringify(await s.eval(`Array.from({length:5}, (_, i) => window.__links[i])`)) === JSON.stringify(RIGHT_ANSWERS),
      JSON.stringify(await s.eval(`window.__links`)));
    check('Submit became available, and was pressed once', out.selected === true && out.submitted === true, out.error || '');
    check('it was Submit Answer that got clicked, never the sidebar button',
      /^submit answer/i.test(out.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0, JSON.stringify(out.submitLabel));
    check('page graded it correct', await s.eval(`window.__matchCorrect === true`) === true);
    check('no gesture left half-finished',
      await s.eval(`document.querySelectorAll('.sel').length === 0 && document.querySelectorAll('#overlay line').length === 0`) === true);
  }

  /* --------------------------------------------------- end to end, via the model */
  console.log('\n=== solveOne with a scripted model reply ===');
  await load('?mode=click');
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solveOne reported ok', res.ok === true, res.reason || '');
  check('page graded it correct', await s.eval(`window.__matchCorrect === true`) === true);
  const sent = await J(`window.__asked[0]`);
  check('model was sent kind=match with both columns',
    sent.kind === 'match' && JSON.stringify(sent.match.left) === JSON.stringify(LEFT) &&
    JSON.stringify(sent.match.right) === JSON.stringify(RIGHT));
  check('no screenshot taken for a text-complete item', !sent.image);

  console.log('\n=== answers map to different links ===');
  await load('?mode=click');
  await s.eval(`window.__alefSolver.commitMatch([0,1,2,3,4], { autoSubmit: true, answerDelay: 50 })`);
  check('[0,1,2,3,4] linked each item to the sentence at its own position',
    JSON.stringify(await s.eval(`Array.from({length:5}, (_, i) => window.__links[i])`)) === '[0,1,2,3,4]');
  check('and the page graded that as incorrect', await s.eval(`window.__matchCorrect === false`) === true);

  /* ------------------------------------------------------------ refusals */
  console.log('\n=== refusals ===');
  await load('?mode=click');
  const touched = async () => await s.eval(`Object.keys(window.__links).length`);
  const dup = await J(`window.__alefSolver.commitMatch([0,0,1,2,3], { autoSubmit: false })`);
  check('refuses a repeated sentence', dup.selected !== true && /different/.test(dup.error || ''), dup.error || '');
  const range = await J(`window.__alefSolver.commitMatch([0,1,2,3,9], { autoSubmit: false })`);
  check('refuses a sentence that does not exist', range.selected !== true && /existing/.test(range.error || ''), range.error || '');
  const few = await J(`window.__alefSolver.commitMatch([0,1,2], { autoSubmit: false })`);
  check('refuses the wrong number of answers', few.selected !== true && /mismatch/.test(few.error || ''), few.error || '');
  check('and none of them touched the page', await touched() === 0);

  /* --------------------------------------------------- a page that ignores us */
  console.log('\n=== page ignoring synthetic events (?strict=1) ===');
  await load('?mode=click&strict=1');
  const t1 = Date.now();
  const strict = await J(`window.__alefSolver.commitMatch([4,2,3,1,0], { autoSubmit: true, answerDelay: 50 })`);
  console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s, error=${JSON.stringify(strict.error).slice(0, 130)}`);
  check('does not claim success', strict.selected !== true && strict.submitted !== true);
  check('names the ways it tried', /tried: click row, then row/.test(strict.error || '') && /drag/.test(strict.error || ''));
  check('the page really did ignore it', await s.eval(`window.__ignored >= 1 && Object.keys(window.__links).length === 0`) === true);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
