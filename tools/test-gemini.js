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
  chrome: {
    runtime: { onMessage: { addListener() { } } },
    storage: { local: { get: async () => ({ ...store }) } },
  },
});
vm.runInContext(SRC, ctx, { filename: 'background.js' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const j = v => JSON.stringify(v);           // results come out of another realm: compare by value

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

  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e && e.stack || e); process.exit(1); });
