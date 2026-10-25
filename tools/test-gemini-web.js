#!/usr/bin/env node
/* Gemini's own web app as the service that answers. Runs the real gemini-web.js — the script
   that lives inside a gemini.google.com tab — in a sandbox with a stubbed `fetch` and a
   scripted page, so it needs no browser, no Google login and no call to Google.

   What is checked: the session values read out of the page, the model list and the account
   flags that decide which models may be used, the 81-slot request body and the model header
   that names a model, the length-prefixed `)]}'` response frames, and the three things that
   actually go wrong (signed out, out of allowance, a network address the site has blocked). */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(process.env.ALEF_GEMINI_WEB || path.join(__dirname, '..', 'gemini-web.js'), 'utf8');

let fetchImpl = async () => { throw new Error('no network in tests'); };
let sent = [];
let listener = null;                      // the message handler the page script registers, captured
// The tab's own address. A browser signed in to more than one Google account keeps each at its
// own `/u/<n>` slot, and the script reads this to know which one to talk to.
let pagePath = '/app';
const ctx = vm.createContext({
  console,
  fetch: (...a) => fetchImpl(...a),
  crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  TextEncoder,
  Blob,
  FormData,
  URLSearchParams,
  location: { get pathname() { return pagePath; } },
  chrome: {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async () => ({}),
    },
  },
});
vm.runInContext(SRC, ctx, { filename: 'gemini-web.js' });

/** Ask the tab the way the service worker does: through the real message handler, so what is
 *  tested is the path a question actually takes, not a shortcut around it. */
const ask = msg => new Promise(resolve => { listener(msg, {}, resolve); });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const j = v => JSON.stringify(v);

/** A page whose HTML carries the five values the script watches for. `at: null` is signed out. */
const PAGE = (at = 'TOKEN-abc', bl = 'bl-1', sid = 'sid-1', hl = 'en', push = 'feeds/xyz') =>
  `<html><script>window.WIZ_global_data = {"SNlM0e":"${at}","cfb2h":"${bl}","FdrFJe":"${sid}","TuX5cc":"${hl}","qKIAYe":"${push}"};</script></html>`;

/** A length-prefixed reply, `)]}'` and all, exactly as the site frames one. Counted in UTF-16
 *  units, which is what a JavaScript string's length already is.
 *
 *  Each frame is an array of parts, and every part is itself an array whose slot 1 names the
 *  RPC it answers and whose slot 2 carries the payload — which is why a frame is spread out
 *  into its parts as it is read. */
const framed = (...frames) => {
  let out = ")]}'";
  for (const f of frames) {
    const s = JSON.stringify(f);
    out += `\n\n${s.length}\n${s}`;
  }
  return out;
};

const ok = (body, status = 200) => ({ ok: true, status, text: async () => body, json: async () => JSON.parse(body) });
const fail_ = (status, body = '') => ({ ok: false, status, text: async () => body, json: async () => ({}) });

/** Record requests and answer with the next scripted reply (the last one repeats). */
function script(...replies) {
  sent = [];
  fetchImpl = async (url, init) => {
    sent.push({ url: String(url), method: init?.method, headers: init?.headers || {}, body: String(init?.body || '') });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    return typeof r === 'function' ? r(sent[sent.length - 1]) : r;
  };
  return sent;
}

/** The body of the f.req form field, decoded, for inspecting what was actually asked. */
const reqOf = call => {
  const m = /(?:^|&)f\.req=([^&]*)/.exec(call.body);
  return m ? JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' '))) : null;
};
const atOf = call => {
  const m = /(?:^|&)at=([^&]*)/.exec(call.body);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
};

/** A list of the given size with the given slots filled, since these payloads are JSPB arrays
 *  and every field lives at its own position. */
const slots = (n, filled) => { const a = new Array(n).fill(null); for (const [i, v] of Object.entries(filled)) a[i] = v; return a; };

/** A status reply carrying `models`, with the account flags that set the tier. */
const statusReply = (models, tier = [], caps = []) => framed([
  slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 2: JSON.stringify(slots(18, { 14: 1000, 15: models, 16: tier, 17: caps })), 6: 'generic' }),
]);

/** A generation part carrying one candidate with this text. */
const genPart = (text, extra = {}) => framed([
  slots(7, {
    0: 'wrb.fr',
    2: JSON.stringify(slots(5, {
      1: ['r-1', 'rid-1'],
      4: [slots(9, { 0: 'rc-1', 1: [text], 8: [2], ...extra })],
    })),
    6: 'generic',
  }),
]);

