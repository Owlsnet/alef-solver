#!/usr/bin/env node
/* Tests the drop-down question type: finding the boxes (custom and native),
   rebuilding the sentence with [BLANK n] markers, reading each menu by opening
   it, choosing the right option per blank, and submitting.

   Runs against three layouts of the same item, and one page that ignores
   synthetic events — which must produce an honest failure, never a false win. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-dropdown.html');
const PORT = 9336;
process.env.CDP_PORT = String(PORT);

// A silent death is worse than a failure: say what killed the run.
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

const MENUS = [
  ['exceeded', 'matched', 'trailed'],
  ['whereas', 'so that', 'unless'],
  ['Overall', 'However', 'For instance'],
];

(async () => {
  const profile = require('./scratch.js').mkdtemp('alef-dd-');
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
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });
  s.on('Runtime.exceptionThrown', e => console.error('  [page exception]', e?.exceptionDetails?.exception?.description || e?.exceptionDetails?.text));

  /** Load the fixture, stub the extension runtime, inject content.js. */
  async function load(query) {
    await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + query);
    await s.eval(`
      window.__asked = []; window.__picks = [0, 0, 0];
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ picks: window.__picks, confidence: 0.9, why: 'scripted' }); }
          return Promise.resolve({ error: 'unstubbed' }); },
        onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() },
                   onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 250));
  }
  // Await the expression IN the page before stringifying; JSON.stringify(promise) is "{}".
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));

  for (const mode of ['aria', 'plain', 'native']) {
    console.log(`\n=== layout: ${mode} ===`);
    await load(`?mode=${mode}`);

    console.log('detection');
    const rep = await J(`window.__alefSolver.report()`);
    check('recognised as a drop-down question', rep.kind === 'dropdown', `kind=${rep.kind}`);
    check('found 3 drop-downs', rep.dropdownBlanks.length === 3, `${rep.dropdownBlanks.length}`);
    check(mode === 'native' ? 'boxes are native <select>s' : 'boxes are custom',
      rep.dropdownBlanks.every(b => b.native === (mode === 'native')));

    const text = rep.dropdownText;
    check('3 blank markers', (text.match(/\[BLANK \d\]/g) || []).length === 3, text.slice(0, 80));
    check('grammar around each gap preserved',
      /rise\s+\[BLANK 1\]\s+tourism/.test(text) &&
      /points;\s+\[BLANK 2\]\s*,\s+energy/.test(text) &&
      /points\.\s+\[BLANK 3\]\s*,\s+technology/.test(text), JSON.stringify(text.slice(-110)));
    check('instructions included', /Choose the correct option from the drop-down list/.test(text));
    check('page chrome excluded',
      !/need help/i.test(text) && !/go back/i.test(text) && !/submit answer/i.test(text));
    check('the "Select…" placeholder is not left in the text', !/Select…/.test(text));

    console.log('reading the menus');
    const menus = await J(`window.__alefSolver.readDropdownOptions(window.__alefSolver.scrape().dropdown.blanks)`);
    check('read all three option lists', JSON.stringify(menus) === JSON.stringify(MENUS), JSON.stringify(menus));
    check('menus were closed again', await s.eval(`document.querySelectorAll('.menu').length`) === 0);
    check('reading changed nothing on the page',
      await s.eval(`window.__sel.every(v => v == null)`) === true);

    console.log('solving it end to end (picks 0,0,0 = the right answers)');
    await load(`?mode=${mode}`);
    const res = await J(`window.__alefSolver.solveOne(true)`);
    check('solveOne reported ok', res.ok === true, res.reason || '');
    check('page recorded the three choices',
      JSON.stringify(await s.eval(`window.__sel`)) === JSON.stringify(['exceeded', 'whereas', 'Overall']),
      JSON.stringify(await s.eval(`window.__sel`)));
    check('submitted, once', await s.eval(`window.__ddSubmitted === true`) === true);
    check('it was Submit Answer that got clicked, never the sidebar button',
      /^submit answer/i.test(res.commit?.submitLabel || '') && await s.eval(`window.__sideClicks`) === 0,
      JSON.stringify(res.commit?.submitLabel));
    check('page graded it correct', await s.eval(`window.__ddCorrect === true`) === true);

    const sent = await J(`window.__asked[0]`);
    check('model was sent kind=dropdown with every menu',
      sent.kind === 'dropdown' && JSON.stringify(sent.dropdown.menus) === JSON.stringify(MENUS));
    check('no screenshot was taken for a text-complete item', !sent.image);

    console.log('index -> option mapping is not "always the first"');
    await load(`?mode=${mode}`);
    await s.eval(`window.__picks = [2, 1, 0]`);
    await s.eval(`window.__alefSolver.solveOne(true)`);
    const sel2 = await s.eval(`window.__sel`);
    check('picks [2,1,0] chose trailed / so that / Overall',
      JSON.stringify(sel2) === JSON.stringify(['trailed', 'so that', 'Overall']), JSON.stringify(sel2));
    check('and the page graded that as incorrect', await s.eval(`window.__ddCorrect === false`) === true);

    console.log('refusals');
    await load(`?mode=${mode}`);
    const short = await J(`window.__alefSolver.commitDropdown(['exceeded','whereas'], { autoSubmit: false })`);
    check('refuses when the count does not match', short.selected !== true && /mismatch/.test(short.error || ''), short.error || '');
    check('and touched nothing', await s.eval(`window.__sel.every(v => v == null)`) === true);

    const bad = await J(`window.__alefSolver.commitDropdown(['exceeded','nope','Overall'], { autoSubmit: false })`);
    check('stops at an option that is not in the list', bad.selected === false && /nope/.test(bad.error || ''), bad.error || '');
    check('earlier picks still landed', await s.eval(`window.__sel[0]`) === 'exceeded');
    check('no menu left open', await s.eval(`document.querySelectorAll('.menu').length`) === 0);
  }

  console.log('\n=== page ignoring synthetic events (?strict=1) ===');
  await load('?mode=aria&strict=1');
  const strict = await J(`window.__alefSolver.commitDropdown(['exceeded','whereas','Overall'], { autoSubmit: true, answerDelay: 50 })`);
  console.log(`  selected=${strict.selected} submitted=${strict.submitted} error=${JSON.stringify(strict.error)}`);
  check('does not claim success', strict.selected !== true && strict.submitted !== true);
  check('says why', /menu did not open/.test(strict.error || ''), strict.error || '');
  check('the page really did ignore it', await s.eval(`window.__ignored >= 1 && window.__sel.every(v => v == null)`) === true);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
