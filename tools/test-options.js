#!/usr/bin/env node
/* The Options page with two services to choose from: OpenRouter and Google Gemini.
 * Runs the real options.html and options.js in headless Chrome, with the extension's storage and
 * the network both scripted, so no key is needed and nothing goes to Google or OpenRouter.
 *
 * Checked: only the chosen service's fields show, what is saved and what is kept, and what
 * "Test key" sends and says for each service — including that the Gemini key goes in a header and
 * never in an address.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, findPage, version } = require('./cdp.js');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const OPTIONS = 'file:///' + (process.env.ALEF_OPTIONS || path.join(ROOT, 'options.html')).split(path.sep).join('/');
const PORT = 9379;
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
const KEY = 'AIzaSy-SECRET-TEST-KEY-0123456789';

/** The extension's storage, its messages to the service worker, and the network, all scripted.
 *  `window.__replies` is a queue for fetches and `window.__msgReplies` one for messages: each
 *  call takes the next. */
const STUB = (store = {}) => `
  window.__store = ${JSON.stringify(store)};
  window.__fetches = []; window.__replies = []; window.__msgReplies = []; window.__msgSent = [];
  window.chrome = { tabs: { create: async o => { window.__msgSent.push({ tab: o.url }); return { id: 1 }; } },
    runtime: { getManifest: () => ({ version: '9.9.9' }),
      sendMessage: async m => { window.__msgSent.push({ type: m.type, keys: Object.keys(m).sort() }); return window.__msgReplies.shift(); } },
    storage: { local: {
      get: async k => { const o = {}; for (const x of [].concat(k)) if (x in window.__store) o[x] = window.__store[x]; return o; },
      set: async o => { Object.assign(window.__store, o); },
    } } };
  window.fetch = async (url, init) => {
    window.__fetches.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: (init && init.body) || '' });
    const r = window.__replies.shift() || { ok: true, status: 200, json: {} };
    return { ok: r.ok !== false, status: r.status || 200, text: async () => r.text || JSON.stringify(r.json || {}), json: async () => r.json || {} };
  };`;