/** A part reporting one of the site's error codes: slot 5, four levels down. */
const errPart = code => framed([
  slots(7, { 0: 'wrb.fr', 2: JSON.stringify([]), 5: [null, null, [[null, [code]]]], 6: 'generic' }),
]);

/** A part whose refusal is a `BardErrorInfo` block rather than a bare code — the other way the
 *  site reports one, and the only way when the block sits somewhere else than usual. */
const bardErrPart = code => framed([
  slots(7, {
    0: 'wrb.fr',
    2: JSON.stringify([null, 'cid-1', 'rid-1', null, null, ['BardErrorInfo', code, 'blocked']]),
    6: 'generic',
  }),
]);

/** A part in the newer shape: no candidates at all, the answer streamed as numbered fields. */
const streamPart = text => framed([
  slots(7, {
    0: 'wrb.fr',
    2: JSON.stringify([null, ['cid-1', 'rid-1'], { 7: [text], 44: true }]),
    6: 'generic',
  }),
]);

(async () => {
  /* ------------------------------------------------------ reading the page's session */
  console.log('the session: the five values read out of the Gemini page');
  script(ok(PAGE()));
  let s = await ctx.gwInit();
  check('the access token is read', s.at === 'TOKEN-abc', s.at);
  check('the build label, session id, language and push id come too', s.bl === 'bl-1' && s.sid === 'sid-1' && s.hl === 'en' && s.push === 'feeds/xyz', j(s));
  check('the page itself is fetched, with the login attached', sent[0].url === 'https://gemini.google.com/app');

  // The token is sometimes a key of one object and sometimes a `["SNlM0e","…"]` pair in another.
  script(ok('<html><script>AF_initDataCallback({data:[["SNlM0e","PAIR-TOKEN-9"],["cfb2h","bl-9"]]});</script></html>'));
  s = await ctx.gwInit();
  check('a token held as a pair rather than a key is still found', s.at === 'PAIR-TOKEN-9', s.at);

  script(ok(PAGE('TOKEN', '', '', '')));
  s = await ctx.gwInit();
  check('a page with no language still gives a usable one', s.hl === 'en', s.hl);

  /* ------------------------------------------------ which account the tab is showing */
  // A browser signed in to several Google accounts keeps each at its own /u/<n> slot, and a
  // request made at the wrong slot arrives for an account whose session this is not — which is
  // what a live "the model list did not arrive" turned out to be. The slot is read from the
  // tab's own address, so the requests are made where the tab actually is.
  for (const [path, want] of [['/app', ''], ['/u/0/app', '0'], ['/u/1/app', '1'], ['/u/12/app', '12'], ['/u/3', '3']]) {
    pagePath = path;
    script(ok(PAGE()));
    s = await ctx.gwInit();
    check(`an address at ${path} is read as account slot ${want || '(none)'}`, s.account === want, s.account);
  }

  pagePath = '/u/1/app';
  script(ok(PAGE()));
  s = await ctx.gwInit();
  check('the page is fetched inside this tab\'s own account slot',
    sent[0].url === 'https://gemini.google.com/u/1/app', sent[0].url);

  // A signed-out tab at a known slot should say which slot, so the person knows which login to fix.
  pagePath = '/u/2/app';
  script(ok('<html>sign in</html>'));
  let threwSlot = '';
  try { await ctx.gwInit(); } catch (e) { threwSlot = e.message; }
  check('a signed-out tab names the account slot it looked in', /slot 2/.test(threwSlot), threwSlot);
  pagePath = '/app';

  // A reply carrying nothing recognisable must say what did arrive, not just that it failed.
  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'somethingElse', 2: JSON.stringify([]), 6: 'generic' })])));
  let threwWhat = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threwWhat = e.message; }
  check('an unrecognised reply reports what the frames actually held, to tell the two cases apart',
    /somethingElse/.test(threwWhat) && /1 frame/.test(threwWhat), threwWhat);

  script(ok(")]}'\n\n"));
  threwWhat = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threwWhat = e.message; }
  check('an empty reply is reported as empty rather than as a change to the site',
    /no frames at all/.test(threwWhat), threwWhat);

  script(ok('<html>sign in</html>'));
  let threw = '';
  try { await ctx.gwInit(); } catch (e) { threw = e.message; }
  check('a signed-out page is reported as signed out, not as an empty token', /sign in/i.test(threw), threw);

  script(fail_(500));
  threw = '';
  try { await ctx.gwInit(); } catch (e) { threw = e.message; }
  check('a page that will not load says so', /HTTP 500/.test(threw), threw);

  /* ---------------------------------------------------------------- the model list */
  console.log('\nthe model list: what the site says this account may use');
  const MODELS = [
    slots(18, { 0: 'id-flash', 1: 'Flash', 11: 'Flash', 12: 'Fast', 17: 1 }),
    slots(18, { 0: 'id-pro', 1: 'Pro', 11: 'Pro', 12: 'Smarter', 17: 3 }),
  ];
  script(ok(statusReply(MODELS)));
  let m = await ctx.gwModels({ at: 'T', bl: 'b', sid: 's', hl: 'en' });
  check('the call goes to the batchexecute endpoint', sent[0].url.startsWith('https://gemini.google.com/_/BardChatUi/data/batchexecute?'), sent[0].url);
  check('it names the user-status rpc', /rpcids=otAQ7b/.test(sent[0].url), sent[0].url);
  check('it says the request came from the page it is pretending to be', /source-path=%2Fapp/.test(sent[0].url), sent[0].url);
  check('the access token is in the body, not the address', atOf(sent[0]) === 'T' && !sent[0].url.includes('T='), atOf(sent[0]));
  check('it sends a form body, as the site does', /^at=/.test(sent[0].body), sent[0].body.slice(0, 40));
  check('both models come back, in order', m.models.length === 2 && m.models[0].name === 'gemini-flash' && m.models[1].name === 'gemini-pro', j(m.models.map(x => x.name)));
  check('each carries the name to show and what it is for', m.models[0].label === 'Flash' && m.models[0].description === 'Fast', j(m.models[0]));
  check('each carries the model number the request body mirrors', m.models[0].number === 1 && m.models[1].number === 3, j(m.models.map(x => x.number)));
  check('a free account is tier 1', m.capacity.capacity === 1 && m.capacity.capacityField === 12, j(m.capacity));

  // The slot has to ride on every call, not just the page load: a browser with several Google
  // accounts signed in would otherwise be answered for whichever one it defaults to.
  pagePath = '/u/1/app';
  script(ok(PAGE()));
  const s1 = await ctx.gwInit();
  script(ok(statusReply(MODELS)));
  await ctx.gwModels(s1);
  check('the model list is asked for inside the tab\'s own account slot',
    sent[0].url.startsWith('https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute?'), sent[0].url);
  // Including the address the site is told it came from: a request made as slot 1 that says it
  // came from the bare path describes a different account than the one it is being made as.
  check('and says it came from that slot\'s own page', /source-path=%2Fu%2F1%2Fapp/.test(sent[0].url), sent[0].url);

  script(ok(genPart('answer')));
  await ctx.gwGenerate(s1, { prompt: 'Q', model: { id: 'x', name: 'gemini-flash', label: 'Flash', number: 1, capacity: 1, capacityField: 12 } });
  check('and so is the generation call — asking the bare path is not the same thing',
    sent[0].url.startsWith('https://gemini.google.com/u/1/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?'), sent[0].url);
  pagePath = '/app';

  // The public name comes from the display name, which is what the person sees on the site —
  // not from the category, which can differ from it.
  script(ok(statusReply([
    slots(18, { 0: 'id-1', 1: 'Flash Lite', 11: 'Flash Lite 2.5', 17: 1 }),
  ])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('the model is named after what the site displays, not its category',
    m.models[0].name === 'gemini-flash-lite-2.5' && m.models[0].label === 'Flash Lite 2.5', j(m.models[0]));

  // An entry whose routing number is stated but unusable cannot be asked for by index; naming
  // it while sending a made-up number would silently answer with a different model.
  script(ok(statusReply([
    slots(18, { 0: 'id-bad', 1: 'Broken', 11: 'Broken', 17: 0 }),
    slots(18, { 0: 'id-ok', 1: 'Fine', 11: 'Fine', 17: 2 }),
  ])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('an entry with an unusable model number is left out rather than guessed at',
    m.models.length === 1 && m.models[0].id === 'id-ok', j(m.models.map(x => x.id)));

  // The number also lives at index 9 on some entries, which is the fallback.
  script(ok(statusReply([slots(18, { 0: 'id-9', 1: 'Nine', 11: 'Nine', 9: 5 })])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('the second place the site keeps the number is used when the first is empty',
    m.models[0].number === 5, String(m.models[0].number));

  // A version in the display name has to survive: "2.5 Pro" turned into "2-5-pro" is not the
  // name of anything, and the same model listed twice has to become one entry.
  script(ok(statusReply([
    slots(18, { 0: 'id-25', 1: 'Pro', 11: '2.5 Pro', 17: 3 }),
  ])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('a version inside the display name is kept as a version',
    m.models[0].name === 'gemini-2.5-pro', m.models[0].name);

  script(ok(statusReply([
    slots(18, { 0: 'id-same', 1: 'Flash', 11: 'Flash', 17: 1 }),
    slots(18, { 0: 'id-same', 1: 'Flash', 11: 'Flash', 17: 1 }),
  ])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('the same model listed twice becomes one entry', m.models.length === 1, j(m.models.length));

  // Two different entries the site happens to display under one name must stay told apart,
  // or choosing one of them in Options would silently pick the other.
  script(ok(statusReply([
    slots(18, { 0: 'id-aaa111', 1: 'Flash', 11: 'Flash', 17: 1 }),
    slots(18, { 0: 'id-bbb222', 1: 'Flash', 11: 'Flash', 17: 2 }),
  ])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('two entries sharing a display name get names that differ',
    m.models.length === 2 && m.models[0].name !== m.models[1].name, j(m.models.map(x => x.name)));

  // The account's own tier flags, which decide both the header and the model numbers.
  for (const [name, tier, caps, want] of [
    ['Plus (a capability flag)', [], [115], [4, 12]],
    ['Pro (a tier flag)', [16], [], [3, 12]],
    ['Pro (a capability flag)', [], [106], [3, 12]],
    ['a paid tier', [8], [], [2, 12]],
    ['a paid tier (a capability flag)', [], [19], [2, 12]],
    ['free', [], [], [1, 12]],
  ]) {
    script(ok(statusReply(MODELS, tier, caps)));
    const got = (await ctx.gwModels({ at: 'T', hl: 'en' })).capacity;
    check(`the tier is read from the account's own flags — ${name}`, got.capacity === want[0] && got.capacityField === want[1], j(got));
  }

  script(ok(statusReply(MODELS, [21])));
  check('the rarest tier is read too', j((await ctx.gwModels({ at: 'T', hl: 'en' })).capacity) === j({ capacity: 1, capacityField: 13 }));

  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 2: JSON.stringify(slots(18, { 14: 1016 })), 6: 'generic' })])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('an unsigned-in session is reported with the site\'s own status', m.status === 1016, j(m.status));
  check('and still yields no models', m.models.length === 0);

  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 5: [7], 6: 'generic' })])));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('a session the server rejects outright is said to be rejected', /not signed in/i.test(threw), threw);

  // Any non-zero code in the rejection slot means refused, not only the one code seen so far.
  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 5: [4], 6: 'generic' })])));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('a rejection is a rejection whatever number it carries', /not signed in/i.test(threw), threw);

  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 5: [0], 2: JSON.stringify(slots(18, { 14: 1000, 15: MODELS })), 6: 'generic' })])));
  check('a zero in that slot is not a rejection, so the call still succeeds', (await ctx.gwModels({ at: 'T', hl: 'en' })).models.length === 2);

  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'somethingelse', 2: JSON.stringify([]), 6: 'generic' })])));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('a reply with no status in it is not silently treated as fine', /did not arrive/i.test(threw), threw);
  // And the failure has to say what did turn up, so a report is enough to diagnose it.
  check('and it describes the frames that did arrive, without quoting them',
    /1 frame \(rpc ids: somethingelse; largest part 2 chars\)/.test(threw), threw);

  script(ok(framed([])));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('an entirely empty reply is described as such, not as a change', /no frames at all/.test(threw), threw);

  // An `er` frame carries the error as a bare number where a status would be. Running that
  // through JSON.parse used to turn it into a "successful" reply with no models in it.
  script(ok(framed([slots(7, { 0: 'er', 1: 'otAQ7b', 2: 3, 6: 'generic' })])));
  threw = '';
  let erResult = null;
  try { erResult = await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('an error frame for the status call is an error, not an empty success', !erResult && /reported an error for the model-list call \(code 3\)/.test(threw), threw || j(erResult));

  script(ok(framed([slots(7, { 0: 'wrb.fr', 1: 'otAQ7b', 2: slots(18, { 14: 1000, 15: MODELS }), 6: 'generic' })])));
  m = await ctx.gwModels({ at: 'T', hl: 'en' });
  check('a status that arrives already decoded (a list, not a string) is read too', m.models.length === 2 && m.status === 1000, j(m.models.length));

  script(ok('<!doctype html><html><body>Sign in</body></html>'));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('a web page where data should be is called a web page, not an empty reply',
    /no frames at all/.test(threw) && /look like a web page/.test(threw) && !/Sign in/.test(threw), threw);

  script(ok(framed([slots(7, { 0: 'er', 1: 'somethingelse', 2: 9, 6: 'generic' })])));
  threw = '';
  try { await ctx.gwModels({ at: 'T', hl: 'en' }); } catch (e) { threw = e.message; }
  check('a frame that is not the usual kind is named in the description', /other markers: er/.test(threw), threw);

  /* -------------------------------------------------------------- the frames */
  console.log('\nthe reply frames: Google lengths them rather than delimiting them');
  const cand = [['rc-1', ['Hello'], null, null, null, null, null, null, [2]]];
  const one = genPart('Hello');
  check('a framed reply is split into its frames', ctx.gwFrames(one).length === 1, j(ctx.gwFrames(one).length));
  check('the anti-XSSI prefix is dropped', !j(ctx.gwFrames(one)).includes(")]}'"));
  check('a frame is parsed into its parts', Array.isArray(ctx.gwFrames(one)[0]));
  check('two frames both come back', ctx.gwFrames(")]}'\n\n" + (() => { const a = JSON.stringify(['a']), b = JSON.stringify(['b']); return `${a.length}\n${a}\n\n${b.length}\n${b}`; })()).length === 2);

  // The length is in UTF-16 units, so a character outside the basic plane counts as two —
  // which is exactly what a JavaScript string index counts, so the slicing needs no fix-up.
  const emoji = JSON.stringify([['\u{1F600} hi']]);
  check('an emoji does not throw the length counting off', ctx.gwFrames(`)]}'\n\n${emoji.length}\n${emoji}`).length === 1);
  check('frames survive being fed the whole reply at once', ctx.gwFrames(genPart('x')).length === 1);
  check('rubbish in the middle does not lose the good frames', ctx.gwFrames(")]}'\n\n5\n{oops" + genPart('good').slice(5)).length === 1);

  // The declared count is a hint, not a boundary. Whatever it counts — bytes, UTF-16 units, with
  // or without the newline — a frame must be cut where its brackets close, or one miscount on
  // non-ASCII text loses every frame after it. These are the shapes that would break a slicer.
  const arabic = JSON.stringify([['wrb.fr', 'rpc', JSON.stringify(['الإجابة الصحيحة هي ب', 'ثانيا'])]]);
  const second = JSON.stringify([['di', 42]]);
  const inBytes = `)]}'\n\n${Buffer.byteLength(arabic)}\n${arabic}\n${Buffer.byteLength(second)}\n${second}`;
  check('a count made in bytes (larger than the characters) does not cut the next frame off',
    ctx.gwFrames(inBytes).length === 2 && ctx.gwFrames(inBytes)[1][0] === 'di', j(ctx.gwFrames(inBytes).map(p => p[0])));
  check('and the Arabic text itself arrives intact',
    JSON.parse(ctx.gwFrames(inBytes)[0][2])[0] === 'الإجابة الصحيحة هي ب');

  const tooSmall = `)]}'\n\n3\n${second}\n\n3\n${second}`;
  check('a count that is too small does not truncate a frame', ctx.gwFrames(tooSmall).length === 2, j(ctx.gwFrames(tooSmall).length));
  const tooBig = `)]}'\n\n9999\n${second}\n\n9999\n${second}`;
  check('a count that is too big does not swallow the next frame', ctx.gwFrames(tooBig).length === 2, j(ctx.gwFrames(tooBig).length));
  check('no count at all is fine: a bare list is a frame', ctx.gwFrames(`)]}'${second}`).length === 1);

  const spread = '[\n  ["wrb.fr",\n   "rpc",\n   "x"]\n,\n  ["di", 1]\n]';
  check('a frame spread over several lines is one frame', ctx.gwFrames(`)]}'\n\n40\n${spread}`).length === 2, j(ctx.gwFrames(`)]}'\n\n40\n${spread}`).length));

  // A bracket or a quote inside a string must not be mistaken for structure.
  const tricky = JSON.stringify([['a]b[c', 'say "hi" ] now', 'back\\slash"', ']']]);
  check('brackets and escaped quotes inside strings do not end a frame early',
    j(ctx.gwFrames(`)]}'\n\n9\n${tricky}`)) === j([['a]b[c', 'say "hi" ] now', 'back\\slash"', ']']]), j(ctx.gwFrames(`)]}'\n\n9\n${tricky}`)));

  const half = `)]}'\n\n${second.length}\n${second}\n\n500\n[["wrb.fr","rpc","cut off here`;
  check('a reply cut off mid-frame keeps the frames before it', ctx.gwFrames(half).length === 1, j(ctx.gwFrames(half).length));
  check('leading whitespace before the guard is tolerated', ctx.gwFrames(`\n  ${one}`).length === 1);
  check('a page that is not data yields no frames rather than throwing', ctx.gwFrames('<html><body>sign in</body></html>').length === 0);

  /* ------------------------------------------------------------- the request body */
  console.log('\nthe request: an 81-slot body, and a header that names the model');
  script(ok(genPart('the answer')));
  const model = { id: 'id-flash', name: 'gemini-flash', label: 'Flash', number: 1, capacity: 1, capacityField: 12 };
  let out = await ctx.gwGenerate({ at: 'TOKEN', hl: 'en', bl: 'b', sid: 's' }, { prompt: 'Q?', model });
  const gen = sent.find(c => c.url.includes('StreamGenerate'));
  check('the generation call goes to the site\'s own endpoint', !!gen);
  check('the model is named in the header, not the address', gen.headers['x-goog-ext-525001261-jspb'].includes('"id-flash"') && !gen.url.includes('id-flash'), gen.headers['x-goog-ext-525001261-jspb']);
  check('the two companion headers the site requires go too', gen.headers['x-goog-ext-73010989-jspb'] === '[0]' && gen.headers['x-goog-ext-73010990-jspb'] === '[0,0,0]');
  check('it is sent as a form, with the token', /application\/x-www-form-urlencoded/.test(gen.headers['content-type']) && atOf(gen) === 'TOKEN');
  check('it declares the same origin, which a page request is entitled to', gen.headers['x-same-domain'] === '1');
  check('the per-request session header is present', typeof gen.headers['x-goog-ext-525005358-jspb'] === 'string');

  const inner = JSON.parse(reqOf(gen)[1]);
  check('the body is 81 slots wide', inner.length === 81, String(inner.length));
  check('slot 0 is the prompt, as a block of its own', Array.isArray(inner[0]) && inner[0][0] === 'Q?', j(inner[0]));
  check('streaming is asked for', inner[7] === 1);
  check('the model number is mirrored into slot 79', inner[79] === 1, String(inner[79]));
  check('an unnamed thinking level is the standard one', inner[80] === 1, String(inner[80]));
  check('the slots the site leaves empty are left empty', inner.filter(x => x === null).length > 50, String(inner.filter(x => x === null).length));
  check('the conversation metadata is the site\'s own empty shape', j(inner[2]) === j(['', '', '', null, null, null, null, null, null, '']), j(inner[2]));

  // Continuing a conversation names the last turn's three ids in the first three places of that
  // same slot, and changes nothing else. Anything that is not three real ids starts a new one.
  script(ok(genPart('x')));
  await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, chat: ['c_1', 'r_1', 'rc_1'] });
  const innerChat = JSON.parse(reqOf(sent.find(c => c.url.includes('StreamGenerate')))[1]);
  check('a continued conversation names its three ids and keeps the rest of the shape',
    j(innerChat[2]) === j(['c_1', 'r_1', 'rc_1', null, null, null, null, null, null, '']), j(innerChat[2]));
  check('and the prompt, model and thinking slots are untouched by it',
    innerChat[0][0] === 'Q?' && innerChat[79] === 1 && innerChat[80] === 1);

  for (const [why, bad] of [
    ['a missing id', ['c_1', '', 'rc_1']],
    ['too few ids', ['c_1', 'r_1']],
    ['ids that are not strings', [1, 2, 3]],
    ['something that is not a list', 'c_1'],
    ['nothing at all', null],
  ]) {
    script(ok(genPart('x')));
    await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, chat: bad });
    const got = JSON.parse(reqOf(sent.find(c => c.url.includes('StreamGenerate')))[1])[2];
    check(`${why} starts a new conversation rather than naming one the site would not know`,
      j(got) === j(['', '', '', null, null, null, null, null, null, '']), j(got));
  }

  // The site numbers its thinking levels out of order — medium is 4, high is 2 — so the words
  // are mapped here rather than passed straight through.
  for (const [level, wire, where] of [['low', 1, 'low'], ['medium', 4, 'medium'], ['high', 2, 'extended']]) {
    script(ok(genPart('x')));
    await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, thinking: level });
    const g = sent.find(c => c.url.includes('StreamGenerate'));
    check(`${where} thinking is ${wire} in slot 80 and the header`,
      JSON.parse(reqOf(g)[1])[80] === wire && g.headers['x-goog-ext-525001261-jspb'].includes(`,${wire},`),
      g.headers['x-goog-ext-525001261-jspb']);
  }

  script(ok(genPart('x')));
  await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, thinking: 'HIGH' });
  check('a level is read whatever case it arrives in',
    JSON.parse(reqOf(sent.find(c => c.url.includes('StreamGenerate')))[1])[80] === 2);

  script(ok(genPart('x')));
  await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, thinking: 'nonsense' });
  check('an unknown level is the standard one, not a broken request',
    JSON.parse(reqOf(sent.find(c => c.url.includes('StreamGenerate')))[1])[80] === 1);

  script(ok(genPart('x')));
  await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model: null });
  const gen3 = sent.find(c => c.url.includes('StreamGenerate'));
  check('with no model chosen, no model header is sent at all — the site picks', !gen3.headers['x-goog-ext-525001261-jspb']);
  check('and no model number is claimed in the body', JSON.parse(reqOf(gen3)[1])[79] === 1);

  script(ok(genPart('x')));
  await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q?', model, fileData: [[['https://x/y'], 'input_1.jpg']] });
  const gen4 = sent.find(c => c.url.includes('StreamGenerate'));
  check('an attached picture is referenced by its address', j(JSON.parse(reqOf(gen4)[1])[0][3]) === j([[['https://x/y'], 'input_1.jpg']]), j(JSON.parse(reqOf(gen4)[1])[0][3]));

  /* ------------------------------------------------------------- reading the answer */
  console.log('\nreading the answer out of a stream of frames');
  script(ok(genPart('final answer here')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('the answer text is taken from the candidate', out.text === 'final answer here', out.text);
  check('a finished turn is marked done', out.done === true);
  check('the conversation ids come back for reference', out.cid === 'r-1' && out.rid === 'rid-1' && out.rcid === 'rc-1', j([out.cid, out.rid, out.rcid]));

  // The block is cumulative: each frame repeats the whole text so far, so the last one wins.
  script(ok(genPart('partial') + genPart('the whole thing').slice(6)));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('a later frame replaces an earlier one rather than being appended to it', out.text === 'the whole thing', out.text);

  script(ok(genPart('thinking out loud', { 37: [['my reasoning']] })));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('the model\'s reasoning is read, on its own', out.thoughts === 'my reasoning', out.thoughts);
  check('and is not mixed into the answer', out.text === 'thinking out loud', out.text);

  script(ok(genPart('https://googleusercontent.com/card_content/1 gone')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('the placeholder link the site leaves for an attachment is not passed on as text', !/googleusercontent/.test(out.text), out.text);

  script(ok(errPart(1037)));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('the allowance being used up is read as an error code, not as an empty answer', out.code === 1037, String(out.code));

  // The site reports a refusal either as a bare code or as a BardErrorInfo block, and only the
  // block covers the versions that keep it somewhere other than slot 5.
  script(ok(bardErrPart(1037)));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('a refusal sent as a BardErrorInfo block is read too', out.code === 1037, String(out.code));

  // A block that names itself but carries no number is still a refusal, and must not surface
  // as the meaningless "error -1".
  script(ok(framed([slots(7, { 0: 'wrb.fr', 2: JSON.stringify(['BardErrorInfo']), 6: 'generic' })])));
  const noCode = await ask({ type: 'gw-generate', session: { at: 'T', hl: 'en' }, prompt: 'Q', model });
  check('a refusal with no code is described, not numbered', /refused the question/.test(noCode.failure || ''), noCode.failure);

  // A reply where the answer is streamed as numbered fields instead of candidates.
  script(ok(streamPart('streamed answer')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('an answer sent as numbered fields rather than candidates is still read',
    out.text === 'streamed answer', out.text);

  // Reasoning is usually its own field, but some replies weave it into the text between two
  // control characters, where it has to be cut out rather than left in the answer.
  script(ok(genPart('the answer<ctrl94>thoughtweighing it up<ctrl95>')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('reasoning woven into the text is separated out', out.thoughts === 'weighing it up', out.thoughts);
  check('and what is left is the answer alone', out.text === 'the answer', out.text);

  script(ok(genPart('before<ctrl94>thoughtmid-thought')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('a reply cut off mid-thought still yields the part before it', out.text === 'before', out.text);
  check('and the unfinished thought is not thrown away', out.thoughts === 'mid-thought', out.thoughts);

  script(ok(genPart('no markers here at all')));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('an answer with no markers is passed through untouched', out.text === 'no markers here at all' && out.thoughts === '', j({ t: out.text, th: out.thoughts }));

  script(fail_(429, 'rate limited'));
  out = await ctx.gwGenerate({ at: 'T', hl: 'en' }, { prompt: 'Q', model });
  check('an HTTP refusal is handed back with its status', out.ok === false && out.status === 429, j({ ok: out.ok, status: out.status }));

  /* --------------------------------------------------- what the worker asks for */
  console.log('\nthe messages the service worker sends, and what comes back');
  script(ok(PAGE()));
  let r = await ask({ type: 'gw-ping' });
  check('a ping is answered, which is how a usable tab is found', r.ok === true, j(r));

  script(ok(PAGE()));
  r = await ask({ type: 'gw-init' });
  check('the session is handed back from a message', r.ok && r.session.at === 'TOKEN-abc', j(r.session));

  script(ok(statusReply(MODELS)));
  r = await ask({ type: 'gw-models', session: { at: 'T', hl: 'en' } });
  check('the model list is handed back from a message', r.ok && r.models.length === 2, j((r.models || []).length));

  script(ok(genPart('an answer')));
  r = await ask({ type: 'gw-generate', session: { at: 'T', hl: 'en' }, prompt: 'Q', model });
  check('a question is answered through a message', r.ok && r.text === 'an answer', r.text);

  // The site's error codes get turned into words here, so a person is told what to do.
  for (const [code, want] of [
    [1037, /allowance/],
    [1013, /temporary/],
    [1052, /model/],
    [1060, /blocked/],
    [1050, /matches/],
  ]) {
    script(ok(errPart(code)));
    r = await ask({ type: 'gw-generate', session: { at: 'T', hl: 'en' }, prompt: 'Q', model });
    check(`error ${code} comes back as something a person can act on`, r.ok === true && want.test(r.failure || ''), r.failure);
    // The number travels with the words: the worker decides from it whether a fresh conversation
    // could help (a deleted one can; an empty allowance cannot).
    check(`and error ${code} carries its number as well`, r.code === code, String(r.code));
  }

  script(ok(errPart(9999)));
  r = await ask({ type: 'gw-generate', session: { at: 'T', hl: 'en' }, prompt: 'Q', model });
  check('an error code nobody knows is still reported, with the number', /9999/.test(r.failure || ''), r.failure);

  r = await ask({ type: 'gw-nonsense' });
  check('an unknown message is refused rather than silently ignored', r.ok === false, j(r));

  script(fail_(500, 'boom'));
  r = await ask({ type: 'gw-generate', session: { at: 'T', hl: 'en' }, prompt: 'Q', model });
  check('a failure inside the page comes back as a failed reply, not a thrown error', r.ok === false && r.status === 500, j({ ok: r.ok, status: r.status }));

  r = await ask({ type: 'gw-init' });
  check('and a thrown error is caught and reported, not left to reject', r.ok === false && /HTTP 500/.test(r.detail || ''), r.detail);

  /* ------------------------------------------------------------- the field reader */
  console.log('\nreading a field out of a JSPB array');
  check('a field in its own slot is read', ctx.gwField(['a', 'b', 'c'], 1) === 'b');
  check('a missing field gives the fallback', ctx.gwField(['a'], 5, 'none') === 'none');
  check('a sparse field is found in the trailing dict by number + 1', ctx.gwField(['a', null, { '87': 'deep' }], 86) === 'deep');
  check('an empty array is treated as absent', ctx.gwField(['a', []], 1, 'none') === 'none');
  check('a path walks lists and keys alike', ctx.gwPath({ a: [{ b: 'c' }] }, ['a', 0, 'b']) === 'c');
  check('a path that runs out gives the fallback, not an error', ctx.gwPath({ a: 1 }, ['a', 'b', 'c'], 'none') === 'none');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
