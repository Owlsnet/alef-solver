#!/usr/bin/env node
/* Tests the model-facing half of background.js: how replies are parsed and how
   the prompt is built. Runs the real file in a sandbox with a stubbed `chrome`,
   so it needs no browser and no API call.

   The other suites stub the model, so without this the parsers — and the
   function the drop-down path depends on — are never exercised at all. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// The model call is faked per test: assign fetchImpl before calling ctx.ask().
let fetchImpl = async () => { throw new Error('no network in tests'); };
const ctx = vm.createContext({
  console,
  fetch: (...a) => fetchImpl(...a),
  chrome: {
    runtime: { onMessage: { addListener() { } } },
    storage: { local: { get: async () => ({ apiKey: 'test-key' }) } },
  },
});
vm.runInContext(SRC, ctx, { filename: 'background.js' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
// Results come out of another realm; compare by value, not by identity.
const j = v => JSON.stringify(v);

const MENUS = [
  ['exceeded', 'matched', 'trailed'],
  ['whereas', 'so that', 'unless'],
  ['Overall', 'However', 'For instance'],
];

console.log('parsePicks is defined');
check('parsePicks exists', typeof ctx.parsePicks === 'function');
if (typeof ctx.parsePicks !== 'function') { console.log('\n✗ cannot continue\n'); process.exit(1); }

console.log('\nparsePicks: well-formed replies');
let r = ctx.parsePicks('{"picks":[0,2,1],"confidence":0.9,"why":"fits"}', MENUS);
check('plain JSON', j(r?.picks) === '[0,2,1]', j(r));
check('keeps confidence and why', r?.confidence === 0.9 && r?.why === 'fits');
r = ctx.parsePicks('```json\n{"picks":[1,1,1]}\n```', MENUS);
check('markdown fence stripped', j(r?.picks) === '[1,1,1]', j(r));
r = ctx.parsePicks('Sure! Here you go: {"picks":[2,0,0],"confidence":1} Hope that helps.', MENUS);
check('prose around the object tolerated', j(r?.picks) === '[2,0,0]', j(r));
r = ctx.parsePicks('{"answers":[0,0,0]}', MENUS);
check('"answers" accepted as an alias', j(r?.picks) === '[0,0,0]', j(r));

console.log('\nparsePicks: entries that are not plain integers');
r = ctx.parsePicks('{"picks":["exceeded"," WHEREAS ","overall"]}', MENUS);
check('option text matched case-insensitively', j(r?.picks) === '[0,0,0]', j(r));
r = ctx.parsePicks('{"picks":["1","2","0"]}', MENUS);
check('numeric strings accepted', j(r?.picks) === '[1,2,0]', j(r));

console.log('\nparsePicks: replies that must be rejected, not guessed at');
check('index past the end of its own menu', ctx.parsePicks('{"picks":[0,3,0]}', MENUS) === null);
check('negative index', ctx.parsePicks('{"picks":[0,-1,0]}', MENUS) === null);
check('index valid for another menu but not this one',
  ctx.parsePicks('{"picks":[0,0,0]}', [['a'], ['b'], []]) === null);
check('fractional index', ctx.parsePicks('{"picks":[0.5,0,0]}', MENUS) === null);
check('text that is not an option', ctx.parsePicks('{"picks":["exceeded","nope","Overall"]}', MENUS) === null);
check('a multiple-choice style reply', ctx.parsePicks('{"answer":"B","index":1}', MENUS) === null);
check('empty picks', ctx.parsePicks('{"picks":[]}', MENUS) === null);
check('not JSON at all', ctx.parsePicks('I think the answers are 1, 2 and 3', MENUS) === null);
check('empty reply', ctx.parsePicks('', MENUS) === null);
check('missing menus', ctx.parsePicks('{"picks":[0]}', undefined) === null);

console.log('\nparsePicks: wrong count is passed through for the caller to refuse');
r = ctx.parsePicks('{"picks":[0,0]}', MENUS);
check('two picks for three menus come back as two', j(r?.picks) === '[0,0]', j(r));

console.log('\nprompt building for a drop-down question');
const payload = {
  kind: 'dropdown', passage: '', stem: '', images: [], options: [],
  dropdown: { text: 'Technology rose [BLANK 1] tourism. [BLANK 2] , it led.', menus: MENUS },
};
const text = ctx.buildText(payload);
check('sentence with markers is in the prompt', /\[BLANK 1\] tourism/.test(text));
check('every menu is listed, numbered from 0',
  /BLANK 1:\s+0\. exceeded\s+1\. matched\s+2\. trailed/.test(text) &&
  /BLANK 3:\s+0\. Overall\s+1\. However\s+2\. For instance/.test(text), text.slice(-120).replace(/\n/g, ' | '));

const body = ctx.buildBody({}, payload);
check('uses the drop-down system prompt', /drop-down/.test(body.messages[0].content) && /"picks"/.test(body.messages[0].content));
check('drop-down leaves room for a reasoning model to think', body.max_tokens >= 1000, `${body.max_tokens}`);

const mc = ctx.buildBody({}, { kind: 'choice', stem: 'Q?', options: [{ text: 'a' }, { text: 'b' }], images: [] });
check('multiple choice still uses its own prompt', /multiple-choice/.test(mc.messages[0].content), `max_tokens=${mc.max_tokens}`);
// 300 was the old limit. A reasoning model's thinking counts against it, and on
// a hard question it was used up before any answer: an empty reply, a stopped lesson.
check('multiple choice leaves room for a reasoning model to think', mc.max_tokens >= 1000, `${mc.max_tokens}`);

const cz = ctx.buildBody({}, { kind: 'cloze', cloze: { text: 'x [BLANK 1]', blanks: [{}], wordBank: [] }, images: [] });
check('cloze still uses its own prompt', /fill-in-the-blank/.test(cz.messages[0].content), `max_tokens=${cz.max_tokens}`);

console.log('\nparsePairs (matching)');
check('parsePairs exists', typeof ctx.parsePairs === 'function');
if (typeof ctx.parsePairs === 'function') {
  r = ctx.parsePairs('{"pairs":[4,2,3,1,0],"confidence":0.8,"why":"computed changes"}', 5, 5);
  check('a clean pairing', j(r?.pairs) === '[4,2,3,1,0]' && r?.confidence === 0.8, j(r));
  r = ctx.parsePairs('```json\n{"pairs":["4","2","3","1","0"]}\n```', 5, 5);
  check('fence stripped and numeric strings accepted', j(r?.pairs) === '[4,2,3,1,0]', j(r));
  r = ctx.parsePairs('{"pairs":[1,0]}', 2, 4);
  check('fewer left items than right sentences is fine', j(r?.pairs) === '[1,0]', j(r));
  check('a repeated sentence is rejected, not repaired', ctx.parsePairs('{"pairs":[0,0,1,2,3]}', 5, 5) === null);
  check('a number past the last sentence is rejected', ctx.parsePairs('{"pairs":[0,1,2,3,5]}', 5, 5) === null);
  check('a negative number is rejected', ctx.parsePairs('{"pairs":[0,1,2,3,-1]}', 5, 5) === null);
  check('a fractional number is rejected', ctx.parsePairs('{"pairs":[0,1,2,3,1.5]}', 5, 5) === null);
  check('the wrong count is rejected', ctx.parsePairs('{"pairs":[0,1,2]}', 5, 5) === null);
  check('words instead of numbers are rejected', ctx.parsePairs('{"pairs":["a","b"]}', 2, 2) === null);
  check('another question type\'s reply is rejected', ctx.parsePairs('{"picks":[0,1]}', 2, 2) === null);
  check('not JSON', ctx.parsePairs('1 -> 5, 2 -> 3', 2, 2) === null);
}

console.log('\nprompt building for a matching question');
const mp = {
  kind: 'match', passage: '', stem: '', images: [], options: [],
  match: { intro: 'Match each set of figures with the sentence.', left: ['A: 20% → 16%', 'B: 10% → 24%'], right: ['Fell by 4 points.', 'Rose by 14 points.'] },
};
const mt = ctx.buildText(mp);
check('instructions, both columns and 0-based right numbers are in the prompt',
  /Match each set of figures/.test(mt) && /LEFT 1: A: 20% → 16%/.test(mt) && /LEFT 2: B: 10% → 24%/.test(mt) &&
  /0\. Fell by 4 points\./.test(mt) && /1\. Rose by 14 points\./.test(mt), mt.replace(/\n/g, ' | ').slice(0, 200));
const mb = ctx.buildBody({}, mp);
check('uses the matching system prompt', /matching exercise/.test(mb.messages[0].content) && /"pairs"/.test(mb.messages[0].content));
check('matching leaves room for a reasoning model to think', mb.max_tokens >= 1000, `${mb.max_tokens}`);

console.log('\ndrag-and-drop replies ("fills")');
r = ctx.parsePairs('{"fills":[1,5,3],"confidence":0.8,"why":"fits"}', 3, 6);
check('three gaps, six items: a clean answer', j(r?.fills) === '[1,5,3]' && j(r?.pairs) === '[1,5,3]', j(r));
check('more gaps than the model answered is rejected', ctx.parsePairs('{"fills":[1,5]}', 3, 6) === null);
check('an item used twice is rejected', ctx.parsePairs('{"fills":[1,1,3]}', 3, 6) === null);
check('an item number past the tray is rejected', ctx.parsePairs('{"fills":[1,5,6]}', 3, 6) === null);

console.log('\nprompt building for a drag-and-drop question');
const dp = {
  kind: 'drag', passage: '', stem: '', images: [], options: [],
  drag: { intro: 'Drag each item to the correct place.', text: 'Rising [BLANK 1] create pressure.', items: ['quantity', 'tuition fees', 'hire'], blanks: 1 },
};
const dt = ctx.buildText(dp);
check('instructions, the text with markers and every item numbered from 0 are in the prompt',
  /Drag each item/.test(dt) && /Rising \[BLANK 1\] create pressure/.test(dt) &&
  /0\. quantity/.test(dt) && /1\. tuition fees/.test(dt) && /2\. hire/.test(dt) && /1 gap\(s\), 3 items/.test(dt), dt.replace(/\n/g, ' | ').slice(0, 160));
const db = ctx.buildBody({}, dp);
check('uses the drag-and-drop system prompt, which warns about decoys',
  /drag-and-drop/.test(db.messages[0].content) && /decoys/.test(db.messages[0].content) && /"fills"/.test(db.messages[0].content));

console.log('\nother parsers still behave (regression)');
r = ctx.parseCloze('{"blanks":["increased","decreased"],"confidence":0.8}', 2);
check('parseCloze reads a normal reply', j(r?.words) === '["increased","decreased"]', j(r));
r = ctx.parseAnswer('{"answer":"B","index":1,"confidence":0.7,"why":"x"}');
check('parseAnswer reads a normal reply', r?.index === 1 && r?.letter === 'B', j(r));

/* ------------------------------------------------------------------ images */

