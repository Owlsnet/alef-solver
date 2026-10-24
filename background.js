/* Alef Solver — service worker.
 *
 * Owns the API key and every network call. The content script never sees the
 * key; it sends a scraped question here and gets back an answer index.
 */

const API = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const DEFAULTS = {
  provider: 'openrouter',          // 'openrouter' | 'gemini' | 'openai': which service answers
  apiKey: '',
  model: 'deepseek/deepseek-v4.1-flash',
  fallbackModel: '',
  geminiKey: '',                   // a key from Google AI Studio; used only when provider is 'gemini'
  geminiModel: 'gemini-2.5-flash',
  geminiFallbackModel: '',
  openaiKey: '',                   // an API key from platform.openai.com (not a ChatGPT login); used only when provider is 'openai'
  openaiModel: 'gpt-5-mini',
  openaiFallbackModel: '',
  autoSubmit: true,
  openPassage: true,
  screenshot: 'auto', // 'auto' | 'always' | 'never'
  answerDelay: 120,
};

async function settings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

/* --------------------------------------------------------------- prompt */

const SYSTEM = [
  'You are taking a multiple-choice exam. You are shown the question stem, the',
  'answer choices, and usually a reading passage or a figure.',
  '',
  'Pick the single best answer. Read the passage carefully before deciding —',
  'most questions are comprehension questions whose answer is directly supported',
  'by the text. Do not pick an answer just because it sounds plausible; check it',
  'against the passage. If a figure or diagram is shown as an image, read the',
  'image and answer from what it actually shows.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences, no explanation',
  'outside the object:',
  '{"answer":"<letter>","index":<zero-based index of the chosen choice>,"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
].join('\n');

const MULTI_SYSTEM = [
  'You are taking an exam question that says "Select the correct answers": MORE THAN ONE of the',
  'choices may be correct (sometimes only one, never none). You are shown the question, the',
  'choices, and sometimes a passage or a figure.',
  '',
  'Judge every choice on its own, against the question, and list ALL the ones that are correct.',
  'Do not stop at the first one you find. Several choices can say the same thing in different',
  'notation (an interval and a set written with a condition, equivalent fractions, a formula and',
  'its expanded form): all of those are correct. Near-copies are wrong for a small reason: a bracket',
  'open where it should be closed, "<" for "≤", a flipped sign, a rounded value that is off.',
  'For a calculation, work the answer out first, then compare each choice with your result.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"answers":["<letter>","<letter>"],"indices":[<zero-based index>,<zero-based index>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'Every correct choice exactly once, in order; "answers" and "indices" must name the same choices.',
].join('\n');

const CLOZE_SYSTEM = [
  'You are completing a fill-in-the-blank exercise. You are given the full text',
  'with each gap marked [BLANK 1], [BLANK 2] and so on, plus the instructions and',
  'usually a Word Bank of permitted answers.',
  '',
  'Fill every blank. The single most common mistake is choosing the right word in',
  'the wrong form: "increase" and "increased" both appear in the bank and both fit',
  'the meaning, but only one fits the grammar of that gap. Read the words on each',
  'side of the gap to decide the part of speech and tense. When a Word Bank is',
  'given, prefer an exact entry from it.',
  '',
  'Use the figures or data in the instructions to decide the direction and size of',
  'each change — do not answer from the passage alone if numbers are provided.',
  '',
  'A blank can be a math answer box (the exercise then says so). Answer it with the',
  'math itself, typed as plain text: x^2 for a power, sqrt(x) for a root, (a)/(b) for a',
  'fraction, pi, <= and >=. No $ signs, no backslashes, no words, no units unless the',
  'box asks for them. For a polynomial, write the whole expression the box stands for.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"blanks":["<answer for BLANK 1>","<answer for BLANK 2>"],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'One entry per blank, in order, with exactly as many entries as there are blanks.',
].join('\n');

const DROPDOWN_SYSTEM = [
  'You are completing a paragraph in which each gap is a drop-down menu. You are',
  'given the text with each menu marked [BLANK 1], [BLANK 2] and so on, the',
  'instructions, and the full list of options each menu offers.',
  '',
  'Choose exactly one option for every blank. Read the words on both sides of a',
  'gap: the option has to fit the grammar of the sentence (tense, part of speech,',
  'whether it joins two clauses or opens a sentence) as well as the meaning. Use',
  'any figures given to decide direction and size of a change. When two options',
  'look alike, the one that fits the sentence structure is the answer.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"picks":[<zero-based option index for BLANK 1>,<for BLANK 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'One integer per blank, in order, each counting from 0 within that blank\'s own list.',
].join('\n');

