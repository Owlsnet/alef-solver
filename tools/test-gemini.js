#!/usr/bin/env node
/* Gemini as the service that answers. Runs the real background.js in a sandbox with a stubbed
   `chrome` and a scripted network, so it needs no browser, no key and no call to Google.

   What is checked: the request that would be sent (address, headers, body — and that the key is in
   a header and nowhere else), how each kind of reply is read, and what happens when it goes wrong
   (a refused key, a rate limit, a token budget that runs out, a refusal, a picture it cannot read).
   OpenRouter must behave exactly as before whichever service is chosen. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(process.env.ALEF_BACKGROUND || path.join(__dirname, '..', 'background.js'), 'utf8');

let fetchImpl = async () => { throw new Error('no network in tests'); };
let store = {};
const ctx = vm.createContext({
  console,
  fetch: (...a) => fetchImpl(...a),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),   // a service worker has this; the sandbox must too
  chrome: {
    runtime: { onMessage: { addListener() { } } },
    storage: { local: { get: async () => ({ ...store }), set: async o => { Object.assign(store, o); } } },
  },
});
vm.runInContext(SRC, ctx, { filename: 'background.js' });
// A service worker has timers; the sandbox does not. Waits are recorded and then skipped, so the
// schedule can be checked without sitting through it.
const pauses = [];
ctx.setTimeout = (fn, ms) => { pauses.push(ms); return setTimeout(fn, 0); };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const j = v => JSON.stringify(v);           // results come out of another realm: compare by value
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

const KEY = 'AIzaSy-SECRET-TEST-KEY-0123456789';
const DATA = 'data:image/jpeg;base64,AAAA';
const DATA2 = 'data:image/png;base64,BBBB';
const mcq = extra => ({ kind: 'choice', stem: 'Which is right?', options: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], images: [], image: null, imageCount: 0, ...extra });

/** A Gemini reply with this text. */
const gem = (text, cand = {}, top = {}) => ({
  ok: true, status: 200, text: async () => '',
  json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', ...cand }], usageMetadata: { candidatesTokenCount: 12 }, ...top }),
});
const fail_ = (status, body) => ({ ok: false, status, json: async () => ({}), text: async () => body });

/** Record every request; answer with the next scripted reply (the last repeats). */
function script(...replies) {
  const calls = [];
  fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : null, raw: init?.body || '' });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof r === 'function' ? r(calls[calls.length - 1]) : r;
  };
  return calls;
}
const useGemini = (extra = {}) => { store = { provider: 'gemini', geminiKey: KEY, ...extra }; };