const DATA = 'data:image/jpeg;base64,AAAA';
const URL_IMG = 'https://files.example.com/v2/files/00000000-0000-0000-0000-000000000000';
const imageParts = b => b.messages[1].content.filter(c => c.type === 'image_url').map(c => c.image_url.url);
const mcq = extra => ({ kind: 'choice', stem: 'What warning?', options: [{ text: 'a' }, { text: 'b' }], ...extra });

console.log('\nimages: a plain URL is never sent to the provider');
let b = ctx.buildBody({}, mcq({ images: [URL_IMG, DATA], image: null, imageCount: 2 }));
check('a data image is attached', imageParts(b).includes(DATA));
check('a plain URL is NOT attached', !imageParts(b).some(u => u.startsWith('http')), JSON.stringify(imageParts(b)));
b = ctx.buildBody({}, mcq({ images: [URL_IMG], image: DATA, imageCount: 1 }));
check('the screenshot is attached when there is one', JSON.stringify(imageParts(b)) === JSON.stringify([DATA]));

console.log('\nimages: the model is told the truth about what it can see');
let t = ctx.buildText(mcq({ images: [], image: DATA, imageCount: 1 }));
check('with a screenshot: says the attached image shows the page', /attached image shows the page/.test(t) && !/could NOT/.test(t));
t = ctx.buildText(mcq({ images: [], image: null, imageCount: 1 }));
check('without one: says the image could NOT be attached', /could NOT be attached/.test(t));
t = ctx.buildText(mcq({ images: [], image: null, imageCount: 0 }));
check('no images on the page: no image note at all', !/image/i.test(t.split('=== CHOICES ===')[0].replace(/What warning\?/, '')) && !/NOTE/.test(t));

