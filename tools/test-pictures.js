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

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
