#!/usr/bin/env node
/* Drive the Alef Solver pipeline over CDP.
 *
 *   node solve.js --recon              dump what the scraper sees (default)
 *   node solve.js --solve              full cycle: scrape -> ask -> click -> submit
 *   node solve.js --solve --no-submit  pick the answer, don't submit
 *   node solve.js --url <url>          navigate first
 *   node solve.js --frames             report from every frame, not just the top
 *
 * Key comes from OPENROUTER_API_KEY, or from a .key.txt file in the project folder
 * (so the key never has to appear in a shell command). .key.txt is git-ignored.
 */

const fs = require('fs');
const path = require('path');
const { Session, findPage, version, port } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = path.join(ROOT, 'content.js');
const KEY_FILE = path.join(ROOT, '.key.txt');
const API = 'https://openrouter.ai/api/v1/chat/completions';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const MODE = flag('solve', false) ? 'solve' : 'recon';
const URL = flag('url', null);
const MODEL = flag('model', 'deepseek/deepseek-v4.1-flash');
const DO_SUBMIT = !flag('no-submit', false);
const ALL_FRAMES = !!flag('frames', false);

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  return '';
}

/* ------------------------------------------------------------- the prompt */

const SYSTEM = [
  'You are taking a multiple-choice exam. You are shown a question stem, its',
  'answer choices, and usually a reading passage and/or a figure.',
  '',
  'First read the passage in full, then decide. Most questions are comprehension',
  'questions whose answer is directly supported by the text; check each candidate',
  'against the passage rather than picking what merely sounds plausible. If an',
  'image is attached it is the figure the question refers to — read it and answer',
  'from what it actually shows.',
  '',
  'Respond with ONLY a JSON object, no prose and no markdown fences:',
  '{"answer":"<letter>","index":<0-based index>,"confidence":<0..1>,"why":"<max 12 words>"}',
].join('\n');

function todoText(r) {
  const out = [];
  if (r.passage) out.push('=== PASSAGE ===', r.passage, '');
  out.push('=== QUESTION ===', r.stem || '(no stem found)', '');
  if (r.options?.length) {
    out.push('=== CHOICES ===');
    r.options.forEach((t, i) => out.push(`${'ABCDEFGHIJ'[i]}. ${t}`));
    out.push('');
  }
  return out.join('\n');
}

function parseAnswer(raw) {
  if (!raw) return null;
  let t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const j = JSON.parse(t.slice(s, e + 1));
      let idx = Number.isInteger(j.index) ? j.index : null;
      const letter = typeof j.answer === 'string' ? j.answer.trim().toUpperCase()[0] : null;
      if (idx === null && letter) {
        const i = 'ABCDEFGHIJ'.indexOf(letter);
        if (i >= 0) idx = i;
      }
      if (idx !== null) {
        return { index: idx, letter, confidence: typeof j.confidence === 'number' ? j.confidence : null, why: j.why || '' };
      }
    } catch { /* fall through */ }
  }
  const m = t.match(/\b(?:answer|choice|option)\b[^A-J]{0,20}\b([A-J])\b/i) || t.match(/^\(?([A-J])\)?[.):]?\s*$/i);
  if (m) return { index: 'ABCDEFGHIJ'.indexOf(m[1].toUpperCase()), letter: m[1].toUpperCase(), confidence: null, why: 'regex fallback' };
  return null;
}

/* ---------------------------------------------------------------- report */

/** Serialize what a frame's scraper sees. `report()` returns plain JSON. */
const REPORT_EXPR = `
  (() => {
    if (!window.__alefSolver) return JSON.stringify({ error: 'scraper not injected' });
    return JSON.stringify(window.__alefSolver.report());
  })()
`;

/* ------------------------------------------------------------------ main */