console.log('\nmath answer boxes');
const mathQ = { kind: 'cloze', images: [], stem: '', cloze: { text: 'Complete f(x) = [BLANK 1] − 6x + 8', wordBank: [], blanks: [{ math: true }] } };
const mathT = ctx.buildText(mathQ);
check('a math blank is called out, and the answer is to be plain typed math', /BLANK 1 is a math answer box/.test(mathT) && /x\^2/.test(mathT), mathT.replace(/\n/g, ' | '));
check('two of them say so in the plural', /BLANK 1, 2 are math answer boxes/.test(ctx.buildText({ ...mathQ, cloze: { ...mathQ.cloze, blanks: [{ math: true }, { math: true }] } })));
check('an ordinary blank gets no such note', !/math answer box/.test(ctx.buildText({ ...mathQ, cloze: { ...mathQ.cloze, blanks: [{ math: false }] } })));
check('the prompt says how to write math: x^2, sqrt(x), (a)/(b), no backslashes', /x\^2 for a power/.test(ctx.buildBody({}, mathQ).messages[0].content) && /no backslashes/.test(ctx.buildBody({}, mathQ).messages[0].content));
check('and an answer like "3x^2" comes back from the model\'s JSON as it was written', j(ctx.parseCloze('{"blanks":["3x^2"],"confidence":0.8}', 1)?.words) === '["3x^2"]', j(ctx.parseCloze('{"blanks":["3x^2"],"confidence":0.8}', 1)));