const MATCH_SYSTEM = [
  'You are completing a matching exercise. You are given the instructions, a LEFT',
  'list of items (often data: figures, dates, terms) and a RIGHT list of',
  'statements. Pair each LEFT item with the one RIGHT statement that describes it',
  'correctly.',
  '',
  'Work out the facts from the LEFT item first (for data, compute the change and',
  'its direction and size), then find the statement that says exactly that. Watch',
  'for near-misses: "rose by 14 points" is not "rose to 24%", and a small change',
  'is not a large one. Each RIGHT statement is used at most once.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"pairs":[<RIGHT number for LEFT 1>,<RIGHT number for LEFT 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'One integer per LEFT item, in order, using the RIGHT numbers exactly as listed,',
  'which count from 0.',
].join('\n');

const DRAG_SYSTEM = [
  'You are completing a drag-and-drop exercise. You are given a text with gaps',
  'marked [BLANK 1], [BLANK 2] and so on, and a list of items that can be dropped',
  'into them. There are usually MORE items than gaps: the extras are decoys that',
  'do not fit anywhere. Each item is used at most once.',
  '',
  'Pick the one item that completes each gap. Read both sides of the gap: the item',
  'has to fit the grammar (singular or plural, noun or verb) as well as the meaning.',
  'Check that the finished sentence reads naturally and says something sensible.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"fills":[<item number for BLANK 1>,<item number for BLANK 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'One integer per gap, in order, using the item numbers exactly as listed, which',
  'count from 0. Never repeat a number.',
].join('\n');

const SORT_SYSTEM = [
  'You are completing an ordering exercise. You are given an instruction and a list of',
  'items, numbered from 0 in the order they are shown now. Put them in the right order:',
  'the order events happen, steps are done, a conversation goes, sizes grow, dates fall.',
  '',
  'Some items may describe audio you cannot hear. Use the wording and common sense to',
  'give the most likely order; a guess is better than no answer. A question usually',
  'comes before its answer, and a greeting before the rest.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"order":[<number of the item that comes FIRST>,<number of the SECOND>,...],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'Every item exactly once, using the numbers exactly as listed, which count from 0.',
].join('\n');

/** The question as the page shows it, plus — on a retry — what the page already
 *  marked wrong. Without that, the same input at temperature 0 gives the same
 *  wrong answer and Try Again only wastes a click. */