(async () => {
  /* ------------------------------------------------------------- the pieces */
  console.log('the request: a chat-shaped body, laid out the way Gemini wants it');
  check('the converters exist', typeof ctx.toGemini === 'function' && typeof ctx.fromGemini === 'function' && typeof ctx.geminiUrl === 'function');
  const body = ctx.buildBody({}, mcq({ image: DATA, images: [DATA2, 'https://files.example.com/x'], imageCount: 3 }));
  let g = ctx.toGemini(body, true);
  check('the instructions go in systemInstruction, as text', g.systemInstruction.parts.length === 1 && /multiple-choice exam/.test(g.systemInstruction.parts[0].text));
  check('the question is one user turn whose first part is its text', g.contents.length === 1 && g.contents[0].role === 'user' && /Which is right\?/.test(g.contents[0].parts[0].text));
  check('the screenshot and the other picture go in as inline data, in order', j(g.contents[0].parts.slice(1)) === j([{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { inlineData: { mimeType: 'image/png', data: 'BBBB' } }]), j(g.contents[0].parts.slice(1)));
  check('a plain link is not sent (Google cannot fetch it with the page\'s login either)', !/files\.example\.com/.test(j(g)));
  check('temperature and the token limit are carried over', g.generationConfig.temperature === 0 && g.generationConfig.maxOutputTokens === 1500, j(g.generationConfig));
  check('structured mode asks for a JSON reply', g.generationConfig.responseMimeType === 'application/json');
  check('plain mode does not', !('responseMimeType' in ctx.toGemini(body, false).generationConfig));
  check('nothing from the chat shape is left in it', j(Object.keys(g).sort()) === j(['contents', 'generationConfig', 'systemInstruction']), j(Object.keys(g)));
  check('a larger limit (the retry) is carried over', ctx.toGemini({ ...body, max_tokens: 4000 }, true).generationConfig.maxOutputTokens === 4000);
  check('a retry after a wrong answer keeps its warmer temperature', ctx.toGemini(ctx.buildBody({}, mcq({ tried: [{ label: 'A. a' }] })), true).generationConfig.temperature > 0);

  console.log('\nthe address');
  check('a model is called by name', ctx.geminiUrl('gemini-2.5-flash') === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', ctx.geminiUrl('gemini-2.5-flash'));
  check('"models/…", as Google lists them, is the same model', ctx.geminiUrl('models/gemini-2.5-flash') === ctx.geminiUrl('gemini-2.5-flash'));
  check('stray spaces are ignored', ctx.geminiUrl('  gemini-2.5-flash ') === ctx.geminiUrl('gemini-2.5-flash'));

  console.log('\nreading a reply');
  let r = ctx.fromGemini({ candidates: [{ content: { parts: [{ text: '{"answer":"B"}' }] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 9 } });
  check('the text, why it stopped, and the tokens used', r.raw === '{"answer":"B"}' && r.finish === 'STOP' && r.tokens === 9 && r.blocked === '', j(r));
  r = ctx.fromGemini({ candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] });
  check('several parts are joined', r.raw === '{"a":1}');
  r = ctx.fromGemini({ candidates: [{ content: { parts: [{ text: 'let me think', thought: true }, { text: '{"a":1}' }] } }] });
  check('a model\'s thinking is not part of the answer', r.raw === '{"a":1}');
  r = ctx.fromGemini({ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }] });
  check('running out of room is said as "length", like the others say it', r.finish === 'length' && r.raw === '' && r.blocked === '', j(r));
  r = ctx.fromGemini({ promptFeedback: { blockReason: 'SAFETY' } });
  check('a question refused before any answer is a refusal', r.blocked === 'SAFETY' && r.raw === '', j(r));
  r = ctx.fromGemini({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] });
  check('an answer cut off for its content, with no text, is a refusal', r.blocked === 'PROHIBITED_CONTENT', j(r));
  r = ctx.fromGemini({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'RECITATION' }] });
  check('but an answer that did arrive is kept', r.raw === '{"a":1}' && r.blocked === '', j(r));
  r = ctx.fromGemini(null);
  check('nothing at all is an empty reply, not a crash', r.raw === '' && r.blocked === '');

  /* ---------------------------------------------------------------- end to end */
  console.log('\nasking Gemini');
  useGemini();
  let calls = script(gem('{"answer":"B","index":1,"confidence":0.8,"why":"stated"}'));
  let res = await ctx.ask(mcq());
  check('the answer comes back', res && res.index === 1 && res.letter === 'B' && !res.error, j(res));
  check('and says which model gave it', res.model === 'gemini-2.5-flash', res.model);
  check('one POST to the model\'s address', calls.length === 1 && calls[0].method === 'POST' && calls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', calls[0].url);
  check('the key is in the x-goog-api-key header', calls[0].headers['x-goog-api-key'] === KEY);
  check('and nowhere else: not the address, not the body', !calls[0].url.includes(KEY) && !calls[0].url.includes('key=') && !calls[0].raw.includes(KEY));
  check('no OpenRouter login or headers go with it', !('Authorization' in calls[0].headers) && !('HTTP-Referer' in calls[0].headers));
  check('the first try asks for JSON', calls[0].body.generationConfig.responseMimeType === 'application/json');
  check('the key does not come back in the result', !j(res).includes(KEY));

  console.log('\nevery kind of question is read from a Gemini reply');
  calls = script(gem('{"blanks":["increased","decreased"],"confidence":0.9}'));
  res = await ctx.ask({ kind: 'cloze', images: [], cloze: { text: 'a [BLANK 1] b [BLANK 2]', wordBank: [], blanks: [{}, {}] } });
  check('fill in the blank', j(res.words) === '["increased","decreased"]', j(res));
  calls = script(gem('{"picks":[2,0]}'));
  res = await ctx.ask({ kind: 'dropdown', images: [], dropdown: { text: 'x', menus: [['a', 'b', 'c'], ['d', 'e']] } });
  check('drop-downs', j(res.picks) === '[2,0]', j(res));
  calls = script(gem('{"pairs":[1,0]}'));
  res = await ctx.ask({ kind: 'match', images: [], match: { intro: 'm', left: ['l1', 'l2'], right: ['r1', 'r2'] } });
  check('matching', j(res.pairs) === '[1,0]', j(res));
  calls = script(gem('{"fills":[1,0]}'));
  res = await ctx.ask({ kind: 'drag', images: [], drag: { intro: 'd', text: 't', items: ['p', 'q', 'r'], blanks: 2 } });
  check('drag and drop', j(res.fills) === '[1,0]', j(res));
  calls = script(gem('{"order":[1,0,2]}'));
  res = await ctx.ask({ kind: 'sort', images: [], sort: { intro: 's', items: ['a', 'b', 'c'] } });
  check('ordering', j(res.pairs) === '[1,0,2]', j(res));
  calls = script(gem('{"answers":["A","C"],"indices":[0,2]}'));
  res = await ctx.ask(mcq({ multi: true, instruction: 'Select the correct answers.' }));
  check('select all that apply', j(res.indices) === '[0,2]', j(res));
  check('and that question was sent with the tick-all instructions', /MORE THAN ONE/.test(calls[0].body.systemInstruction.parts[0].text), calls[0].body.systemInstruction.parts[0].text.slice(0, 60));

  console.log('\na picture goes with the question');
  calls = script(gem('{"answer":"A","index":0}'));
  await ctx.ask(mcq({ image: DATA, imageCount: 1 }));
  check('as inline data, next to the text', calls[0].body.contents[0].parts.length === 2 && calls[0].body.contents[0].parts[1].inlineData.mimeType === 'image/jpeg');
  calls = script(fail_(400, '{"error":{"code":400,"message":"Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting","status":"INVALID_ARGUMENT"}}'), gem('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq({ image: DATA, imageCount: 1 }));
  check('a picture Google cannot read does not cost the answer', res.index === 2 && res.imageDropped === true && calls.length === 2, j(res));
  check('the second try has no picture, and tells the model so', calls[1].body.contents[0].parts.length === 1 && /could NOT be attached/.test(calls[1].body.contents[0].parts[0].text));

  console.log('\nwhen it goes wrong');
  calls = script(fail_(400, '{"error":{"code":400,"message":"JSON mode is not enabled for this model","status":"INVALID_ARGUMENT"}}'), gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model with no JSON mode is asked again in plain mode', res.index === 1 && calls.length === 2 && !('responseMimeType' in calls[1].body.generationConfig), `calls=${calls.length}`);

  calls = script(gem('', { content: { role: 'model' }, finishReason: 'MAX_TOKENS' }), gem('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq());
  check('a model that used its room thinking is given more, once', res.index === 2 && calls.length === 2 && calls[0].body.generationConfig.maxOutputTokens === 1500 && calls[1].body.generationConfig.maxOutputTokens === 4000, calls.map(c => c.body.generationConfig.maxOutputTokens).join(','));

  calls = script(fail_(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'));
  useGemini({ geminiFallbackModel: 'gemini-2.5-flash-lite' });
  res = await ctx.ask(mcq());
  check('a key Google refuses stops at once — no second way of asking, no second model', calls.length === 1, `calls=${calls.length}`);
  check('and says to check the key in Options', /check the key in Options/.test(res.error || '') && /API key not valid/.test(res.error || ''), res.error);
  check('without ever repeating the key', !(res.error || '').includes(KEY));

  calls = script(fail_(403, '{"error":{"code":403,"message":"Requests from this IP are blocked","status":"PERMISSION_DENIED"}}'));
  res = await ctx.ask(mcq());
  check('a 403 is treated the same', calls.length === 1 && /HTTP 403/.test(res.error || ''), res.error);

  useGemini({ geminiFallbackModel: 'gemini-2.5-flash-lite' });
  calls = script(fail_(429, '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}'), gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a rate limit moves on to the fallback model', res.index === 1 && res.model === 'gemini-2.5-flash-lite' && calls.length === 2 && /gemini-2\.5-flash-lite:generateContent$/.test(calls[1].url), calls.map(c => c.url.split('/').pop()).join(' → '));

  useGemini();
  calls = script(gem('', { content: undefined, finishReason: 'SAFETY' }));
  res = await ctx.ask(mcq());
  check('a refusal is not asked again with more room', calls.length === 1, `calls=${calls.length}`);
  check('and says it was a refusal, and why', /refused=SAFETY/.test(res.error || ''), res.error);

  calls = script(gem('', {}, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, candidates: undefined }));
  res = await ctx.ask(mcq());
  check('the same when the question itself was refused', calls.length === 1 && /refused=PROHIBITED_CONTENT/.test(res.error || ''), res.error);

  calls = script(gem('I think it is B.'));
  res = await ctx.ask(mcq());
  check('a reply that is not an answer fails with what it said', !!res.error && /unparseable reply/.test(res.error) && /I think it is B/.test(res.error), (res.error || '').slice(0, 120));

  calls = script(gem('{"answer":"B","index":1}'));
  useGemini({ geminiModel: 'models/gemini-2.5-pro' });
  await ctx.ask(mcq());
  check('a model saved as "models/…" is called by its name', calls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', calls[0].url);

  console.log('\nthe keys');
  store = { provider: 'gemini', apiKey: 'sk-or-v1-something' };
  calls = script(gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('an OpenRouter key does not stand in for a Gemini one', !!res.error && /Gemini API key/.test(res.error) && calls.length === 0, res.error);
  store = { provider: 'gemini', geminiKey: KEY };
  calls = script(gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a Gemini key alone is enough', res.index === 1 && !res.error);
  store = { provider: 'gemini', geminiKey: KEY, geminiModel: '' };
  calls = script(gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model box saved empty means the default model, not no model', res.index === 1 && calls.length === 1 && /models\/gemini-2\.5-flash:generateContent$/.test(calls[0].url), calls[0] && calls[0].url);

  console.log('\nOpenRouter is unchanged');
  store = { apiKey: 'sk-or-v1-abc' };
  calls = script({ ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '{"answer":"B","index":1}' }, finish_reason: 'stop' }] }) });
  res = await ctx.ask(mcq());
  check('with nothing chosen it is still OpenRouter', res.index === 1 && calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', calls[0].url);
  check('with its own login header, and no Google header', calls[0].headers.Authorization === 'Bearer sk-or-v1-abc' && !('x-goog-api-key' in calls[0].headers));
  check('and the model it always used', calls[0].body.model === 'deepseek/deepseek-v4.1-flash', calls[0].body.model);
  store = { provider: 'openrouter', apiKey: 'sk-or-v1-abc', geminiKey: KEY, model: 'anthropic/claude-haiku-4.5' };
  calls = script({ ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '{"answer":"A","index":0}' } }] }) });
  res = await ctx.ask(mcq());
  check('a Gemini key saved beside it is never used', calls.length === 1 && calls[0].url.startsWith('https://openrouter.ai/') && !calls[0].raw.includes(KEY) && calls[0].body.model === 'anthropic/claude-haiku-4.5');
  store = { provider: 'openrouter' };
  calls = script(gem('x'));
  res = await ctx.ask(mcq());
  check('with no OpenRouter key, the old message', /^No API key set/.test(res.error || '') && !/Gemini/.test(res.error || ''), res.error);

  /* ------------------------------------------- a model that cannot read pictures */
  // The failure from a real run: a graph question carries a screenshot, the chosen model takes no
  // pictures, OpenRouter answers 404 "No endpoints found that support image input" — and the run
  // stopped, because only a 400 was ever taken for a picture problem.
  console.log('\na model that cannot read pictures');
  const NOIMG = '{"error":{"message":"No endpoints found that support image input","code":404,"metadata":{"failed_routing_step":"Filter by Image Support"}}}';
  const orGood = content => ({ ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
  const pic = extra => mcq({ image: DATA, imageCount: 1, ...extra });
  const hasPic = c => JSON.stringify(c.body).includes('image_url') || JSON.stringify(c.body).includes('inlineData');

  store = { apiKey: 'sk-or-v1-abc', model: 'm/blind' };
  calls = script(fail_(404, NOIMG), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('with one model, the question is asked again without the picture, not given up on', res.index === 1 && calls.length === 2, `calls=${calls.length} ${res.error || ''}`);
  check('the first try had the picture, the second did not', hasPic(calls[0]) && !hasPic(calls[1]));
  check('and the second says the figure could not be attached', /could NOT be attached/.test(JSON.stringify(calls[1].body)));
  check('the answer is marked as given without the picture', res.imageDropped === true, j(res));

  store = { apiKey: 'sk-or-v1-abc', model: 'm/blind', fallbackModel: 'm/sees' };
  calls = script(fail_(404, NOIMG), orGood('{"answer":"C","index":2}'));
  res = await ctx.ask(pic());
  check('with a second model, it gets the picture too — the first one\'s limit is not the question\'s', res.index === 2 && res.model === 'm/sees' && calls.length === 2 && hasPic(calls[1]) && calls[1].body.model === 'm/sees', `calls=${calls.length} model=${res.model}`);
  check('and the answer is not marked as blind', !res.imageDropped);

  calls = script(fail_(404, NOIMG), fail_(404, NOIMG), orGood('{"answer":"A","index":0}'));
  res = await ctx.ask(pic());
  check('with every model unable to see, the first is asked once more without the picture', res.index === 0 && calls.length === 3 && calls[2].body.model === 'm/blind' && !hasPic(calls[2]), calls.map(c => c.body.model + (hasPic(c) ? '+pic' : '')).join(' → '));
  check('and the answer says so', res.imageDropped === true);

  store = { apiKey: 'sk-or-v1-abc', model: 'm/x' };
  calls = script(fail_(404, '{"error":{"message":"No endpoints found for m/x","code":404}}'));
  res = await ctx.ask(pic());
  check('a 404 that is not about pictures is not mistaken for one (no second go without the picture)', calls.length === 1 && /HTTP 404/.test(res.error || ''), `calls=${calls.length} ${res.error}`);

  calls = script(fail_(404, NOIMG));
  res = await ctx.ask(mcq());
  check('and with no picture in the request it is just an error', calls.length === 1 && !!res.error, `calls=${calls.length}`);

  calls = script(fail_(400, '{"error":{"message":"This model does not support image input","code":400}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('the same words as a 400 are the same thing', res.index === 1 && calls.length === 2 && !hasPic(calls[1]) && res.imageDropped === true, `calls=${calls.length}`);

  store = { apiKey: 'sk-or-v1-abc', model: 'm/primary', fallbackModel: 'm/second' };
  calls = script(fail_(400, '{"error":{"message":"Received 401 status code when fetching image from URL: https://files.example.com/x","code":400}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('a picture that could not be FETCHED is still a problem with the picture: same model, no picture', res.index === 1 && calls.length === 2 && calls[1].body.model === 'm/primary' && !hasPic(calls[1]) && res.imageDropped === true, calls.map(c => c.body.model).join(' → '));

  useGemini({ geminiFallbackModel: 'gemini-2.5-flash-lite' });
  calls = script(fail_(400, '{"error":{"code":400,"message":"Image input modality is not enabled for models/gemma-3-27b-it","status":"INVALID_ARGUMENT"}}'), gem('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('Gemini: a model without picture input hands on to the next one, which gets the picture', res.index === 1 && calls.length === 2 && hasPic(calls[1]) && /gemini-2\.5-flash-lite:generateContent$/.test(calls[1].url) && !res.imageDropped, calls.map(c => c.url.split('/').pop()).join(' → '));
  useGemini();
  calls = script(fail_(400, '{"error":{"code":400,"message":"Image input modality is not enabled for models/gemma-3-27b-it","status":"INVALID_ARGUMENT"}}'), gem('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('Gemini, one model: asked again without the picture, and marked', res.index === 1 && calls.length === 2 && !hasPic(calls[1]) && res.imageDropped === true);

  calls = script(fail_(404, NOIMG), fail_(404, NOIMG), fail_(404, NOIMG));
  store = { apiKey: 'sk-or-v1-abc', model: 'm/blind' };
  res = await ctx.ask(pic());
  check('if it still fails without the picture, it ends as an error and says why', !!res.error && /cannot read pictures/.test(res.error) && /asking again without the picture/.test(res.error), (res.error || '').slice(0, 160));

  /* ------------------------------------------------------ OpenAI (ChatGPT models) */
  console.log('\nOpenAI, the ChatGPT models');
  const OKEY = 'sk-test-OPENAI-FAKE-KEY-123';
  const useOpenAI = (extra = {}) => { store = { provider: 'openai', openaiKey: OKEY, ...extra }; };
  const orLength = { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) };

  useOpenAI();
  calls = script(orGood('{"answer":"B","index":1,"confidence":0.8,"why":"stated"}'));
  res = await ctx.ask(mcq());
  check('the answer comes back, from the default model', res.index === 1 && res.model === 'gpt-5-mini', j(res));
  check('one POST to OpenAI\'s chat address', calls.length === 1 && calls[0].method === 'POST' && calls[0].url === 'https://api.openai.com/v1/chat/completions', calls[0].url);
  check('the key is a Bearer login, and is nowhere else', calls[0].headers.Authorization === 'Bearer ' + OKEY && !calls[0].url.includes(OKEY) && !calls[0].raw.includes(OKEY));
  check('no OpenRouter or Google headers go along', !('HTTP-Referer' in calls[0].headers) && !('X-Title' in calls[0].headers) && !('x-goog-api-key' in calls[0].headers));
  check('the limit is called max_completion_tokens, never max_tokens', calls[0].body.max_completion_tokens === 1500 && !('max_tokens' in calls[0].body), j(Object.keys(calls[0].body)));
  check('a gpt-5 model is sent no temperature (it accepts none)', !('temperature' in calls[0].body));
  check('the first try asks for JSON', j(calls[0].body.response_format) === '{"type":"json_object"}');
  check('the key does not come back in the result', !j(res).includes(OKEY));

  useOpenAI({ openaiModel: 'gpt-4.1-mini' });
  calls = script(orGood('{"answer":"B","index":1}'));
  await ctx.ask(mcq());
  check('a model that takes a temperature gets one (0 the first time)', calls[0].body.temperature === 0, j(calls[0].body.temperature));
  calls = script(orGood('{"answer":"B","index":1}'));
  await ctx.ask(mcq({ tried: [{ label: 'A. a' }] }));
  check('and a warmer one after a wrong answer', calls[0].body.temperature > 0);
  useOpenAI({ openaiModel: 'o3' });
  calls = script(orGood('{"answer":"B","index":1}'));
  await ctx.ask(mcq());
  check('an o-series model is sent none either', !('temperature' in calls[0].body));

  useOpenAI();
  calls = script(orGood('{"answers":["A","C"],"indices":[0,2]}'));
  res = await ctx.ask(mcq({ multi: true, instruction: 'Select the correct answers.' }));
  check('a select-all question is read from an OpenAI reply', j(res.indices) === '[0,2]' && /MORE THAN ONE/.test(calls[0].body.messages[0].content), j(res));

  useOpenAI({ openaiFallbackModel: 'gpt-4o-mini' });
  calls = script(fail_(401, '{"error":{"message":"Incorrect API key provided: sk-test***. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}'));
  res = await ctx.ask(mcq());
  check('a key OpenAI refuses stops at once — no second way of asking, no second model', calls.length === 1, `calls=${calls.length}`);
  check('and says to check the key in Options', /check it in Options/.test(res.error || '') && /HTTP 401/.test(res.error || ''), res.error);
  check('without repeating the key', !(res.error || '').includes(OKEY));

  useOpenAI({ openaiModel: 'gpt-4o-mini' });
  calls = script(fail_(400, '{"error":{"message":"Unsupported value: \'temperature\' does not support 0 with this model. Only the default (1) value is supported.","type":"invalid_request_error","param":"temperature"}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model that takes no temperature is asked again without one', res.index === 1 && calls.length === 2 && ('temperature' in calls[0].body) && !('temperature' in calls[1].body), `calls=${calls.length}`);

  useOpenAI({ openaiModel: 'gpt-3.5-turbo' });
  calls = script(fail_(400, '{"error":{"message":"Unsupported parameter: \'max_completion_tokens\' is not supported with this model. Use \'max_tokens\' instead.","type":"invalid_request_error"}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model that wants the old max_tokens is asked that way', res.index === 1 && calls.length === 2 && calls[1].body.max_tokens === 1500 && !('max_completion_tokens' in calls[1].body), `calls=${calls.length}`);

  useOpenAI();
  calls = script(orLength, orGood('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq());
  check('a model that spent its room thinking is given more, once, under the same name', res.index === 2 && calls.length === 2 && calls[0].body.max_completion_tokens === 1500 && calls[1].body.max_completion_tokens === 4000, calls.map(c => c.body.max_completion_tokens).join(','));

  calls = script({ ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }] }) });
  res = await ctx.ask(mcq());
  check('a refusal is not asked again with more room, and says it was one', calls.length === 1 && /refused=refusal/.test(res.error || ''), `calls=${calls.length} ${res.error}`);

  useOpenAI({ openaiFallbackModel: 'gpt-4o-mini' });
  calls = script(fail_(429, '{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a rate limit moves on to the fallback model', res.index === 1 && res.model === 'gpt-4o-mini' && calls.length === 2 && calls[1].body.model === 'gpt-4o-mini', calls.map(c => c.body.model).join(' → '));

  const NOIMG_OA = '{"error":{"message":"Invalid content type. image_url is only supported by certain models.","type":"invalid_request_error","param":"messages.[1].content.[1].type","code":null}}';
  useOpenAI({ openaiModel: 'gpt-3.5-turbo', openaiFallbackModel: 'gpt-4o-mini' });
  calls = script(fail_(400, NOIMG_OA), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('a model that takes no pictures hands on to the next, which gets the picture', res.index === 1 && res.model === 'gpt-4o-mini' && calls.length === 2 && hasPic(calls[1]) && !res.imageDropped, calls.map(c => c.body.model + (hasPic(c) ? '+pic' : '')).join(' → '));
  useOpenAI({ openaiModel: 'gpt-3.5-turbo' });
  calls = script(fail_(400, NOIMG_OA), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('with one model: asked again without the picture, and marked', res.index === 1 && calls.length === 2 && !hasPic(calls[1]) && res.imageDropped === true);

  store = { provider: 'openai', apiKey: 'sk-or-v1-something', geminiKey: KEY };
  calls = script(orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('another service\'s key does not stand in for an OpenAI one', !!res.error && /OpenAI API key/.test(res.error) && calls.length === 0, res.error);
  store = { provider: 'openai', openaiKey: OKEY, openaiModel: '' };
  calls = script(orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model box saved empty means the default model', res.model === 'gpt-5-mini' && calls.length === 1 && calls[0].body.model === 'gpt-5-mini');

  store = { apiKey: 'sk-or-v1-abc', openaiKey: OKEY };
  calls = script(orGood('{"answer":"B","index":1}'));
  await ctx.ask(mcq());
  check('OpenRouter is unchanged: still max_tokens and a temperature, still its own address, never the OpenAI key', calls[0].url === 'https://openrouter.ai/api/v1/chat/completions' && calls[0].body.max_tokens === 1500 && calls[0].body.temperature === 0 && !('max_completion_tokens' in calls[0].body) && !calls[0].raw.includes(OKEY));

  /* ------------------------------------- a page that takes only so many ticks */
  // The live page took 2 ticks on a question with two right answers and ignored a third. The page script
  // then asks again with maxPicks: the prompt must say so, and an answer over it must not be accepted.
  console.log('\na page that takes only so many ticks');
  const multiQ = extra => mcq({ multi: true, instruction: 'Select the correct answers.', options: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], ...extra });
  const askText = ctx.buildText(multiQ({ maxPicks: 2 }));
  check('the question tells the model how many ticks the page takes, and to give exactly that many', /=== LIMIT ===\s+The page accepts at most 2 ticked choices\. Give exactly 2/.test(askText), askText.replace(/\n/g, ' | ').slice(-200));
  check('without a limit, no such line', !/LIMIT/.test(ctx.buildText(multiQ())));
  const needText = ctx.buildText(multiQ({ minPicks: 2 }));
  check('a page that keeps Submit off tells the model to give at least that many', /=== LIMIT ===\s+The page keeps Submit switched off until at least 2 choices are ticked\. Give at least 2/.test(needText), needText.replace(/\n/g, ' | ').slice(-220));
  check('one answer where the page wants 2 is refused', ctx.parseMulti('{"answers":["B"],"indices":[1]}', 4, undefined, 2) === null);
  check('two, or three, are accepted', j(ctx.parseMulti('{"answers":["B","D"],"indices":[1,3]}', 4, undefined, 2)?.indices) === '[1,3]' && j(ctx.parseMulti('{"answers":["A","B","D"],"indices":[0,1,3]}', 4, undefined, 2)?.indices) === '[0,1,3]');
  check('with both a least and a most, only the range fits', ctx.parseMulti('{"indices":[1]}', 4, 3, 2) === null && ctx.parseMulti('{"indices":[0,1,2,3]}', 4, 3, 2) === null && j(ctx.parseMulti('{"indices":[1,2]}', 4, 3, 2)?.indices) === '[1,2]');
  check('a single-answer question never gets one', !/LIMIT/.test(ctx.buildText(mcq({ maxPicks: 2 }))));
  check('three answers where the page takes 2 are refused, not trimmed', ctx.parseMulti('{"answers":["A","B","D"],"indices":[0,1,3]}', 4, 2) === null);
  check('two are accepted', j(ctx.parseMulti('{"answers":["B","D"],"indices":[1,3]}', 4, 2)?.indices) === '[1,3]');
  check('one is accepted too (at most)', j(ctx.parseMulti('{"answers":["B"],"indices":[1]}', 4, 2)?.indices) === '[1]');
  check('with no limit, three are fine as before', j(ctx.parseMulti('{"answers":["A","B","D"],"indices":[0,1,3]}', 4)?.indices) === '[0,1,3]');
  useOpenAI();
  calls = script(orGood('{"answers":["B","D"],"indices":[1,3]}'));
  res = await ctx.ask(multiQ({ maxPicks: 2 }));
  check('end to end: the limit is in what is sent, and the answer comes back', j(res.indices) === '[1,3]' && /at most 2 ticked/.test(calls[0].body.messages[1].content[0].text), j(res));
  calls = script(orGood('{"answers":["A","B","D"],"indices":[0,1,3]}'));
  res = await ctx.ask(multiQ({ maxPicks: 2 }));
  check('end to end: an answer over the limit is an error, not a wrong answer put in', !!res.error && !res.indices, (res.error || '').slice(0, 120));

  /* ----------------------------------------- a model that thinks itself out of room */
  // From a real run: the model used its whole 4000-token budget thinking, three times over, and never wrote
  // an answer. The retry now asks for LESS thinking as well as more room, and a second cut-off is not
  // answered with yet another call in plain mode.
  console.log('\na model that thinks itself out of room');
  store = { apiKey: 'sk-or-v1-abc', model: 'm/thinker' };
  calls = script(orLength, orGood('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq());
  check('OpenRouter: the retry has more room AND switches extended thinking off', res.index === 2 && calls.length === 2 && calls[1].body.max_tokens === 4000 && j(calls[1].body.reasoning) === '{"enabled":false}', j(calls.map(c => ({ t: c.body.max_tokens, r: c.body.reasoning }))));
  check('and tells the model to answer at once, in the question itself', /This is a retry/.test(calls[1].body.messages[1].content[0].text) && /Reply now with the JSON object only/.test(calls[1].body.messages[1].content[0].text) && /Which is right\?/.test(calls[1].body.messages[1].content[0].text));
  check('the first call carries no such setting or note (a plain question is asked as before)', !('reasoning' in calls[0].body) && calls[0].body.max_tokens === 1500 && !/This is a retry/.test(calls[0].body.messages[1].content[0].text));

  calls = script(orLength, fail_(400, '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled","code":400}}'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a model that will not switch thinking off is asked for less of it instead', res.index === 1 && calls.length === 3 && j(calls[1].body.reasoning) === '{"enabled":false}' && j(calls[2].body.reasoning) === '{"effort":"low"}', j(calls.map(c => c.body.reasoning)));

  calls = script(orLength, fail_(404, NOIMG), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(pic());
  check('a picture dropped after a cut-off does not undo the retry: still the larger budget, the note, and no thinking', res.index === 1 && res.imageDropped === true && calls.length === 3 && !hasPic(calls[2]) && calls[2].body.max_tokens === 4000 && /This is a retry/.test(calls[2].body.messages[1].content[0].text) && j(calls[2].body.reasoning) === '{"enabled":false}', j(calls.map(c => c.body.max_tokens)));

  calls = script(orLength, orLength, orLength, orLength);
  res = await ctx.ask(mcq());
  check('cut off again after that: two calls, not three or four, and the error says why', calls.length === 2 && !!res.error && /finish_reason=length/.test(res.error) && /no extended thinking/.test(res.error), `calls=${calls.length}`);

  store = { apiKey: 'sk-or-v1-abc', model: 'm/thinker', fallbackModel: 'm/quick' };
  calls = script(orLength, orLength, orGood('{"answer":"A","index":0}'));
  res = await ctx.ask(mcq());
  check('with a fallback model, that is tried next', res.index === 0 && res.model === 'm/quick' && calls.length === 3 && calls[2].body.model === 'm/quick', calls.map(c => c.body.model).join(' → '));

  useOpenAI({ openaiModel: 'gpt-5-mini' });
  calls = script(orLength, orGood('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq());
  check('OpenAI reasoning model: the retry has reasoning_effort low, and more room', calls.length === 2 && calls[1].body.reasoning_effort === 'low' && calls[1].body.max_completion_tokens === 4000 && !('reasoning_effort' in calls[0].body), j(calls.map(c => c.body.reasoning_effort)));
  useOpenAI({ openaiModel: 'gpt-4.1-mini' });
  calls = script(orLength, orGood('{"answer":"C","index":2}'));
  res = await ctx.ask(mcq());
  check('OpenAI model with no reasoning: never sent a setting it would refuse', calls.length === 2 && !('reasoning_effort' in calls[1].body) && calls[1].body.max_completion_tokens === 4000);

  useGemini();
  calls = script(gem('', { content: { role: 'model' }, finishReason: 'MAX_TOKENS' }), gem('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('Gemini: more room as before, and no setting of another service in the request', res.index === 1 && calls[1].body.generationConfig.maxOutputTokens === 4000 && !/reasoning/.test(calls[1].raw));

  /* ---------------------------------------------------------------- DeepSeek */
  console.log('\nDeepSeek, the account\'s own chat login');
  const DKEY = 'ds-token-FAKE-0123456789';
  // These tests are about the request of ONE question, thread and all, so they run with the chat
  // kept off; keeping one chat going has its own section below, with it on as it is by default.
  const useDeepSeek = (extra = {}) => { store = { provider: 'deepseek', deepseekToken: DKEY, reuseChat: false, ...extra }; };
  // The challenge the site hands out, with an answer the solver can actually find.
  const SALT = 'testsalt', EXPIRE = 1700000000, NONCE = 4242;
  const round1 = toHex(ctx.deepseekHash(ctx.utf8(`${SALT}_${EXPIRE}_${NONCE}`), 1));
  const challenge = { algorithm: 'DeepSeekHashV1', challenge: round1, salt: SALT, expire_at: EXPIRE, difficulty: 10000, signature: 'sig', target_path: '/api/v0/chat/completion' };
  const biz = data => ({ ok: true, status: 200, text: async () => '', json: async () => ({ code: 0, msg: '', data: { biz_data: data } }) });
  const sse = (text, extra = {}) => ({
    ok: true, status: 200, json: async () => ({}),
    text: async () => [`data: ${JSON.stringify({ v: { response: { message_id: 777, fragments: [{ type: 'RESPONSE', content: text }] } } })}`, 'data: {"v":"[DONE]"}'].join('\n') + (extra.tail || ''),
  });
  const isChallenge = c => /create_pow_challenge$/.test(c.url);
  const isCompletion = c => /\/chat\/completion$/.test(c.url);
  // Every DeepSeek call in order: the thread, the challenge, then the completion.
  const dsScript = completionText => script(
    biz({ chat_session: { id: 'sess-1' } }),
    biz({ challenge }),
    sse(completionText),
  );

  useDeepSeek();
  calls = dsScript('{"answer":"B","index":1,"confidence":0.8,"why":"stated"}');
  res = await ctx.ask(mcq());
  check('the answer comes back, read out of the site\'s own stream', res.index === 1 && res.letter === 'B' && !res.error, j(res));
  check('three calls: a thread, a challenge, then the completion', calls.length === 3 && /chat_session\/create$/.test(calls[0].url) && isChallenge(calls[1]) && isCompletion(calls[2]), calls.map(c => c.url.split('/api/v0')[1]).join(' → '));
  check('the token is a Bearer login, and never in an address or a body', calls.every(c => c.headers.authorization === 'Bearer ' + DKEY) && calls.every(c => !c.url.includes(DKEY) && !c.raw.includes(DKEY)));
  check('no other service\'s headers ride along', calls.every(c => !('x-goog-api-key' in c.headers) && !('HTTP-Referer' in c.headers)));
  check('it says which service it pretends to be', calls[0].headers['x-client-platform'] === 'web' && calls[0].headers['x-client-bundle-id'] === 'com.deepseek.chat' && !!calls[0].headers['x-client-version']);
  check('the token does not come back in the result', !j(res).includes(DKEY));

  check('the thread is created before it is used, and named in the completion', calls[2].body.chat_session_id === 'sess-1');
  check('the completion asks for the model the site knows', calls[2].body.model_type === 'default', calls[2].body.model_type);
  check('the proof-of-work answer is in its own header, base64 of JSON', (() => {
    const h = calls[2].headers['x-ds-pow-response'];
    if (!h) return false;
    const d = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    return d.answer === NONCE && d.challenge === round1 && d.salt === SALT && d.signature === 'sig' && d.target_path === '/api/v0/chat/completion';
  })(), calls[2].headers['x-ds-pow-response']);
  check('the challenge was asked for with the path it is for', isChallenge(calls[1]) && calls[1].body.target_path === '/api/v0/chat/completion');
  check('the question is sent as the site\'s own prompt field', /Which is right\?/.test(calls[2].body.prompt) && calls[2].body.ref_file_ids.length === 0, JSON.stringify(Object.keys(calls[2].body)));
  check('the system instructions ride along in the prompt', /multiple-choice exam/.test(calls[2].body.prompt));
  check('thinking and search are off unless asked for', calls[2].body.thinking_enabled === false && calls[2].body.search_enabled === false);

  useDeepSeek({ deepseekThinking: true, deepseekSearch: true });
  calls = dsScript('{"answer":"A","index":0}');
  res = await ctx.ask(mcq());
  check('DeepThink and web search are switches on the request, not separate models', res.index === 0 && calls[2].body.thinking_enabled === true && calls[2].body.search_enabled === true);

  useDeepSeek({ deepseekModel: 'deepseek-expert' });
  calls = dsScript('{"answer":"A","index":0}');
  await ctx.ask(mcq());
  check('the stronger model is asked for as "expert"', calls[2].body.model_type === 'expert', calls[2].body.model_type);

  console.log('\nDeepSeek: every kind of question is read from its stream');
  useDeepSeek();
  calls = dsScript('{"blanks":["increased","decreased"]}');
  res = await ctx.ask({ kind: 'cloze', images: [], cloze: { text: 'a [BLANK 1] b [BLANK 2]', wordBank: [], blanks: [{}, {}] } });
  check('fill in the blank', j(res.words) === '["increased","decreased"]', j(res));
  calls = dsScript('{"picks":[2,0]}');
  res = await ctx.ask({ kind: 'dropdown', images: [], dropdown: { text: 'x', menus: [['a', 'b', 'c'], ['d', 'e']] } });
  check('drop-downs', j(res.picks) === '[2,0]', j(res));
  calls = dsScript('{"pairs":[1,0]}');
  res = await ctx.ask({ kind: 'match', images: [], match: { intro: 'm', left: ['l1', 'l2'], right: ['r1', 'r2'] } });
  check('matching', j(res.pairs) === '[1,0]', j(res));
  calls = dsScript('{"order":[1,0,2]}');
  res = await ctx.ask({ kind: 'sort', images: [], sort: { intro: 's', items: ['a', 'b', 'c'] } });
  check('ordering', j(res.pairs) === '[1,0,2]', j(res));
  calls = dsScript('{"answers":["A","C"],"indices":[0,2]}');
  res = await ctx.ask(mcq({ multi: true, instruction: 'Select the correct answers.' }));
  check('select all that apply', j(res.indices) === '[0,2]', j(res));
  check('and that question was sent with the tick-all instructions', /MORE THAN ONE/.test(calls[2].body.prompt));

  console.log('\nDeepSeek: pictures, and the things that go wrong');
  useDeepSeek();
  calls = dsScript('{"answer":"A","index":0}');
  res = await ctx.ask(mcq({ image: DATA, images: [DATA2], imageCount: 2 }));
  check('the chat takes no pictures, so the question goes without them and is marked blind', res.index === 0 && res.imageDropped === true && calls.length === 3, j(res));
  check('nothing image-shaped is in the prompt', !/base64/.test(calls[2].raw));
  check('and the prompt admits the figure could not be attached', /could NOT be attached/.test(calls[2].body.prompt));

  calls = dsScript('not an answer at all, just prose');
  res = await ctx.ask(mcq());
  check('a reply with no answer in it fails, and says what it said', !!res.error && /unparseable reply/.test(res.error) && /just prose/.test(res.error), (res.error || '').slice(0, 120));
  check('and the question was not asked twice for a flag this endpoint has no setting for', calls.length === 3, `calls=${calls.length}`);

  calls = script(biz({ chat_session: { id: 'sess-1' } }), { ok: false, status: 401, text: async () => '{"code":401,"msg":"unauthorized"}', json: async () => ({}) });
  res = await ctx.ask(mcq());
  check('a refused token stops at once, without asking for a challenge', calls.length === 2, `calls=${calls.length}`);
  check('and says how to fix it', /DeepSeek refused the token/.test(res.error || '') && /Copy token from the site/.test(res.error || ''), res.error);
  check('without repeating the token', !(res.error || '').includes(DKEY));

  calls = script(biz({ chat_session: { id: 's' } }), biz({ challenge }), { ok: false, status: 429, text: async () => '{"code":429,"msg":"too many"}', json: async () => ({}) });
  res = await ctx.ask(mcq());
  check('a rate limit stops rather than trying a second model the account would also be refused', calls.length === 3 && /rate-limiting this account/.test(res.error || ''), res.error);

  calls = script(biz({ chat_session: { id: 's' } }), biz({ challenge: { ...challenge, difficulty: 5, challenge: 'ff'.repeat(32) } }));
  res = await ctx.ask(mcq());
  check('a challenge the tool cannot answer is said plainly, not passed off as a wrong answer', !!res.error && /proof-of-work/.test(res.error), (res.error || '').slice(0, 140));

  // The digest variant: sources disagree on whether DeepSeek drops Keccak round 0. Whichever
  // one a challenge was made with, the solver must find it — that is the whole point of trying both.
  const standard = toHex(ctx.deepseekHash(ctx.utf8(`${SALT}_${EXPIRE}_${NONCE}`), 0));
  calls = script(biz({ chat_session: { id: 's' } }), biz({ challenge: { ...challenge, challenge: standard } }), sse('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('a challenge made with the standard digest is still answered (both variants are tried)', res.index === 1 && !res.error, j(res));

  store = { provider: 'deepseek' };
  calls = script(biz({}));
  res = await ctx.ask(mcq());
  check('no token set: the old no-credential message, naming the right service', /DeepSeek token/.test(res.error || '') && calls.length === 0, res.error);

  /* ---------------------------------------------------------- one chat, not one per question */
  console.log('\nDeepSeek: one chat is kept going instead of a new one per question');
  const ANS = '{"answer":"B","index":1}';
  const sseId = (text, id) => ({
    ok: true, status: 200, json: async () => ({}),
    text: async () => [`data: ${JSON.stringify({ v: { response: { ...(id === undefined ? {} : { message_id: id }), fragments: [{ type: 'RESPONSE', content: text }] } } })}`, 'data: [DONE]'].join('\n'),
  });
  const newThread = id => biz({ chat_session: { id } });
  const dsOld = (over = {}) => ({ sessionId: 'sess-old', parentId: 500, turns: 5, model: 'default', at: 1, ...over });
  const useDsChat = (extra = {}) => { store = { provider: 'deepseek', deepseekToken: DKEY, ...extra }; };   // reuseChat at its default

  useDsChat();
  calls = script(newThread('sess-1'), biz({ challenge }), sseId(ANS, 777));
  res = await ctx.ask(mcq());
  check('the first question makes a thread, with no parent message', res.index === 1 && calls.length === 3 && /chat_session\/create$/.test(calls[0].url) && calls[2].body.parent_message_id === null, j(calls.map(c => c.url.split('/api/v0')[1])));
  check('and the thread is remembered, with the assistant\'s message id to continue from',
    store.deepseekChat?.sessionId === 'sess-1' && store.deepseekChat?.parentId === 777 && store.deepseekChat?.turns === 1 && store.deepseekChat?.model === 'default', j(store.deepseekChat));
  check('the login is not kept in it', !j(store.deepseekChat).includes(DKEY));

  calls = script(biz({ challenge }), sseId(ANS, 778));
  res = await ctx.ask(mcq());
  check('the second question makes no new thread: only a challenge, then the completion', res.index === 1 && calls.length === 2 && isChallenge(calls[0]) && isCompletion(calls[1]), j(calls.map(c => c.url.split('/api/v0')[1])));
  check('it goes into the same thread, hanging from the assistant\'s last message', calls[1].body.chat_session_id === 'sess-1' && calls[1].body.parent_message_id === 777, j({ s: calls[1].body.chat_session_id, p: calls[1].body.parent_message_id }));
  check('it still carries its own proof of work', !!calls[1].headers['x-ds-pow-response']);
  check('and the count goes up, with the new reply to continue from', store.deepseekChat.turns === 2 && store.deepseekChat.parentId === 778, j(store.deepseekChat));

  calls = script(biz({ challenge }), sseId(ANS, 779));
  await ctx.ask(mcq());
  check('the third hangs from the second\'s reply, not the first\'s', calls[1].body.parent_message_id === 778, String(calls[1].body.parent_message_id));

  // The switch: off means a thread per question, and neither reads nor disturbs a saved one.
  useDsChat({ reuseChat: false, deepseekChat: dsOld() });
  calls = script(newThread('sess-9'), biz({ challenge }), sseId(ANS, 1));
  res = await ctx.ask(mcq());
  check('with the switch off every question makes its own thread', calls.length === 3 && calls[2].body.chat_session_id === 'sess-9' && calls[2].body.parent_message_id === null);
  check('and a saved chat is left alone', store.deepseekChat.sessionId === 'sess-old' && store.deepseekChat.turns === 5, j(store.deepseekChat));

  // A thread is only continued while it is the same model it started with.
  useDsChat({ deepseekModel: 'deepseek-expert', deepseekChat: dsOld() });
  calls = script(newThread('sess-e'), biz({ challenge }), sseId(ANS, 800));
  await ctx.ask(mcq());
  check('a different model starts a new thread', calls.length === 3 && calls[2].body.chat_session_id === 'sess-e' && calls[2].body.model_type === 'expert', j(calls[2].body));
  check('and that thread is the one remembered now', store.deepseekChat.sessionId === 'sess-e' && store.deepseekChat.model === 'expert' && store.deepseekChat.turns === 1, j(store.deepseekChat));

  // A thread is retired after a fixed number of questions, so its memory of them stays small.
  useDsChat({ deepseekChat: dsOld({ turns: 29 }) });
  calls = script(biz({ challenge }), sseId(ANS, 601));
  await ctx.ask(mcq());
  check('the last question a thread has room for still goes into it', calls.length === 2 && calls[1].body.chat_session_id === 'sess-old' && store.deepseekChat.turns === 30, j(store.deepseekChat));
  calls = script(newThread('sess-n'), biz({ challenge }), sseId(ANS, 602));
  await ctx.ask(mcq());
  check('and the one after that starts a new thread', calls.length === 3 && calls[2].body.chat_session_id === 'sess-n' && calls[2].body.parent_message_id === null && store.deepseekChat.turns === 1, j(store.deepseekChat));

  // If the thread has been deleted from the site, the question is asked again in a fresh one.
  useDsChat({ deepseekChat: dsOld() });
  calls = script(biz({ challenge }), fail_(400, '{"code":40003,"msg":"chat session not found"}'), newThread('sess-2'), biz({ challenge }), sseId(ANS, 901));
  res = await ctx.ask(mcq());
  check('a thread the site will not continue is replaced, and the question still gets answered', res.index === 1 && !res.error && calls.length === 5, j({ n: calls.length, e: res.error }));
  check('the first try was in the old thread, the second in a new one with no parent', calls[1].body.chat_session_id === 'sess-old' && calls[4].body.chat_session_id === 'sess-2' && calls[4].body.parent_message_id === null);
  check('the new thread is what is remembered', store.deepseekChat.sessionId === 'sess-2' && store.deepseekChat.parentId === 901 && store.deepseekChat.turns === 1, j(store.deepseekChat));

  // An answer with nothing in it is treated the same way.
  useDsChat({ deepseekChat: dsOld() });
  calls = script(biz({ challenge }), sseId('', 600), newThread('sess-3'), biz({ challenge }), sseId(ANS, 902));
  res = await ctx.ask(mcq());
  check('an empty answer from a continued thread is asked again in a fresh one', res.index === 1 && calls.length === 5 && calls[4].body.chat_session_id === 'sess-3', j({ n: calls.length, e: res.error }));

  // But a refused login or a rate limit is the account's, and a new thread would be refused too.
  useDsChat({ deepseekChat: dsOld() });
  calls = script(biz({ challenge }), fail_(401, '{"code":401,"msg":"unauthorized"}'));
  res = await ctx.ask(mcq());
  check('a refused login is not retried in a new thread', calls.length === 2 && /refused the token/.test(res.error || ''), j({ n: calls.length, e: res.error }));
  check('and the saved thread is kept', store.deepseekChat?.sessionId === 'sess-old' && store.deepseekChat?.turns === 5, j(store.deepseekChat));

  useDsChat({ deepseekChat: dsOld() });
  calls = script(biz({ challenge }), fail_(429, '{"code":429,"msg":"too many"}'));
  res = await ctx.ask(mcq());
  check('a rate limit is not retried in a new thread either', calls.length === 2 && /rate-limiting/.test(res.error || ''), j({ n: calls.length, e: res.error }));
  check('and a failed question does not use up one of the thread\'s places', store.deepseekChat?.turns === 5, j(store.deepseekChat));

  // A thread whose message id could not be read cannot be continued, so it is not kept.
  useDsChat();
  calls = script(newThread('sess-x'), biz({ challenge }), sseId(ANS));
  res = await ctx.ask(mcq());
  check('a reply with no message id is still answered', res.index === 1 && !res.error);
  check('but nothing is remembered, so the next question starts a new thread', !store.deepseekChat, j(store.deepseekChat));

  // The message id is also read from where the site has put it before: `id`, or on the frame.
  for (const [where, frame] of [
    ['`id` on the response', { v: { response: { id: 41, fragments: [{ type: 'RESPONSE', content: 'a' }] } } }],
    ['`message_id` on the frame', { v: { message_id: 42, response: { fragments: [{ type: 'RESPONSE', content: 'a' }] } } }],
    ['`id` on the frame', { v: { id: 43, response: { fragments: [{ type: 'RESPONSE', content: 'a' }] } } }],
  ]) {
    check(`a message id given as ${where} is found`, [41, 42, 43].includes(ctx.parseDeepseekStream(`data: ${JSON.stringify(frame)}`).messageId), where);
  }
  check('one that is not a whole number is not mistaken for one', ctx.parseDeepseekStream(`data: ${JSON.stringify({ v: { response: { message_id: 'abc', fragments: [{ type: 'RESPONSE', content: 'a' }] } } })}`).messageId === null);

  /* ------------------------------------------------ the Gemini site: the same, through its tab */
  console.log('\nthe Gemini site: one conversation is kept going instead of a new one per question');
  // The service worker never talks to the site itself: it talks to a tab. This is that tab.
  let tabLog = [], genQueue = [], genN = 0, convN = 0, tabAccount = '1';
  let tabId = 7, tabUrl = 'https://gemini.google.com/app', modelsReply = null, onModels = null;
  const WEB_MODELS = [
    { id: 'id-flash', name: 'gemini-flash', label: 'Flash', description: '', number: 1 },
    { id: 'id-pro', name: 'gemini-pro', label: 'Pro', description: '', number: 3 },
  ];
  ctx.chrome.tabs = {
    query: async () => [{ id: tabId, url: tabUrl }],
    sendMessage: async (_id, msg) => {
      tabLog.push(msg);
      switch (msg.type) {
        case 'gw-ping': return { ok: true };
        case 'gw-init': return { ok: true, session: { at: 'T', hl: 'en', account: tabAccount, push: 'feeds/x' } };
        case 'gw-models':
          if (onModels) onModels();
          return modelsReply || { ok: true, status: 1000, capacity: { capacity: 1, capacityField: 12 }, models: WEB_MODELS };
        case 'gw-generate': {
          const scripted = genQueue.shift();
          if (scripted) return scripted;
          // The site starts a conversation (new ids) when none is named, and carries on the one named.
          const n = ++genN;
          return { ok: true, text: ANS, done: true, cid: msg.chat ? msg.chat[0] : `c_${++convN}`, rid: `r_${n}`, rcid: `rc_${n}` };
        }
        default: return { ok: false, detail: 'unexpected' };
      }
    },
  };
  // Each scenario starts with nothing remembered from the last one, the session cache included
  // (it is dropped synchronously; the storage call behind it has no stub here and is ignored).
  const useWeb = (extra = {}) => {
    store = { provider: 'gemini-web', ...extra };
    tabLog = []; genQueue = []; genN = 0; convN = 0; tabAccount = '1';
    tabId = 7; tabUrl = 'https://gemini.google.com/app'; modelsReply = null; onModels = null;
    ctx.gwCacheDrop();
  };
  const gens = () => tabLog.filter(m => m.type === 'gw-generate');
  const webOld = (over = {}) => ({ cid: 'c_old', rid: 'r_old', rcid: 'rc_old', turns: 5, model: '', account: '1', at: 1, ...over });

  useWeb();
  res = await ctx.ask(mcq());
  check('the first question starts a new conversation', res.index === 1 && gens().length === 1 && gens()[0].chat === null, j(gens().map(g => g.chat)));
  check('and the conversation is remembered',
    store.geminiWebChat?.cid === 'c_1' && store.geminiWebChat?.rid === 'r_1' && store.geminiWebChat?.rcid === 'rc_1' && store.geminiWebChat?.turns === 1 && store.geminiWebChat?.account === '1', j(store.geminiWebChat));

  tabLog = [];
  res = await ctx.ask(mcq());
  check('the second question continues it, naming the last reply\'s ids', j(gens()[0].chat) === j(['c_1', 'r_1', 'rc_1']), j(gens()[0].chat));
  check('and it is answered', res.index === 1 && !res.error);
  check('the ids move on to the newest reply, and the count goes up', store.geminiWebChat.cid === 'c_1' && store.geminiWebChat.rid === 'r_2' && store.geminiWebChat.turns === 2, j(store.geminiWebChat));

  tabLog = [];
  await ctx.ask(mcq());
  check('the third continues from the second\'s reply', j(gens()[0].chat) === j(['c_1', 'r_2', 'rc_2']), j(gens()[0].chat));
  check('it is the same conversation throughout, not a new one each time', convN === 1, String(convN));

  useWeb({ reuseChat: false, geminiWebChat: webOld() });
  await ctx.ask(mcq());
  check('with the switch off a new conversation is started', gens()[0].chat === null);
  check('and a saved one is left alone', store.geminiWebChat.cid === 'c_old' && store.geminiWebChat.turns === 5, j(store.geminiWebChat));

  useWeb({ geminiWebModel: 'gemini-pro', geminiWebChat: webOld({ model: 'id-flash' }) });
  await ctx.ask(mcq());
  check('a different model starts a new conversation', gens()[0].chat === null, j(gens()[0].chat));
  check('and that one is remembered, with the model it is for', store.geminiWebChat.model === 'id-pro' && store.geminiWebChat.turns === 1 && store.geminiWebChat.cid === 'c_1', j(store.geminiWebChat));

  useWeb({ geminiWebChat: webOld({ account: '0' }) });
  await ctx.ask(mcq());
  check('a different Google account starts a new conversation', gens()[0].chat === null && store.geminiWebChat.account === '1', j(gens()[0].chat));

  useWeb({ geminiWebChat: webOld({ turns: 29 }) });
  await ctx.ask(mcq());
  check('the last question a conversation has room for still goes into it', j(gens()[0].chat) === j(['c_old', 'r_old', 'rc_old']) && store.geminiWebChat.turns === 30, j(store.geminiWebChat));
  tabLog = [];
  await ctx.ask(mcq());
  check('and the one after that starts a new conversation', gens()[0].chat === null && store.geminiWebChat.turns === 1, j(store.geminiWebChat));

  // The conversation was deleted from the site, or no longer matches: ask again in a fresh one.
  useWeb({ geminiWebChat: webOld() });
  genQueue = [{ ok: true, text: '', failure: 'the model no longer matches this conversation', code: 1050 }];
  res = await ctx.ask(mcq());
  check('a conversation the site will not continue is replaced, and the question still gets answered', res.index === 1 && !res.error && gens().length === 2, j({ n: gens().length, e: res.error }));
  check('the first try named the old one, the second named none', j(gens()[0].chat) === j(['c_old', 'r_old', 'rc_old']) && gens()[1].chat === null);
  check('the new conversation is what is remembered', store.geminiWebChat.cid === 'c_1' && store.geminiWebChat.turns === 1, j(store.geminiWebChat));

  useWeb({ geminiWebChat: webOld() });
  genQueue = [{ ok: false, status: 400, detail: 'bad request' }];
  res = await ctx.ask(mcq());
  check('a refused request in a continued conversation is asked again in a fresh one', res.index === 1 && gens().length === 2 && gens()[1].chat === null, j({ n: gens().length, e: res.error }));

  useWeb({ geminiWebChat: webOld() });
  genQueue = [{ ok: true, text: '', done: true, cid: 'c_old', rid: 'r_x', rcid: 'rc_x' }];
  res = await ctx.ask(mcq());
  check('an empty answer from a continued conversation is asked again in a fresh one', res.index === 1 && gens().length === 2 && gens()[1].chat === null, j({ n: gens().length, e: res.error }));

  // An empty allowance, a rate limit or a block belongs to the account; a new conversation would meet it too.
  for (const [code, label] of [[1037, 'an empty allowance'], [1013, 'a temporary error'], [1060, 'a blocked address']]) {
    useWeb({ geminiWebChat: webOld() });
    genQueue = [{ ok: true, text: '', failure: `site said ${code}`, code }];
    res = await ctx.ask(mcq());
    check(`${label} is not retried in a new conversation`, gens().length === 1 && !!res.error, j({ n: gens().length, e: res.error }));
    check(`and the saved conversation survives ${label}`, store.geminiWebChat.cid === 'c_old' && store.geminiWebChat.turns === 5, j(store.geminiWebChat));
  }

  useWeb({ geminiWebChat: webOld() });
  genQueue = [{ ok: false, status: 429, detail: 'slow down' }];
  res = await ctx.ask(mcq());
  check('an HTTP rate limit is not retried in a new conversation either', gens().length === 1 && !!res.error, j({ n: gens().length, e: res.error }));

  useWeb();
  genQueue = [{ ok: true, text: ANS, done: true }];
  await ctx.ask(mcq());
  check('a reply that came back without its ids is answered but not kept', !store.geminiWebChat, j(store.geminiWebChat));

  /* ------------------------------------------------ the Gemini session is kept */
  console.log('\nthe Gemini session and model list are kept between questions');
  // The upload below runs in this realm too; it needs the same few browser pieces.
  ctx.URL = URL; ctx.TextEncoder = TextEncoder; ctx.FormData = FormData; ctx.Blob = Blob;
  ctx.atob = s => Buffer.from(s, 'base64').toString('binary');
  const count = type => tabLog.filter(m => m.type === type).length;
  const MIN = 60 * 1000;

  useWeb({ reuseChat: false });
  res = await ctx.ask(mcq());
  check('the first question asks the page for its session and for the model list, once each',
    res.index === 1 && count('gw-init') === 1 && count('gw-models') === 1, j({ init: count('gw-init'), models: count('gw-models') }));
  check('and its timing says the setup was done, not kept', res.timing.cached === false);
  tabLog = [];
  res = await ctx.ask(mcq());
  const res2 = await ctx.ask(mcq());
  check('the next questions ask for neither, and are still answered',
    count('gw-init') === 0 && count('gw-models') === 0 && gens().length === 2 && res.index === 1 && res2.index === 1, j({ init: count('gw-init'), models: count('gw-models'), gens: gens().length }));
  check('and their timing says the setup was kept', res.timing.cached === true && res2.timing.cached === true);
  check('the kept session is what the question is sent with', gens().every(g => g.session.at === 'T' && g.session.account === '1'));

  useWeb({ reuseChat: false, speedCache: false });
  await ctx.ask(mcq());
  await ctx.ask(mcq());
  check('with the switch off every question asks for both, as it used to', count('gw-init') === 2 && count('gw-models') === 2, j({ init: count('gw-init'), models: count('gw-models') }));

  // It is kept for ten minutes and no longer.
  useWeb({ reuseChat: false });
  ctx.__clock = 1_700_000_000_000;
  vm.runInContext('globalThis.__realNow = Date.now; Date.now = () => globalThis.__clock', ctx);
  await ctx.ask(mcq());
  ctx.__clock += 9 * MIN; tabLog = [];
  await ctx.ask(mcq());
  check('nine minutes later it is still kept', count('gw-init') === 0 && count('gw-models') === 0);
  ctx.__clock += 2 * MIN; tabLog = [];
  await ctx.ask(mcq());
  check('eleven minutes after it was fetched it is asked for again', count('gw-init') === 1 && count('gw-models') === 1, j({ init: count('gw-init'), models: count('gw-models') }));
  vm.runInContext('Date.now = globalThis.__realNow', ctx);

  // It belongs to one tab and one Google account slot.
  useWeb({ reuseChat: false });
  await ctx.ask(mcq());
  tabId = 8; tabLog = [];
  await ctx.ask(mcq());
  check('another tab does not borrow the first one\'s session', count('gw-init') === 1);
  tabUrl = 'https://gemini.google.com/u/2/app'; tabLog = [];
  await ctx.ask(mcq());
  check('nor does the same tab once it is on another Google account', count('gw-init') === 1);
  tabLog = [];
  await ctx.ask(mcq());
  check('and once there, the next question keeps it again', count('gw-init') === 0);

  // The site turning the session down is not a failed question: fetch it again and ask again.
  useWeb();
  await ctx.ask(mcq());
  genQueue = [{ ok: false, status: 400, detail: 'stale' }];
  tabLog = [];
  res = await ctx.ask(mcq());
  check('a kept session the site refuses is fetched again, and the question asked once more',
    res.index === 1 && !res.error && count('gw-init') === 1 && count('gw-models') === 1 && gens().length === 2, j({ n: gens().length, init: count('gw-init'), e: res.error }));
  check('in the same conversation, not a new one', gens()[0].chat !== null && j(gens()[1].chat) === j(gens()[0].chat), j(gens().map(g => g.chat)));
  check('and the conversation carries on', store.geminiWebChat.turns === 2 && store.geminiWebChat.cid === 'c_1', j(store.geminiWebChat));

  useWeb();
  await ctx.ask(mcq());
  genQueue = [{ ok: true, text: '', failure: 'refused without saying why', code: -1 }];
  tabLog = [];
  res = await ctx.ask(mcq());
  check('a refusal with no reason from a kept session fetches it again too', res.index === 1 && count('gw-init') === 1 && gens().length === 2, j({ n: gens().length, init: count('gw-init'), e: res.error }));

  useWeb({ reuseChat: false });
  await ctx.ask(mcq());
  genQueue = [{ ok: false, status: 429, detail: 'slow down' }];
  tabLog = [];
  res = await ctx.ask(mcq());
  check('a rate limit is not mistaken for a stale session', !!res.error && count('gw-init') === 0 && gens().length === 1, j({ n: gens().length, init: count('gw-init') }));

  useWeb({ reuseChat: false });
  await ctx.ask(mcq());
  genQueue = [{ ok: false, status: 400, detail: 'a' }, { ok: false, status: 400, detail: 'b' }];
  tabLog = [];
  res = await ctx.ask(mcq());
  check('a session refused even when fresh is tried once more, not again and again', !!res.error && gens().length === 2 && count('gw-init') === 1, j({ n: gens().length, init: count('gw-init') }));

  // Only a healthy account is worth remembering.
  useWeb({ reuseChat: false });
  modelsReply = { ok: true, status: 1016, capacity: { capacity: 1, capacityField: 12 }, models: [] };
  await ctx.ask(mcq());
  tabLog = [];
  await ctx.ask(mcq());
  check('an account that did not answer healthily is looked at again every time', count('gw-init') === 1 && count('gw-models') === 1, j({ init: count('gw-init'), models: count('gw-models') }));

  // A model that is not in the kept list may have been added since.
  useWeb({ reuseChat: false });
  await ctx.ask(mcq());
  modelsReply = { ok: true, status: 1000, capacity: { capacity: 1, capacityField: 12 },
    models: [...WEB_MODELS, { id: 'id-new', name: 'gemini-new', label: 'New', description: '', number: 5 }] };
  store.geminiWebModel = 'gemini-new';
  tabLog = [];
  res = await ctx.ask(mcq());
  check('a model missing from the kept list is looked for again before giving up', res.index === 1 && count('gw-models') === 1 && gens()[0].model?.id === 'id-new', j({ models: count('gw-models'), model: gens()[0]?.model?.id, e: res.error }));
  store.geminiWebModel = 'gemini-ghost';
  tabLog = [];
  res = await ctx.ask(mcq());
  check('one that is not there even then is reported, after a single new look', /no model called/.test(res.error || '') && count('gw-models') === 1 && gens().length === 0, j({ models: count('gw-models'), e: res.error }));

  // Test login proves the login and leaves the first real question warm.
  useWeb({ reuseChat: false });
  const proved = await ctx.geminiWebSelfTest();
  tabLog = [];
  res = await ctx.ask(mcq());
  check('after Test login the first real question needs no setup', proved.ok === true && count('gw-init') === 0 && count('gw-models') === 0 && res.timing.cached === true, j({ proved: proved.ok, init: count('gw-init') }));

  /* --------------------------------------------- the picture upload beside the list */
  console.log('\nthe screenshot is uploaded while the model list loads');
  const SHOT = 'data:image/jpeg;base64,QUFBQQ==';
  let uploads = 0, uploadsWhenListAsked = -1;
  const uploadOnly = async url => {
    if (/content-push/.test(String(url))) { uploads++; return { ok: true, status: 200, text: async () => 'https://x/up' }; }
    throw new Error(`unexpected request to ${url}`);
  };
  for (const [parallel, wantStarted] of [[true, 1], [false, 0]]) {
    useWeb({ reuseChat: false, speedParallel: parallel });
    uploads = 0; uploadsWhenListAsked = -1;
    fetchImpl = uploadOnly;
    onModels = () => { uploadsWhenListAsked = uploads; };
    res = await ctx.ask(mcq({ image: SHOT, imageCount: 1 }));
    check(`with the switch ${parallel ? 'on' : 'off'}, ${wantStarted ? 'the upload has already started' : 'the upload has not started'} when the model list is asked for`,
      res.index === 1 && uploadsWhenListAsked === wantStarted, j({ started: uploadsWhenListAsked, e: res.error }));
    check('either way the picture is uploaded once and goes with the question', uploads === 1 && gens()[0].fileData?.[0]?.[0]?.[0] === 'https://x/up', j({ uploads, fd: gens()[0]?.fileData }));
    check('and the timing shows an upload', Number.isFinite(res.timing.upload));
  }

  useWeb({ reuseChat: false });
  await ctx.ask(mcq());                                 // warm: the session is now kept
  uploads = 0; fetchImpl = uploadOnly; onModels = null; tabLog = [];
  res = await ctx.ask(mcq({ image: SHOT, imageCount: 1 }));
  check('with the session kept, the upload starts at once and nothing is asked of the page first', res.index === 1 && uploads === 1 && count('gw-init') === 0 && count('gw-models') === 0, j({ uploads, init: count('gw-init') }));
  res = await ctx.ask(mcq());
  check('a question without a picture has no upload in its timing', res.timing.upload === undefined);

  /* ----------------------------------------------------------------- the timings */
  console.log('\nevery answer carries its timing, and the last ones are logged');
  useWeb({ reuseChat: false });
  res = await ctx.ask(mcq({ shotMs: 840 }));
  check('an answer carries the whole time, the setup and the model\'s',
    Number.isFinite(res.timing.total) && Number.isFinite(res.timing.setup) && Number.isFinite(res.timing.ai), j(res.timing));
  check('and the screenshot time the page reported', res.timing.shot === 840);
  check('and which switches were on', j(res.timing.mode) === j({ provider: 'gemini-web', cache: true, parallel: true, shot: 'auto' }), j(res.timing.mode));
  check('it is written to the log', store.speedLog?.length === 1 && store.speedLog[0].total === res.timing.total && j(store.speedLog[0].mode) === j(res.timing.mode), j(store.speedLog));

  useWeb({ reuseChat: false, speedCache: false, speedParallel: false, screenshot: 'smart' });
  res = await ctx.ask(mcq());
  check('a different set of switches is logged as a different combination',
    j(res.timing.mode) === j({ provider: 'gemini-web', cache: false, parallel: false, shot: 'smart' }), j(res.timing.mode));

  useWeb({ reuseChat: false, speedLog: Array.from({ length: 59 }, (_, i) => ({ at: i, total: 1, mode: {} })) });
  await ctx.ask(mcq()); await ctx.ask(mcq()); await ctx.ask(mcq());
  check('the log keeps the last 60 and drops the oldest', store.speedLog.length === 60 && store.speedLog[0].at === 2, j({ n: store.speedLog.length, first: store.speedLog[0]?.at }));

  useWeb({ reuseChat: false });
  genQueue = [{ ok: false, status: 429, detail: 'slow down' }];
  res = await ctx.ask(mcq());
  check('a question that failed still shows its timing, but is not logged', !!res.error && Number.isFinite(res.timing.total) && !(store.speedLog || []).length, j({ e: !!res.error, log: store.speedLog }));

  store = { apiKey: 'sk-or-v1-abc' };
  script(orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('another service gets a total and none of the stages it does not have',
    res.index === 1 && Number.isFinite(res.timing.total) && res.timing.setup === undefined && res.timing.ai === undefined && res.timing.mode.provider === 'openrouter', j(res.timing));

  /* --------------------------------------------- a rate limit is a wait, so the answer says so */
  console.log('\nA rate limit is flagged, so the page can wait and ask again');
  const limitRes = (status, body = '', retryAfter = null) => ({
    ok: false, status, json: async () => ({}), text: async () => body,
    headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  });

  useDeepSeek();
  script(newThread('s'), biz({ challenge }), limitRes(429, '{"code":429}'));
  res = await ctx.ask(mcq());
  check('DeepSeek turning the account away is flagged, with the reason to show while waiting',
    res.rateLimited === true && /DeepSeek is rate-limiting this account/.test(res.limitNote) && res.retryAfterMs === 0, j({ r: res.rateLimited, n: res.limitNote, ms: res.retryAfterMs }));
  check('and it is still an error with the full reason, for anything that does not wait', /rate-limiting this account \(HTTP 429\)/.test(res.error || ''), res.error);
  script(newThread('s'), biz({ challenge }), limitRes(429, '', '7'));
  res = await ctx.ask(mcq());
  check('a Retry-After in seconds is passed on, in milliseconds', res.retryAfterMs === 7000, String(res.retryAfterMs));
  script(newThread('s'), biz({ challenge }), limitRes(429, '', new Date(Date.now() + 20000).toUTCString()));
  res = await ctx.ask(mcq());
  check('and so is one given as a date', res.retryAfterMs >= 17000 && res.retryAfterMs <= 21000, String(res.retryAfterMs));
  script(newThread('s'), biz({ challenge }), limitRes(401, '{"code":401,"msg":"unauthorized"}'));
  res = await ctx.ask(mcq());
  check('a refused login is not a rate limit', !!res.error && res.rateLimited === undefined, j(res.rateLimited));

  // The Gemini site's own codes: the ones that mean "not now" are waited out, the others are not.
  for (const code of [1013, 1037, 1060, 1095]) {
    useWeb({ reuseChat: false });
    genQueue = [{ ok: true, text: '', failure: `site said ${code}`, code }];
    res = await ctx.ask(mcq());
    check(`Gemini site code ${code} is one to wait out`, res.rateLimited === true && res.limitNote === `the Gemini site is limiting this account (error ${code})`, j(res.limitNote));
  }
  for (const code of [1050, 1052, 9999]) {
    useWeb({ reuseChat: false });
    genQueue = [{ ok: true, text: '', failure: `site said ${code}`, code }];
    res = await ctx.ask(mcq());
    check(`code ${code} is not: asking again would be refused again`, !!res.error && res.rateLimited === undefined, j(res.rateLimited));
  }
  useWeb({ reuseChat: false });
  genQueue = [{ ok: false, status: 429, detail: 'slow down' }];
  res = await ctx.ask(mcq());
  check('a plain HTTP 429 from the Gemini site is waited out too', res.rateLimited === true && res.limitNote === 'the Gemini site is limiting this account', j(res.limitNote));
  useWeb({ reuseChat: false });
  genQueue = [{ ok: false, status: 401, detail: 'not signed in' }];
  res = await ctx.ask(mcq());
  check('a refused session is not', !!res.error && res.rateLimited === undefined);

  useWeb({ geminiWebChat: webOld() });
  genQueue = [{ ok: true, text: '', failure: 'site said 1095', code: 1095 }];
  res = await ctx.ask(mcq());
  check('1095 on a continued conversation is not blamed on the conversation: no new one is started',
    gens().length === 1 && res.rateLimited === true && store.geminiWebChat.cid === 'c_old', j({ n: gens().length, chat: store.geminiWebChat?.cid }));

  // The other services: a 429 is a wait on each, unless the money has run out.
  store = { apiKey: 'sk-or-v1-abc', model: 'a/one', fallbackModel: 'b/two' };
  script(limitRes(429, 'busy'), limitRes(429, 'busy'));
  res = await ctx.ask(mcq());
  check('OpenRouter turning both models away is flagged', res.rateLimited === true && /OpenRouter is rate-limiting/.test(res.limitNote), j(res.limitNote));
  script(limitRes(429, 'busy'), orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('but one that answers on the fallback model is simply an answer, not a wait', res.index === 1 && res.rateLimited === undefined, j(res));
  script(limitRes(500, 'broken'), limitRes(500, 'broken'));
  res = await ctx.ask(mcq());
  check('a server error is not a rate limit', !!res.error && res.rateLimited === undefined);
  store = { provider: 'openai', openaiKey: 'sk-test-OPENAI-FAKE-KEY-123' };
  script(limitRes(429, '{"error":{"code":"rate_limit_exceeded"}}'));
  res = await ctx.ask(mcq());
  check('OpenAI asking for patience is flagged', res.rateLimited === true && /OpenAI is rate-limiting/.test(res.limitNote), j(res.limitNote));
  script(limitRes(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'));
  res = await ctx.ask(mcq());
  check('OpenAI saying the money has run out is not: waiting does not cure that', !!res.error && res.rateLimited === undefined, j(res.rateLimited));
  useGemini();
  script(limitRes(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'));
  res = await ctx.ask(mcq());
  check('the Gemini key service is flagged too', res.rateLimited === true && /Gemini is rate-limiting/.test(res.limitNote), j(res.limitNote));

  check('Retry-After: nothing, or a response with no headers, is zero', ctx.retryAfterOf(null) === 0 && ctx.retryAfterOf({}) === 0 && ctx.retryAfterOf(limitRes(429)) === 0);
  check('seconds are read as milliseconds', ctx.retryAfterOf(limitRes(429, '', '12')) === 12000);
  check('garbage is zero, not NaN', ctx.retryAfterOf(limitRes(429, '', 'soon')) === 0);
  check('a date already past is zero', ctx.retryAfterOf(limitRes(429, '', 'Wed, 01 Jan 2020 00:00:00 GMT')) === 0);

  /* ------------------------------------- the site's own error message comes back as the reply */
  console.log('\nThe Gemini site\'s own error message is not an answer');
  const OWN_ERROR = 'I seem to be encountering an error. Can I try something else for you?';
  const errorReply = (cid = 'c_err') => ({ ok: true, text: OWN_ERROR, done: true, cid, rid: 'r_err', rcid: 'rc_err' });

  for (const [text, want, why] of [
    [OWN_ERROR, true, 'the message from the failure report'],
    ['  I seem to be encountering an error.  ', true, 'with spaces round it'],
    ['Something went wrong. Please try again.', true, 'the plain "something went wrong"'],
    ['', false, 'an empty reply is another case, not this one'],
    ['{"answer":"B","index":1}', false, 'an answer'],
    ['{"answer":"C","why":"something went wrong with option B"}', false, 'an answer that happens to say so in its reason'],
    ['[2,0]', false, 'a list of picks'],
    ['There is no error in option A.', false, 'prose that merely mentions an error'],
    ['x'.repeat(500) + ' encountering an error', false, 'long text is never the short fallback message'],
  ]) {
    check(`${why}: ${want ? 'recognised' : 'left alone'}`, ctx.gwErrorReply(text) === want, text.slice(0, 40));
  }

  useWeb({ reuseChat: false });
  genQueue = [errorReply()];
  pauses.length = 0;
  res = await ctx.ask(mcq());
  check('asked again, and the question is answered', res.index === 1 && !res.error && gens().length === 2, j({ n: gens().length, e: res.error }));
  check('after a short wait', j(pauses) === j([2000]), j(pauses));
  check('with a fresh session: the page and the model list were asked for again', count('gw-init') === 2 && count('gw-models') === 2, j({ init: count('gw-init'), models: count('gw-models') }));

  useWeb();
  await ctx.ask(mcq());                                // the session is now kept
  genQueue = [errorReply()];
  tabLog = [];
  res = await ctx.ask(mcq());
  check('even a kept session is fetched again for the retry', res.index === 1 && count('gw-init') === 1 && count('gw-models') === 1, j({ init: count('gw-init'), e: res.error }));

  useWeb({ geminiWebChat: webOld() });
  genQueue = [errorReply('c_old')];
  res = await ctx.ask(mcq());
  check('a continued conversation that says this is not gone on with: the retry is in a new one',
    j(gens()[0].chat) === j(['c_old', 'r_old', 'rc_old']) && gens()[1].chat === null && res.index === 1, j(gens().map(g => g.chat)));
  check('and what is kept is the new conversation, never the one that errored',
    store.geminiWebChat.cid === 'c_1' && store.geminiWebChat.rid === 'r_1' && store.geminiWebChat.turns === 1, j(store.geminiWebChat));

  useWeb({ reuseChat: false });
  genQueue = [errorReply(), errorReply()];
  pauses.length = 0;
  res = await ctx.ask(mcq());
  check('twice, then an answer: three tries in all, waiting two seconds and then six', res.index === 1 && gens().length === 3 && j(pauses) === j([2000, 6000]), j({ n: gens().length, pauses }));

  useWeb({ geminiWebChat: webOld() });
  genQueue = [errorReply(), errorReply(), errorReply()];
  pauses.length = 0;
  res = await ctx.ask(mcq());
  check('three times in all it is not answered, and says why', !!res.error && gens().length === 3 && /own error message/.test(res.error) && /encountering an error/.test(res.error), (res.error || '').slice(0, 160));
  check('it is flagged as a wait that has an end, four long', res.rateLimited === true && res.retryLimit === 4 && /own error message/.test(res.limitNote || ''), j({ r: res.rateLimited, l: res.retryLimit, n: res.limitNote }));
  check('and no conversation is kept from it', !store.geminiWebChat, j(store.geminiWebChat));

  useWeb({ reuseChat: false });
  genQueue = [{ ok: true, text: '{"answer":"B","index":1,"why":"something went wrong with C"}', done: true, cid: 'c_1', rid: 'r_1', rcid: 'rc_1' }];
  pauses.length = 0;
  res = await ctx.ask(mcq());
  check('an answer that merely says so is an answer: no retry, no wait', res.index === 1 && gens().length === 1 && pauses.length === 0, j({ n: gens().length, pauses }));

  /* ---------------------------------------------------- "Lessons per run" went from 5 to 100 */
  console.log('\nLessons per run: the old default of 5 becomes 100, once');
  store = { maxLessons: 5 };
  await ctx.migrateSettings();
  check('a stored 5 is the old default saved by Options, and becomes 100', store.maxLessons === 100 && store.lessonsDefault100 === true, j(store));
  store.maxLessons = 5;
  await ctx.migrateSettings();
  check('but only once: a 5 chosen afterwards is left alone', store.maxLessons === 5, j(store));
  store = { maxLessons: 12 };
  await ctx.migrateSettings();
  check('any other number the person chose is kept', store.maxLessons === 12 && store.lessonsDefault100 === true, j(store));
  store = {};
  await ctx.migrateSettings();
  check('with nothing stored there is nothing to change, and the default (100) applies', store.maxLessons === undefined && store.lessonsDefault100 === true, j(store));
  store = { maxLessons: 100 };
  await ctx.migrateSettings();
  check('a stored 100 is untouched', store.maxLessons === 100);

  console.log('\nOpenRouter and the others are unchanged by any of this');
  store = { apiKey: 'sk-or-v1-abc' };
  calls = script(orGood('{"answer":"B","index":1}'));
  res = await ctx.ask(mcq());
  check('with nothing chosen it is still OpenRouter, with no DeepSeek call', res.index === 1 && calls.length === 1 && calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', calls[0].url);

  console.log('\na question whose page text holds no question');
  const bareQ = ctx.buildText(multiQ({ stem: 'Select the correct answers.' }));
  check('when the only "question" is the instruction itself, the model is told so', /=== QUESTION ===\s+\(The page's text holds no question, only the instruction below\. If a picture is attached, the question is in it\.\)/.test(bareQ), bareQ.replace(/\n/g, ' | ').slice(0, 220));
  check('the instruction is still given, once, as the instruction', /=== INSTRUCTION ===\s+Select the correct answers\./.test(bareQ));
  check('a real question is shown as it is', /=== QUESTION ===\s+What is it\?/.test(ctx.buildText(multiQ({ stem: 'What is it?' }))));
  check('a single-answer question with no text keeps the old words', /=== QUESTION ===\s+\(no question text found\)/.test(ctx.buildText(mcq({ stem: '' }))));

  console.log('\nthe thinking level saved by an older version');
  // 0.6.30 and earlier saved the Gemini-site thinking setting as on/off, not as a level. It must
  // keep meaning what it meant — extended thinking — rather than quietly falling back to standard.
  for (const [saved, want, why] of [
    [true, 'high', 'an old "extended thinking" switch comes back as the level it meant'],
    [false, '', 'an old switch that was off comes back as standard'],
    ['high', 'high', 'a level saves and loads as itself'],
    ['medium', 'medium', 'the level the site puts above low is kept'],
    ['nonsense', '', 'a level that is not one of the site\'s falls back to standard'],
    [undefined, '', 'nothing saved is standard'],
  ]) {
    store = { provider: 'gemini-web', geminiWebThinking: saved };
    check(why, (await ctx.settings())?.geminiWebThinking === want, j((await ctx.settings())?.geminiWebThinking));
  }

  console.log('\nthe picture upload: the plain way, and the newer one behind it');
  // Nothing else here touches an upload, so the pieces it uses are given to the sandbox now.
  ctx.URL = URL; ctx.TextEncoder = TextEncoder; ctx.FormData = FormData; ctx.Blob = Blob;
  ctx.atob = s => Buffer.from(s, 'base64').toString('binary');

  /** Record upload calls without touching the body: an upload body is bytes or a form, which
   *  the JSON-recording helper above would choke on. */
  const upScript = (...replies) => {
    const calls = [];
    fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, headers: init?.headers || {}, body: init?.body });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (typeof r === 'function') return r(calls[calls.length - 1]);
      if (r && r.throw) throw new Error(r.throw);
      return r;
    };
    return calls;
  };
  const upOk = body => ({ ok: true, status: 200, text: async () => body });
  const upFail = status => ({ ok: false, status, text: async () => '' });
  const upStart = dest => ({ ok: true, status: 200, headers: { get: h => (h.toLowerCase() === 'x-goog-upload-url' ? dest : null) }, text: async () => '' });
  const PIC = 'data:image/jpeg;base64,QUFBQQ==';

  // The plain multipart route, which is what this did before: one POST, the address in the reply.
  let up = upScript(upOk('https://x/y'));
  let ur = await ctx.gwUpload(PIC, 'feeds/abc');
  check('a picture goes to the upload endpoint the site uses, with the push id the page gave',
    ur.ok && ur.url === 'https://x/y' && up[0].url === 'https://content-push.googleapis.com/upload' && up[0].headers['push-id'] === 'feeds/abc', j({ u: up[0].url, p: up[0].headers['push-id'] }));
  check('and is named as an image so the site can read it back',
    /^input_\d+\.jpeg$/.test(ur.name), ur.name);
  check('with no push id from the page, the site\'s own default is used',
    (up = upScript(upOk('https://x/y')), await ctx.gwUpload(PIC), up[0].headers['push-id'] === 'feeds/mcudyrk2a4khkz'));

  // A refusal, a dead network, or an empty reply is not the end: the resumable handshake is tried.
  up = upScript(upFail(404), upOk(''), upStart('https://content-push.googleapis.com/upload/session'), upOk('/contrib_service/ttl_1d/abc'));
  ur = await ctx.gwUpload(PIC, 'feeds/abc');
  check('an upload the plain way is refused for falls through to the newer handshake and still succeeds',
    ur.ok && ur.url === '/contrib_service/ttl_1d/abc', j(ur));
  check('which asks where to put it first, then sends the bytes there',
    up[1].method === 'OPTIONS' && up[2].method === 'POST' && /^File name: input_/.test(String(up[2].body)) &&
    up[3].url === 'https://content-push.googleapis.com/upload/session' && up[3].method === 'OPTIONS' &&
    up[4].url === 'https://content-push.googleapis.com/upload/session' && up[4].headers['x-goog-upload-command'] === 'upload, finalize',
    j({ m1: up[1].method, m2: up[2].method, m3: up[3].method, u4: up[4].url, c4: up[4].headers['x-goog-upload-command'] }));
  check('and tells the endpoint how large the picture is, as the site does',
    up[2].headers.size === '4' && up[2].headers['x-goog-upload-header-content-length'] === '4',
    j({ s: up[2].headers.size, l: up[2].headers['x-goog-upload-header-content-length'] }));
  check('the bytes go to the destination, not to the original endpoint',
    up[4].url === 'https://content-push.googleapis.com/upload/session' && !up.slice(3).some(c => c.url === 'https://content-push.googleapis.com/upload'),
    j(up.slice(3).map(c => c.url)));

  // An upload address is a reply's word for where the bytes go. It must be Google's own host and
  // nothing else, or a screenshot would be posted wherever a reply pointed.
  up = upScript(upFail(404), upOk(''), upStart('https://evil.example.com/collect'), upOk('nope'));
  ur = await ctx.gwUpload(PIC, 'feeds/abc');
  check('an upload address that is not the site\'s own host is refused, and the picture is not sent there',
    !ur.ok && !up.some(c => c.url.includes('evil.example.com')), j({ ok: ur.ok, d: ur.detail }));

  up = upScript(upFail(404), upOk(''), upFail(500));
  ur = await ctx.gwUpload(PIC, 'feeds/abc');
  check('a handshake that fails too is reported plainly', !ur.ok && /HTTP 500/.test(ur.detail || ''), ur.detail);

  up = upScript({ throw: 'offline' }, upOk(''), upStart('https://content-push.googleapis.com/u/1'), upOk('/x'));
  ur = await ctx.gwUpload(PIC, 'feeds/abc');
  check('a network that is down altogether is retried the other way rather than given up on',
    ur.ok && ur.url === '/x', j(ur));

  up = upScript(upOk('https://x/y'));
  ur = await ctx.gwUpload('not a data url at all', 'feeds/abc');
  check('something that is not a picture at all is refused before any request', !ur.ok && up.length === 0, ur.detail);

  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e && e.stack || e); process.exit(1); });
