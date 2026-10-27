#!/usr/bin/env node
/* The live site's drop-downs are react-select. One of them (Arabic, inside a <strong>, under a bulleted
 * list) came back "options of drop-down 1 not readable". This drives the real library (fixture loads it
 * from esm.sh, so it needs the network): the menu has to be opened, read, and an option chosen.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const CONTENT_JS = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixture-reactselect.html');
const PORT = 9353;
process.env.CDP_PORT = String(PORT);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = scratch.mkdtemp('alef-rs-');
  const exe = path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => {
    try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }); } catch { }
  };
  process.on('exit', cleanup);
  for (let i = 0; i < 60; i++) { await sleep(250); try { await version(); break; } catch { } }
  const s = await Session.attach((await findPage(/about:blank/)).webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  await s.goto('file:///' + FIXTURE.replace(/\\/g, '/'));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await sleep(250); ready = await s.eval(`!!document.querySelector('.lib-Select__control')`); }
  if (!ready) { console.log('✗ react-select did not load (no network?)'); process.exit(2); }

  await s.eval(`window.__asked = [];
    window.chrome = { runtime: { sendMessage: (m) => { if (m && m.type === 'ask') { window.__asked.push(m.payload); return Promise.resolve({ picks: [0], confidence: 0.9, why: 'scripted' }); } return Promise.resolve({ error: 'unstubbed' }); },
      onMessage: { addListener(){} } }, storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener(){} } } }; 'ok'`);
  await s.eval(CONTENT_JS, { awaitPromise: false });
  await sleep(300);
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));

  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as a drop-down question', rep.kind === 'dropdown', `kind=${rep.kind}`);
  const menus = await J(`window.__alefSolver.readDropdownOptions(window.__alefSolver.scrape().dropdown.blanks)`);
  check('the menu is opened and its three options read', JSON.stringify(menus) === JSON.stringify([['إرشاديٌّ', 'سرديٌّ', 'وصفيٌّ']]), JSON.stringify(menus));
  check('and closed again with nothing chosen', await s.eval(`window.__sel === null && !document.querySelector('.lib-Select__menu')`) === true);
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solving it picks the first option', res.ok === true && await s.eval(`window.__sel`) === 'إرشاديٌّ', `${res.reason || ''} sel=${await s.eval('window.__sel')}`);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n✗ harness error:', e.message || e); process.exit(1); });