function buildText(p) {
  const text = buildQuestionText(p);
  const tried = (p.tried || []).map(t => String(t?.label ?? '').trim()).filter(Boolean);
  if (!tried.length) return text;
  return [
    text, '',
    '=== PREVIOUS ATTEMPTS ===',
    'The page marked these answers to this exact question WRONG. Do not repeat any of them;',
    'reconsider the question and give a different answer.',
    ...tried.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');
}

function buildQuestionText(p) {
  const lines = [];

  if (p.kind === 'sort') {
    if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');
    lines.push('=== INSTRUCTIONS ===', p.sort?.intro || p.stem || '', '');
    lines.push(`=== ITEMS (${(p.sort?.items || []).length}), in the order they are shown now ===`);
    (p.sort?.items || []).forEach((t, i) => lines.push(`${i}. ${t}`));
    return lines.join('\n');
  }

  if (p.kind === 'drag') {
    if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');
    lines.push('=== INSTRUCTIONS ===', p.drag?.intro || '', '');
    lines.push('=== TEXT ===', p.drag?.text || p.stem || '(no text found)', '');
    lines.push(`=== ITEMS (${p.drag?.blanks ?? '?'} gap(s), ${(p.drag?.items || []).length} items) ===`);
    (p.drag?.items || []).forEach((t, i) => lines.push(`${i}. ${t}`));
    return lines.join('\n');
  }

  if (p.kind === 'match') {
    if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');
    lines.push('=== INSTRUCTIONS ===', p.match?.intro || p.stem || '', '');
    lines.push('=== LEFT ===');
    (p.match?.left || []).forEach((t, i) => lines.push(`LEFT ${i + 1}: ${t}`));
    lines.push('', '=== RIGHT ===');
    (p.match?.right || []).forEach((t, i) => lines.push(`${i}. ${t}`));
    return lines.join('\n');
  }

  if (p.kind === 'dropdown') {
    if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');
    lines.push('=== EXERCISE ===', p.dropdown?.text || p.stem || '(no text found)', '');
    lines.push('=== OPTIONS FOR EACH BLANK ===');
    (p.dropdown?.menus || []).forEach((opts, i) => {
      lines.push(`BLANK ${i + 1}:`);
      opts.forEach((o, j) => lines.push(`  ${j}. ${o}`));
    });
    return lines.join('\n');
  }

  if (p.kind === 'cloze') {
    if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');
    lines.push('=== EXERCISE ===',
                p.cloze?.text || p.stem || '(no text found)', '');
    if (p.cloze?.wordBank?.length) {
      lines.push('=== WORD BANK ===', p.cloze.wordBank.join('\n'), '');
    }
    lines.push(`=== NOTE === There are ${p.cloze?.blanks?.length ?? 0} blank(s).`);
    const mathAt = (p.cloze?.blanks || []).map((b, i) => (b && b.math ? i + 1 : 0)).filter(Boolean);
    if (mathAt.length) {
      lines.push(`=== MATH === BLANK ${mathAt.join(', ')} ${mathAt.length > 1 ? 'are math answer boxes' : 'is a math answer box'}: ` +
                 'write the answer as plain typed math (x^2, sqrt(x), (a)/(b)), nothing else.');
    }
    return lines.join('\n');
  }

  if (p.passage) lines.push('=== PASSAGE ===', p.passage, '', '');

  // Some questions keep their real text where the page's own text does not reach (a picture, say), and the
  // only "question" found is the instruction line itself. Say so, rather than let it pass for the question.
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
  const onlyInstruction = !!p.multi && !!p.instruction && squash(p.stem) === squash(p.instruction);
  lines.push('=== QUESTION ===',
    onlyInstruction ? '(The page\'s text holds no question, only the instruction below. If a picture is attached, the question is in it.)'
                    : (p.stem || '(no question text found)'), '');

  if (p.multi && p.instruction) lines.push('=== INSTRUCTION ===', p.instruction, '');
  // The page was seen to take only so many ticks (it does not say how many, and ignores the rest).
  if (p.multi && p.maxPicks) {
    lines.push('=== LIMIT ===',
      `The page accepts at most ${p.maxPicks} ticked choices. Give exactly ${p.maxPicks}: the ${p.maxPicks} that are most clearly correct.`, '');
  } else if (p.multi && p.minPicks) {
    // ...or kept Submit switched off until enough were ticked.
    lines.push('=== LIMIT ===',
      `The page keeps Submit switched off until at least ${p.minPicks} choices are ticked. Give at least ${p.minPicks}: the ${p.minPicks} that are most clearly correct, and more only if you are sure of them.`, '');
  }

  if (p.options?.length) {
    lines.push(p.multi ? '=== CHOICES (more than one may be correct) ===' : '=== CHOICES ===');
    p.options.forEach((o, i) => lines.push(`${'ABCDEFGHIJ'[i]}. ${o.text}`));
    lines.push('');
  }
  const count = p.imageCount ?? p.images?.length ?? 0;
  if (count) {
    // Say what the model can actually see. Claiming an image is attached when it
    // isn't invites a confident answer about a figure nobody showed it.
    lines.push(p.image || p.images?.length
      ? `=== NOTE === The page contains ${count} image(s) (a figure, diagram or graph the question may ` +
        `refer to). The attached image shows the page as displayed.`
      : `=== NOTE === The page contains ${count} image(s) that could NOT be attached. If the question ` +
        `depends on a figure you cannot see, answer from the text as best you can.`);
  }
  return lines.join('\n');
}

function buildBody(cfg, p) {
  const content = [{ type: 'text', text: buildText(p) }];

  // Attach the stitched page screenshot when the content script sent one.
  if (p.image) {
    content.push({ type: 'image_url', image_url: { url: p.image } });
  }
  // Plus any standalone images the question references — as data only. A plain
  // URL is fetched by the provider, without the user's login, and a site that
  // needs one answers 401, which fails the whole request.
  for (const src of p.images || []) {
    if (typeof src === 'string' && src.startsWith('data:')) {
      content.push({ type: 'image_url', image_url: { url: src } });
    }
  }

  return {
    messages: [
      { role: 'system', content: p.kind === 'cloze' ? CLOZE_SYSTEM
                               : p.kind === 'dropdown' ? DROPDOWN_SYSTEM
                               : p.kind === 'match' ? MATCH_SYSTEM
                               : p.kind === 'drag' ? DRAG_SYSTEM
                               : p.kind === 'sort' ? SORT_SYSTEM
                               : p.multi ? MULTI_SYSTEM : SYSTEM },
      { role: 'user', content },
    ],
    // Deterministic the first time. After a wrong answer some spread helps: it
    // keeps a model that ignores the "do not repeat" note from repeating itself.
    temperature: (p.tried || []).some(t => t?.label) ? 0.4 : 0,
    max_tokens: MAX_TOKENS,
  };
}

/* ---------------------------------------------------------------- Gemini */

// The prompts are built once, in the chat shape every provider takes (a system message and a
// user message of text and picture parts). Gemini's own API wants the same content laid out
// differently, so it is converted here, at the last moment, and nowhere else.

/** The address for one model. `models/gemini-2.5-flash` and `gemini-2.5-flash` are the same
 *  model: the list Google returns uses the first spelling. The key is NOT in the address — it
 *  goes in a header, so it cannot end up in a log or an error message. */
function geminiUrl(model) {
  return `${GEMINI_API}/models/${encodeURIComponent(String(model).trim().replace(/^models\//, ''))}:generateContent`;
}

/** A chat-shaped request as a Gemini `generateContent` body. Pictures must arrive as data
 *  (a screenshot): Gemini cannot fetch a link on the page's behalf either. */
function toGemini(body, structured) {
  const [system, user] = body.messages;
  const parts = [];
  for (const c of user.content) {
    if (c.type === 'text') { parts.push({ text: c.text }); continue; }
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(c.image_url?.url || '');
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  return {
    systemInstruction: { parts: [{ text: system.content }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens,
      ...(structured ? { responseMimeType: 'application/json' } : {}),
    },
  };
}

/** The chat-shaped request for OpenAI's own API. It takes the same messages, but the newer models
 *  want the limit called max_completion_tokens, and the reasoning ones (gpt-5…, o1…) accept no
 *  temperature at all. `opts` can undo either, for a model that turns out to want it the old way. */
function toOpenAI(body, model, structured, opts = {}) {
  const { max_tokens, temperature, ...rest } = body;
  const req = { ...rest, model };
  req[opts.legacyTokens ? 'max_tokens' : 'max_completion_tokens'] = max_tokens;
  if (!opts.noTemperature && !/^(?:o\d|gpt-5)/i.test(String(model).trim())) req.temperature = temperature;
  if (structured) req.response_format = { type: 'json_object' };
  if (opts.lowEffort && /^(?:o\d|gpt-5)/i.test(String(model).trim())) req.reasoning_effort = 'low';
  return req;
}

// How a service says the model it was asked for cannot take a picture. Not matched: a failure to
// FETCH a picture ("Received 401 status code when fetching image from URL"), which says nothing
// about the model.
const NO_VISION = /(?:support|supports|supported|enabled)[^.]{0,40}image (?:input|modality)|image (?:input|modality)[^.]{0,40}(?:not|n't) (?:supported|enabled|available)|(?:not|n't) support[^.]{0,25}(?:image|vision)|image_url[^.]{0,40}only supported by certain models|no endpoints found that support image/i;

// Why Gemini may return no text at all: it refused. Asking again with more room will not help.
const GEMINI_BLOCKS = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY|RECITATION|LANGUAGE|OTHER)$/;

/** Gemini's reply as the three things the caller reads: the text, why it stopped (MAX_TOKENS is
 *  said as "length", as the others say it), and — when it declined — the reason. */
function fromGemini(json) {
  const cand = json?.candidates?.[0];
  const raw = (cand?.content?.parts || []).filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text).join('');
  const reason = cand?.finishReason || '';
  const refused = json?.promptFeedback?.blockReason || (!raw.trim() && GEMINI_BLOCKS.test(reason) ? reason : '');
  return {
    raw,
    finish: reason === 'MAX_TOKENS' ? 'length' : reason,
    blocked: refused,
    tokens: json?.usageMetadata?.candidatesTokenCount,
  };
}

// Room for a reasoning model to think. Its thinking counts against this limit,
// so the old 300–400 was enough for an easy question and, on a hard one, was
// used up before a single character of the answer — an empty reply, and a
// stopped lesson. The answer itself is a line of JSON; unused room costs nothing.
const MAX_TOKENS = 1500;
const RETRY_TOKENS = 4000;

/* --------------------------------------------------------------- parsing */

/** Parse a fill-in-the-blank reply: an array of words, one per blank. */
function parseCloze(raw, expected) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const grab = obj => {
    const arr = Array.isArray(obj.blanks) ? obj.blanks
              : Array.isArray(obj.answers) ? obj.answers
              : null;
    if (!arr) return null;
    const words = arr.map(v => String(v ?? '').trim()).filter(Boolean);
    if (!words.length) return null;
    if (expected != null && words.length !== expected) {
      return { words, confidence: obj.confidence ?? null, why: obj.why || '',
               mismatch: `model gave ${words.length}, page has ${expected}` };
    }
    return { words, confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
             why: typeof obj.why === 'string' ? obj.why : '' };
  };

  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { const r = grab(JSON.parse(text.slice(s, e + 1))); if (r) return r; } catch { /* fall through */ }
  }
  // A bare JSON array is also acceptable.
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a !== -1 && b > a) {
    try {
      const words = JSON.parse(text.slice(a, b + 1)).map(v => String(v ?? '').trim()).filter(Boolean);
      if (words.length) return { words, confidence: null, why: 'bare array' };
    } catch { /* fall through */ }
  }
  return null;
}

