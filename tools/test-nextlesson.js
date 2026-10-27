#!/usr/bin/env node
/* Going on to the next lesson by itself.
 *
 * When a lesson's last question is answered the page offers "Done". With the setting
 * on, the run presses it, finds the way to the next lesson (a Next Lesson button, a
 * Continue first, or the page moving on by itself) and carries on, up to a limit.
 * With the setting off it does what it always did: says the lesson is finished and
 * leaves Done alone.
 *
 * Runs the real content script against fixture-lesson.html?course=3, which is three
 * lessons in a row and has several ways of ending a lesson. The model is scripted.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-lesson.html');
const PORT = 9345;
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
  const profile = scratch.mkdtemp('alef-nextlesson-');
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
  for (let i = 0; i < 60; i++) { await sleep(250); try { v = await version(); break; } catch { } }
  if (!v) { console.error('✗ headless chrome never started'); process.exit(2); }
  console.log(`headless: ${v.Browser}\n`);

  const page = await findPage(/about:blank/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  s.on('Inspector.targetCrashed', () => { console.error('\n✗ the page (renderer) crashed'); process.exit(1); });

  /** A fresh course, the model answering 0 every time (right or wrong makes no
   *  difference here: the fixture moves on either way). */
  async function fresh(query, cfg = {}) {
    await s.goto('file:///' + FIXTURE.replace(/\\/g, '/') + query);
    await s.eval(`
      window.__asked = [];
      window.__cfg = ${JSON.stringify(cfg)};
      window.__stored = null;
      window.chrome = {
        runtime: {
          sendMessage: (msg) => {
            if (msg && msg.type === 'ask') { window.__asked.push(msg.payload); return Promise.resolve({ index: 0, letter: 'A', confidence: 0.9, why: 'scripted' }); }
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
    await sleep(200);
  }

  async function run() {
    await s.eval(`window.__alefSolver.solveLesson()`, { awaitPromise: false });
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      if (await s.eval(`!window.__alefSolverRunning`)) { await sleep(300); return true; }
    }
    return false;
  }

  const state = async () => JSON.parse(await s.eval(`JSON.stringify({
    asked: window.__asked.map(p => (p.stem || '').slice(0, 9)),
    done: window.__doneClicks, next: window.__nextLessonClicks, cont: window.__contClicks,
    back: window.__backClicks, start: window.__startClicks, decoy: window.__decoyClicks, attempts: window.__attemptStarts,
    resFinish: window.__resFinish, resSubmit: window.__resSubmit, splash: window.__splashStarts,
    rated: window.__rated, rateClicks: window.__rateSubmitClicks, smileys: window.__smileys, typed: window.__ratingTyped, backWhileRating: window.__backWhileRating,
    chrome: window.__chromeClicks, pops: window.__popBacks,
    slides: window.__slidesSkipped, submitted: window.__lessonSubmissions.length, skips: window.__skips,
    opens: window.__passageOpens || 0,
    hash: location.hash,
    hud: (document.getElementById('alef-solver-hud') || {}).textContent || '',
    stored: window.__stored && String(window.__stored.lastReport || '').slice(0, 500),
    endShown: getComputedStyle(document.getElementById('end')).display !== 'none',
  })`));
  const lessonsAsked = st => [1, 2, 3].map(n => st.asked.filter(a => a.startsWith(`Lesson ${n}:`)).length);

  console.log('=== a "Next Lesson" button ===');
  await fresh('?course=3&end=next', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  let st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Done: ${st.done}  Next Lesson: ${st.next}  hash: ${st.hash}`);
  check('answered all three questions of all three lessons', JSON.stringify(lessonsAsked(st)) === '[3,3,3]', JSON.stringify(lessonsAsked(st)));
  check('pressed Done on each lesson', st.done === 3, `${st.done}`);
  check('pressed Next Lesson between them, and not after the last', st.next === 2, `${st.next}`);
  check('ended on the third lesson', /\/lesson\/[0-9a-f-]+3\//.test(st.hash), st.hash);
  check('each lesson read its own passage (nothing carried over from the one before)', st.opens === 3, `${st.opens}`);
  check('at the end, says how many lessons it did and that no next lesson appeared',
    /3 lessons/.test(st.hud) && /no next lesson/i.test(st.hud), JSON.stringify(st.hud));
  check('and leaves a report in case there should have been one', /alef-solver failure/.test(st.stored || '') && /next-lesson/.test(st.stored || ''), JSON.stringify(st.stored));

  console.log('\n=== the limit in Options ===');
  await fresh('?course=3&end=next', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('did two lessons and pressed Done on both', JSON.stringify(lessonsAsked(st)) === '[3,3,0]' && st.done === 2, `${JSON.stringify(lessonsAsked(st))} done=${st.done}`);
  check('did not open a third', st.next === 1 && /\/lesson\/[0-9a-f-]+2\//.test(st.hash), `next=${st.next} ${st.hash}`);
  check('says it stopped at the limit', /limit/i.test(st.hud) && /2 lessons/.test(st.hud), JSON.stringify(st.hud));

  console.log('\n=== the button in Arabic ===');
  await fresh('?course=3&end=ar', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('"الدرس التالي" is recognised: three lessons done', JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.next === 2, `${JSON.stringify(lessonsAsked(st))} next=${st.next}`);

  console.log('\n=== a Continue before the Next Lesson button ===');
  await fresh('?course=3&end=modal', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('pressed Continue, then Next Lesson, each time', JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.cont === 2 && st.next === 2,
    `${JSON.stringify(lessonsAsked(st))} continue=${st.cont} next=${st.next}`);

  console.log('\n=== the page moves on by itself after Done ===');
  await fresh('?course=3&end=auto', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('carries on without pressing anything else', JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.next === 0 && st.cont === 0 && st.done === 3,
    `${JSON.stringify(lessonsAsked(st))} done=${st.done} next=${st.next}`);

  console.log('\n=== setting off (the default) ===');
  await fresh('?course=3&end=next', {});
  check('the run finished', await run());
  st = await state();
  check('does one lesson, and does NOT press Done', JSON.stringify(lessonsAsked(st)) === '[3,0,0]' && st.done === 0, `${JSON.stringify(lessonsAsked(st))} done=${st.done}`);
  check('says to press Done itself', /last question/i.test(st.hud) && /Done/.test(st.hud), JSON.stringify(st.hud));

  console.log('\n=== a Next Lesson button that does nothing ===');
  await fresh('?course=3&end=dead', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished (no endless loop)', await run());
  st = await state();
  check('tried the button, then gave up', st.next >= 1 && st.next <= 4 && JSON.stringify(lessonsAsked(st)) === '[3,0,0]', `next=${st.next} ${JSON.stringify(lessonsAsked(st))}`);
  check('and says the next lesson did not open, with a report', /next lesson/i.test(st.hud) && /alef-solver failure/.test(st.stored || ''), JSON.stringify(st.hud));

  // What the live site does (from a screen recording): the last button says "Finish",
  // then "Back to Coursework", which lands on a coursework page where each task has a
  // Start (not begun) or a Continue (begun); both are lessons to do.
  console.log('\n=== Finish, Back to Coursework, then Start the next task ===');
  await fresh('?course=3&end=real', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Finish: ${st.done}  Back: ${st.back}  Start: ${st.start}  Continue: ${st.decoy}`);
  check('answered all three lessons', JSON.stringify(lessonsAsked(st)) === '[3,3,3]', JSON.stringify(lessonsAsked(st)));
  check('pressed Finish on each, then Back to Coursework each time', st.done === 3 && st.back === 3, `finish=${st.done} back=${st.back}`);
  check('pressed Start for the next two lessons', st.start === 2, `${st.start}`);

  check('back at the coursework page with nothing to start, it says so and how many lessons it did',
    /3 lessons/.test(st.hud) && /nothing left to start/i.test(st.hud), JSON.stringify(st.hud));
  check('and keeps a report in case that was wrong', /next-lesson/.test(st.stored || ''), JSON.stringify(st.stored));

  // The live site's way out, as the person described it: Done on the last question, then the
  // results page's own Finish, then a Submit, then Back to Coursework, then the next lesson.
  // It stopped at the results page ("no next lesson button appeared after Done").
  console.log('\n=== Done → results page Finish → Submit → Back to Coursework → next lesson ===');
  await fresh('?course=3&end=results', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Done: ${st.done}  results Finish: ${st.resFinish}  Submit: ${st.resSubmit}  Back: ${st.back}  Start: ${st.start}`);
  check('every step in the order, for every lesson: Done, Finish, Submit, Back, then Start on the next',
    st.done === 3 && st.resFinish === 3 && st.resSubmit === 3 && st.back === 3 && st.start === 2, `done=${st.done} finish=${st.resFinish} submit=${st.resSubmit} back=${st.back} start=${st.start}`);
  check('and all three lessons were answered', JSON.stringify(lessonsAsked(st)) === '[3,3,3]', JSON.stringify(lessonsAsked(st)));

  await fresh('?course=3&end=results', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('at the limit of two, the last lesson is still finished properly (Finish, Submit, Back) and nothing more is started',
    st.done === 2 && st.resFinish === 2 && st.resSubmit === 2 && st.back === 2 && st.start === 1 && JSON.stringify(lessonsAsked(st)) === '[3,3,0]',
    `done=${st.done} finish=${st.resFinish} submit=${st.resSubmit} back=${st.back} start=${st.start} ${JSON.stringify(lessonsAsked(st))}`);

  await fresh('?course=3&end=results&under=1', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('with the results Finish still showing under the Submit, it presses Submit and does not press Finish a second time',
    st.resFinish === 2 && st.resSubmit === 2 && st.back === 2, `finish=${st.resFinish} submit=${st.resSubmit} back=${st.back}`);

  await fresh('?course=3&end=results&submitlag=2500', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('a Submit that stays greyed out for 2.5 s is waited for',
    st.resSubmit === 2 && st.back === 2 && st.start === 1, `submit=${st.resSubmit} back=${st.back} start=${st.start} ${JSON.stringify(st.hud)}`);

  await fresh('?course=3&end=results&submitlag=999999', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('a Submit that never becomes available: stops, says what it pressed and that it could not go on, keeps a report',
    st.resFinish === 1 && st.resSubmit === 0 && st.start === 0 && /no next lesson button/i.test(st.hud) && /next-lesson/.test(st.stored || '') && /Finish/.test(st.stored || ''),
    `finish=${st.resFinish} submit=${st.resSubmit} ${JSON.stringify(st.hud)}`);

  await fresh('?course=3&end=results', {});
  check('the run finished', await run());
  st = await state();
  check('with the next-lesson switch OFF, nothing past the last question is pressed: no Done, no Finish, no Submit',
    st.done === 0 && st.resFinish === 0 && st.resSubmit === 0, `done=${st.done} finish=${st.resFinish} submit=${st.resSubmit}`);

  // The rating box the live site opens after the results page's Finish: "Rate your lesson!",
  // smileys, a text area whose placeholder says "Submit", Cancel and Submit. Its Submit has to be
  // pressed. It was taken for a fill-in-the-blank question and "Submit" was typed into the text
  // area, and the run stopped there.
  console.log('\n=== the "Rate your lesson!" box ===');
  for (const [variant, query] of [['Submit as a styled box', '&rate=1'], ['Submit as a real <button>', '&rate=1&ratebtn=1']]) {
    await fresh(`?course=3&end=results${query}`, { autoNextLesson: true, maxLessons: 5 });
    check('the run finished', await run());
    st = await state();
    console.log(`  [${variant}] asked: ${st.asked.length}  Done: ${st.done}  Finish: ${st.resFinish}  rating Submit: ${st.rated}  Back: ${st.back}  Start: ${st.start}  typed: ${st.typed}`);
    check(`${variant}: every lesson is Done, Finish, the rating Submit, Back to Coursework, then Start on the next`,
      st.done === 3 && st.resFinish === 3 && st.rated === 3 && st.back === 3 && st.start === 2, `done=${st.done} finish=${st.resFinish} rated=${st.rated} back=${st.back} start=${st.start}`);
    check(`${variant}: nothing typed into the box and no question made of it — nine questions over three lessons`,
      st.typed === 0 && st.asked.length === 9 && JSON.stringify(lessonsAsked(st)) === '[3,3,3]', `typed=${st.typed} asked=${st.asked.length} ${JSON.stringify(lessonsAsked(st))}`);
    check(`${variant}: Submit came BEFORE Back to Coursework, which was showing behind the box all along`, st.backWhileRating === 0, `backWhileRating=${st.backWhileRating}`);
    check(`${variant}: no rating was chosen on the person's behalf`, st.smileys === 0, `smileys=${st.smileys}`);
  }

  await fresh('?course=3&end=results&rate=1', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('at the limit of two, the last lesson\'s rating box is submitted and Back pressed, and nothing more is started',
    st.rated === 2 && st.back === 2 && st.start === 1 && st.backWhileRating === 0, `rated=${st.rated} back=${st.back} start=${st.start} backWhileRating=${st.backWhileRating}`);

  await fresh('?course=3&end=results&rate=need', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('a box that will not take Submit until a smiley is chosen: Submit pressed once, no smiley picked for the person, and it stops saying so',
    st.rateClicks === 1 && st.rated === 0 && st.smileys === 0 && st.typed === 0 && st.start === 0 && /rating box/i.test(st.hud), `clicks=${st.rateClicks} rated=${st.rated} smileys=${st.smileys} ${JSON.stringify(st.hud)}`);
  check('and it did not go round the box to Back to Coursework', st.backWhileRating === 0 && st.back === 0, `back=${st.back}`);
  check('and a report is kept, with the reason', /next-lesson/.test(st.stored || '') && /stayed open/i.test(st.stored || ''), JSON.stringify((st.stored || '').slice(0, 160)));

  await fresh('?ratenow=1', {});
  check('(fixture) the page is showing the rating box and nothing else', await s.eval(`getComputedStyle(document.getElementById('ratebox')).display !== 'none' && getComputedStyle(document.getElementById('stem')).display === 'none'`) === true);
  check('its text area is not a question: nothing is detected on the page', await s.eval(`window.__alefSolver.scrape().kind`) === null);
  check('and the script finds its Submit', await s.eval(`(window.__alefSolver.feedbackSubmit() || {}).textContent`) === 'Submit');
  check('without the next-lesson switch, a lesson run there leaves it alone: no Submit pressed, nothing typed', await run() && (await state()).rateClicks === 0 && (await state()).typed === 0);

  for (const [variant, query] of [['styled box', ''], ['real <button>', '&ratebtn=1']]) {
    await fresh(`?ratenow=1${query}`, { autoNextLesson: true, maxLessons: 3 });
    check('the run finished', await run());
    st = await state();
    check(`with the switch on, a run that begins on the box presses its Submit (${variant}) and types nothing`, st.rated === 1 && st.typed === 0 && st.smileys === 0, `rated=${st.rated} typed=${st.typed} smileys=${st.smileys} ${JSON.stringify(st.hud)}`);
  }

  // A run started on the "For You" page, the list of tasks. The site's own header is there too:
  // a profile menu with "Select Language" in it. The run read that as a drop-down QUESTION,
  // clicked the person's name, opened the language box and tried to pick "English".
  console.log('\n=== a run started on the list of tasks ===');
  await fresh('?home=1&chrome=1&course=3', {});
  check('(fixture) the page opens on the list of tasks, with the site\'s own menu showing',
    await s.eval(`getComputedStyle(document.getElementById('home')).display !== 'none' && getComputedStyle(document.getElementById('sitechrome')).display !== 'none'`) === true);
  check('nothing on it is read as a question: the menu\'s "Select Language" is not a drop-down', await s.eval(`window.__alefSolver.scrape().kind`) === null);
  check('the Start that is found is the first lesson\'s',
    /Lesson 1/.test(await s.eval(`(() => { const b = window.__alefSolver.findButton('startTask', null); return b ? b.parentElement.innerText : ''; })()`)));

  check('the run finished', await run());
  st = await state();
  check('without the next-lesson switch, a run there starts nothing, touches nothing, and says no question was found',
    st.start === 0 && st.decoy === 0 && st.chrome === 0 && /no question found/i.test(st.hud), `start=${st.start} decoy=${st.decoy} chrome=${st.chrome} ${JSON.stringify(st.hud)}`);
  check('and it saves a fresh report of that screen, so "Copy last report" is not an older one',
    /stage:\s+no-question/.test(st.stored || '') && /Developer mode|Copy last report|report/i.test(st.hud), JSON.stringify([(st.stored || '').slice(0, 130), st.hud]));

  await fresh('?home=1&chrome=1&course=3', { autoNextLesson: true, maxLessons: 1 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked: ${st.asked.length}  Start pressed: ${st.start}  menu clicks: ${st.chrome}  hud: ${st.hud}`);
  check('with the switch on, it starts the first task that says Start and answers its three questions',
    st.start === 1 && st.asked.length === 3 && JSON.stringify(lessonsAsked(st)) === '[3,0,0]', `start=${st.start} asked=${st.asked.length} ${JSON.stringify(lessonsAsked(st))}`);
  check('and it never touched the site\'s own menu', st.chrome === 0, `chrome=${st.chrome}`);

  // The list when every lesson is one already begun, as all four rows of the live list were: each
  // says Continue. A begun lesson is picked up like a new one — it was being passed over.
  await fresh('?home=1&chrome=1&course=3&begun=1', {});
  check('(fixture) every row says Continue', await s.eval(`[...document.querySelectorAll('#tasks button')].every(b => b.textContent === 'Continue') && document.querySelectorAll('#tasks button').length === 3`) === true);
  check('and the script finds the first as the one to press', /Lesson 1/.test(await s.eval(`(() => { const b = window.__alefSolver.findButton('startTask', null); return b ? b.parentElement.innerText : ''; })()`)));
  check('the run finished', await run());
  st = await state();
  check('without the next-lesson switch, nothing is pressed', st.start === 0 && st.chrome === 0, `start=${st.start} chrome=${st.chrome}`);
  await fresh('?home=1&chrome=1&course=3&begun=1&end=real', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Continue pressed: ${st.start}  menu clicks: ${st.chrome}`);
  check('with the switch on, it continues the first begun lesson and goes on to the next two, in the list\'s order',
    JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.start === 3, `${JSON.stringify(lessonsAsked(st))} start=${st.start}`);
  check('and never touched the site\'s own menu', st.chrome === 0, `chrome=${st.chrome}`);

  // The live "All Lessons" page (build 0.6.37's report): lessons are clickable cards, not buttons,
  // and the run stopped there saying "nothing left to start". It takes the cards tagged Assigned
  // that say Start, in order — never an unassigned one, nor one that says Review (done).
  console.log('\n=== the coursework page as cards, Assigned ones only ===');
  await fresh('?home=1&chrome=1&course=3&cards=1', {});
  check('(fixture) the page has five cards and no Start button', await s.eval(`document.querySelectorAll('[data-testid^="core-coursework"]').length === 5 && ![...document.querySelectorAll('#tasks button')].length`) === true);
  check('and the script finds the first assigned card that says Start', /^3\. Lesson 1/.test(await s.eval(`(() => { const b = window.__alefSolver.findButton('startTask', null); return b ? b.innerText.trim() : ''; })()`)));
  await fresh('?home=1&chrome=1&course=3&cards=1&end=real', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  cards pressed: ${st.start}  decoys: ${st.decoy}  hud: ${st.hud}`);
  check('it opens each assigned lesson from its card, in order, and answers all three',
    JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.start === 3, `${JSON.stringify(lessonsAsked(st))} start=${st.start}`);
  check('and never opened the unassigned card or the one already done', st.decoy === 0, `decoy=${st.decoy}`);

  // A card can say Assigned and still open "This is not assigned to you yet": leave it, take the next.
  await fresh('?home=1&chrome=1&course=3&cards=1&unassigned=1&end=real', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  const naOpens = await s.eval('window.__unassignedOpens');
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  not-assigned opened: ${naOpens}  hud: ${st.hud}`);
  check('a card that opens "not assigned to you yet" is left once, and the next lessons are done',
    naOpens === 1 && JSON.stringify(lessonsAsked(st)) === '[0,3,3]', `opens=${naOpens} ${JSON.stringify(lessonsAsked(st))}`);

  // Partway through a lesson the next part is locked ("This is not assigned to you yet", only a
  // button back): the run stopped there. It has to leave the lesson and go on to the next one.
  await fresh('?home=1&chrome=1&course=3&cards=1&lockafter=1&end=real', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  const locks = await s.eval('window.__lockShown');
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  lock screens: ${locks}  hud: ${st.hud}`);
  check('a lesson whose next part is locked is left, and the next lessons are done',
    locks === 1 && JSON.stringify(lessonsAsked(st)) === '[2,3,3]', `locks=${locks} ${JSON.stringify(lessonsAsked(st))}`);

  // The live list's last task was a speaking lesson ("10. Speaking: …"). It is done like any
  // other, and it was being passed over.
  await fresh('?home=1&course=1&speaking=1', { autoNextLesson: true, maxLessons: 1 });
  check('(fixture) the list\'s one Start is a speaking lesson', /Speaking: A Sample Task/.test(await s.eval(`(() => { const b = window.__alefSolver.findButton('startTask', null); return b ? b.parentElement.innerText : ''; })()`)));
  check('the run finished', await run());
  st = await state();
  check('a speaking lesson is started like any other, and its three questions answered',
    st.start === 1 && st.asked.length === 3, `start=${st.start} asked=${st.asked.length}`);

  await fresh('?course=3&end=real', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  check('after each lesson, the Start it presses is the next lesson\'s',
    st.start === 2 && JSON.stringify(lessonsAsked(st)) === '[3,3,3]', `start=${st.start} ${JSON.stringify(lessonsAsked(st))}`);

  // After a lesson the list can still show it, first among the Starts, and the first Start pressed
  // REOPENED the lesson that was already done. A lesson is told from another by the id in the
  // address; the rows of the list carry nothing to match it to, so a row that opens a lesson
  // already been in is gone back from and passed over.
  console.log('\n=== a list that still shows the lesson just finished ===');
  await fresh('?course=3&end=results&rate=1&stale=1', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Start presses: ${st.start}  went back from a done lesson: ${st.pops}  hud: ${st.hud}`);
  check('every lesson answered once: three lessons, three questions each — the done lesson was never answered a second time',
    JSON.stringify(lessonsAsked(st)) === '[3,3,3]', JSON.stringify(lessonsAsked(st)));
  check('it opened each finished lesson once more by mistake, noticed from its address, and went back (twice)',
    st.pops === 2 && st.start === 4, `went back=${st.pops} Start presses=${st.start}`);


  await fresh('?course=3&end=results&rate=1', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  check('when the list is right (the finished lesson is gone from it) nothing is gone back from',
    st.pops === 0 && st.start === 2 && JSON.stringify(lessonsAsked(st)) === '[3,3,3]', `pops=${st.pops} start=${st.start} ${JSON.stringify(lessonsAsked(st))}`);

  // The first screen of the next lesson can be a video slide: a Next, and no question. The run
  // only knew a question as "the next lesson has opened", kept looking for another Start, and stopped
  // on the slide saying "back at the coursework page with nothing left to start". It has to go on.
  console.log('\n=== a next lesson that opens on a slide ===');
  await fresh('?course=3&end=results&rate=1&slides=1', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  slides gone past: ${st.slides}  hud: ${st.hud}`);
  check('every lesson opens on a slide, has its Next pressed, and has its three questions answered',
    JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.slides === 3, `${JSON.stringify(lessonsAsked(st))} slides=${st.slides}`);
  check('and it did not stop on the way saying there was nothing left to start', !/nothing left to start|no next lesson/i.test(st.hud) && /3 lessons done/.test(st.hud), JSON.stringify(st.hud));

  await fresh('?course=3&end=results&rate=1&slides=1&splash=start', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('the same when an opening screen with a Start comes first, and then the slide',
    JSON.stringify(lessonsAsked(st)) === '[3,3,0]' && st.slides === 2 && st.splash === 2, `${JSON.stringify(lessonsAsked(st))} slides=${st.slides} splash=${st.splash}`);

  // The live page's results screen, right after Finish: a card per attempt, and a Start on the
  // next one that begins ANOTHER GO AT THE SAME LESSON. It was pressed in place of going on.
  console.log('\n=== the results screen with a Start for another attempt ===');
  await fresh('?course=3&end=attempts', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  console.log(`  asked per lesson: ${JSON.stringify(lessonsAsked(st))}  Finish: ${st.done}  Back: ${st.back}  Start: ${st.start}  attempt Starts: ${st.attempts}`);
  check('never pressed the Start of another attempt at the same lesson', st.attempts === 0, `${st.attempts}`);
  check('waited for Back to Coursework to appear, and pressed it every time', st.back === 3, `back=${st.back}`);
  check('went on to all three lessons', JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.start === 2, `${JSON.stringify(lessonsAsked(st))} start=${st.start}`);

  await fresh('?course=3&end=attempts', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('with a limit of two it still presses Back at the end, and never the attempt Start',
    st.attempts === 0 && st.back === 2 && st.start === 1 && JSON.stringify(lessonsAsked(st)) === '[3,3,0]', `attempts=${st.attempts} back=${st.back} start=${st.start}`);

  await fresh('?course=3&end=real', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('with a limit of two: two lessons, Finish and Back on both, one Start',
    JSON.stringify(lessonsAsked(st)) === '[3,3,0]' && st.done === 2 && st.back === 2 && st.start === 1, `${JSON.stringify(lessonsAsked(st))} finish=${st.done} back=${st.back} start=${st.start}`);
  check('and says it stopped at the limit', /limit/i.test(st.hud) && /2 lessons/.test(st.hud), JSON.stringify(st.hud));

  await fresh('?course=3&end=real', {});
  check('the run finished', await run());
  st = await state();
  check('with the switch off, Finish is left alone', JSON.stringify(lessonsAsked(st)) === '[3,0,0]' && st.done === 0 && st.back === 0, `finish=${st.done}`);

  // A lesson also has screens with no question: a picture to explore, text to read, a
  // closing screen. The live site had one (a picture with "+" hotspots and an enabled
  // Next) and "no question detected" was all a lesson run could say about it.
  console.log('\n=== screens with no question: Next past them ===');
  await fresh('?slides=2', {});
  check('the run finished', await run());
  st = await state();
  console.log(`  slides skipped: ${st.slides}  answered: ${st.submitted}  hud: ${st.hud}`);
  check('pressed Next past both slides, then answered all three questions', st.slides === 2 && st.submitted === 3 && st.asked.length === 3, `slides=${st.slides} answered=${st.submitted}`);
  check('and the run ended the usual way, on the last question', /last question/i.test(st.hud), JSON.stringify(st.hud));

  await fresh('?slides=2&ghost=1', {});
  check('the run finished', await run());
  st = await state();
  check('a screen with a Submit button on it is NOT skipped (an answer is wanted there)', st.slides === 0 && st.asked.length === 0, `slides=${st.slides}`);
  check('and it says no question was found', /no question found/i.test(st.hud), JSON.stringify(st.hud));

  await fresh('?slides=25', {});
  check('the run finished (no endless loop)', await run());
  st = await state();
  check('endless slides: stops at 20 and says so', st.slides === 20 && st.asked.length === 0 && /slides in a row/i.test(st.hud), `slides=${st.slides} ${JSON.stringify(st.hud)}`);

  // Slides often hold Next back for a few seconds (narration, an animation). The run waits
  // for it, the way a person does, instead of deciding the lesson is over.
  console.log('\n=== a slide whose Next is greyed out for a while ===');
  await fresh('?slides=2&lock=1500', {});
  check('the run finished', await run());
  st = await state();
  check('waits for each Next to unlock, goes past both, answers the three questions', st.slides === 2 && st.submitted === 3, `slides=${st.slides} answered=${st.submitted} ${JSON.stringify(st.hud)}`);

  // The case seen on the live site: a question answered, Next pressed, and the slide that
  // follows keeps its own Next greyed out for longer than the 9 s it waits for a screen.
  await fresh('?slides=1&slideafter=1&lock=11000', {});
  check('the run finished', await run());
  st = await state();
  check('question, Next, a slide locked for 11 s: it waits it out and carries on to the other two questions',
    st.slides === 1 && st.submitted === 3, `slides=${st.slides} answered=${st.submitted} ${JSON.stringify(st.hud)}`);

  await fresh('?slides=1&lock=-1', { slideWaitMs: 2000 });
  check('the run finished (it does not wait for ever)', await run());
  st = await state();
  check('a Next that never unlocks: gives up, says so, and says what may be needed',
    st.slides === 0 && st.submitted === 0 && /greyed out/i.test(st.hud) && /clicked/i.test(st.hud), JSON.stringify(st.hud));
  check('and keeps a report of how the button looked', /slide-locked/.test(st.stored || '') && /greyed out/i.test(st.stored || ''), JSON.stringify(st.stored));

  console.log('\n=== "disabled" is read correctly ===');
  const enabledNext = attrs => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = '<button ${attrs} style="padding:6px 12px">Next</button>';
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton('next', null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove(); return ok;
  })()`);
  await fresh('?course=3&end=real', {});
  check('data-disabled="false" is an enabled button', await enabledNext('data-disabled="false"') === true);
  check('data-disabled="" is a disabled one', await enabledNext('data-disabled=""') === false);
  check('aria-disabled="true" and the disabled attribute are disabled', await enabledNext('aria-disabled="true"') === false && await enabledNext('disabled') === false);

  await fresh('?tail=1', {});
  check('the run finished', await run());
  st = await state();
  check('a closing screen with only Done: answers three, says to press Done, and leaves it alone',
    st.submitted === 3 && st.done === 0 && /last screen/i.test(st.hud) && /Done/.test(st.hud), `answered=${st.submitted} done=${st.done} ${JSON.stringify(st.hud)}`);

  await fresh('?course=2&end=real&tail=1', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('with the switch on, a closing screen is finished too, and the next lesson started',
    JSON.stringify(lessonsAsked(st).slice(0, 2)) === '[3,3]' && st.done === 2 && st.back === 2 && st.start === 1,
    `${JSON.stringify(lessonsAsked(st))} finish=${st.done} back=${st.back} start=${st.start}`);

  // An activity's opening screen: its title and a Start in the player's footer bar. The live run
  // answered a question, pressed Next, and met one (a "Writing: …" activity):
  // "no question or slide appeared after Next".
  console.log('\n=== an activity\'s opening screen (title and Start) ===');
  await fresh('?splash=mid', {});
  check('the run finished', await run());
  st = await state();
  console.log(`  asked: ${st.asked.length}  Start pressed: ${st.splash}  hud: ${st.hud}`);
  check('answered a question, pressed Next, met the title screen, pressed its Start, and answered the other two',
    st.splash === 1 && st.asked.length === 3 && st.submitted === 3, `start=${st.splash} asked=${st.asked.length} ${JSON.stringify(st.hud)}`);
  check('and the run ended the usual way', /last question/i.test(st.hud), JSON.stringify(st.hud));

  await fresh('?splash=start', {});
  check('the run finished', await run());
  st = await state();
  check('a run that BEGINS on the title screen presses Start and carries on', st.splash === 1 && st.asked.length === 3, `start=${st.splash} asked=${st.asked.length} ${JSON.stringify(st.hud)}`);

  await fresh('?splash=start&course=3&end=results', { autoNextLesson: true, maxLessons: 3 });
  check('the run finished', await run());
  st = await state();
  check('over three lessons that each open on a title screen: every Start pressed, nine questions answered',
    st.splash === 3 && JSON.stringify(lessonsAsked(st)) === '[3,3,3]' && st.start === 2, `splash=${st.splash} ${JSON.stringify(lessonsAsked(st))} start=${st.start}`);

  console.log('\n=== a Start is only an opening screen when it is in the player\'s footer ===');
  await fresh('?course=3&end=real', {});
  const bare = () => s.eval(`(() => { for (const id of ['stem','grid','slide','submit','later','next','done','retry','passage','readPassage']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
    const p = document.querySelector('.prompt'); if (p) p.style.display = 'none'; return 'ok'; })()`, { awaitPromise: false });
  const screenOf = html => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe'; host.innerHTML = ${JSON.stringify(html)}; document.body.appendChild(host);
    const c = window.__alefSolver.contentScreen(); host.remove();
    return !c ? 'none' : c.splash ? 'splash' : c.next ? 'next' : c.finish ? 'finish' : 'other'; })()`);
  await bare();
  check('Start in the player footer: an opening screen', await screenOf('<div class="lib-navigation-container"><button style="padding:6px">Start</button></div>') === 'splash');
  check('Start in a list of tasks: not one (that is the coursework page)', await screenOf('<div><b>Lesson 17: Skill Practice</b> <span>2 Tasks Assigned</span> <button style="padding:6px">Start</button></div>') === 'none');
  check('Start inside an attempt card: not one either', await screenOf('<div class="lib-navigation-container"><b>2nd Attempt</b> <button style="padding:6px">Start</button></div>') === 'none');

  // The page offers "I'll try later" on some questions: listening ones, and others (a writing
  // activity's "arrange the ideas" question had it). It only moves on, so press it whatever the
  // question is — no tokens spent, no time lost. It was once pressed only where the wording
  // began "Listen", and a writing question with the same button got solved.
  console.log('\n=== questions that offer "I\'ll try later" ===');
  await fresh('?later=2', {});
  check('the run finished', await run());
  st = await state();
  console.log(`  skipped: ${st.skips}  asked the model: ${st.asked.length}  answered: ${st.submitted}  hud: ${st.hud}`);
  check('a question that is NOT about listening, with the button: pressed, and the model asked about the other two only',
    st.skips === 1 && st.asked.length === 2 && st.submitted === 2, `skips=${st.skips} asked=${st.asked.length}`);
  check('it was that question that was skipped, and the model was never sent it', !st.asked.includes('How effec') && st.asked.length === 2, JSON.stringify(st.asked));      // asked holds the first 9 letters of each stem
  check('and the run ended the usual way', /last question/i.test(st.hud), JSON.stringify(st.hud));

  await fresh('?later=2', { skipLater: false });
  check('the run finished', await run());
  st = await state();
  check('with the switch off it answers that question like any other', st.skips === 0 && st.asked.length === 3, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?later=all', {});
  check('the run finished', await run());
  st = await state();
  check('every question offering it: all skipped, the model never asked, and the lesson still ends properly (Done left alone)',
    st.skips === 3 && st.asked.length === 0 && /last question/i.test(st.hud) && /Done/.test(st.hud) && st.done === 0,
    `skips=${st.skips} asked=${st.asked.length} done=${st.done} ${JSON.stringify(st.hud)}`);

  await fresh('?later=all&course=2&end=results', { autoNextLesson: true, maxLessons: 2 });
  check('the run finished', await run());
  st = await state();
  check('with the next-lesson switch on, a lesson of nothing but skips is still finished, left, and the next one opened',
    st.done === 2 && st.resFinish === 2 && st.resSubmit === 2 && st.back === 2 && st.start === 1 && st.asked.length === 0,
    `done=${st.done} finish=${st.resFinish} submit=${st.resSubmit} back=${st.back} start=${st.start} asked=${st.asked.length}`);

  await fresh('?later=2', {});
  await s.eval(`window.__alefSolver.solve()`, { awaitPromise: false });     // one question, by hotkey, on question 1: not skippable
  for (let i = 0; i < 40 && await s.eval(`window.__alefSolverRunning`); i++) await sleep(250);
  await sleep(300);
  st = await state();
  check('one question by hotkey where there is no button: answered as usual', st.skips === 0 && st.asked.length === 1, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?later=1', {});
  await s.eval(`window.__alefSolver.solve()`, { awaitPromise: false });
  for (let i = 0; i < 40 && await s.eval(`window.__alefSolverRunning`); i++) await sleep(250);
  await sleep(300);
  st = await state();
  check('one question by hotkey where there is a button: skipped, and the model is not asked',
    st.skips === 1 && st.asked.length === 0 && /try later/i.test(st.hud), `skips=${st.skips} asked=${st.asked.length} ${JSON.stringify(st.hud)}`);

  // Listening questions ("Listen. Which pattern shows the intonation?") are the usual case.
  console.log('\n=== listening questions ===');
  await fresh('?listen=1', {});
  check('the run finished', await run());
  st = await state();
  check('pressed "I\'ll try later" on the listening question, and asked the model about the other two only',
    st.skips === 1 && st.asked.length === 2 && st.submitted === 2, `skips=${st.skips} asked=${st.asked.length}`);
  check('the model was never sent the listening question', st.asked.length === 2 && !st.asked.some(a => a.startsWith('Listen')), JSON.stringify(st.asked));

  await fresh('?listen=1', { skipLater: false });
  check('the run finished', await run());
  st = await state();
  check('with the switch off it answers the listening question like any other', st.skips === 0 && st.asked.length === 3, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?listen=1&noskip=1', {});
  check('the run finished', await run());
  st = await state();
  check('a listening question with NO skip button on it is answered normally: it is the button that decides, not the wording', st.skips === 0 && st.asked.length === 3, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?listen=1,3', {});
  check('the run finished', await run());
  st = await state();
  check('a skipped question LAST in the lesson: the lesson ends properly after it',
    st.skips === 2 && st.asked.length === 1 && /last question/i.test(st.hud) && /Done/.test(st.hud) && st.done === 0,
    `skips=${st.skips} asked=${st.asked.length} done=${st.done} ${JSON.stringify(st.hud)}`);

  await fresh('?listen=1,3&course=2&end=real', { autoNextLesson: true, maxLessons: 5 });
  check('the run finished', await run());
  st = await state();
  check('and with the next-lesson switch on, it finishes that lesson and goes on to the next',
    st.done >= 1 && st.back >= 1 && st.start === 1, `finish=${st.done} back=${st.back} start=${st.start} ${JSON.stringify(st.hud)}`);

  // A question of a type this cannot read at all ("Select the correct answers", say). It
  // offers the button, and that is all that is needed to skip it.
  console.log('\n=== a question of a type that cannot be read ===');
  await fresh('?listen=2&plain=2', {});
  check('(fixture) question 1 is an ordinary readable one', await s.eval(`window.__alefSolver.scrape().kind`) === 'choice');
  check('the run finished', await run());
  st = await state();
  console.log(`  skipped: ${st.skips}  asked: ${st.asked.length}  answered: ${st.submitted}  hud: ${st.hud}`);
  check('answers question 1, skips the unreadable one after it, answers question 3',
    st.skips === 1 && st.asked.length === 2 && st.submitted === 2, `skips=${st.skips} asked=${st.asked.length} answered=${st.submitted} ${JSON.stringify(st.hud)}`);
  check('and ends the usual way', /last question/i.test(st.hud), JSON.stringify(st.hud));

  await fresh('?later=2&plain=2', {});
  check('the run finished', await run());
  st = await state();
  check('the same with no "Listen" in the wording: the button is all it needs', st.skips === 1 && st.asked.length === 2 && st.submitted === 2, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?listen=1&plain=1', {});
  check('the run finished', await run());
  st = await state();
  check('unreadable and skippable as the FIRST screen: skipped, the other two answered', st.skips === 1 && st.asked.length === 2 && st.submitted === 2, `skips=${st.skips} asked=${st.asked.length}`);

  await fresh('?listen=3&plain=3', {});
  check('the run finished', await run());
  st = await state();
  check('unreadable and skippable as the LAST screen: skipped, and the lesson ends properly',
    st.skips === 1 && st.asked.length === 2 && /last (screen|question)/i.test(st.hud) && /Done/.test(st.hud), `skips=${st.skips} asked=${st.asked.length} ${JSON.stringify(st.hud)}`);

  await fresh('?plain=2', {});
  check('the run finished', await run());
  st = await state();
  check('unreadable with NO skip button: not skipped — it stops and says so, with a report',
    st.skips === 0 && st.asked.length === 1 && /no further questions/i.test(st.hud) && /after-next/.test(st.stored || ''), `skips=${st.skips} asked=${st.asked.length} ${JSON.stringify(st.hud)}`);

  await fresh('?later=2&plain=2', { skipLater: false });
  check('the run finished', await run());
  st = await state();
  check('with the switch off, an unreadable question is not skipped either', st.skips === 0, `skips=${st.skips}`);

  await fresh('?later=1&plain=1', {});
  await s.eval(`window.__alefSolver.solve()`, { awaitPromise: false });
  for (let i = 0; i < 40 && await s.eval(`window.__alefSolverRunning`); i++) await sleep(250);
  await sleep(300);
  st = await state();
  check('one question by hotkey on such a screen: skipped too', st.skips === 1 && /try later/i.test(st.hud), `skips=${st.skips} ${JSON.stringify(st.hud)}`);

  console.log('\n=== which buttons count as the skip button ===');
  const skipMissed = [], skipWrong = [];
  await fresh('?course=3&end=real', {});
  const asSkip = label => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = '<button style="padding:6px 12px">' + ${JSON.stringify(label)} + '</button>';
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton('skip', null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove(); return ok;
  })()`);
  for (const l of ["I'll try later", 'I’ll try later', 'Try later', 'Skip', 'Skip question', 'سأحاول لاحقًا']) if (!(await asSkip(l))) skipMissed.push(l);
  for (const l of ['Try again', 'Later', 'Skip to content', 'Next', 'Submit Answer', "I'll try later if there is time and I feel like it"]) if (await asSkip(l)) skipWrong.push(l);
  check('the skip button is found by its label, and nothing else is', !skipMissed.length && !skipWrong.length, `missed ${JSON.stringify(skipMissed)} wrongly ${JSON.stringify(skipWrong)}`);

  // The lesson player's footer bar holds the buttons that move a lesson on. An answer in the tray
  // that reads "next steps" is not one of them, and neither is a stray button outside it.
  console.log('\n=== Next, Submit and skip are the footer\'s ===');
  await fresh('?course=3&end=real', {});
  const inProbe = (kind, html) => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe'; host.innerHTML = ${JSON.stringify(html)};
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton(${JSON.stringify(kind)}, null);
    const out = hit && hit.closest('#probe') ? hit.textContent.trim() : null;
    host.remove(); return out; })()`);
  const FOOT = (inner) => `<div class="lib-navigation-container">${inner}</div>`;
  check('a draggable item reading "next steps" is not Next', await inProbe('next', '<div role="button" aria-roledescription="draggable" style="padding:6px">next steps</div>') === null);
  check('a sortable item reading "next" is not Next either', await inProbe('next', '<div role="button" aria-roledescription="sortable" style="padding:6px">next</div>') === null);
  check('nor is anything marked draggable', await inProbe('next', '<div role="button" draggable="true" style="padding:6px">continue</div>') === null);
  check('a draggable reading "submit" is not Submit', await inProbe('submit', '<div role="button" aria-roledescription="draggable" style="padding:6px">submit</div>') === null);
  check('with a footer on the page, Next is the footer\'s, not a button reading "next steps" outside it',
    await inProbe('next', `<button style="padding:6px">next steps</button>${FOOT('<button style="padding:6px">Next</button>')}`) === 'Next');
  check('with a footer on the page, a "Continue" outside it is not Next',
    await inProbe('next', `<button style="padding:6px">Continue</button>${FOOT('<button style="padding:6px">Go Back</button>')}`) === null);
  check('Submit is the footer\'s too', await inProbe('submit', `<button style="padding:6px">Submit</button>${FOOT('<button style="padding:6px">Submit Answer</button>')}`) === 'Submit Answer');
  check('and so is "I\'ll try later"', await inProbe('skip', `<button style="padding:6px">Skip</button>${FOOT('<button style="padding:6px">I\'ll try later</button>')}`) === 'I\'ll try later');
  check('with no footer on the page, a plain Next button is found as before', await inProbe('next', '<button style="padding:6px">Next</button>') === 'Next');
  check('a footer that is not showing (the opening screen\'s, while a question is up) restricts nothing',
    await inProbe('next', `<div class="lib-navigation-container" style="display:none"><button>Start</button></div><button style="padding:6px">Next</button>`) === 'Next');
  check('and neither does one with no button showing in it',
    await inProbe('submit', `${FOOT('<span>just text</span>')}<button style="padding:6px">Submit Answer</button>`) === 'Submit Answer');

  console.log('\n=== which buttons count as "back to coursework" and "start" ===');
  const asKind = (kind, label) => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = '<button style="padding:6px 12px">' + ${JSON.stringify(label)} + '</button>';
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton(${JSON.stringify(kind)}, null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove();
    return ok;
  })()`);
  await fresh('?course=3&end=real', {});
  for (const [kind, yes, no] of [
    ['backToCoursework', ['Back to Coursework', 'Back to coursework', '‹ Back to Coursework', 'Back to Course Work'], ['Back', 'Go Back', 'Back to lesson', 'Back to question', 'Coursework']],
    ['startTask', ['Start', 'start', 'ابدأ'], ['Continue', 'Restart', 'Start next lesson', "Let's Go!", 'Start over', 'Next']],
    ['finish', ['Finish', 'Done'], ['Finish later', 'Unfinished']],
  ]) {
    const missed = [], wrongly = [];
    for (const l of yes) if (!(await asKind(kind, l))) missed.push(l);
    for (const l of no) if (await asKind(kind, l)) wrongly.push(l);
    check(`${kind}: every wording is found, and none of the others`, !missed.length && !wrongly.length, `missed ${JSON.stringify(missed)} wrongly ${JSON.stringify(wrongly)}`);
  }

  console.log('\n=== a Start in a card for an attempt is not the next lesson ===');
  await fresh('?course=3&end=real', {});
  const startIn = html => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = ${JSON.stringify(html)};
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton('startTask', null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove(); return ok;
  })()`);
  check('a task in the list (title, tasks assigned, Start): found',
    await startIn('<div><b>17. A Lesson Title</b> <span>2 Tasks Assigned</span> <button style="padding:6px">Start</button></div>') === true);
  check('"2nd Attempt … Start": not the next lesson', await startIn('<div><b>2nd Attempt</b><br><button style="padding:6px">Start</button></div>') === false);
  check('"3rd Attempt … In Progress … Start": not it either', await startIn('<div><div>3rd Attempt</div><div>Not Attempted</div><button style="padding:6px">Start</button></div>') === false);
  check('an Arabic attempt card is not it either', await startIn('<div><b>المحاولة الثانية</b><br><button style="padding:6px">ابدأ</button></div>') === false);

  console.log('\n=== which buttons count as "next lesson" ===');
  await fresh('?course=3&end=next', {});
  const asNextLesson = label => s.eval(`(() => {
    const host = document.createElement('div'); host.id = 'probe';
    host.innerHTML = '<button style="padding:6px 12px">' + ${JSON.stringify(label)} + '</button>';
    document.body.appendChild(host);
    const hit = window.__alefSolver.findButton('nextLesson', null);
    const ok = !!hit && hit.closest('#probe') === host;
    host.remove();
    return ok;
  })()`);
  const SHOULD = ['Next Lesson', 'Next lesson ›', 'Start next lesson', 'Go to next lesson', 'Continue to next lesson', 'Next activity', 'الدرس التالي', 'ابدأ الدرس التالي', 'الانتقال إلى الدرس التالي', 'النشاط التالي'];
  const missed = []; for (const l of SHOULD) if (!(await asNextLesson(l))) missed.push(l);
  check('every wording is found', missed.length === 0, missed.length ? `missed ${JSON.stringify(missed)}` : '');
  const NOT = ['Next', 'Next question', 'Continue', 'Previous lesson', 'Lesson plan', 'Next lesson plan details and notes for teachers', 'السؤال التالي', 'الدرس السابق', 'Check My Understanding'];
  const wrong = []; for (const l of NOT) if (await asNextLesson(l)) wrong.push(l);
  check('and nothing else is', wrong.length === 0, JSON.stringify(wrong));
  check('one in the lesson sidebar is found too (it often lives there)',
    await s.eval(`(() => { const a = document.createElement('aside'); a.innerHTML = '<nav><button style="padding:6px 12px">Next Lesson</button></nav>'; document.body.appendChild(a);
      const hit = window.__alefSolver.findButton('nextLesson', null); const ok = !!hit && a.contains(hit); a.remove(); return ok; })()`) === true);
  check('"Next Lesson" is not mistaken for the Next button', await s.eval(`(() => {
      const host = document.createElement('div'); host.innerHTML = '<button style="padding:6px 12px">Next Lesson</button>'; document.body.appendChild(host);
      const hit = window.__alefSolver.findButton('next', null); const ok = !hit || !host.contains(hit); host.remove(); return ok; })()`) === true);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