console.log('\nordering questions');
const sp = { kind: 'sort', images: [], sort: { intro: 'Put these in the order they happen. Arrange the items in the correct order.', items: ['b item', 'a item', 'c item'] } };
const st = ctx.buildText(sp);
check('the instruction and every item are in the prompt, numbered from 0 in the order shown',
  /Put these in the order they happen/.test(st) && /0\. b item\s+1\. a item\s+2\. c item/.test(st), st.replace(/\n/g, ' | '));
const sb = ctx.buildBody({}, sp);
check('uses the ordering prompt, which asks for {"order": [...]}', /ordering exercise/.test(sb.messages[0].content) && /"order"/.test(sb.messages[0].content));
check('and tells the model to guess about audio it cannot hear, rather than refuse', /cannot hear/.test(sb.messages[0].content) && /guess/.test(sb.messages[0].content));
check('ordering leaves room for a reasoning model to think', sb.max_tokens >= 1000, `${sb.max_tokens}`);
r = ctx.parsePairs('{"order":[1,0,2],"confidence":0.7,"why":"question first"}', 3, 3);
check('an order reply is read', j(r?.pairs) === '[1,0,2]' && r?.confidence === 0.7 && r?.why === 'question first', j(r));
check('and handed back as pairs (what the page script uses)', j(r?.fills) === '[1,0,2]');
check('a reply that repeats an item is refused', ctx.parsePairs('{"order":[1,1,2]}', 3, 3) === null);
check('one that leaves an item out is refused', ctx.parsePairs('{"order":[1,0]}', 3, 3) === null);
check('one that names an item that is not there is refused', ctx.parsePairs('{"order":[0,1,3]}', 3, 3) === null);
check('numbers as text are accepted', j(ctx.parsePairs('{"order":["2","0","1"]}', 3, 3)?.pairs) === '[2,0,1]');
const stTried = ctx.buildText({ ...sp, tried: [{ label: 'b item → a item → c item' }] });
check('a retry lists the order that was marked wrong', /PREVIOUS ATTEMPTS/.test(stTried) && /b item → a item → c item/.test(stTried));