/** Parse a drop-down reply: one option index per menu. An entry may be a number,
 *  a numeric string, or the option's own text; each is checked against that
 *  menu's list, so a pick can never point past the end of it. */
function parsePicks(raw, menus) {
  if (!raw) return null;
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;

  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return null; }
  const arr = Array.isArray(obj.picks) ? obj.picks : Array.isArray(obj.answers) ? obj.answers : null;
  if (!arr || !arr.length) return null;

  const picks = [];
  for (const [i, v] of arr.entries()) {
    const options = menus?.[i] || [];
    let idx = -1;
    if (typeof v === 'number' && Number.isInteger(v)) idx = v;
    else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) idx = Number(v);
    else if (typeof v === 'string') idx = options.findIndex(o => o.trim().toLowerCase() === v.trim().toLowerCase());
    if (idx < 0 || idx >= options.length) return null;
    picks.push(idx);
  }
  return {
    picks,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    why: typeof obj.why === 'string' ? obj.why : '',
  };
}

/** Parse a matching reply: for each left item, the index of its right item. It
 *  has to be a clean one-to-one pairing — a repeated or out-of-range number is
 *  rejected, never repaired, because a repaired answer is a guess. */
function parsePairs(raw, leftCount, rightCount) {
  if (!raw) return null;
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;

  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return null; }
  // "fills" is the drag-and-drop spelling of the same thing: one distinct index per slot.
  // "order" is the ordering-question spelling: the item that goes in each place.
  const key = Array.isArray(obj.pairs) ? 'pairs' : Array.isArray(obj.fills) ? 'fills' : Array.isArray(obj.order) ? 'order'
            : Array.isArray(obj.answers) ? 'answers' : null;
  const arr = key ? obj[key] : null;
  if (!arr || !arr.length) return null;

  const pairs = arr.map(v => (typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN)));
  if (pairs.some(v => !Number.isInteger(v) || v < 0 || (rightCount != null && v >= rightCount))) return null;
  if (new Set(pairs).size !== pairs.length) return null;
  if (leftCount != null && pairs.length !== leftCount) return null;

  return {
    pairs,
    fills: pairs,           // same list, named for drag-and-drop callers
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    why: typeof obj.why === 'string' ? obj.why : '',
  };
}