(async () => {
  const profile = scratch.mkdtemp('alef-options-');
  const child = spawn(chromeExe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1000,1200', 'about:blank',
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
  s.on('Runtime.exceptionThrown', e => console.error('  [page exception]', e?.exceptionDetails?.exception?.description || e?.exceptionDetails?.text));

  let scriptId = null;
  async function open(store) {
    if (scriptId) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    ({ identifier: scriptId } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB(store) }));
    await s.goto(OPTIONS);
    await sleep(200);
  }
  const ev = expr => s.eval(expr);
  const val = id => ev(`document.getElementById('${id}').value`);
  const setVal = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  const shown = id => ev(`!document.getElementById('${id}').hidden`);
  const status = () => ev(`document.getElementById('status').textContent`);
  const click = async id => { await ev(`document.getElementById('${id}').click(); 'ok'`); await sleep(250); };
  const reply = r => ev(`window.__replies.push(${JSON.stringify(r)}); 'ok'`);
  const msgReply = r => ev(`window.__msgReplies.push(${JSON.stringify(r)}); 'ok'`);
  const messages = () => ev(`JSON.stringify(window.__msgSent)`).then(JSON.parse);
  const fetches = () => ev(`JSON.stringify(window.__fetches)`).then(JSON.parse);
  const choose = v => ev(`(() => { const e = document.getElementById('provider'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);

  /* ------------------------------------------------------------- what shows */
  console.log('=== which fields show ===');
  await open({});
  check('with nothing saved, OpenRouter is the service', await val('provider') === 'openrouter');
  check('its fields show, and Gemini\'s do not', await shown('openrouterFields') === true && await shown('geminiFields') === false);
  check('the Gemini model box starts with the default model', await val('geminiModel') === 'gemini-2.5-flash', await val('geminiModel'));
  check('both keys are password boxes', await ev(`document.getElementById('apiKey').type === 'password' && document.getElementById('geminiKey').type === 'password'`) === true);

  await open({ provider: 'gemini', geminiKey: KEY, geminiModel: 'gemini-2.5-pro', geminiFallbackModel: 'gemini-2.5-flash-lite', apiKey: 'sk-or-v1-abc', model: 'anthropic/claude-haiku-4.5' });
  check('a saved Gemini choice opens on Gemini', await val('provider') === 'gemini' && await shown('geminiFields') === true && await shown('openrouterFields') === false);
  check('with its key, model and fallback filled in', await val('geminiKey') === KEY && await val('geminiModel') === 'gemini-2.5-pro' && await val('geminiFallbackModel') === 'gemini-2.5-flash-lite');
  check('and the OpenRouter ones kept, just out of sight', await val('apiKey') === 'sk-or-v1-abc' && await val('model') === 'anthropic/claude-haiku-4.5');

  await open({});
  await choose('gemini');
  check('choosing Gemini swaps the fields at once', await shown('geminiFields') === true && await shown('openrouterFields') === false);
  check('and says it needs Save', /Save/.test(await status()), await status());
  await choose('openrouter');
  check('choosing OpenRouter swaps them back', await shown('openrouterFields') === true && await shown('geminiFields') === false);

  /* ----------------------------------------------------------------- saving */
  console.log('\n=== saving ===');
  await open({ hotkeys: { solve: null }, retries: 4 });
  await choose('gemini');
  await setVal('geminiKey', `  ${KEY}  `);
  await setVal('geminiModel', 'gemini-2.5-flash-lite');
  await click('save');
  let st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('the service, key (trimmed) and model are saved', st.provider === 'gemini' && st.geminiKey === KEY && st.geminiModel === 'gemini-2.5-flash-lite', JSON.stringify({ p: st.provider, k: st.geminiKey === KEY, m: st.geminiModel }));
  check('and it says Saved', await status() === 'Saved.');
  check('what was already there is not lost', st.hotkeys && st.hotkeys.solve === null && typeof st.apiKey === 'string');

  await setVal('geminiModel', '   ');
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('an empty model box is saved as the default, not as nothing', st.geminiModel === 'gemini-2.5-flash', st.geminiModel);

  await choose('openrouter');
  await setVal('apiKey', 'sk-or-v1-zzz');
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('switching back saves OpenRouter as the service', st.provider === 'openrouter' && st.apiKey === 'sk-or-v1-zzz');
  check('and keeps the Gemini key for later', st.geminiKey === KEY);

  /* ------------------------------------------------------------- Test key: Gemini */
  console.log('\n=== Test key: Gemini ===');
  await open({ provider: 'gemini', geminiKey: KEY, geminiModel: 'gemini-2.5-flash' });
  const GOOD = { json: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } };
  const LIST = { json: { models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/text-bison-001', displayName: 'Bison', supportedGenerationMethods: ['generateContent'] },
  ] } };
  await reply(GOOD); await reply(LIST);
  await click('test');
  let f = await fetches();
  check('it asks the chosen model, by name, with a POST', f.length >= 1 && f[0].method === 'POST' && f[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', f[0] && f[0].url);
  check('the key is in the x-goog-api-key header, and in no address or body', f[0].headers['x-goog-api-key'] === KEY && f.every(x => !x.url.includes(KEY) && !x.body.includes(KEY)));
  check('the question it asks is the one-word test, with room for a model that thinks', /Reply with the single word: ok/.test(f[0].body) && JSON.parse(f[0].body).generationConfig.maxOutputTokens === 256);
  check('then it asks which models this key may use', f.length === 2 && f[1].method === 'GET' && f[1].url === 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' && f[1].headers['x-goog-api-key'] === KEY, f[1] && f[1].url);
  const st1 = await status();
  check('it says what the model answered, and how many models it found', /✓ gemini-2\.5-flash responded: "ok"/.test(st1) && /2 models/.test(st1), st1);
  const opts = await ev(`JSON.stringify([...document.getElementById('geminiModels').options].map(o => o.value))`).then(JSON.parse);
  check('the list becomes exactly those that can answer, without embedding or non-Gemini models', JSON.stringify(opts) === JSON.stringify(['gemini-2.5-flash', 'gemini-2.5-pro']), JSON.stringify(opts));
  check('and shows their names', await ev(`document.getElementById('geminiModels').options[0].textContent`) === 'gemini-2.5-flash — Gemini 2.5 Flash');

  await open({ provider: 'gemini', geminiKey: KEY, geminiModel: 'models/gemini-2.5-pro' });
  await reply(GOOD); await reply({ ok: false, status: 500, text: 'boom' });
  await click('test');
  f = await fetches();
  check('a model saved as "models/…" is asked by its name', f[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', f[0].url);
  check('a model list that cannot be read does not spoil a good test', /✓ gemini-2\.5-pro responded: "ok"/.test(await status()) && !/models available/.test(await status()), await status());
  check('and the suggestions stay as they were', (await ev(`document.getElementById('geminiModels').options.length`)) === 3);

  await open({ provider: 'gemini', geminiKey: KEY, geminiModel: 'gemini-2.5-flash' });
  await reply({ ok: false, status: 400, text: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}' });
  await click('test');
  f = await fetches();
  check('a refused key says so, with the status and Google\'s words', /^HTTP 400/.test(await status()) && /API key not valid/.test(await status()) && ev(`document.getElementById('status').className`) !== 'ok', await status());
  check('and goes no further (no model list is asked for)', f.length === 1, `fetches=${f.length}`);
  check('and the status is shown as a problem', await ev(`document.getElementById('status').className`) === 'bad');
  check('the key is not repeated in what it says', !(await status()).includes(KEY));

  await open({ provider: 'gemini' });
  await click('test');
  check('with no key it asks for one, and sends nothing', await status() === 'Paste a Gemini key first.' && (await fetches()).length === 0, await status());

  await open({ provider: 'gemini', geminiKey: KEY });
  await ev(`window.fetch = async () => { throw new Error('offline'); }; 'ok'`);
  await click('test');
  check('no network says so', /✗ offline/.test(await status()) && await ev(`document.getElementById('status').className`) === 'bad', await status());

  await open({ provider: 'gemini', geminiKey: KEY });
  await reply({ json: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'ok' }] } }] } });
  await reply({ json: {} });
  await click('test');
  check('what the test shows is the answer, without the model\'s thinking, as the real calls read it', /responded: "ok"/.test(await status()) && !/thinking/.test(await status()), await status());

  /* ---------------------------------------------------------- Test key: OpenRouter */
  console.log('\n=== Test key: OpenRouter is as it was ===');
  await open({ provider: 'openrouter', apiKey: 'sk-or-v1-abc', model: 'anthropic/claude-haiku-4.5', geminiKey: KEY });
  await reply({ json: { choices: [{ message: { content: 'ok' } }] } });
  await click('test');
  f = await fetches();
  check('it calls OpenRouter with the Bearer login', f.length === 1 && f[0].url === 'https://openrouter.ai/api/v1/chat/completions' && f[0].headers.Authorization === 'Bearer sk-or-v1-abc', f[0] && f[0].url);
  check('with the model in its box, and never the Gemini key', JSON.parse(f[0].body).model === 'anthropic/claude-haiku-4.5' && !f[0].body.includes(KEY) && !JSON.stringify(f[0].headers).includes(KEY));
  check('and says what the model answered', /✓ anthropic\/claude-haiku-4\.5 responded: "ok"/.test(await status()), await status());
  await open({ provider: 'openrouter' });
  await click('test');
  check('with no key it asks for one', await status() === 'Paste a key first.');

  /* ------------------------------------------------------------------- OpenAI */
  console.log('\n=== OpenAI: fields, saving, Test key ===');
  const OKEY = 'sk-test-OPENAI-FAKE-KEY-123';
  await open({});
  await choose('openai');
  check('choosing OpenAI shows its fields and only those', await shown('openaiFields') === true && await shown('openrouterFields') === false && await shown('geminiFields') === false);
  check('its model box starts with the default model, and the key box is a password box', await val('openaiModel') === 'gpt-5-mini' && await ev(`document.getElementById('openaiKey').type`) === 'password', await val('openaiModel'));
  await choose('gemini');
  check('going on to Gemini hides them again', await shown('openaiFields') === false && await shown('geminiFields') === true);

  await open({ provider: 'openai', openaiKey: OKEY, openaiModel: 'gpt-4.1-mini', openaiFallbackModel: 'gpt-4o-mini', apiKey: 'sk-or-v1-abc', geminiKey: KEY });
  check('a saved OpenAI choice opens on OpenAI, filled in, the others kept out of sight', await val('provider') === 'openai' && await shown('openaiFields') === true && await val('openaiKey') === OKEY && await val('openaiModel') === 'gpt-4.1-mini' && await val('openaiFallbackModel') === 'gpt-4o-mini' && await val('apiKey') === 'sk-or-v1-abc' && await val('geminiKey') === KEY);

  await open({ hotkeys: { solve: null } });
  await choose('openai');
  await setVal('openaiKey', `  ${OKEY}  `);
  await setVal('openaiModel', '   ');
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('saving keeps the service, the trimmed key, and the default for an empty model box', st.provider === 'openai' && st.openaiKey === OKEY && st.openaiModel === 'gpt-5-mini', JSON.stringify({ p: st.provider, k: st.openaiKey === OKEY, m: st.openaiModel }));
  check('and loses nothing that was already saved', st.hotkeys && st.hotkeys.solve === null);

  await open({ provider: 'openai', openaiKey: OKEY, openaiModel: 'gpt-5-mini' });
  await reply({ json: { choices: [{ message: { content: 'ok' } }] } });
  await reply({ json: { data: [{ id: 'gpt-5-mini' }, { id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'dall-e-3' }, { id: 'o3' }, { id: 'gpt-image-1' }, { id: 'omni-moderation-latest' }, { id: 'gpt-4o-mini' }] } });
  await click('test');
  f = await fetches();
  check('Test key asks the chosen model, by name, with a POST and a Bearer login', f[0].method === 'POST' && f[0].url === 'https://api.openai.com/v1/chat/completions' && f[0].headers.Authorization === 'Bearer ' + OKEY && JSON.parse(f[0].body).model === 'gpt-5-mini', f[0].url);
  check('with the one-word question and room for a model that thinks first', /Reply with the single word: ok/.test(f[0].body) && JSON.parse(f[0].body).max_completion_tokens === 256 && !('max_tokens' in JSON.parse(f[0].body)));
  check('the key is in no address and no body', f.every(x => !x.url.includes(OKEY) && !x.body.includes(OKEY)));
  check('then it lists the models this key may use', f.length === 2 && f[1].method === 'GET' && f[1].url === 'https://api.openai.com/v1/models' && f[1].headers.Authorization === 'Bearer ' + OKEY, f[1] && f[1].url);
  const oOpts = await ev(`JSON.stringify([...document.getElementById('openaiModels').options].map(o => o.value))`).then(JSON.parse);
  check('the list becomes the chat models only, once each, sorted — no embeddings, speech, image or moderation models', JSON.stringify(oOpts) === JSON.stringify(['gpt-4o-mini', 'gpt-5-mini', 'o3']), JSON.stringify(oOpts));
  check('and the status says what it answered and how many it found', /✓ gpt-5-mini responded: "ok"/.test(await status()) && /3 models/.test(await status()), await status());

  await open({ provider: 'openai', openaiKey: OKEY, openaiModel: 'gpt-3.5-turbo' });
  await reply({ ok: false, status: 400, text: '{"error":{"message":"Unsupported parameter: \'max_completion_tokens\' is not supported with this model. Use \'max_tokens\' instead."}}' });
  await reply({ json: { choices: [{ message: { content: 'ok' } }] } });
  await reply({ ok: false, status: 500, text: 'boom' });
  await click('test');
  f = await fetches();
  check('an older model that wants max_tokens is tried that way, and the test passes', f.length === 3 && 'max_tokens' in JSON.parse(f[1].body) && !('max_completion_tokens' in JSON.parse(f[1].body)) && /✓ gpt-3\.5-turbo responded/.test(await status()), await status());
  check('a model list that cannot be read does not spoil a good test; the suggestions stay', !/models available/.test(await status()) && (await ev(`document.getElementById('openaiModels').options.length`)) === 4);

  await open({ provider: 'openai', openaiKey: OKEY });
  await reply({ ok: false, status: 401, text: '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}' });
  await click('test');
  f = await fetches();
  check('a refused key says so with the status and OpenAI\'s words, and goes no further', /^HTTP 401/.test(await status()) && /Incorrect API key/.test(await status()) && f.length === 1 && await ev(`document.getElementById('status').className`) === 'bad', await status());
  check('without repeating the key', !(await status()).includes(OKEY));

  await open({ provider: 'openai' });
  await click('test');
  check('with no key it asks for one, and sends nothing', await status() === 'Paste an OpenAI key first.' && (await fetches()).length === 0, await status());

  /* --------------------------------------------------- the Gemini-site login */
  console.log('\n=== Gemini (your own site login): fields and the model list ===');
  await open({});
  await choose('gemini-web');
  check('choosing it shows its fields and only those',
    await shown('geminiWebFields') === true && await shown('openrouterFields') === false &&
    await shown('geminiFields') === false && await shown('openaiFields') === false && await shown('deepseekFields') === false);
  // There is no key for this service, so the button must not offer to test one — and the hint
  // in the panel tells the person to press it by its label, so the two have to agree.
  check('the button says it tests the login, not a key', await ev(`document.getElementById('test').textContent`) === 'Test login', await ev(`document.getElementById('test').textContent`));
  check('the panel has no key or token box at all — there is nothing to paste',
    await ev(`!!document.querySelector('#geminiWebFields input[type=password]')`) === false);
  check('and it offers the one model every account has, by default',
    await val('geminiWebModel') === '' && /default model/i.test(await ev(`document.querySelector('#geminiWebModel option').textContent`)));

  await choose('openai');
  check('leaving it puts the button back to testing a key', await ev(`document.getElementById('test').textContent`) === 'Test key', await ev(`document.getElementById('test').textContent`));

  await open({ provider: 'gemini-web' });
  await msgReply({ error: 'No signed-in gemini.google.com tab is open. Open one and leave it open.' });
  await click('test');
  check('Test login with no signed-in tab open repeats what to open, and sends no model list request',
    /No signed-in gemini\.google\.com tab/.test(await status()) && (await fetches()).length === 0 && (await messages()).some(m => m.type === 'gemini-web-test'), await status());
  check('a failed login test is shown as a failure, not a pass', await ev(`document.getElementById('status').className`) === 'bad');

  await open({ provider: 'gemini-web', geminiWebModels: [
    { id: 'a', name: 'gemini-flash', label: 'Flash', description: 'Fast', number: 1 },
  ] });
  await msgReply({ note: 'Signed in and ready · 1 model available to this account are in the list' });
  await click('test');
  check('a good login test is a green tick that says what it found',
    /^✓ /.test(await status()) && /1 model/.test(await status()) && await ev(`document.getElementById('status').className`) === 'ok', await status());
  check('it asks the service worker, and carries no key, token or password of any kind',
    (await messages()).some(m => m.type === 'gemini-web-test' && m.keys.length === 1) &&
    (await messages()).every(m => !m.keys.includes('token') && !m.keys.includes('key') && !m.keys.includes('body')), JSON.stringify(await messages()));

  // The button that opens the site is the only way in — the login already lives in that browser,
  // so this is where a new user is sent first.
  await ev(`document.getElementById('openGemini').click(); 'ok'`);
  await sleep(50);
  check('Open gemini.google.com opens the site\'s chat page in a new tab',
    (await messages()).some(m => m.tab === 'https://gemini.google.com/app'), JSON.stringify(await messages()));

  // A saved model list becomes the two drop-downs, so a model can be picked without asking again.
  await open({ provider: 'gemini-web', geminiWebModels: [
    { id: 'a', name: 'gemini-flash', label: 'Flash', description: 'Fast', number: 1 },
    { id: 'b', name: 'gemini-pro', label: 'Pro', description: 'Smarter', number: 3 },
  ] });
  const gOpts = await ev(`JSON.stringify([...document.getElementById('geminiWebModel').options].map(o => o.value))`).then(JSON.parse);
  check('a saved model list fills the drop-down, keeping the account default first',
    JSON.stringify(gOpts) === JSON.stringify(['', 'gemini-flash', 'gemini-pro']), JSON.stringify(gOpts));
  check('each entry says what the model is for',
    /Flash — Fast/.test(await ev(`document.querySelector('#geminiWebModel option[value="gemini-flash"]').textContent`)));
  check('the fallback drop-down offers the same models, with None first',
    JSON.stringify(await ev(`JSON.stringify([...document.getElementById('geminiWebFallbackModel').options].map(o => o.value))`).then(JSON.parse)) === JSON.stringify(['', 'gemini-flash', 'gemini-pro']));

  // A model saved before, which this account's list no longer offers, must not be silently
  // swapped: that would change the answers without saying so.
  await open({ provider: 'gemini-web', geminiWebModel: 'gemini-pro', geminiWebModels: [
    { id: 'a', name: 'gemini-flash', label: 'Flash', description: 'Fast', number: 1 },
  ] });
  check('a saved model the list no longer offers is kept, and marked as such',
    await val('geminiWebModel') === 'gemini-pro' && /not offered by this account/.test(await ev(`document.querySelector('#geminiWebModel option[value="gemini-pro"]').textContent`)), await val('geminiWebModel'));

  await open({ provider: 'gemini-web', geminiWebModel: 'gemini-pro', geminiWebFallbackModel: 'gemini-flash', geminiWebThinking: 'medium' });
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('saving keeps the service, both models and the thinking level',
    st.provider === 'gemini-web' && st.geminiWebModel === 'gemini-pro' && st.geminiWebFallbackModel === 'gemini-flash' && st.geminiWebThinking === 'medium', JSON.stringify({ p: st.provider, m: st.geminiWebModel, f: st.geminiWebFallbackModel, t: st.geminiWebThinking }));
  check('and stores no key or token for it, because there is none', !('geminiWebToken' in st) && !('geminiWebKey' in st));

  // The site has four levels, not two, and Medium is not the one above Low.
  check('the thinking box offers all four of the site\'s levels, standard first',
    JSON.stringify(await ev(`JSON.stringify([...document.getElementById('geminiWebThinking').options].map(o => o.value))`).then(JSON.parse)) === JSON.stringify(['', 'low', 'medium', 'high']));

  await open({ provider: 'gemini-web' });
  check('and standard is what a new install is on', await val('geminiWebThinking') === '', await val('geminiWebThinking'));

  // 0.6.30 and earlier saved this as a plain on/off switch; an old `true` was the site's
  // extended thinking, so it must come back as "high" rather than silently dropping to standard.
  await open({ provider: 'gemini-web', geminiWebThinking: true });
  check('an on/off switch saved by an older version opens as the level it meant',
    await val('geminiWebThinking') === 'high', await val('geminiWebThinking'));

  await open({ provider: 'gemini-web', geminiWebThinking: 'nonsense' });
  check('a level that is not one of the site\'s falls back to standard rather than being sent',
    await val('geminiWebThinking') === '', await val('geminiWebThinking'));

  /* ----------------------------------------------------------- keeping one chat */
  console.log('\n=== Keep using one chat: the switch, who sees it, and the new-chat button ===');
  const checkedBox = id => ev(`document.getElementById('${id}').checked`);

  // Only the two services that have chats of their own have anything to keep.
  await open({});
  for (const [service, expectShown] of [
    ['openrouter', false], ['gemini', false], ['openai', false], ['deepseek', true], ['gemini-web', true],
  ]) {
    await choose(service);
    check(`the chat switch is ${expectShown ? 'offered' : 'not offered'} for ${service}`, await shown('chatFields') === expectShown);
  }

  await open({});
  check('it is on for a fresh install, since one chat is the point', await checkedBox('reuseChat') === true);
  await open({ reuseChat: false });
  check('and stays off once switched off', await checkedBox('reuseChat') === false);
  await open({ reuseChat: true });
  check('and on once switched on', await checkedBox('reuseChat') === true);

  await open({ provider: 'deepseek' });
  await ev(`(() => { const e = document.getElementById('reuseChat'); e.checked = false; e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('saving keeps the switch off', st.reuseChat === false, JSON.stringify(st.reuseChat));
  await open({ provider: 'deepseek', reuseChat: false });
  await ev(`(() => { const e = document.getElementById('reuseChat'); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await click('save');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('and keeps it on', st.reuseChat === true, JSON.stringify(st.reuseChat));

  // The button is an action, not a setting: it works at once and needs no Save.
  await open({ provider: 'gemini-web', geminiWebChat: { cid: 'c', rid: 'r', rcid: 'rc', turns: 4 }, deepseekChat: { sessionId: 's', parentId: 9, turns: 2 } });
  await click('newChat');
  st = await ev(`JSON.stringify(window.__store)`).then(JSON.parse);
  check('the new-chat button forgets the saved chat on both sites at once', st.geminiWebChat === null && st.deepseekChat === null, JSON.stringify({ g: st.geminiWebChat, d: st.deepseekChat }));
  check('and says what happens next', /next question will start a new chat/i.test(await status()), await status());
  check('without touching any other setting', st.provider === 'gemini-web');

  s.close();
  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n✗ harness error:', e.message || e);
  process.exit(1);
});