console.log('\nretries: the model is told what was already marked wrong');
const tried = [{ label: 'A. a' }, { label: 'B. b' }];
const kinds = {
  choice: mcq({ images: [], image: null, imageCount: 0 }),
  cloze: { kind: 'cloze', images: [], cloze: { text: 'x [BLANK 1]', blanks: [{}], wordBank: ['p', 'q'] } },
  dropdown: { kind: 'dropdown', images: [], dropdown: { text: 'x [BLANK 1]', menus: [['p', 'q']] } },
  match: { kind: 'match', images: [], match: { intro: 'match', left: ['l1'], right: ['r1'] } },
  drag: { kind: 'drag', images: [], drag: { intro: 'drag', text: 'x [BLANK 1]', items: ['p', 'q'], blanks: 1 } },
};
for (const [kind, base] of Object.entries(kinds)) {
  const plain = ctx.buildText(base);
  const again = ctx.buildText({ ...base, tried });
  check(`${kind}: a first attempt has no attempts section`, !/PREVIOUS ATTEMPTS/.test(plain) && !/WRONG/.test(plain));
  check(`${kind}: a retry lists every wrong answer and says they were wrong`,
    /PREVIOUS ATTEMPTS/.test(again) && /A\. a/.test(again) && /B\. b/.test(again) && /WRONG/.test(again) && /not repeat/i.test(again),
    again.slice(-170).replace(/\n/g, ' | '));
  check(`${kind}: the original question text is still there, unchanged`, again.startsWith(plain));
  check(`${kind}: a first attempt is deterministic, a retry is not`,
    ctx.buildBody({}, base).temperature === 0 && ctx.buildBody({}, { ...base, tried }).temperature > 0,
    `${ctx.buildBody({}, base).temperature} / ${ctx.buildBody({}, { ...base, tried }).temperature}`);
}
check('an empty list is not a retry', !/PREVIOUS ATTEMPTS/.test(ctx.buildText({ ...kinds.choice, tried: [] })) &&
  ctx.buildBody({}, { ...kinds.choice, tried: [] }).temperature === 0);

console.log('\n"select the correct answers": several choices may be right');
const mq = { kind: 'choice', multi: true, instruction: 'Select the correct answers.', stem: 'Solve 2x^2 + 3x − 8 ≥ 0', images: [], image: null, imageCount: 0,
  options: [{ text: '{x| −2 ≤ x ≤ 0.5}' }, { text: '(−∞, −2.89] ∪ [1.39, ∞)' }, { text: '(−2.89, 1.39)' }, { text: '{x| x ≤ −2.89 or x ≥ 1.39}' }] };
const mqt = ctx.buildText(mq);
check('the question carries its instruction and says more than one choice may be correct',
  /=== INSTRUCTION ===\s+Select the correct answers\./.test(mqt) && /more than one may be correct/.test(mqt), mqt.replace(/\n/g, ' | ').slice(0, 220));
check('every choice is lettered, formulas as text', /A\. \{x\| −2 ≤ x ≤ 0\.5\}/.test(mqt) && /B\. \(−∞, −2\.89\] ∪ \[1\.39, ∞\)/.test(mqt) && /D\. /.test(mqt));
const mqb = ctx.buildBody({}, mq);
check('uses the tick-all prompt, which asks for every correct choice and names equivalent forms',
  /MORE THAN ONE/.test(mqb.messages[0].content) && /"indices"/.test(mqb.messages[0].content) && /same thing in different/.test(mqb.messages[0].content));