/** Parse a "select all that apply" reply: the set of choices to tick. Letters win over numbers
 *  when the two disagree (a letter is read off the choice itself; a zero-based number is where a
 *  model slips by one). Anything out of range, repeated, or unreadable is rejected, never repaired:
 *  a repaired answer is a guess. */
function parseMulti(raw, count, max, min) {
  if (!raw) return null;
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;

  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return null; }

  const okIndex = i => Number.isInteger(i) && i >= 0 && (count == null || i < count);
  const unique = xs => new Set(xs).size === xs.length;

  let fromLetters = null;
  if (Array.isArray(obj.answers) && obj.answers.length) {
    const ls = obj.answers.map(v => (typeof v === 'string' && /^\s*[A-J]\s*$/i.test(v) ? 'ABCDEFGHIJ'.indexOf(v.trim().toUpperCase()) : NaN));
    if (ls.every(okIndex) && unique(ls)) fromLetters = ls;
  }
  let fromNumbers = null;
  if (Array.isArray(obj.indices) && obj.indices.length) {
    const ns = obj.indices.map(v => (typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN)));
    if (ns.every(okIndex) && unique(ns)) fromNumbers = ns;
  }

  const picked = fromLetters || fromNumbers;
  if (!picked) return null;
  if (max && picked.length > max) return null;      // the page will not take more than this many ticks
  if (min && picked.length < min) return null;      // and keeps Submit off until it has this many
  const agree = !fromLetters || !fromNumbers || [...fromLetters].sort().join() === [...fromNumbers].sort().join();
  return {
    indices: [...picked].sort((a, b) => a - b),
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    why: (typeof obj.why === 'string' ? obj.why : '') + (agree ? '' : ' [letters and numbers disagreed: used the letters]'),
  };
}

