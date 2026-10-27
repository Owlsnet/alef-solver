#!/usr/bin/env node
/* The typed-math question: "Complete the polynomial function … f(x) = ▢ − 6x + 8". The answer box is a
 * MathLive <math-field> (not an <input>), with a "Type…" label of its own beside it.
 *
 * Two things are modelled the way Chrome really does them, because the first version of this test did
 * not and passed while the live page did nothing:
 *   - content.js runs in an ISOLATED WORLD (Page.createIsolatedWorld), as an extension's page script
 *     does. There, a page-defined element's methods and properties (insert, value) do not exist.
 *   - bridge-main.js is loaded into the page's own world before the page's scripts, as the manifest's
 *     "world": "MAIN" content script is (Page.addScriptToEvaluateOnNewDocument).
 * The page is the REAL MathLive (tools/dndkit/math.jsx, built by `node tools/dndkit/setup.js`): how a
 * value is set, which events it sends, how it writes a formula back are the library's own.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(process.env.ALEF_CONTENT || path.join(ROOT, 'content.js'), 'utf8');
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'bridge-main.js'), 'utf8');
const PAGE = 'file:///' + path.join(__dirname, 'dndkit', 'math.html').replace(/\\/g, '/');
const BUNDLE = path.join(ROOT, '.tmp', 'dndkit', 'math.js');
const PORT = 9373;
process.env.CDP_PORT = String(PORT);

process.on('uncaughtException', e => { console.error('\n✗ UNCAUGHT:', e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('\n✗ UNHANDLED REJECTION:', e && e.stack || e); process.exit(1); });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

if (!fs.existsSync(BUNDLE)) { console.error('✗ run `node tools/dndkit/setup.js` first (it builds the MathLive page)'); process.exit(2); }

const chromeExe = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => p && fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = scratch.mkdtemp('alef-math-');
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

  // bridge-main.js: a "world": "MAIN" content script at document_start.
  const bridge = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_JS });

  let ctx = null;                                                    // the extension's isolated world
  async function load(query = '', reply = ['3x^2']) {
    await s.goto(PAGE + query);
    for (let i = 0; i < 80; i++) {                                    // MathLive upgrades its element a moment after load
      if (await s.eval(`!!document.querySelector('math-field') && typeof document.querySelector('math-field').insert === 'function'`)) break;
      await sleep(100);
    }
    const tree = await s.send('Page.getFrameTree');
    const w = await s.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'alef-solver', grantUniveralAccess: true });
    ctx = w.executionContextId;
    await s.eval(`
      window.__asked = []; window.__reply = ${JSON.stringify(reply)};
      window.chrome = { runtime: {
        sendMessage: (m) => {
          if (m && m.type === 'ask') { window.__asked.push(m.payload);
            return Promise.resolve({ words: window.__reply, confidence: 0.9, why: 'scripted' }); }
          return Promise.resolve({ error: 'unstubbed' }); },
        onMessage: { addListener(){} } },
        storage: { local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: () => Promise.resolve() },
                   onChanged: { addListener(){} } } };
      'ok'`, { awaitPromise: false, contextId: ctx });
    await s.eval(CONTENT_JS, { awaitPromise: false, contextId: ctx });
    await sleep(300);
  }
  const J = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`, { contextId: ctx }));   // in the extension's world
  const M = async expr => JSON.parse(await s.eval(`(async () => JSON.stringify(await (${expr})))()`));                          // in the page's own world

  /* ------------------------------------------------------------ the setup is real */
  console.log('=== the setup is the real one ===');
  await load('');
  check('MathLive is running in the page\'s own world: the element has its insert method there', await M(`typeof document.querySelector('math-field').insert`) === 'function');
  check('and the extension\'s world does NOT see it — the reason a direct call cannot work', await J(`typeof document.querySelector('math-field').insert`) === 'undefined');
  check('so a value written from the extension\'s world is a private property that the page never hears of',
    await J(`(() => { const f = document.querySelector('math-field'); f.value = 'zzz'; return f.value; })()`) === 'zzz' && (await M(`document.querySelector('math-field').value`)) === '');

  /* ------------------------------------------------------------ detection */
  console.log('\n=== one math box: f(x) = ▢ − 6x + 8 ===');
  await load('');
  const rep = await J(`window.__alefSolver.report()`);
  check('recognised as a fill-in-the-blank question', rep.kind === 'cloze', `kind=${rep.kind}`);
  const sc = await J(`(() => { const p = window.__alefSolver.scrape(); return { n: p.cloze.blanks.length, math: p.cloze.blanks.map(b => b.math), text: p.cloze.text }; })()`);
  check('with one blank, and it is marked as a math box', sc.n === 1 && sc.math[0] === true, JSON.stringify(sc));
  check('the text has the blank where the box is, and no "Type…" label in it', /\[BLANK 1\]/.test(sc.text) && !/Type\.\.\./.test(sc.text), JSON.stringify(sc.text));
  check('and the formulas around it read as plain math', /f\(x\)\s*=/.test(sc.text) && /−\s*6x\s*\+\s*8/.test(sc.text), JSON.stringify(sc.text));
  check('the sidebar and the footer are not in it', !/Check My Understanding|Submit Answer/.test(sc.text), JSON.stringify(sc.text));

  /* -------------------------------------------------------------- typing */
  console.log('\n=== typing into it ===');
  const out = await J(`window.__alefSolver.commitCloze(['3x^2'], { autoSubmit: true, answerDelay: 50 })`);
  console.log(`  filled: ${JSON.stringify(out.filled)}  events seen by the page: ${JSON.stringify(await M(`window.__events`))}`);
  check('the REAL field holds the answer, as MathLive writes it', (await M(`window.__values()`))[0] === '3x^2', JSON.stringify(await M(`window.__values()`)));
  check('the page itself noticed (its "Type…" label went, Submit came on) and Submit was pressed', out.selected === true && out.submitted === true, out.error || '');
  check('the page took the answer as submitted', JSON.stringify(await M(`window.__submitted`)) === JSON.stringify(['3x^2']), JSON.stringify(await M(`window.__submitted`)));
  check('it was Submit Answer that got clicked, not the sidebar button', /^submit answer/i.test(out.submitLabel || '') && await M(`window.__sideClicks`) === 0, JSON.stringify(out.submitLabel));
  check('the math keyboard that focusing the box opens was put away again', await M(`!(window.mathVirtualKeyboard && window.mathVirtualKeyboard.visible)`) === true);

  console.log('\n=== other things a math answer can be ===');
  for (const [typed, want, what] of [
    ['3x^2 - 6x', /^3x\^2-6x$|^3x\^\{2\}-6x$/, 'a polynomial with a minus sign'],
    ['3x^2 − 6x', /^3x\^2-6x$|^3x\^\{2\}-6x$/, 'with the real minus sign (U+2212) the model may use'],
    ['sqrt(x)', /\\sqrt/, 'a square root'],
    ['(1)/(2)', /\\frac/, 'a fraction'],
    ['-4', /^-4$/, 'a negative number'],
    // The model's own way of writing it, tidied first (cleanMathAnswer): never backslashes or dollar
    // signs in the box as text.
    ['$\\frac{3}{4}$', /^\\frac\{?3\}?\{?4\}?$/, 'a fraction the model wrote in LaTeX, with dollar signs'],
    ['\\sqrt{2}', /^\\sqrt\{?2\}?$/, 'a root the model wrote in LaTeX'],
    ['x^{2}+1', /^x\^\{?2\}?\+1$/, 'a power with LaTeX braces'],
    ['½', /^\\frac\{?1\}?\{?2\}?$/, 'a fraction written as one character'],
  ]) {
    await load('', [typed]);
    const o = await J(`window.__alefSolver.commitCloze([${JSON.stringify(typed)}], { autoSubmit: false })`);
    const got = (await M(`window.__values()`))[0];
    check(`${what}: ${JSON.stringify(typed)} → ${JSON.stringify(got)}`, want.test(got) && o.selected === true, o.error || '');
  }

  console.log('\n=== two boxes: the vertex is ( ▢ , ▢ ), with a power in the question ===');
  await load('?blanks=2&power=1', ['2', '0']);
  const sc2 = await J(`(() => { const p = window.__alefSolver.scrape(); return { n: p.cloze.blanks.length, math: p.cloze.blanks.map(b => b.math), text: p.cloze.text }; })()`);
  check('two blanks, both math boxes', sc2.n === 2 && sc2.math.every(Boolean), JSON.stringify(sc2));
  check('the question reads x^2 − 4x + 4, with the power kept', /x\^2\s*−\s*4x\s*\+\s*4/.test(sc2.text), JSON.stringify(sc2.text));
  check('and the two blanks are in order, in their brackets', /\(\s*\[BLANK 1\]\s*,\s*\[BLANK 2\]\s*\)/.test(sc2.text), JSON.stringify(sc2.text));
  const out2 = await J(`window.__alefSolver.commitCloze(['2', '0'], { autoSubmit: true, answerDelay: 50 })`);
  check('both are typed in the real fields, and Submit pressed', JSON.stringify(await M(`window.__values()`)) === JSON.stringify(['2', '0']) && out2.submitted === true, out2.error || JSON.stringify(await M(`window.__values()`)));

  console.log('\n=== end to end: solveOne with a scripted model reply ===');
  await load('', ['3x^2']);
  const res = await J(`window.__alefSolver.solveOne(true)`);
  check('solveOne reported ok', res.ok === true, res.reason || '');
  check('the answer is in the field and was submitted', JSON.stringify(await M(`window.__submitted`)) === JSON.stringify(['3x^2']), JSON.stringify(await M(`window.__submitted`)));
  const sent = await J(`(() => { const p = window.__asked[0]; return { kind: p.kind, n: p.cloze.blanks.length, math: p.cloze.blanks.map(b => b.math), text: p.cloze.text }; })()`);
  check('the model was sent a fill-in-the-blank question whose blank is flagged as math',
    sent.kind === 'cloze' && sent.n === 1 && sent.math[0] === true && /\[BLANK 1\]/.test(sent.text) && !/Type\.\.\./.test(sent.text), JSON.stringify(sent).slice(0, 220));

  console.log('\n=== the dump can see inside the field ===');
  await load('');
  await J(`window.__alefSolver.commitCloze(['3x^2'], { autoSubmit: false })`);
  const dump = await J(`window.__alefSolver.dump ? window.__alefSolver.report() : null`);
  check('the dump reads the field\'s value through the page-side helper, and says the helper answered',
    (dump.editables || []).some(e => /math-field/.test(e) && /value="3x\^2"/.test(e) && /it answered/.test(e)), JSON.stringify((dump.editables || []).map(e => e.slice(-200))));

  /* ------------------------------------------------- without the page-side helper */
  console.log('\n=== if the page-side helper is not there ===');
  await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bridge.identifier });
  await load('');
  check('(fixture) there is no helper in the page\'s world now', await M(`typeof window.__alefBridge`) === 'undefined');
  const out3 = await J(`window.__alefSolver.commitCloze(['3x^2'], { autoSubmit: true, answerDelay: 50 })`);
  check('it does not pretend: it says the box could not be reached, and why', out3.selected !== true && out3.submitted !== true && /could not be reached/.test(out3.error || '') && /bridge-main\.js/.test(out3.error || ''), JSON.stringify(out3.error));
  check('and the field is still empty, nothing was submitted', (await M(`window.__values()`))[0] === '' && await M(`window.__submitted`) === null);

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