(async () => {
  try {
    const v = await version();
    console.log(`chrome:  ${v.Browser}  (cdp :${port()})`);
  } catch (e) {
    console.error(`\n✗ No Chrome debug port on :${port()}.\n` +
      `  Launch one with:\n` +
      `    chrome --remote-debugging-port=${port()} --user-data-dir="${path.join(ROOT, '.chrome-profile')}"\n` +
      `  or run:  powershell -File ${path.join(__dirname, 'launch.ps1')}\n`);
    process.exit(2);
  }

  const page = await findPage();
  if (!page) { console.error('✗ No page target found.'); process.exit(2); }
  console.log(`tab:     ${page.title}\n         ${page.url}`);

  const s = await Session.attach(page.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  if (URL) {
    console.log(`→ navigating to ${URL}`);
    await s.goto(URL);
  }

  // Inject the extension's own scraper so the driver and the extension can
  // never drift apart.
  await s.eval(fs.readFileSync(CONTENT_JS, 'utf8'), { awaitPromise: false });

  // Notify the top frame that it is driven by CDP rather than by an extension.
  await s.eval(`window.__alefDriver = true; 'ok'`, { awaitPromise: false });

  const raw = await s.eval(REPORT_EXPR);
  let report;
  try { report = JSON.parse(raw); } catch { report = { error: 'unparseable report', raw }; }

  if (report.error) {
    console.error('✗ scraper did not load:', report.error);
    process.exit(3);
  }

  console.log('\n──────────── scrape ────────────');
  console.log(`score:      ${report.score}   (stem + choices + passage)`);
  console.log(`frame:      ${report.frame}`);
  console.log(`stem:       ${report.stem ? JSON.stringify(report.stem.slice(0, 160)) : '— NOT FOUND —'}`);
  console.log(`passage:    ${report.passageLen} chars`);
  if (report.passageHead) console.log(`  head:     ${JSON.stringify(report.passageHead.slice(0, 140))}`);
  console.log(`choices:    ${report.options.length}`);
  for (const [i, t] of report.options.entries()) {
    console.log(`  ${'ABCDEFGHIJ'[i]}. ${String(t).slice(0, 90)}`);
  }
  console.log(`images:     ${report.images}`);
  console.log(`radios:     ${report.radios} role=radio, ${report.nativeRadios} input[type=radio]`);
  console.log(`choiceEl:   ${report.choiceSelector || '— none —'}`);
  console.log(`buttons:`);
  for (const b of report.submitCandidates || []) console.log(`  ${b}`);

  if (MODE === 'recon') {
    console.log('\n(recon only — pass --solve to run the full cycle)');
    s.close();
    return;
  }

  /* ------------------------------------------------------------- solve */

  if (report.options.length < 2) {
    console.error('\n✗ No answer choices found — cannot solve. Fix scraping first.');
    s.close();
    process.exit(3);
  }

  const key = readKey();
  if (!key) {
    console.error(`\n✗ No API key. Put it in ${KEY_FILE} (one line, nothing else),\n` +
                  `  or set OPENROUTER_API_KEY in the environment.`);
    s.close();
    process.exit(4);
  }

  // Screenshot when the text alone probably isn't enough.
  const needShot = !report.passage || report.passageLen < 250 || report.images > 0;
  let shot = null;
  if (needShot) {
    process.stdout.write('\ncapturing full page… ');
    shot = await s.screenshot({ beyondViewport: true }).catch(e => (console.log('failed:', e.message), null));
    if (shot) console.log(`${(shot.length * 0.75 / 1024) | 0} KB`);
  } else {
    console.log('\npassage is long enough — skipping screenshot');
  }

  const content = [{ type: 'text', text: todoText(report) }];
  if (shot) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot}` } });

  console.log(`asking ${MODEL}…`);
  const t0 = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://moe.alefed.com',
      'X-Title': 'Alef Solver',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    s.close();
    process.exit(5);
  }

  const json = await res.json();
  const msg = json.choices?.[0]?.message?.content ?? '';
  const ms = Date.now() - t0;
  console.log(`reply in ${ms}ms: ${String(msg).slice(0, 200)}`);

  const ans = parseAnswer(msg);
  if (!ans || ans.index == null || ans.index >= report.options.length) {
    console.error('✗ could not parse a usable answer');
    s.close();
    process.exit(6);
  }

  const letter = 'ABCDEFGHIJ'[ans.index];
  console.log(`\n→ answer ${letter}: ${String(report.options[ans.index]).slice(0, 120)}`);
  if (ans.why) console.log(`  model says: ${ans.why}`);
  if (ans.confidence != null) console.log(`  confidence: ${(ans.confidence * 100) | 0}%`);
  if (json.usage) console.log(`  tokens: ${json.usage.prompt_tokens} in / ${json.usage.completion_tokens} out`);

  const out = await s.eval(
    `window.__alefSolver.commit(${ans.index}, { autoSubmit: ${DO_SUBMIT} })`
  );

  console.log('\n──────────── commit ────────────');
  console.log(`clicked:    ${out?.clicked ? 'yes' : 'NO'}`);
  console.log(`selected:   ${out?.selected ? 'yes' : 'no'}`);
  console.log(`submitted:  ${out?.submitted ? 'yes' : (DO_SUBMIT ? 'no — no enabled submit button found' : 'skipped (--no-submit)')}`);
  if (out?.error) console.log(`error:      ${out.error}`);

  s.close();
})().catch(e => {
  console.error('\n✗', e.message || e);
  process.exit(1);
});