function parseAnswer(raw) {
  if (!raw) return null;
  let text = String(raw).trim();

  // strip ```json fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // first JSON object in the string
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1));
      const out = {
        index: Number.isInteger(j.index) ? j.index : null,
        letter: typeof j.answer === 'string' ? j.answer.trim().toUpperCase().slice(0, 1) : null,
        confidence: typeof j.confidence === 'number' ? j.confidence : null,
        why: typeof j.why === 'string' ? j.why : '',
      };
      if (out.index === null && out.letter) {
        const i = 'ABCDEFGHIJ'.indexOf(out.letter);
        if (i >= 0) out.index = i;
      }
      if (out.index !== null) return out;
    } catch { /* fall through to regex */ }
  }

  // regex fallback: a bare letter, or "answer is C"
  const m = text.match(/\b(?:answer|choice|option)\b[^A-J]{0,20}\b([A-J])\b/i) ||
            text.match(/^\(?([A-J])\)?[.):]?\s*$/i);
  if (m) {
    const i = 'ABCDEFGHIJ'.indexOf(m[1].toUpperCase());
    if (i >= 0) return { index: i, letter: m[1].toUpperCase(), confidence: null, why: 'regex fallback' };
  }
  return null;
}

/* ------------------------------------------------------------- the call */

async function ask(payload) {
  const cfg = await settings();
  const gemini = cfg.provider === 'gemini';
  const openai = cfg.provider === 'openai';
  if (gemini ? !cfg.geminiKey : openai ? !cfg.openaiKey : !cfg.apiKey) {
    return { error: gemini ? 'No Gemini API key set — open the extension Options and paste one.'
                  : openai ? 'No OpenAI API key set — open the extension Options and paste one.'
                  : 'No API key set — open the extension Options and paste one.' };
  }

  // A model box saved empty means "the default", not "no model to ask".
  const chain = (gemini ? [cfg.geminiModel || DEFAULTS.geminiModel, cfg.geminiFallbackModel]
               : openai ? [cfg.openaiModel || DEFAULTS.openaiModel, cfg.openaiFallbackModel]
               : [cfg.model, cfg.fallbackModel]).filter(Boolean);
  const oa = {};                 // OpenAI only: what a model has turned out not to accept (see toOpenAI)
  let body = buildBody(cfg, payload);
  let imageDropped = false;
  const errors = [];
  const hasImages = b => b.messages[1].content.some(c => c.type === 'image_url');
  const blind = new Set();       // models that said they cannot read a picture

  const post = (model, structured) => {
    if (gemini) {
      return fetch(geminiUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
        body: JSON.stringify(toGemini(body, structured)),
      });
    }
    if (openai) {
      return fetch(OPENAI_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toOpenAI(body, model, structured, { ...oa, lowEffort: !!thinking })),
      });
    }
    const reqBody = { ...body, model };
    if (structured) reqBody.response_format = { type: 'json_object' };
    // OpenRouter's own settings; a model with no thinking to adjust ignores them.
    if (thinking === 'off') reqBody.reasoning = { enabled: false };
    else if (thinking === 'low') reqBody.reasoning = { effort: 'low' };
    return fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://moe.alefed.com',
        'X-Title': 'Alef Solver',
      },
      body: JSON.stringify(reqBody),
    });
  };

  let tokensRaised = false;
  // After a reply cut off while the model was still thinking: what to ask of its thinking on the retry —
  // 'off' first (a model that can think or not, answers straight away), 'low' if the service refuses that.
  let thinking = '';
  const NUDGE = '\n\nThis is a retry: the earlier reply ran out of room before it gave an answer. Do not deliberate at length. Reply now with the JSON object only.';
  // The body as the retry sends it: more room, and the nudge. Kept when the body has to be rebuilt (a picture
  // dropped), or the retry would silently go back to the small budget it just ran out of.
  const forRetry = b => {
    const user = b.messages[1];
    return {
      ...b,
      max_tokens: RETRY_TOKENS,
      messages: [b.messages[0], { ...user, content: user.content.map((c, i) => (i === 0 && c.type === 'text' ? { ...c, text: c.text + NUDGE } : c)) }],
    };
  };
  const rebuilt = extra => { const b = buildBody(cfg, { ...payload, ...extra }); return tokensRaised ? forRetry(b) : b; };

  /** One round trip. Resolves { parsed } on success, or { error, then } where
   *  `then` says what the caller should do next: 'network' (give up on this
   *  model), 'format' (retry without response_format), 'model' (try the next
   *  model), 'again' (try the next way of asking this one) or 'stop' (give up
   *  altogether: the key is refused, and every model would be). */
  const attempt = async (model, structured) => {
    let res;
    try {
      res = await post(model, structured);
    } catch (e) {
      return { error: `${model}: ${e}`, then: 'network' };   // network is down, another model won't help
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);

      // Google says a wrong key as a plain 400, and a key that may not use this model as a 403:
      // another model or another way of asking will be refused the same way, so stop here and
      // say what to check.
      if (gemini && (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(detail))) {
        return { error: `${model}: Gemini refused the request (HTTP ${res.status}) — check the key in Options. ${detail.slice(0, 160)}`, then: 'stop' };
      }

      // OpenAI says a wrong key as a 401. Every model would be refused the same way: stop, and say what to check.
      if (openai && (res.status === 401 || /invalid_api_key|Incorrect API key/i.test(detail))) {
        return { error: `${model}: OpenAI refused the key (HTTP ${res.status}) — check it in Options. ${detail.slice(0, 160)}`, then: 'stop' };
      }

      // OpenRouter was told to switch thinking off and the model will not have it (some think whether asked
      // or not): ask for less of it instead.
      if (!gemini && !openai && thinking === 'off' && res.status === 400 && /reasoning/i.test(detail)) {
        thinking = 'low';
        errors.push(`${model}: cannot switch thinking off — asked for less of it`);
        return attempt(model, structured);
      }

      // The newer OpenAI models take no temperature and call the limit max_completion_tokens; older ones
      // want max_tokens. The first answer is a 400 naming the thing; ask again the other way, once each.
      if (openai && res.status === 400 && /temperature/i.test(detail) && !oa.noTemperature) {
        oa.noTemperature = true;
        errors.push(`${model}: takes no temperature — asked without`);
        return attempt(model, structured);
      }
      if (openai && res.status === 400 && /max_completion_tokens/i.test(detail) && !oa.legacyTokens) {
        oa.legacyTokens = true;
        errors.push(`${model}: takes max_tokens, not max_completion_tokens — asked that way`);
        return attempt(model, structured);
      }

      // A model that cannot read pictures at all says so — OpenRouter as a 404 ("No endpoints found
      // that support image input"), others as a 400. That is a fact about the model, not about this
      // picture: the next model may well read it, so it is tried next, picture and all. Only when
      // none can does the question go out without it (below).
      if (hasImages(body) && NO_VISION.test(detail)) {
        blind.add(model);
        return { error: `${model}: cannot read pictures (HTTP ${res.status})`, then: 'model' };
      }

      // A picture the provider can't fetch or read — a 401 on an image URL, an
      // unsupported format — must not cost the answer. Send the same request
      // without any images; the prompt then says the figure couldn't be attached.
      if (res.status === 400 && /image/i.test(detail) && hasImages(body)) {
        errors.push(`${model}: dropped the images (${detail.slice(0, 90)})`);
        body = rebuilt({ image: null, images: [] });
        imageDropped = true;
        return attempt(model, structured);
      }
      return {
        error: `${model}${structured ? ' [json]' : ''}: HTTP ${res.status} ${detail}`,
        then: structured && res.status === 400 ? 'format' : 'model',
      };
    }

    const json = await res.json().catch(() => null);
    let raw, finish, tokens, blocked = '';
    if (gemini) {
      ({ raw, finish, tokens, blocked } = fromGemini(json));
    } else {
      const choice = json?.choices?.[0];
      raw = choice?.message?.content ?? '';
      finish = choice?.finish_reason || choice?.native_finish_reason || '';
      tokens = json?.usage?.completion_tokens;
      if (!raw && choice?.message?.refusal) blocked = 'refusal';      // the model declined: asking again will not help
    }

    const parsed = payload.kind === 'cloze' ? parseCloze(raw, payload.cloze?.blanks?.length)
      : payload.kind === 'dropdown' ? parsePicks(raw, payload.dropdown?.menus)
      : payload.kind === 'match' ? parsePairs(raw, payload.match?.left?.length, payload.match?.right?.length)
      : payload.kind === 'drag' ? parsePairs(raw, payload.drag?.blanks, payload.drag?.items?.length)
      : payload.kind === 'sort' ? parsePairs(raw, payload.sort?.items?.length, payload.sort?.items?.length)
      : payload.multi ? parseMulti(raw, payload.options?.length, payload.maxPicks, payload.minPicks)
      : parseAnswer(raw);

    if (parsed) {
      return { parsed: { ...parsed, model, raw: raw.slice(0, 300), ...(imageDropped ? { imageDropped: true } : {}) } };
    }

    // An empty answer from a model that reasons usually means it spent the whole
    // token budget thinking and was cut off (finish_reason "length"). Give it
    // room and ask once more, rather than failing a question it could answer.
    if (!tokensRaised && !blocked && (finish === 'length' || !String(raw).trim())) {
      tokensRaised = true;
      thinking = 'off';
      body = forRetry(body);
      errors.push(`${model}: empty reply (finish_reason=${finish || 'none'}) — retried with ${RETRY_TOKENS} tokens, no extended thinking, and told to answer at once`);
      return attempt(model, structured);
    }

    return {
      error: `${model}: unparseable reply ${JSON.stringify(String(raw).slice(0, 120))} ` +
             `(finish_reason=${finish || 'none'}${blocked ? `, refused=${blocked}` : ''}, completion_tokens=${tokens ?? '?'}, ` +
             `max_tokens=${body.max_tokens})`,
      // A refusal is the same however it is asked; so is a model that ran out of room twice with its
      // thinking — plain mode instead of JSON mode would only spend it again.
      then: blocked || (tokensRaised && finish === 'length') ? 'model' : 'again',
    };
  };

  /** Every model in turn. Resolves the parsed answer, 'stop' (the key is refused: no model will do
   *  better), or null when none of them answered. */
  const runChain = async () => {
    for (const model of chain) {
      // Try structured output first, then plain — some models reject response_format.
      for (const structured of [true, false]) {
        const r = await attempt(model, structured);
        if (r.parsed) return r.parsed;
        errors.push(r.error);
        if (r.then === 'stop') return 'stop';
        if (r.then === 'network' || r.then === 'model') break;   // next model
        // 'format' and 'again': the next way of asking this model
      }
    }
    return null;
  };

  let got = await runChain();

  // Not one model on the list could read the picture. A guess from the words is better than a
  // stopped lesson, so ask once more without it — and say so in the answer (imageDropped), so
  // the person can pick a model that sees pictures.
  if (!got && blind.size && hasImages(body)) {
    errors.push('no model on the list can read pictures — asking again without the picture');
    body = rebuilt({ image: null, images: [] });
    imageDropped = true;
    got = await runChain();
  }

  if (got && got !== 'stop') return got;
  return { error: errors.join(' | ') || 'unknown failure' };
}

