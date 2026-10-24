#!/usr/bin/env node
/* Offline end-to-end test of the scraper and the click sequence.
 *
 *   node test.js            scrape + commit against fixture.html
 *   node test.js --api      also send the scraped question to the real model
 *
 * Launches its own headless Chrome on a throwaway profile, so it needs neither
 * your browser session nor any package installs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture.html');
const PORT = 9333;

// Must be set before cdp.js resolves any endpoint.
process.env.CDP_PORT = String(PORT);
const API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'deepseek/deepseek-v4.1-flash';
const WITH_API = process.argv.includes('--api');

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

function launch() {
  const profile = require('./scratch.js').mkdtemp('alef-test-');
  const child = spawn(chromeExe, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  child.on('error', e => console.error('chrome spawn:', e.message));
  return { child, profile };
}

async function waitForPort(tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { return await version(); } catch { /* keep waiting */ }
  }
  throw new Error(`headless chrome never answered on :${PORT}`);
}

/* ------------------------------------------------------------------ main */

(async () => {
  if (!chromeExe) { console.error('✗ chrome.exe not found'); process.exit(2); }
  if (!fs.existsSync(FIXTURE)) { console.error('✗ fixture.html missing'); process.exit(2); }

  const { child, profile } = launch();
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

  const v = await waitForPort();
  console.log(`headless: ${v.Browser}\n`);

  const page = await findPage(/about:blank|fixture/);
  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  await s.goto('file:///' + FIXTURE.replace(/\\/g, '/'));
  console.log(`loaded ${path.basename(FIXTURE)}\n`);

  /* --- inject the real content script --------------------------------- */

  await s.eval(CONTENT_JS, { awaitPromise: false });

  const loaded = await s.eval(`typeof window.__alefSolver === 'object'`);
  check('content.js loads outside an extension context', loaded === true);
  if (!loaded) { console.error('\n✗ cannot continue without the scraper'); process.exit(3); }

  /* --- scraping ------------------------------------------------------- */

  console.log('\nscrape');
  const report = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));

  check('found 4 answer choices', report.options.length === 4, `got ${report.options.length}`);
  check('choice order is correct',
    /statistics/.test(report.options[0] || '') && /contrasting/.test(report.options[1] || ''),
    report.options[1] ? `B = "${report.options[1].slice(0, 46)}…"` : '');
  check('found a question stem', /develop the central idea/i.test(report.stem), JSON.stringify(report.stem));
  check('stem is the question, not a choice', !/^by citing|^by contrasting/.test(report.stem || ''));
  check('passage not captured yet (behind the button)', report.passageLen === 0, `${report.passageLen} chars`);
  check('choice element identifiable', !!report.choiceSelector, report.choiceSelector || '');
  check('submit button offered', (report.submitCandidates || []).some(b => /submit/i.test(b)));

  // Each row must map to exactly one choice. If a row swallowed its siblings,
  // every index would resolve to the same element and clicking any answer would
  // land on the first one — answering "A" every time, silently.
  const distinct = JSON.parse(await s.eval(`
    JSON.stringify((() => {
      const p = window.__alefSolver.scrape();
      const els = p.options.map(o => o.el);
      return {
        sane: p.optionsSane,
        unique: new Set(els).size,
        count: els.length,
        textPer: p.options.map(o => o.text.length),
      };
    })())
  `));
  check('each choice row is a distinct element', distinct.unique === distinct.count,
    `${distinct.unique}/${distinct.count} unique`);
  check('grouping reported as sane', distinct.sane === true);
  check('every choice carries text', distinct.textPer.every(n => n > 2), `lengths ${distinct.textPer}`);

  /* --- auto-opening the passage (needs chrome.tabs, so drive it manually) */

  console.log('\nauto-open passage (simulated)');
  await s.eval(`document.getElementById('readPassage').click()`);
  await new Promise(r => setTimeout(r, 250));
  const report2 = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));
  check('passage found once opened', report2.passageLen > 400, `${report2.passageLen} chars`);
  check('passage is the passage, not the choices',
    /pilings|trawlers|cannery/i.test(report2.passageHead || ''), JSON.stringify((report2.passageHead || '').slice(0, 60)));
  check('stem still correct after passage opens', /develop the central idea/i.test(report2.stem));

  /* --- the click sequence --------------------------------------------- */

  console.log('\ncommit (pick B, submit)');
  const out = await s.eval(
    `window.__alefSolver.commit(1, { autoSubmit: true, answerDelay: 60 })`
  );

  check('clicked a choice', out?.clicked === true);
  check('selection registered on the page',
    await s.eval(`window.__fixtureSelection`) === 1,
    `page recorded index ${await s.eval(`window.__fixtureSelection`)}`);
  check('our own selected() sees it', out?.selected === true);
  check('submit button became enabled and was clicked', out?.submitted === true, out?.submitLabel ? `"${out.submitLabel}"` : '');
  check('the page actually submitted', await s.eval(`window.__fixtureSubmitted === true`) === true);

  const state = await s.eval(`[...document.querySelectorAll('.choice')].map(c => c.dataset.state).join(',')`);
  check('only B is marked checked', state === 'unchecked,checked,unchecked,unchecked', state);

  // Pole-to-pole check: the click target must depend on the index, not always
  // resolve to the first choice.
  console.log('\nindex mapping (A vs D)');
  await s.eval(`window.__fixtureSelection = -1`);
  await s.eval(`window.__alefSolver.commit(0, { autoSubmit: false })`);
  const gotA = await s.eval(`window.__fixtureSelection`);
  await s.eval(`window.__alefSolver.commit(3, { autoSubmit: false })`);
  const gotD = await s.eval(`window.__fixtureSelection`);
  check('index 0 selects choice A', gotA === 0, `page recorded ${gotA}`);
  check('index 3 selects choice D', gotD === 3, `page recorded ${gotD}`);
  check('the two differ (not a constant click target)', gotA !== gotD);
  const state2 = await s.eval(`[...document.querySelectorAll('.choice')].map(c => c.dataset.state).join(',')`);
  check('only D is marked checked', state2 === 'unchecked,unchecked,unchecked,checked', state2);

  /* --- a wrong pick still works (regression guard) --------------------- */

  console.log('\ncommit (pick D, no submit)');
  await s.eval(`window.__fixtureSubmitted = false`);
  const out2 = await s.eval(`window.__alefSolver.commit(3, { autoSubmit: false })`);
  check('index 3 selected', await s.eval(`window.__fixtureSelection`) === 3);
  check('suppressed submit when asked', out2?.submitted === false);
  check('did not submit', await s.eval(`window.__fixtureSubmitted`) !== true);

  /* --- second fixture: the real split-cell layout ---------------------- */

  console.log('\n--- fixture-table.html (split cells, native radios) ---');
  await s.goto('file:///' + path.join(__dirname, 'fixture-table.html').replace(/\\/g, '/'));
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await new Promise(r => setTimeout(r, 200));

  const rep = JSON.parse(await s.eval(`JSON.stringify(window.__alefSolver.report())`));
  check('found 4 choices', rep.options.length === 4, `got ${rep.options.length}`);
  check('grouping reported as sane', rep.optionsSane === true);
  check('choice text is NOT blank', rep.options.every(t => t && t.length > 10),
    JSON.stringify(rep.options[1] || '').slice(0, 60));
  // Each index must carry ITS OWN text — a shift by one means the model reasons
  // about the right answer and the click lands on the wrong choice.
  const want = [
    /changes in technology/,
    /two perspectives/,
    /benefits workers more than globalisation/,
    /skills for new careers/,
  ];
  for (const [i, re] of want.entries()) {
    check(`choice ${'ABCD'[i]} has its own text`, re.test(rep.options[i] || ''),
      JSON.stringify((rep.options[i] || '').slice(0, 52)));
  }
  check('stem separated from the prompt line',
    /develop the central idea/i.test(rep.stem), JSON.stringify(rep.stem));

  // Clicking must pick the matching radio, for each index independently.
  console.log('\nclick mapping (split cells)');
  for (const i of [0, 1, 2, 3]) {
    const got = await s.eval(`(() => {
      window.__fixtureSelection = -1;
      const row = window.__alefSolver.scrape().options[${i}].el;
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      if (window.__fixtureSelection === -1) row.click();
      return window.__fixtureSelection;
    })()`);
    check(`clicking row ${i} selects choice ${'ABCD'[i]}`, got === i, `page recorded ${got}`);
  }

  /* --- optional live API call ----------------------------------------- */

  if (WITH_API) {
    const keyFile = path.join(ROOT, '.key.txt');
    const key = process.env.OPENROUTER_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
    console.log('\nlive api');
    if (!key) {
      check('api key available', false, `set OPENROUTER_API_KEY or write ${keyFile}`);
    } else {
      const body = [
        '=== PASSAGE ===', report2.passage, '',
        '=== QUESTION ===', report2.stem, '',
        '=== CHOICES ===',
        ...report2.options.map((t, i) => `${'ABCDEFGHIJ'[i]}. ${t}`),
      ].join('\n');

      const t0 = Date.now();
      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: 'Answer the multiple-choice question. Reply with ONLY JSON: {"answer":"<letter>","index":<int>,"confidence":<float>,"why":"<12 words>"}' },
            { role: 'user', content: body },
          ],
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }),
      });
      const ms = Date.now() - t0;

      if (!res.ok) {
        check(`api responded`, false, `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      } else {
        const j = await res.json();
        const txt = j.choices?.[0]?.message?.content ?? '';
        check(`api responded in ${ms}ms`, true, String(txt).slice(0, 90));
        const m = String(txt).match(/"index"\s*:\s*(\d+)/) || String(txt).match(/"answer"\s*:\s*"([A-J])"/i);
        let idx = m ? (m[1].length === 1 ? 'ABCDEFGHIJ'.indexOf(m[1].toUpperCase()) : Number(m[1])) : null;
        check('model chose the intended answer (B)', idx === 1,
          idx == null ? 'could not parse index' : `chose ${'ABCDEFGHIJ'[idx]}`);
        if (j.usage) console.log(`    tokens: ${j.usage.prompt_tokens} in / ${j.usage.completion_tokens} out`);
      }
    }
  }

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