check('a single-answer question keeps the single-answer prompt', /single best answer/.test(ctx.buildBody({}, { ...mq, multi: false }).messages[0].content));
check('and gets no such heading', !/more than one may be correct/.test(ctx.buildText({ ...mq, multi: false })) && !/INSTRUCTION/.test(ctx.buildText({ ...mq, multi: false })));
check('a retry lists both choices that were marked wrong together', /B\. .* \+ D\. /.test(ctx.buildText({ ...mq, tried: [{ label: 'B. x + D. y' }] })));

r = ctx.parseMulti('{"answers":["B","D"],"indices":[1,3],"confidence":0.9,"why":"same set"}', 4);
check('a normal reply: both choices, in order', j(r?.indices) === '[1,3]' && r?.confidence === 0.9 && r?.why === 'same set', j(r));
check('letters alone are enough', j(ctx.parseMulti('{"answers":["d","b"]}', 4)?.indices) === '[1,3]');
check('numbers alone are enough', j(ctx.parseMulti('{"indices":[3,1]}', 4)?.indices) === '[1,3]');
check('numbers as text are accepted', j(ctx.parseMulti('{"indices":["0","2"]}', 4)?.indices) === '[0,2]');
check('one correct choice is a fine answer', j(ctx.parseMulti('{"answers":["C"],"indices":[2]}', 4)?.indices) === '[2]');
check('a markdown fence is stripped', j(ctx.parseMulti('```json\n{"answers":["A"],"indices":[0]}\n```', 4)?.indices) === '[0]');
r = ctx.parseMulti('{"answers":["B","D"],"indices":[0,2]}', 4);
check('when letters and numbers disagree the letters win, and it says so', j(r?.indices) === '[1,3]' && /disagreed/.test(r?.why || ''), j(r));
check('numbers that are off the end are refused', ctx.parseMulti('{"indices":[1,4]}', 4) === null);
check('a letter that is not a choice is refused', ctx.parseMulti('{"answers":["B","F"]}', 4) === null);
check('a repeated choice is refused, not repaired', ctx.parseMulti('{"answers":["B","B"]}', 4) === null && ctx.parseMulti('{"indices":[2,2]}', 4) === null);
check('an empty list is refused', ctx.parseMulti('{"answers":[],"indices":[]}', 4) === null);
check('negative and fractional numbers are refused', ctx.parseMulti('{"indices":[-1,1]}', 4) === null && ctx.parseMulti('{"indices":[0.5]}', 4) === null);
check('prose is refused', ctx.parseMulti('B and D are correct.', 4) === null && ctx.parseMulti('', 4) === null && ctx.parseMulti(null, 4) === null);
check('if one list is unusable the other is used', j(ctx.parseMulti('{"answers":["B","Z"],"indices":[1,3]}', 4)?.indices) === '[1,3]');