/* ------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ask') {
    ask(msg.payload)
      .then(respond)
      .catch(e => respond({ error: String(e) }));
    return true;
  }

  if (msg.type === 'capture') {
    const windowId = sender.tab?.windowId;
    if (windowId == null) { respond({ error: 'no window for capture' }); return true; }
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })
      .then(dataUrl => respond({ dataUrl }))
      .catch(e => respond({ error: String(e) }));
    return true;
  }

  // A frame saw the shortcut for an action. Send it to every frame of the tab, so the
  // one that actually holds the question does the work. The page script of an older
  // version sends no action; it only ever meant "solve".
  if (msg.type === 'hotkey') {
    const tabId = sender.tab?.id;
    const type = HOTKEY_MESSAGES[msg.action ?? 'solve'];
    if (tabId != null && type) {
      chrome.tabs.sendMessage(tabId, { type }, () => void chrome.runtime.lastError);
    }
    respond({ ok: true });
    return true;
  }
});

// What each shortcut asks the frames to do. The shortcuts themselves are set in
// Options and matched in the page: the browser's own extension-shortcut slots take
// only Ctrl/Alt combinations, and none of them reach a key pressed inside a page.
const HOTKEY_MESSAGES = { solve: 'do-solve', lesson: 'do-lesson', stop: 'do-stop', dump: 'do-dump' };
