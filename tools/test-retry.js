#!/usr/bin/env node
/* A wrong answer must not end the run. The live page answers a wrong submit with
 * a red panel and a "Try Again" button instead of Next; the run used to read that
 * as "last question, nothing more to do" and stop. These tests drive the real
 * content script against fixture-lesson.html?retry=1, which behaves the same way,
 * and prove that it clicks Try Again, answers again WITHOUT repeating the answer
 * that was just marked wrong, gives up after a bounded number of tries, and never
 * loops forever.
 *
 * Model answers are scripted, one per call, so the control flow is what's tested.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
// ALEF_CONTENT points at a deliberately broken copy, to prove a check can fail.
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-lesson.html');
const PORT = 9343;
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

(async () => {
  const profile = require('./scratch.js').mkdtemp('alef-retry-');
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

  /** A fresh copy of the lesson with the model scripted. `script` is the choice
   *  index returned on each successive call; `cfg` is what the settings store holds. */
  async function fresh({ retry = true, both = false, script, cfg = {} }) {
    const url = 'file:///' + FIXTURE.replace(/\\/g, '/') + `?p=/lesson/abc-123${retry ? `&retry=${both ? 'both' : '1'}` : ''}`;
    await s.goto(url);
    await s.eval(`
      window.__asked = [];
      window.__script = ${JSON.stringify(script)};
      window.__cfg = ${JSON.stringify(cfg)};
      window.__stored = null;
      window.chrome = {
        runtime: {
          sendMessage: (msg) => {
            if (msg && msg.type === 'ask') {
              window.__asked.push(msg.payload);
              const i = window.__asked.length - 1;
              return Promise.resolve({ index: window.__script[i] ?? 0, letter: 'X', confidence: 0.9, why: 'scripted' });
            }
            return Promise.resolve({ error: 'not stubbed: ' + (msg && msg.type) });
          },
          onMessage: { addListener() {} },
        },
        storage: {
          local: {
            get: (k, cb) => cb ? cb(window.__cfg) : Promise.resolve(window.__cfg),
            set: (o) => { window.__stored = o; return Promise.resolve(); },
          },
          onChanged: { addListener() {} },
        },
      };
      'ok'
    `, { awaitPromise: false });
    await s.eval(CONTENT_JS, { awaitPromise: false });
  }

  /** Start a run and wait for it to finish (or fail the test if it never does). */
  async function run(fn = 'solveLesson') {
    await s.eval(`window.__alefSolver.${fn}()`, { awaitPromise: false });
    let finished = false;
    for (let i = 0; i < 160; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (await s.eval(`!window.__alefSolverRunning`)) { finished = true; break; }
    }
    await new Promise(r => setTimeout(r, 300));
    return finished;
  }

  const state = async () => JSON.parse(await s.eval(`JSON.stringify({
    subs: window.__lessonSubmissions,
    retryClicks: window.__retryClicks,
    wrongs: window.__wrongs,
    advanced: window.__advanced,
    doneClicks: window.__doneClicks,
    sideClicks: window.__sideClicks,
    asked: window.__asked.map(p => ({ stem: (p.stem || '').slice(0, 30), tried: p.tried || null })),
    hud: (document.getElementById('alef-solver-hud') || {}).textContent || '',
    retryShown: getComputedStyle(document.getElementById('retry')).display !== 'none',
    stored: window.__stored && String(window.__stored.lastReport || '').slice(0, 400),
  })`));

  /* ---------------------------------------------------------------- */
  console.log('"Try Again" is a button of its own');
  await fresh({ script: [1] });
  check('no retry button while the question is unanswered',
    await s.eval(`window.__alefSolver.findButton('retry', null) === null`));
  // Answer wrongly by hand, as the live page would show it.
  await s.eval(`document.querySelector('input[name=q][value="0"]').click(); document.getElementById('submit').click(); 'ok'`);
  check('after a wrong answer the Try Again button is found',
    await s.eval(`(() => { const b = window.__alefSolver.findButton('retry', null); return !!b && /try again/i.test(b.textContent); })()`) === true);
  check('"Try Again" is not mistaken for Next',
    await s.eval(`window.__alefSolver.findButton('next', null) === null`));
  check('"Try Again" is not mistaken for Submit',
    await s.eval(`window.__alefSolver.findButton('submit', null, { requireEnabled: false }) === null`));
  check('a question showing Try Again does not count as already graded',
    await s.eval(`window.__alefSolver.isGraded()`) === false);

  /* ---------------------------------------------------------------- */
  console.log('\nwrong once, right on the second try, then the lesson carries on');
  // Q1's right answer is 1. First call says 0 (wrong), the retry says 1; Q2: 2; Q3: 0.
  await fresh({ script: [0, 1, 2, 0] });
  check('the run finished', await run());
  let st = await state();
  console.log(`  submissions: ${JSON.stringify(st.subs)}  retries: ${st.retryClicks}  advanced: ${st.advanced}  asked: ${st.asked.length}`);
  check('answered Q1 twice, then Q2 and Q3', JSON.stringify(st.subs) === '[0,1,2,0]', JSON.stringify(st.subs));
  check('clicked Try Again exactly once', st.retryClicks === 1, `${st.retryClicks}`);
  check('then advanced through the lesson', st.advanced === 2, `${st.advanced}`);
  check('asked the model 4 times', st.asked.length === 4, `${st.asked.length}`);
  check('the first ask carried no earlier attempts', !st.asked[0].tried || st.asked[0].tried.length === 0, JSON.stringify(st.asked[0].tried));
  check('the retry told the model its first answer was wrong',
    Array.isArray(st.asked[1].tried) && st.asked[1].tried.length === 1, JSON.stringify(st.asked[1].tried));
  check('and said WHICH answer (letter and text)',
    /^A\.\s*by listing statistics/.test(st.asked[1].tried?.[0]?.label || ''), JSON.stringify(st.asked[1].tried));
  check('the next question starts clean — no stale attempts',
    !st.asked[2].tried || st.asked[2].tried.length === 0, JSON.stringify(st.asked[2].tried));
  check('it is the same question the second time', st.asked[0].stem === st.asked[1].stem && st.asked[1].stem !== st.asked[2].stem);
  check('the sidebar button was never clicked', st.sideClicks === 0);
  check('ended on the last-question message', /last question/i.test(st.hud) && /Done/.test(st.hud), JSON.stringify(st.hud));
  check('did not press Done by itself', st.doneClicks === 0);

  /* ---------------------------------------------------------------- */
  console.log('\nwrong again and again: bounded, and says so');
  await fresh({ script: [0, 0, 0, 0, 0, 0, 0, 0], cfg: { retries: 2 } });
  check('the run finished (no endless loop)', await run());
  st = await state();
  console.log(`  submissions: ${JSON.stringify(st.subs)}  retries: ${st.retryClicks}  hud: ${st.hud}`);
  check('one try plus two retries, then stopped', JSON.stringify(st.subs) === '[0,0,0]', JSON.stringify(st.subs));
  check('clicked Try Again twice', st.retryClicks === 2, `${st.retryClicks}`);
  check('never advanced', st.advanced === 0);
  check('asked the model exactly 3 times', st.asked.length === 3, `${st.asked.length}`);
  check('the third ask knew about both wrong answers',
    Array.isArray(st.asked[2].tried) && st.asked[2].tried.length === 2, JSON.stringify(st.asked[2].tried));
  check('says it is still wrong after 3 tries', /still wrong/i.test(st.hud) && /3/.test(st.hud), JSON.stringify(st.hud));
  check('saved a report to paste', /alef-solver failure/.test(st.stored || ''), JSON.stringify(st.stored));
  check('left the Try Again button for the person (did not click a third time)', st.retryShown === true);

  /* ---------------------------------------------------------------- */
  console.log('\nretries turned off');
  await fresh({ script: [0, 1, 2, 0], cfg: { retries: 0 } });
  check('the run finished', await run());
  st = await state();
  check('answered once and stopped', JSON.stringify(st.subs) === '[0]', JSON.stringify(st.subs));
  check('did not click Try Again', st.retryClicks === 0, `${st.retryClicks}`);
  check('says the answer was wrong', /wrong/i.test(st.hud), JSON.stringify(st.hud));
  check('says nothing misleading about "no Next button"', !/no next button/i.test(st.hud), JSON.stringify(st.hud));

  /* ---------------------------------------------------------------- */
  console.log('\nresuming on a question that is already showing Try Again');
  // Continue the page left behind by the run above: Q1 wrong, Try Again showing.
  await s.eval(`window.__cfg = { retries: 3 }; window.__script = [1, 2, 0]; window.__asked = []; 'ok'`);
  check('the run finished', await run());
  st = await state();
  console.log(`  submissions: ${JSON.stringify(st.subs)}  retries: ${st.retryClicks}  advanced: ${st.advanced}`);
  check('clicked Try Again first, then answered', st.retryClicks === 1 && st.subs[1] === 1, `${JSON.stringify(st.subs)} retries=${st.retryClicks}`);
  check('went on to finish the lesson', JSON.stringify(st.subs) === '[0,1,2,0]' && st.advanced === 2, JSON.stringify(st.subs));
  check('told the model an earlier answer was wrong, even though it did not make it',
    Array.isArray(st.asked[0].tried) && st.asked[0].tried.length === 1, JSON.stringify(st.asked[0].tried));
  check('and which one the page still showed as chosen',
    /^A\./.test(st.asked[0].tried?.[0]?.label || ''), JSON.stringify(st.asked[0].tried));

  /* ---------------------------------------------------------------- */
  console.log('\none question by hotkey (not a whole lesson)');
  await fresh({ script: [0, 1] });
  check('the run finished', await run('solve'));
  st = await state();
  check('retried within the single-question run', JSON.stringify(st.subs) === '[0,1]' && st.retryClicks === 1, `${JSON.stringify(st.subs)} retries=${st.retryClicks}`);
  check('and stopped on the question it solved (did not click Next)', st.advanced === 0, `${st.advanced}`);

  /* ---------------------------------------------------------------- */
  console.log('\na wrong answer that offers Next as well as Try Again');
  await fresh({ both: true, script: [0, 1, 2, 0] });
  check('the run finished', await run());
  st = await state();
  check('took Try Again rather than skipping the question', JSON.stringify(st.subs) === '[0,1,2,0]' && st.retryClicks === 1,
    `${JSON.stringify(st.subs)} retries=${st.retryClicks}`);
  // The picks alone can't tell: skipping Q1 makes Q2 and Q3 wrong too, and the same
  // script then happens to come out the same. The question asked second tells.
  check('the second ask was the SAME question, not the next one',
    st.asked[0].stem === st.asked[1].stem && st.asked[1].stem !== st.asked[2].stem,
    JSON.stringify(st.asked.map(a => a.stem.slice(0, 12))));
  check('the first question was retried exactly once (not skipped, not twice)', st.asked.filter(a => a.stem === st.asked[0].stem).length === 2);
  check('and still went on to finish the lesson', st.advanced === 2, `${st.advanced}`);

  /* ---------------------------------------------------------------- */
  console.log('\nnothing changes when the page has no Try Again');
  await fresh({ retry: false, script: [0, 2, 0] });   // Q1 wrong, but this page just shows Next
  check('the run finished', await run());
  st = await state();
  check('answered each question once and moved on', JSON.stringify(st.subs) === '[0,2,0]' && st.retryClicks === 0 && st.advanced === 2, `${JSON.stringify(st.subs)}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