(async () => {
  console.log('\nimages: a rejected image must not cost the answer (the failure from the real run)');
  const bodies = [];
  fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (imageParts(body).length) {
      return { ok: false, status: 400, json: async () => ({}), text: async () =>
        `{"error":{"message":"Received 401 status code when fetching image from URL: ${URL_IMG}","code":400}}` };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({
      choices: [{ message: { content: '{"answer":"B","index":1,"confidence":0.8,"why":"stated in text"}' } }] }) };
  };
  let res = await ctx.ask(mcq({ images: [], image: DATA, imageCount: 1 }));
  check('still got an answer', res && res.index === 1 && !res.error, j(res));
  check('retried exactly once more, without any image', bodies.length === 2 && imageParts(bodies[1]).length === 0, `${bodies.length} calls`);
  check('the retry told the model the figure could not be attached', /could NOT be attached/.test(bodies[1].messages[1].content[0].text));
  check('and the result says images were dropped', res && res.imageDropped === true);

  console.log('\nimages: other 400s are not mistaken for an image problem');
  const seen = [];
  fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: false, status: 400, json: async () => ({}), text: async () => '{"error":{"message":"Bad request: temperature out of range"}}' };
  };
  res = await ctx.ask(mcq({ images: [], image: DATA, imageCount: 1 }));
  check('fails with the provider\'s message', !!res.error && /temperature/.test(res.error), (res.error || '').slice(0, 90));
  check('never stripped the image for an unrelated error', seen.every(x => imageParts(x).length === 1), `${seen.length} calls`);

  console.log('\nimages: a normal call is a single request');
  const ok = [];
  fetchImpl = async (url, init) => {
    ok.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({
      choices: [{ message: { content: '{"answer":"A","index":0,"confidence":0.9,"why":"x"}' } }] }) };
  };
  res = await ctx.ask(mcq({ images: [], image: DATA, imageCount: 1 }));
  check('one call, image kept, nothing dropped', ok.length === 1 && imageParts(ok[0]).length === 1 && !res.imageDropped);

  /* ------------------------------------------- an empty reply (the second real failure) */
  console.log('\nan empty reply from a model that spent its budget thinking');
  const sent = [];
  const reply = (content, finish, usage) => ({ ok: true, status: 200, text: async () => '',
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }], usage }) });

  // A tick-all question goes through the same call, parsed as a set of choices.
  fetchImpl = async () => reply('{"answers":["B","D"],"indices":[1,3],"confidence":0.8,"why":"same set"}', 'stop');
  res = await ctx.ask(mq);
  check('ask() on a tick-all question returns the set of choices', j(res?.indices) === '[1,3]' && !res.error, j(res));
  fetchImpl = async () => reply('{"answer":"B","index":1,"confidence":0.8,"why":"x"}', 'stop');
  res = await ctx.ask({ ...mq, multi: false });
  check('and on a single-answer question still returns one index', res?.index === 1 && !res.indices, j(res));

  // First call: cut off mid-thought, content empty. Second call (more room): answers.
  fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    return b.max_tokens >= 4000
      ? reply('{"answer":"C","index":2,"confidence":0.7,"why":"supported"}', 'stop')
      : reply('', 'length', { completion_tokens: b.max_tokens });
  };
  res = await ctx.ask(mcq({ images: [], image: null, imageCount: 0 }));
  check('got the answer after giving it more room', res && res.index === 2 && !res.error, j(res).slice(0, 120));
  check('the first request used the normal budget', sent[0].max_tokens >= 1000 && sent[0].max_tokens < 4000, `${sent[0].max_tokens}`);
  check('the retry used the larger one', sent.length === 2 && sent[1].max_tokens === 4000, `${sent.length} calls`);

  // A model that returns nothing no matter what: fail ONCE per way of asking, and say why.
  const calls = [];
  fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return reply('', 'length', { completion_tokens: 1500 }); };
  res = await ctx.ask(mcq({ images: [], image: null, imageCount: 0 }));
  check('gives up with a useful message, not a bare "unparseable reply"',
    !!res.error && /finish_reason=length/.test(res.error) && /completion_tokens=/.test(res.error), (res.error || '').slice(0, 160));
  check('only raised the budget once (no runaway retries)', calls.filter(c => c.max_tokens === 4000).length >= 1 && calls.length <= 4, `${calls.length} calls`);

  // An empty reply that is NOT a cut-off is still retried once, then reported.
  fetchImpl = async () => reply('', 'stop', { completion_tokens: 0 });
  res = await ctx.ask(mcq({ images: [], image: null, imageCount: 0 }));
  check('an empty reply with finish_reason=stop reports it', !!res.error && /finish_reason=stop/.test(res.error), (res.error || '').slice(0, 120));

  // A reply that is present but not an answer must NOT trigger the token bump.
  const junk = [];
  fetchImpl = async (url, init) => { junk.push(JSON.parse(init.body)); return reply('I am not sure.', 'stop', { completion_tokens: 5 }); };
  res = await ctx.ask(mcq({ images: [], image: null, imageCount: 0 }));
  check('prose that is not an answer fails without a pointless bigger retry',
    !!res.error && junk.every(c => c.max_tokens < 4000), `${junk.length} calls`);

  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e && e.stack || e); process.exit(1); });
