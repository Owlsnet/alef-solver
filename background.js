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
  deepseekToken: '',               // the DeepSeek chat page's own login token, copied out of the page; used only when provider is 'deepseek'
  deepseekModel: 'deepseek-chat',
  deepseekFallbackModel: '',
  deepseekThinking: false,         // DeepThink
  deepseekSearch: false,           // the site's own web search
  deepseekPowRound: null,          // which proof-of-work digest last answered: 1 (round 0 dropped) or 0
  geminiWebModel: '',              // '' is the account's own default model: no model header is sent at all
  geminiWebFallbackModel: '',
  geminiWebThinking: '',           // '' | 'low' | 'medium' | 'high' — the site's own thinking levels; '' is standard
  geminiWebModels: [],             // the models the site says this account may use, as discovered
  reuseChat: true,                 // DeepSeek and the Gemini site: keep one chat going instead of starting a new one per question
  speedCache: true,                // remember the Gemini session and model list between questions
  speedParallel: true,             // upload the picture while the model list is still being fetched
  autoSubmit: true,
  openPassage: true,
  screenshot: 'auto', // 'auto' | 'always' | 'never'
  answerDelay: 120,
};

const GW_THINKING_LEVELS = ['', 'low', 'medium', 'high'];

async function settings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = { ...DEFAULTS, ...s };
  // 0.6.30 and earlier saved this as a plain on/off switch. Extended thinking is what the site
  // now calls the "high" level, so an older `true` keeps meaning exactly what it meant before
  // rather than falling back to standard.
  if (out.geminiWebThinking === true) out.geminiWebThinking = 'high';
  if (!GW_THINKING_LEVELS.includes(out.geminiWebThinking)) out.geminiWebThinking = '';
  return out;
}

/** "Lessons per run" used to default to 5 and now defaults to 100. Options saves every box it
 *  shows, so anyone who ever pressed Save has the old default stored as if they had chosen it, and
 *  a new default alone would never reach them. Once, a stored 5 is taken for the old default and
 *  replaced; whatever is chosen after that is left alone, 5 included. */
async function migrateSettings() {
  try {
    const s = await chrome.storage.local.get(['maxLessons', 'lessonsDefault100']);
    if (s.lessonsDefault100) return;
    await chrome.storage.local.set(s.maxLessons === 5 ? { maxLessons: 100, lessonsDefault100: true } : { lessonsDefault100: true });
  } catch { /* tried again the next time the worker starts */ }
}
migrateSettings();

/* ------------------------------------------------------------- keeping one chat */

/* The two sites that have chats of their own (DeepSeek and the Gemini site) list every
 * conversation in a sidebar, so a new one per question buries the person's own chats under
 * hundreds of one-line threads. Each of them is therefore given a single thread that later
 * questions continue. What is kept is only the ids that let the site find that thread again.
 *
 * Two costs of this are handled rather than ignored. Earlier questions stay in the thread's
 * context, so it is retired after CHAT_MAX_TURNS and a new one started; and a thread can vanish
 * (deleted from the sidebar) or stop matching (another model, another account), in which case
 * the question is asked again in a fresh thread rather than failing. */
const CHAT_MAX_TURNS = 30;
const GW_CHAT_KEY = 'geminiWebChat';
const DS_CHAT_KEY = 'deepseekChat';

async function chatLoad(key) {
  try {
    const v = (await chrome.storage.local.get(key))?.[key];
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
async function chatSave(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); } catch { /* losing it only costs a new thread */ }
}
async function chatClear(key) {
  try { await chrome.storage.local.set({ [key]: null }); } catch { /* as above */ }
}

/* ------------------------------------------------------------------------- speed */

/* Where a question's time goes, recorded so a change can be judged by numbers rather
 * than by feel. Each provider adds the stages it has to `speedStages` as it goes; ask() below
 * stamps the total on and keeps a short log of the last answers, grouped in Options by which of
 * the speed switches were on, so "with" and "without" can be put side by side. */
let speedStages = {};
const SPEED_LOG_KEY = 'speedLog';
const SPEED_LOG_MAX = 60;

/** The switches that were on for this question: what a log entry is grouped by. */
function speedMode(cfg) {
  return { provider: cfg.provider || 'openrouter', cache: cfg.speedCache !== false, parallel: cfg.speedParallel !== false, shot: cfg.screenshot || 'auto' };
}

async function speedLogAdd(timing) {
  try {
    const cur = (await chrome.storage.local.get(SPEED_LOG_KEY))?.[SPEED_LOG_KEY];
    const log = Array.isArray(cur) ? cur : [];
    log.push({ at: Date.now(), ...timing });
    await chrome.storage.local.set({ [SPEED_LOG_KEY]: log.slice(-SPEED_LOG_MAX) });
  } catch { /* a missing log is only a missing statistic */ }
}

/** Whether a saved thread may be continued: it has room left, and every field in `match`
 *  (the model, the account) is still what it was when the thread was started. */
function chatUsable(chat, match) {
  return !!chat && Number.isInteger(chat.turns) && chat.turns > 0 && chat.turns < CHAT_MAX_TURNS
    && Object.entries(match).every(([k, v]) => chat[k] === v);
}

/* --------------------------------------------------------------- prompt */

/* --------------------------------------------------------------- subject guidance */

// Small, fast models (the Flash-Lite kind) answer much better when told what the course expects and
// what to watch for in that subject. Only the guidance for this lesson's subject is sent — a few lines,
// not all of it — so the prompt stays short. The subject comes from the class the page names; failing
// that, from the words of the question.

const EXAM_RULES = [
  'This is a lesson from the UAE Ministry of Education curriculum (the Alef platform). The right answer is',
  'the one the course teaches, in the textbook\'s own terms — not a loophole or a technicality.',
  'Read the whole question, and every choice, before answering. Watch for words that flip what is asked:',
  'NOT, EXCEPT, LEAST, FALSE, INCORRECT; in Arabic ليس، لا، عدا، غير، إلا، الخطأ، غير الصحيح. Rule the wrong',
  'choices out one by one; when two look right, the one that answers exactly what is asked wins.',
  'A typed answer is written in the language of the question (Arabic for an Arabic question).',
].join('\n');

const SUBJECT_TIPS = {
  math: [
    'Subject: mathematics. Work it out in "work": the rule or formula, the substitution, the result.',
    'Check the result (substitute it back, or estimate). Geometry: use the figure\'s labels and the theorem',
    'the lesson is about (midsegment, similar triangles, parallel lines and angle pairs, Pythagoras);',
    'angles on a line add to 180°, in a triangle to 180°. Keep exact values (fractions, sqrt, pi) unless told',
    'to round; follow the rounding asked for exactly.',
  ],
  physics: [
    'Subject: physics. In "work": list the known quantities with units, pick the formula, convert to SI',
    'units first (cm→m, g→kg, km/h→m/s, min→s), then calculate. Use g = 9.8 m/s² unless the question gives',
    'another value. Keep track of direction and sign for vectors. Give the unit the question asks for and',
    'round as instructed. For concept questions, answer from the law involved (Newton\'s laws, conservation',
    'of energy and momentum, Ohm\'s law, waves), not from everyday intuition.',
  ],
  chemistry: [
    'Subject: chemistry. In "work": write and balance the equation if there is one; moles = mass ÷ molar',
    'mass, use periodic-table atomic masses; keep units and significant figures. Use periodic trends',
    '(atomic radius falls across a period and rises down a group; ionisation energy and electronegativity',
    'the opposite), electron configurations (aufbau, Hund, Pauli), ion charges from the group, and IUPAC',
    'names. Ionic bonds: metal + non-metal; covalent: non-metals.',
  ],
  biology: [
    'Subject: biology. Answer with the textbook term and process (cells and organelles, genetics and',
    'Punnett squares, body systems, ecology and food chains, photosynthesis and respiration). For a',
    'genetics cross, work out the ratios in "work".',
  ],
  science: [
    'Subject: science. Answer from the scientific concept the lesson teaches, with the textbook\'s terms.',
    'For any calculation, show the formula and units in "work".',
  ],
  arabic: [
    'المادة: اللغة العربية. أجب وفق قواعد النحو والصرف والبلاغة كما تُدرَّس في المنهج: حدِّد موقع الكلمة',
    'الإعرابي (فاعل، مفعول به، مبتدأ، خبر، حال، تمييز…) وعلامة إعرابها، ونوع الأسلوب البلاغي (تشبيه، استعارة،',
    'كناية، طباق، جناس) والغرض منه. في أسئلة الفهم اعتمد على النص المعطى نفسه ومعنى الكلمة في سياقها.',
    'انقل الخيار أو الكلمة كما هي في الصفحة، بالتشكيل نفسه، ولا تترجم. ضع تحليلك المختصر في "work".',
  ],
  islamic: [
    'المادة: التربية الإسلامية. أجب وفق ما يقرّره منهج التربية الإسلامية في دولة الإمارات (المذهب السني،',
    'وما يدرَّس في الكتاب المدرسي): معاني الآيات والأحاديث، الأحكام الفقهية وشروطها وأركانها، السيرة النبوية',
    'وتواريخها، العقيدة والأخلاق. انتبه للفرق بين الواجب والسنة والمباح والمكروه والحرام، وبين الركن والشرط.',
    'أجب بلغة السؤال، وانقل الخيار كما هو.',
  ],
  social: [
    'Subject: social studies / moral education (UAE curriculum). Answer as the textbook teaches: UAE history',
    '(the union on 2 December 1971, the founding fathers, the seven emirates), geography and map reading,',
    'citizenship, government and the economy, world history as covered in the unit. Use the dates, names and',
    'figures in the passage or source when one is given. For an Arabic question, answer in Arabic.',
  ],
  english: [
    'Subject: English. Grammar questions: decide from the words on both sides of the gap (tense, agreement,',
    'part of speech, articles, prepositions). Reading: answer from the passage itself, matching meaning, not',
    'just shared words. Vocabulary: the meaning the word has in that sentence.',
  ],
};

/** Which of SUBJECT_TIPS fits this question: the class the page names, else the words of the question. */
function subjectOf(p) {
  const cls = String(p.subject || '').toLowerCase();
  const byClass = [
    [/math|رياضيات/, 'math'], [/physic|فيزياء/, 'physics'], [/chem|كيمياء/, 'chemistry'],
    [/biolog|أحياء|احياء/, 'biology'], [/islam|إسلامي|اسلامي|قرآن/, 'islamic'],
    [/social|moral|اجتماعي|أخلاق|الدراسات/, 'social'], [/\barabic\b|اللغة العربية|لغتي/, 'arabic'],
    [/english|إنجليزي/, 'english'], [/science|علوم/, 'science'],
  ].find(([re]) => re.test(cls));
  if (byClass) return byClass[1];
  // No class named: what the question itself is about.
  const t = [p.stem, p.passage, p.instruction, p.cloze?.text, p.dropdown?.text, ...(p.options || []).map(o => o?.text)].join(' ');
  if (/آية|سورة|حديث|رسول الله|صلاة|زكاة|صيام|وضوء|الحج|صلى الله عليه|الفقه|العقيدة|حكم شرعي|ما حكم/.test(t)) return 'islamic';
  if (/إعراب|الفاعل|المفعول|المبتدأ|الخبر|البلاغ|استعارة|تشبيه|كناية|جمع تكسير|الفعل المضارع|نحو/.test(t)) return 'arabic';
  if (/\b(?:mol|moles?|molar|electrons?|ions?|periodic|compound|reaction|atom(?:ic)?)\b/i.test(t)) return 'chemistry';
  if (/\b(?:velocity|acceleration|force|newtons?|joules?|momentum|current|voltage|resistance|m\/s)\b/i.test(t)) return 'physics';
  if (/\b(?:triangle|angle|equation|solve|polynomial|function|slope|area|perimeter|fraction|graph|midsegment)\b|[=√π∠]|\d\s*[x+\-*/^]\s*\d/i.test(t)) return 'math';
  return '';
}

/** The rules every question gets, and the guidance for its subject when it has one. */
function guidanceFor(p) {
  const sub = subjectOf(p);
  return [EXAM_RULES, ...(sub ? ['', ...SUBJECT_TIPS[sub]] : [])].join('\n');
}

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
  'Math and science: work it out before you answer. Put the key steps in "work" (short: the',
  'formula, the numbers, the result — under 50 words), then give the answer that matches them. Read',
  'every number and label in the text and in any figure; do not assume a figure is drawn to scale.',
  'Follow the question\'s instructions on form exactly: round as told, simplest form for fractions',
  'unless a decimal is asked for, the unit it asks for. Re-check signs and arithmetic. For anything',
  'that needs no calculation, leave "work" empty.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences, no explanation',
  'outside the object:',
  '{"work":"<steps, or empty>","answer":"<letter>","index":<zero-based index of the chosen choice>,"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'Math and science: work it out before you answer. Put the key steps in "work" (short: the',
  'formula, the numbers, the result — under 50 words), then give the answer that matches them. Read',
  'every number and label in the text and in any figure; do not assume a figure is drawn to scale.',
  'Follow the question\'s instructions on form exactly: round as told, simplest form for fractions',
  'unless a decimal is asked for, the unit it asks for. Re-check signs and arithmetic. For anything',
  'that needs no calculation, leave "work" empty.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<steps, or empty>","answers":["<letter>","<letter>"],"indices":[<zero-based index>,<zero-based index>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'A blank can be a math answer box (the exercise then says so), and a number to type is',
  'math too. Answer with the math itself, typed as plain text: x^2 for a power, sqrt(x) for',
  'a root, 3/4 for a fraction ((x+1)/(2) when the top or bottom has more than one term),',
  '2 1/2 for a mixed number, pi, <= and >=. No $ signs, no LaTeX, no backslashes, no words.',
  'Write only what goes in the box: not the variable and "=" when the text already has',
  'them before the box, and not a unit the text already shows after it (so "35", not',
  '"35°" before "°"). For a polynomial, write the whole expression the box stands for.',
  '',
  'Math and science: work it out before you answer. Put the key steps in "work" (short: the',
  'formula, the numbers, the result — under 50 words), then give the answer that matches them. Read',
  'every number and label in the text and in any figure; do not assume a figure is drawn to scale.',
  'Follow the question\'s instructions on form exactly: round as told, simplest form for fractions',
  'unless a decimal is asked for, the unit it asks for. Re-check signs and arithmetic. For anything',
  'that needs no calculation, leave "work" empty.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<steps, or empty>","blanks":["<answer for BLANK 1>","<answer for BLANK 2>"],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'Math and science: work it out before you answer. Put the key steps in "work" (short: the',
  'formula, the numbers, the result — under 50 words), then give the answer that matches them. Read',
  'every number and label in the text and in any figure; do not assume a figure is drawn to scale.',
  'Follow the question\'s instructions on form exactly: round as told, simplest form for fractions',
  'unless a decimal is asked for, the unit it asks for. Re-check signs and arithmetic. For anything',
  'that needs no calculation, leave "work" empty.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<steps, or empty>","picks":[<zero-based option index for BLANK 1>,<for BLANK 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'Put your reasoning for each pair in "work" first (short), then the pairs.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<short reasoning>","pairs":[<RIGHT number for LEFT 1>,<RIGHT number for LEFT 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'For a calculation or a fact, work it out in "work" first (short), then choose.',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<steps, or empty>","fills":[<item number for BLANK 1>,<item number for BLANK 2>],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
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
  'comes before its answer, and a greeting before the rest. For steps of a method or a',
  'process (a solution, an experiment, a historical sequence), think the order through in',
  '"work" first (short).',
  '',
  'Respond with ONLY a JSON object. No prose, no markdown fences:',
  '{"work":"<short reasoning>","order":[<number of the item that comes FIRST>,<number of the SECOND>,...],"confidence":<0.0-1.0>,"why":"<at most 12 words>"}',
  'Every item exactly once, using the numbers exactly as listed, which count from 0.',
].join('\n');

/** The question as the page shows it, plus — on a retry — what the page already
 *  marked wrong. Without that, the same input at temperature 0 gives the same
 *  wrong answer and Try Again only wastes a click. */
function buildText(p) {
  const text = buildQuestionText(p);
  const tried = (p.tried || []).map(t => String(t?.label ?? '').trim()).filter(Boolean);
  if (!tried.length) return text;
  // Several boxes in one question: say which the page marked right (keep) and wrong (change). When it
  // did not say, change as little as possible — asked again, a model tends to change every box, and
  // turned right ones wrong.
  const last = (p.tried || [])[p.tried.length - 1];
  if (Array.isArray(last?.blanks) && last.blanks.length > 1) {
    const marked = last.blanks.some(b => b?.mark);
    return [
      text, '',
      '=== PREVIOUS ATTEMPT (marked WRONG) ===',
      ...last.blanks.map((b, i) => `BLANK ${i + 1}: ${b?.value || '(empty)'}${b?.mark === 'right' ? ' — marked CORRECT: keep exactly this'
        : b?.mark === 'wrong' ? ' — marked WRONG: give a different answer' : ''}`),
      marked
        ? 'Keep every blank marked correct exactly as it is, and change only the ones marked wrong.'
        : 'At least one blank was wrong, but the page did not say which. Keep the blanks you are sure of, and change only the one or two most likely to be wrong — do not change everything.',
      ...(tried.length > 1 ? ['', 'Earlier attempts, also wrong:', ...tried.slice(0, -1).map((t, i) => `${i + 1}. ${t}`)] : []),
    ].join('\n');
  }
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
                 'write the answer as plain typed math (x^2, sqrt(x), 3/4), nothing else.');
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
      // The course and subject first, then the task and its answer format — the format last, where a
      // model heeds it most.
      { role: 'system', content: `${guidanceFor(p)}\n\n${p.kind === 'cloze' ? CLOZE_SYSTEM
                               : p.kind === 'dropdown' ? DROPDOWN_SYSTEM
                               : p.kind === 'match' ? MATCH_SYSTEM
                               : p.kind === 'drag' ? DRAG_SYSTEM
                               : p.kind === 'sort' ? SORT_SYSTEM
                               : p.multi ? MULTI_SYSTEM : SYSTEM}` },
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

/* ------------------------------------------------------- DeepSeek (the web chat)
 *
 * The chat at chat.deepseek.com has no public API for a signed-in account, so this asks the
 * site the way the site's own page does: a session id, a proof-of-work challenge answered in
 * the x-ds-pow-response header, then a streamed completion. The only thing the person supplies
 * is their own login token (Options copies it out of an open tab); no key, no billing.
 *
 * Two things are easy to get wrong here and are worth stating plainly:
 *
 *  - The digest is NOT plain SHA3-256. DeepSeek's own wasm export `wasm_deepseek_hash_v1`
 *    runs Keccak-f[1600] starting at round 1 (23 rounds, round 0 dropped). Sources disagree
 *    about this — some say plain SHA3-256 — so POW_ROUND_START is tried both ways at runtime
 *    and the one that answers a real challenge is remembered.
 *  - The browser owns Origin and Referer, so a service-worker fetch cannot set them by hand.
 *    declarativeNetRequest rewrites them (see rules.json); the WAF refuses requests without.
 */

const DS_BASE = 'https://chat.deepseek.com';
const DS_COMPLETION = '/api/v0/chat/completion';
const DS_CHALLENGE = '/api/v0/chat/create_pow_challenge';
const DS_SESSION_CREATE = '/api/v0/chat_session/create';
const DS_VERSION = '2.0.0';       // what the page calls itself; the site checks it

// Keccak-f[1600] round constants, most significant half first as written in the spec.
const RC_HEX = [
  '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000',
  '000000000000808b', '0000000080000001', '8000000080008081', '8000000000008009',
  '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
  '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003',
  '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a',
  '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
];
const RC_LO = Uint32Array.from(RC_HEX, h => parseInt(h.slice(8), 16));
const RC_HI = Uint32Array.from(RC_HEX, h => parseInt(h.slice(0, 8), 16));

// Rotation offsets, indexed by lane = x + 5y.
const RHO = new Uint8Array([
   0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14,
]);

const MASK32 = 0xffffffff;
const DS_RATE = 136;              // SHA3-256 rate in bytes

/** One Keccak-f[1600] permutation over 25 lanes held as lo/hi 32-bit halves.
 *  `startRound` is 0 for standard Keccak, 1 for DeepSeek's variant. */
function keccakF(lo, hi, startRound) {
  const bl = new Uint32Array(25), bh = new Uint32Array(25);
  const cl = new Uint32Array(5), ch = new Uint32Array(5);
  const dl = new Uint32Array(5), dh = new Uint32Array(5);

  for (let round = startRound; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      cl[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      ch[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const p = (x + 4) % 5, q = (x + 1) % 5;      // rotl(c[q], 1) split across the halves
      dl[x] = cl[p] ^ ((cl[q] << 1) | (ch[q] >>> 31));
      dh[x] = ch[p] ^ (((ch[q] << 1) | (cl[q] >>> 31)) & MASK32);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        lo[i] ^= dl[x];
        hi[i] ^= dh[x];
      }
    }

    // rho + pi: B[y, 2x+3y] = rotl(A[x, y], RHO[x, y])
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        const dest = y + 5 * ((2 * x + 3 * y) % 5);
        let l = lo[i], h = hi[i], s = RHO[i], t;
        // A 64-bit rotate, which JS cannot express directly: shifting by >= 32 would wrap
        // (shift counts are taken modulo 32), so half-words are swapped first instead.
        if (s >= 32) { t = l; l = h; h = t; s -= 32; }
        if (s) {
          const back = 32 - s;
          t = (l << s) | (h >>> back);
          h = ((h << s) | (l >>> back)) >>> 0;
          l = t >>> 0;
        }
        bl[dest] = l;
        bh[dest] = h;
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y, a = ((x + 1) % 5) + 5 * y, b = ((x + 2) % 5) + 5 * y;
        lo[i] = bl[i] ^ ((~bl[a] & bl[b]) & MASK32);
        hi[i] = bh[i] ^ ((~bh[a] & bh[b]) & MASK32);
      }
    }

    // iota
    lo[0] ^= RC_LO[round];
    hi[0] ^= RC_HI[round];
  }
}

/** XOR one rate-sized block into the state and permute. */
function absorbBlock(lo, hi, block, startRound) {
  for (let i = 0; i < DS_RATE; i += 4) {
    const w = (block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)) >>> 0;
    const lane = i >> 3;
    if (i & 4) hi[lane] ^= w; else lo[lane] ^= w;
  }
  keccakF(lo, hi, startRound);
}

/** Keccak/SHA3-256 over `bytes` as a 32-byte digest. `startRound` 0 is plain SHA3-256;
 *  1 is the DeepSeek variant (Keccak-f[1600] with round 0 dropped). */
function deepseekHash(bytes, startRound = 1) {
  const lo = new Uint32Array(25), hi = new Uint32Array(25);
  const whole = (bytes.length / DS_RATE) | 0;

  for (let b = 0; b < whole; b++) absorbBlock(lo, hi, bytes.subarray(b * DS_RATE, (b + 1) * DS_RATE), startRound);

  // The tail is always padded out to a full block, even when the message ends on the boundary.
  const rest = bytes.subarray(whole * DS_RATE);
  const last = new Uint8Array(DS_RATE);
  last.set(rest);
  last[rest.length] = 0x06;          // SHA-3 domain separation
  last[DS_RATE - 1] |= 0x80;         // pad10*1
  absorbBlock(lo, hi, last, startRound);

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    const l = lo[lane], h = hi[lane];
    out[lane * 8 + 0] = l & 0xff;         out[lane * 8 + 1] = (l >>> 8) & 0xff;
    out[lane * 8 + 2] = (l >>> 16) & 0xff; out[lane * 8 + 3] = (l >>> 24) & 0xff;
    out[lane * 8 + 4] = h & 0xff;         out[lane * 8 + 5] = (h >>> 8) & 0xff;
    out[lane * 8 + 6] = (h >>> 16) & 0xff; out[lane * 8 + 7] = (h >>> 24) & 0xff;
  }
  return out;
}

/** The bytes of a string as UTF-8. Written out rather than using TextEncoder so that this file
 *  also runs in the bare test sandboxes, which do not provide it. */
function utf8(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i);
    if (c > 0xffff) i++;                       // a surrogate pair is one code point
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/** Solve one proof-of-work challenge: find the nonce in [0, difficulty) whose digest of
 *  `salt_expireAt_<nonce>` equals `challenge`. Returns the nonce, or null if there is none. */
function solvePow(challenge, salt, expireAt, difficulty, startRound = 1) {
  const target = String(challenge).toLowerCase();
  const prefix = utf8(`${salt}_${expireAt}_`);
  const block = new Uint8Array(DS_RATE);
  const lo = new Uint32Array(25), hi = new Uint32Array(25);
  const digest = new Uint8Array(32);
  const limit = Math.max(0, Math.min(Number(difficulty) || 0, 2 ** 31 - 1));

  for (let nonce = 0; nonce < limit; nonce++) {
    // The message is always short enough to be one final block, so build it directly:
    // prefix, then the decimal nonce, then the padding.
    const d = String(nonce);
    block.fill(0, prefix.length, DS_RATE);
    block.set(prefix, 0);
    for (let i = 0; i < d.length; i++) block[prefix.length + i] = d.charCodeAt(i);
    block[prefix.length + d.length] = 0x06;
    block[DS_RATE - 1] |= 0x80;

    lo.fill(0);
    hi.fill(0);
    absorbBlock(lo, hi, block, startRound);
    for (let lane = 0; lane < 4; lane++) {
      const l = lo[lane], h = hi[lane];
      digest[lane * 8 + 0] = l & 0xff;         digest[lane * 8 + 1] = (l >>> 8) & 0xff;
      digest[lane * 8 + 2] = (l >>> 16) & 0xff; digest[lane * 8 + 3] = (l >>> 24) & 0xff;
      digest[lane * 8 + 4] = h & 0xff;         digest[lane * 8 + 5] = (h >>> 8) & 0xff;
      digest[lane * 8 + 6] = (h >>> 16) & 0xff; digest[lane * 8 + 7] = (h >>> 24) & 0xff;
    }
    if (toHex(digest) === target) return nonce;
  }
  return null;
}

/** The header the site wants: base64 of a compact JSON object, with the answer filled in. */
function powHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm || 'DeepSeekHashV1',
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return btoa(JSON.stringify(payload));
}

/** Every header the site's own page sends. Origin and Referer are set by the browser and
 *  cannot be written here — rules.json rewrites those two. */
function dsHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: '*/*',
    'content-type': 'application/json',
    'x-app-version': DS_VERSION,
    'x-client-version': DS_VERSION,
    'x-client-platform': 'web',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    ...extra,
  };
}

/** A business reply is `{code, msg, data:{biz_data}}`; code 0 is success. Anything else is
 *  raised with the site's own message, which is far more useful than a bare HTTP status. */
function dsBiz(json) {
  if (!json || typeof json !== 'object') throw new Error('empty reply from DeepSeek');
  if (json.code !== undefined && json.code !== 0) {
    throw new Error(`DeepSeek said ${json.code}: ${json.msg || 'no message'}`);
  }
  const biz = json.data?.biz_data;
  if (biz === undefined) throw new Error('DeepSeek reply had no business data');
  return biz;
}

/** POST to the site. The response is handed back even when it is not ok, so the caller's
 *  ordinary status handling sees it; only a transport failure throws. */
async function dsCall(path, token, body, extraHeaders) {
  return fetch(DS_BASE + path, {
    method: 'POST',
    headers: dsHeaders(token, extraHeaders),
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

/** A new thread. The site's own page does this before the first message. Only a refused token
 *  is worth stopping for; anything else can be left to the completion call. */
async function dsNewSession(token) {
  const res = await dsCall(DS_SESSION_CREATE, token, {});
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { refused: res };
    return { sessionId: null };
  }
  try {
    return { sessionId: dsBiz(await res.json())?.chat_session?.id ?? null };
  } catch {
    return { sessionId: null };
  }
}

/** Read the streamed completion and hand back the assistant's text, the message id, and why
 *  it stopped. The site frames each line as `{v, p, o}`: `p` names a field, `o:"APPEND"`
 *  means `v` is a piece of it. Thinking arrives on its own path and is dropped. */
function parseDeepseekStream(raw) {
  let text = '', path = '', messageId = null, finish = '';
  // The kind of each fragment the reply is built from, in order. Expert mode streams its
  // reasoning as THINK fragments on the very same `fragments/-1/content` path as the answer,
  // so a string is only part of the answer when the fragment it lands in is a RESPONSE one.
  // An empty list means the site never named its fragments (the older protocol): take it all.
  const frags = [];
  const addFrags = list => {
    for (const f of list || []) {
      if (!f || typeof f !== 'object') continue;
      frags.push(String(f.type || ''));
      if (f.type === 'RESPONSE' && typeof f.content === 'string') text += f.content;
    }
  };
  const isAnswer = p => {
    if (/thinking/.test(p)) return false;
    if (!frags.length) return true;
    const m = p.match(/fragments\/(-?\d+)\/content$/);
    if (!m) return true;
    const i = Number(m[1]);
    return frags[i < 0 ? frags.length + i : i] === 'RESPONSE';
  };
  const apply = (p, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.response) {
      addFrags(v.response.fragments);
      // The assistant's message id is what the next question in the same thread hangs from. The
      // site has put it under `message_id` or `id`, on the response or on the frame itself.
      for (const holder of [v.response, v]) {
        const id = holder?.message_id ?? holder?.id;
        if (Number.isInteger(id)) { messageId = id; break; }
      }
    } else if (Array.isArray(v) && /fragments$/.test(p)) {
      addFrags(v);
    } else if (Array.isArray(v)) {
      // A batch of changes under one path: each names its own path relative to it.
      for (const c of v) if (c && typeof c === 'object' && typeof c.p === 'string') apply(p ? `${p}/${c.p}` : c.p, c.v);
    } else if (Number.isInteger(v) && /message_id$/.test(p)) {
      messageId = v;
    } else if (typeof v === 'string' && /content$/.test(p) && isAnswer(p)) {
      text += v;
    }
  };
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') { finish = finish || 'stop'; continue; }
    if (!payload) continue;

    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    const frame = (j?.data && typeof j.data === 'object' && ('v' in j.data || 'p' in j.data)) ? j.data : j;
    if (typeof frame?.finish_reason === 'string') finish = frame.finish_reason;
    // A frame with no path carries on where the last one was.
    if (typeof frame?.p === 'string') path = frame.p;

    const v = frame?.v;
    // The end marker arrives bare (`data: [DONE]`) but is accepted framed too; either way it
    // ends the message and must not be read as another piece of the answer.
    if (v === '[DONE]' || frame === '[DONE]') { finish = finish || 'stop'; continue; }
    apply(path, v);
    // After a new set of fragments, bare appends go into the last one.
    if (Array.isArray(v) && /fragments$/.test(path)) path = `${path}/-1/content`;
    else if (v && typeof v === 'object' && !Array.isArray(v) && v.response) path = 'response/fragments/-1/content';
  }
  return { text, messageId, finish };
}

/** One question, start to finish: challenge, solve, stream, assemble. Returns a reply shaped
 *  like the other providers' so every retry and fallback rule above still applies. */
async function deepseekComplete(cfg, body, model, thinkingOff) {
  const token = String(cfg.deepseekToken || '').trim();
  if (!token) throw new Error('No DeepSeek token set — open Options and copy one from the site.');

  const modelType = /expert/i.test(model) ? 'expert' : 'default';
  const user = body.messages[1];
  // The site takes one text prompt and its own pictures; the system prompt rides along on top.
  const prompt = [body.messages[0].content, '', ...user.content.filter(c => c.type === 'text').map(c => c.text)].join('\n');

  // One thread is kept going rather than a new one per question (see "keeping one chat"). It can
  // only be continued from the assistant's last message id, so a thread whose id was never read
  // is not kept at all: the next question simply starts a new one, as it always did.
  const reuse = cfg.reuseChat !== false;
  let saved = reuse ? await chatLoad(DS_CHAT_KEY) : null;
  if (saved && !(saved.sessionId && Number.isInteger(saved.parentId) && chatUsable(saved, { model: modelType }))) saved = null;

  let round = await dsRound(cfg, token, prompt, modelType, thinkingOff, saved);
  // The thread was deleted, or the site would not continue it: ask again in a fresh one, once.
  // A refused token or a rate limit would fail the same way again, so those are not retried.
  if (saved && dsChatLost(round)) {
    await chatClear(DS_CHAT_KEY);
    saved = null;
    round = await dsRound(cfg, token, prompt, modelType, thinkingOff, null);
  }
  if (round.res) return round.res;             // the caller's ordinary status handling takes it from here

  if (reuse && round.sessionId && Number.isInteger(round.messageId) && round.text) {
    await chatSave(DS_CHAT_KEY, {
      sessionId: round.sessionId, parentId: round.messageId,
      turns: (saved?.turns || 0) + 1, model: modelType, at: Date.now(),
    });
  }

  // Hand it back in the shape the rest of this file already knows how to read.
  return {
    ok: true,
    status: 200,
    text: async () => round.raw,
    json: async () => ({ choices: [{ message: { content: round.text }, finish_reason: round.finish || 'stop' }] }),
  };
}

/** Whether a failed round says the thread itself is the problem. A refused token or a rate limit
 *  is the account's, and a challenge that would not come is the site's; none of them is helped by
 *  a new thread. An answer with nothing in it is. */
function dsChatLost(round) {
  if (round.res) return round.stage === 'completion' && ![401, 403, 429].includes(round.res.status);
  return !round.text;
}

/** One trip to the site: a thread (new, or the one given), a challenge, its answer, and the
 *  streamed reply. Returns either `{ res, stage }` — a response that was not ok, to be handled by
 *  the caller — or the reply read out of the stream along with the thread it belongs to. */
async function dsRound(cfg, token, prompt, modelType, thinkingOff, chat) {
  let sessionId;
  if (chat) {
    sessionId = chat.sessionId;
  } else {
    const made = await dsNewSession(token);
    if (made.refused) return { res: made.refused, stage: 'session' };
    sessionId = made.sessionId;
  }

  const challengeRes = await dsCall(DS_CHALLENGE, token, { target_path: DS_COMPLETION });
  if (!challengeRes.ok) return { res: challengeRes, stage: 'challenge' };
  const challenge = dsBiz(await challengeRes.json()).challenge;
  if (!challenge?.challenge) throw new Error('DeepSeek sent no proof-of-work challenge');

  // Which digest variant answered last time, so the next question does not try both. A wrong
  // guess costs one wasted search, so this is an optimisation only — never a correctness risk.
  const powRound = cfg.deepseekPowRound === 0 || cfg.deepseekPowRound === 1 ? cfg.deepseekPowRound : 1;
  let answer = solvePow(challenge.challenge, challenge.salt, challenge.expire_at, challenge.difficulty, powRound);
  let usedRound = powRound;
  if (answer === null) {
    // The two variants are indistinguishable from the outside; whichever answers is the real one.
    usedRound = powRound === 1 ? 0 : 1;
    answer = solvePow(challenge.challenge, challenge.salt, challenge.expire_at, challenge.difficulty, usedRound);
  }
  if (answer === null) throw new Error(`could not solve the proof-of-work challenge (difficulty ${challenge.difficulty})`);
  // Remember which digest answered, so the next question does not have to try both. Best effort:
  // losing this only costs one extra attempt.
  if (usedRound !== cfg.deepseekPowRound) {
    try { await chrome.storage.local.set({ deepseekPowRound: usedRound }); } catch { /* ignore */ }
  }

  const res = await dsCall(DS_COMPLETION, token, {
    chat_session_id: sessionId,
    // In a continued thread the new message hangs from the assistant's last one; a new thread
    // has no parent.
    parent_message_id: chat ? chat.parentId : null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: !!(cfg.deepseekThinking && !thinkingOff),
    search_enabled: !!cfg.deepseekSearch,
    action: null,
    preempt: false,
    model_type: modelType,
  }, { 'x-ds-pow-response': powHeader(challenge, answer) });

  if (!res.ok) return { res, stage: 'completion' };
  const raw = await res.text();
  return { raw, sessionId, ...parseDeepseekStream(raw) };
}

/* ------------------------------------------------- Gemini, on the site itself */

/**
 * The Gemini web app, driven with your own signed-in Google session instead of a bought key.
 *
 * Almost none of this runs here. The requests are made by gemini-web.js inside a
 * gemini.google.com tab, for a reason that is not a preference: the session cookie is
 * SameSite=Lax, so a service worker — a different origin — would send its requests signed out,
 * and for accounts with Device Bound Session Credentials switched on the proof-of-possession
 * that proves the cookie is really yours is added by the browser's network stack and cannot be
 * produced from here at all. Copying the cookies out and replaying them fails for the same
 * reason, and increasingly quickly: that is exactly what the binding exists to stop.
 *
 * So this side decides what to ask and how to read the answer, and the tab does the talking.
 */

/* ------------------------------------------------------------------ Gemini trace */

// Every step a Gemini-site question takes — finding the tab, the session, the model, each request and
// how it ended — one line each, with the time. Kept in storage (the newest GW_LOG_MAX lines), so it
// survives the service worker going to sleep, and copied into failure reports and by the popup's
// "Copy Gemini log". Nothing secret goes in: no tokens, no cookies, only lengths and short heads.
const GW_LOG_KEY = 'geminiWebLog';
const GW_LOG_MAX = 300;
let gwLogBuf = null;
let gwLogChain = Promise.resolve();
function gwLog(step, data = {}) {
  const line = { at: Date.now(), step, ...data };
  try { console.log('[alef-solver gemini]', step, data); } catch { /* no console */ }
  gwLogChain = gwLogChain.then(async () => {
    if (!gwLogBuf) {
      try { gwLogBuf = (await chrome.storage.local.get(GW_LOG_KEY))?.[GW_LOG_KEY] || []; } catch { gwLogBuf = []; }
      if (!Array.isArray(gwLogBuf)) gwLogBuf = [];
    }
    gwLogBuf.push(line);
    if (gwLogBuf.length > GW_LOG_MAX) gwLogBuf.splice(0, gwLogBuf.length - GW_LOG_MAX);
    try { await chrome.storage.local.set({ [GW_LOG_KEY]: gwLogBuf }); } catch { /* the console has it */ }
  }).catch(() => {});
  return gwLogChain;
}
/** The log as text, newest last: `HH:MM:SS.mmm step key=value …`. `sinceMs` keeps only recent lines. */
async function gwLogText({ limit = 120, sinceMs = 0 } = {}) {
  await gwLogChain;
  let lines = gwLogBuf;
  if (!lines) { try { lines = (await chrome.storage.local.get(GW_LOG_KEY))?.[GW_LOG_KEY] || []; } catch { lines = []; } }
  const cut = sinceMs ? Date.now() - sinceMs : 0;
  const show = v => (typeof v === 'string' ? JSON.stringify(v.length > 300 ? `${v.slice(0, 300)}…` : v) : JSON.stringify(v));
  return lines.filter(l => l.at >= cut).slice(-limit).map(({ at, step, ...rest }) =>
    `${new Date(at).toISOString().slice(11, 23)} ${step}${Object.entries(rest).map(([k, v]) => ` ${k}=${show(v)}`).join('')}`).join('\n');
}

/** Is any gemini.google.com tab open and listening? Answers with the tab, or null. */
async function gwTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' }); } catch (e) { gwLog('tab.query-failed', { error: String(e?.message || e) }); return null; }
  gwLog('tab.found', { count: tabs.length, tabs: tabs.map(t => ({ id: t.id, status: t.status, discarded: !!t.discarded, path: String(t.url || '').replace(/^https:\/\/gemini\.google\.com/, '').slice(0, 40) })) });
  for (const tab of tabs) {
    if (tab.id != null && await gwPing(tab.id)) { gwLog('tab.ready', { id: tab.id }); return tab; }
  }
  if (tabs.length) gwLog('tab.no-answer', { note: 'no Gemini tab answers — reconnecting' });
  // None answers. The usual reason: the extension was reloaded, and the tab still runs the old copy
  // of gemini-web.js, cut off from this one — or the browser put the tab to sleep. Bring one back
  // rather than tell the person to: put the script in again, or wake the tab.
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      if (tab.discarded || tab.status === 'unloaded') {
        gwLog('tab.waking', { id: tab.id });
        await chrome.tabs.reload(tab.id);
        for (let i = 0; i < 40; i++) { await pause(250); if ((await chrome.tabs.get(tab.id))?.status === 'complete') break; }
      } else {
        gwLog('tab.inject', { id: tab.id });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gemini-web.js'] });
      }
    } catch (e) { gwLog('tab.repair-failed', { id: tab.id, error: String(e?.message || e) }); continue; }
    for (let i = 0; i < 20; i++) { if (await gwPing(tab.id)) { gwLog('tab.reconnected', { id: tab.id, afterMs: i * 250 }); return tab; } await pause(250); }
    gwLog('tab.still-silent', { id: tab.id });
  }
  // No Gemini tab at all: open one in the background. The login is the browser's, so a signed-in
  // person needs nothing more.
  if (!tabs.length) {
    try {
      gwLog('tab.opening', { note: 'no Gemini tab open — opening one in the background' });
      const t = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: false });
      for (let i = 0; i < 60; i++) { await pause(500); if (await gwPing(t.id)) { gwLog('tab.opened', { id: t.id, afterMs: (i + 1) * 500 }); return t; } }
      gwLog('tab.opened-silent', { id: t.id });
    } catch (e) { gwLog('tab.open-failed', { error: String(e?.message || e) }); }
  }
  gwLog('tab.none', {});
  return null;
}

async function gwPing(tabId) {
  try { return !!(await chrome.tabs.sendMessage(tabId, { type: 'gw-ping' }))?.ok; } catch { return false; }
}

/** Ask that tab to do something, and say plainly what to do when there is no tab. */
const GW_CALL_MS = 120000;           // the tab's own limits are shorter; this is for a tab that never replies
async function gwCall(tabId, msg) {
  try {
    let timer;
    const r = await Promise.race([
      chrome.tabs.sendMessage(tabId, msg),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no reply in ${GW_CALL_MS / 1000} s`)), GW_CALL_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!r) throw new Error('no reply');
    return r;
  } catch (e) {
    gwLog('tab.call-failed', { request: msg?.type, error: String(e?.message || e) });
    throw new Error(`lost contact with the Gemini tab (${e.message || e}) — reload it and try again`);
  }
}

/** The upload host, the push id the page handed us, and the one header the endpoint wants that
 *  does not depend on which upload protocol is used. */
const GW_UPLOAD = 'https://content-push.googleapis.com/upload';
const GW_PUSH_DEFAULT = 'feeds/mcudyrk2a4khkz';

/** Google's resumable upload: ask for a destination, then put the bytes there. The plain
 *  multipart POST below is what the original client used and still works on some accounts;
 *  this is the newer of the two and is tried second, so a working simple upload is never
 *  given up in favour of it. Returns the same shape either way. */
async function gwUploadResumable(bytes, type, name, pushId) {
  // `origin` and `referer` are not set here: a page is not allowed to write either, so the
  // browser drops them and rules.json puts the site's own values on instead.
  const base = {
    'push-id': pushId || GW_PUSH_DEFAULT,
    'x-tenant-id': 'bard-storage',
  };
  // The handshake and the "where do I put this" call carry the same set, as the site's own
  // client sends them; only the second adds the length.
  const start = {
    ...base,
    'x-goog-upload-protocol': 'resumable',
    'x-goog-upload-command': 'start',
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
  };
  try {
    // The handshake is an OPTIONS with no body; its reply names where the bytes should go.
    await fetch(GW_UPLOAD, { method: 'OPTIONS', headers: { ...start, 'x-goog-upload-header-content-length': String(bytes.length) } });

    const started = await fetch(GW_UPLOAD, {
      method: 'POST',
      headers: { ...start, 'x-goog-upload-header-content-length': String(bytes.length), size: String(bytes.length) },
      body: `File name: ${name}`,
    });
    if (!started.ok) return { ok: false, detail: `HTTP ${started.status} asking where to put the picture` };

    const dest = started.headers.get('x-goog-upload-url');
    // Only ever send the picture back to Google, whatever the reply says: an upload address
    // handed to us by a reply is not somewhere to post a screenshot on trust.
    if (!dest || new URL(dest).host !== new URL(GW_UPLOAD).host) {
      return { ok: false, detail: 'the site did not name one of its own addresses for the picture' };
    }

    // The destination gets its own handshake before the bytes, with the same headers the
    // "start" call carried — that is what the site's own client does.
    await fetch(dest, {
      method: 'OPTIONS',
      headers: { ...start, 'x-goog-upload-header-content-length': String(bytes.length), size: String(bytes.length) },
    });

    const done = await fetch(dest, {
      method: 'POST',
      headers: {
        ...base,
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'content-type': type,
      },
      body: bytes,
    });
    if (!done.ok) return { ok: false, detail: `HTTP ${done.status} sending the picture` };
    const id = (await done.text()).trim();
    return id ? { ok: true, url: id, name } : { ok: false, detail: 'the upload returned no address' };
  } catch (e) {
    return { ok: false, detail: e.message || String(e) };
  }
}

/** Send a picture to the site's upload endpoint and hand back the address it returns, which is
 *  what a chat request refers to an attachment by.
 *
 *  This one does run here rather than in the tab. The upload endpoint is a different host and
 *  takes no part of the login, so it needs none of what the tab is for — and a content script
 *  gets no cross-origin exemption from host permissions the way a service worker does, so from
 *  the page this request would be refused by CORS before it was ever sent. Unlike DeepSeek,
 *  the site does read pictures, so this path is worth having. */
/** A screenshot no bigger than the model needs. A high-density screen captures at three times the
 *  size it shows (3000-odd pixels across), which is slow to upload and slow for the model to take
 *  in, for no gain in what it can read. Scaled to GW_SHOT_MAX on the long side, as a JPEG. Anything
 *  that goes wrong leaves the picture as it was. */
const GW_SHOT_MAX = 1400;
async function gwShrink(dataUrl) {
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, GW_SHOT_MAX / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && blob.size < 400000) { bmp.close?.(); return dataUrl; }
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    gwLog('picture.shrunk', { from: `${blob.size} bytes`, to: `${out.size} bytes`, size: `${w}x${h}` });
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } catch (e) {
    gwLog('picture.shrink-failed', { error: String(e?.message || e) });
    return dataUrl;
  }
}

async function gwUpload(dataUrl, pushId) {
  if (typeof OffscreenCanvas !== 'undefined') dataUrl = await gwShrink(dataUrl);
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(dataUrl || ''));
  if (!m) return { ok: false, detail: 'the picture was not in a form that can be sent' };

  const type = m[1] || 'image/jpeg';
  const bytes = m[2]
    ? Uint8Array.from(atob(m[3]), ch => ch.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(m[3]));

  const ext = (type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const name = `input_${Math.floor(1000000 + Math.random() * 8999999)}.${ext}`;

  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);

  let res;
  try {
    res = await fetch(GW_UPLOAD, {
      method: 'POST',
      headers: { 'push-id': pushId || GW_PUSH_DEFAULT, 'x-tenant-id': 'bard-storage' },
      body: form,
    });
  } catch (e) {
    return gwUploadResumable(bytes, type, name, pushId);
  }
  // A refusal here is not final: some accounts answer only the resumable handshake, so the
  // picture is offered that way before the caller is told it could not be sent.
  if (!res.ok) return gwUploadResumable(bytes, type, name, pushId);
  const url = (await res.text()).trim();
  if (!url) return gwUploadResumable(bytes, type, name, pushId);
  return { ok: true, url, name };
}

/** Whether a reply to a continued conversation says the conversation itself is the problem — gone
 *  from the site, or tied to a different model — rather than the account being out of allowance,
 *  rate limited or blocked, which a fresh conversation would not cure. */
function gwChatLost(out) {
  if (!out) return false;
  if (!out.ok) return ![401, 403, 429].includes(out.status);
  if (out.failure) return !GW_RETRY_CODES.includes(out.code);
  return !out.text;
}

/** The Gemini site's codes that mean "not now" rather than "not you": the allowance is used up
 *  (1037), a temporary error (1013), the network address is blocked for a while (1060), and 1095.
 *  1095 is in neither reference client and in no documentation found; it came back on the first
 *  question of a run, with the site otherwise answering, and is treated as the same kind of thing.
 *  These are waited out and asked again (see askCore). Anything else — a model that no longer
 *  matches, a refusal — is not a wait, and asking again would only be refused again. */
const GW_RETRY_CODES = [1013, 1037, 1060, 1095];

/** The site's own fallback message, when a request fails on its side. It arrives as the REPLY, in
 *  the voice of the model — "I seem to be encountering an error. Can I try something else for
 *  you?" — so nothing in the transport says it went wrong, and it used to be taken for an answer
 *  that could not be read. It is never an answer: an answer is JSON, which this has none of. */
const GW_ERROR_REPLY = /encountering an error|try something else for you|something went wrong/i;
function gwErrorReply(text) {
  const t = String(text || '').trim();
  return !!t && t.length < 400 && !/[{[]/.test(t) && GW_ERROR_REPLY.test(t);
}
/** How long to wait before the second and the third try after such a reply. */
const GW_ERROR_REPLY_WAITS = [2000, 6000];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------- the Gemini session, kept between questions */

/* Every question used to begin by downloading the whole gemini.google.com page to read its tokens
 * and then asking for the model list. Neither changes from one question to the next, so both are
 * kept for a while. They are kept in memory, and in session storage (gone when the browser
 * closes, and never shown to a page) so a worker that was put to sleep between two questions
 * does not forget them. A kept session is tied to one tab and one account slot, expires after
 * ten minutes, and is thrown away and fetched again the moment the site refuses a request made
 * with it — so being wrong about it costs one extra round trip, never a failed question. */
const GW_SESSION_TTL = 10 * 60 * 1000;
const GW_SESSION_KEY = 'gwSessionCache';
let gwSessionMemo = null;

/** Which tab, and which Google account slot in it, a session belongs to. */
function gwTabKey(tab) {
  let slot = '';
  try { slot = /^\/u\/(\d+)(?:\/|$)/.exec(new URL(tab.url).pathname)?.[1] || ''; } catch { /* no address: no slot */ }
  return `${tab.id}:${slot}`;
}

async function gwCacheGet(key) {
  const fresh = e => !!e && e.key === key && Date.now() - e.at < GW_SESSION_TTL;
  if (fresh(gwSessionMemo)) return gwSessionMemo;
  try {
    const e = (await chrome.storage.session.get(GW_SESSION_KEY))?.[GW_SESSION_KEY];
    if (fresh(e)) { gwSessionMemo = e; return e; }
  } catch { /* no session storage here: the memory copy is all there is */ }
  return null;
}
async function gwCachePut(entry) {
  gwSessionMemo = entry;
  try { await chrome.storage.session.set({ [GW_SESSION_KEY]: entry }); } catch { /* as above */ }
}
async function gwCacheDrop() {
  gwSessionMemo = null;
  try { await chrome.storage.session.remove(GW_SESSION_KEY); } catch { /* as above */ }
}

/** The tab's session and the account's model list: the kept ones when they are fresh, otherwise
 *  asked for. `onSession` is told the session as soon as it is known, before the model list is
 *  fetched, so the picture upload can start beside it. Only an account that answered healthily
 *  is kept — a barred or signed-out one is looked at again every time, as before. */
async function gwSession(tab, cfg, { fresh = false, onSession = null } = {}) {
  const t0 = Date.now();
  const keep = cfg.speedCache !== false;
  const key = gwTabKey(tab);
  if (keep && !fresh) {
    const hit = await gwCacheGet(key);
    if (hit) {
      if (onSession) onSession(hit.session);
      gwLog('session.cached', { models: (hit.found?.models || []).length, ageS: Math.round((Date.now() - (hit.at || 0)) / 1000) });
      return { session: hit.session, found: hit.found, cached: true, ms: Date.now() - t0 };
    }
  }

  const init = await gwCall(tab.id, { type: 'gw-init' });
  if (!init.ok) { gwLog('session.init-failed', { detail: init.detail || '' }); throw new Error(init.detail || 'the Gemini page gave no session'); }
  gwLog('session.init', { account: init.session?.account || '(default)', hl: init.session?.hl, token: init.session?.at ? `${String(init.session.at).length} chars` : 'MISSING', bl: init.session?.bl || '', ms: Date.now() - t0 });
  if (onSession) onSession(init.session);

  const found = await gwCall(tab.id, { type: 'gw-models', session: init.session });
  if (!found.ok) { gwLog('session.models-failed', { detail: found.detail || '' }); throw new Error(found.detail || 'the model list could not be read'); }
  gwLog('session.models', { status: found.status, models: (found.models || []).map(m => m.label || m.name), capacity: found.capacity, ms: Date.now() - t0 });

  if (keep && found.status === 1000 && (found.models || []).length) {
    await gwCachePut({ key, at: Date.now(), session: init.session, found });
  }
  return { session: init.session, found, cached: false, ms: Date.now() - t0 };
}

/** Whether a reply looks like the site refusing the session itself, as opposed to the question. */
function gwSessionStale(out) {
  if (!out) return false;
  if (!out.ok) return [400, 401, 403].includes(out.status);
  return !!out.failure && out.code === -1;
}

/** The session, the model list, and the answer — all inside the tab. */
async function geminiWebComplete(cfg, body, modelName, thinkingOff) {
  const stage = speedStages;                       // this question's timings (see "speed")
  const tStart = Date.now();
  gwLog('ask.start', { wantedModel: modelName || '(none: Flash if the account has it)', thinking: thinkingOff ? 'low (retry)' : (cfg.geminiWebThinking || 'standard'), reuseChat: cfg.reuseChat !== false, picture: body.messages[1].content.some(c => c.type === 'image_url') });
  const tab = await gwTab();
  if (!tab) {
    throw new Error('open gemini.google.com in a tab, signed in, and leave it open — the extension borrows that tab because the login only works from there');
  }

  const user = body.messages[1];
  // The site takes one prompt and its own pictures: the system prompt is put on top of the user's text.
  // In a conversation that is being kept, the model has the instructions already, and very often the
  // passage too (a lesson's questions share one): neither is sent again while it is unchanged. That is
  // most of each prompt, so it is most of the tokens — and the time and the rate limit that go with them.
  const system = body.messages[0].content;
  const userText = user.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const passage = gwPassageOf(userText);
  const promptFor = chat => {
    let u = userText;
    if (chat && passage && chat.passage === gwHash(passage)) u = u.replace(passage, '(the same passage as in my previous message)');
    // The chat model ("Auto") sometimes answered in paragraphs, which cannot be read and cost a whole
    // second ask. The format is said again last, where it is heeded most, and it is told not to deliberate.
    const tail = '\n\nAnswer straight away, without working it out at length. Reply with ONLY the JSON object — no explanation, no markdown.';
    return chat && chat.sys === gwHash(system)
      ? `${u}${tail}`
      : [system, '', u].join('\n') + tail;
  };

  // A picture is uploaded to the site first and referenced by the address it hands back; the
  // site's own chat reads images, so unlike DeepSeek these are not thrown away. The upload needs
  // only the page's push id, so with the "parallel" switch on it starts the moment the session
  // is known and runs while the model list is still being fetched, not after it.
  const shot = user.content.find(c => c.type === 'image_url')?.image_url?.url;
  let uploading = null;
  const startUpload = session => {
    if (!shot || uploading) return uploading;
    const t = Date.now();
    uploading = gwUpload(shot, session.push)
      .catch(e => ({ ok: false, detail: String(e?.message || e) }))
      .then(up => { stage.upload = (stage.upload || 0) + (Date.now() - t); return up; });
    return uploading;
  };

  let sess = await gwSession(tab, cfg, { onSession: cfg.speedParallel !== false ? startUpload : null });

  // An empty model box means the account's own default, which the site picks when no model
  // header is sent. That is the safest choice: it is always available to every account.
  // GW_AUTO_FAST is the stand-in behind a chosen model when no fallback was set: the account's quickest
  // model other than the one that just failed.
  const auto = modelName === GW_AUTO_FAST;
  const wanted = auto ? '' : String(modelName || '').trim().toLowerCase();
  const avoid = auto ? String(cfg.geminiWebModel || '').trim().toLowerCase() : '';
  const pick = found => {
    const all = (found.models || []).map(m => ({ ...m, ...found.capacity }));
    const one = wanted
      ? all.find(m => m.name.toLowerCase() === wanted || m.label.toLowerCase() === wanted || m.id.toLowerCase() === wanted)
        || all.find(m => m.name.toLowerCase().includes(wanted) || wanted.includes(m.name.toLowerCase()))
      : null;
    // No model chosen: a fast one (Flash) rather than whatever the account defaults to, which can be
    // a slow thinking model. Answers here are one short JSON object; speed is what matters.
    return { models: all, model: one || (wanted ? null : gwFastModel(all, avoid)) };
  };
  let { models, model } = pick(sess.found);
  // A model missing from a remembered list may have been added since: look again before saying no.
  if (wanted && !model && sess.cached) {
    sess = await gwSession(tab, cfg, { fresh: true });
    ({ models, model } = pick(sess.found));
  }

  // A saved list is kept so Options can offer the account's real models without asking again.
  if (!sess.cached && models.length && JSON.stringify(models) !== JSON.stringify(cfg.geminiWebModels || [])) {
    try { await chrome.storage.local.set({ geminiWebModels: models }); } catch { /* only a cache */ }
  }

  if (wanted && !model) {
    return { ok: false, status: 400, text: async () => JSON.stringify({
      error: { message: `this account has no model called ${modelName}; Options lists the ones it has` } }) };
  }
  stage.setup = (stage.setup || 0) + (Date.now() - tStart);
  stage.cached = sess.cached;

  let fileData = null;
  if (shot) {
    const up = await (uploading || startUpload(sess.session));
    if (!up.ok) {
      return { ok: false, status: 400, text: async () => JSON.stringify({
        error: { message: `the image could not be attached: ${up.detail || 'unknown reason'}` } }) };
    }
    fileData = [[[up.url], up.name]];
  }

  // One conversation is kept going rather than a new one per question (see "keeping one chat").
  // It is only continued while it is the same account and the same model it was started with.
  const reuse = cfg.reuseChat !== false;
  const modelKey = model?.id || '';
  const accountKey = sess.session.account || '';
  let saved = reuse ? await chatLoad(GW_CHAT_KEY) : null;
  if (saved && !(saved.cid && saved.rid && saved.rcid && chatUsable(saved, { account: accountKey, model: modelKey }))) saved = null;
  // Some accounts refuse every follow-up in a conversation (error 1097): asking that way first cost
  // half a second a question before the new conversation it ends in anyway. Once refused, they are
  // asked in a new one straight away, for a day.
  const noFollowUp = (await chatLoad(GW_NO_FOLLOWUP_KEY)) || {};
  if (saved && noFollowUp[accountKey] && Date.now() - noFollowUp[accountKey] < 24 * 3600e3) {
    gwLog('chat.skip-followup', { note: 'this account refuses follow-ups (1097): new conversation' });
    saved = null;
  }

  // Another model comes after this one in the chain: this one is not waited on for ever.
  const another = !auto && !!(cfg.geminiWebFallbackModel || cfg.geminiWebModel) && wanted === String(cfg.geminiWebModel || '').trim().toLowerCase();
  const stalled = (await chatLoad(GW_STALL_KEY)) || {};
  if (another && model && stalled[model.id] && Date.now() - stalled[model.id] < GW_STALL_SKIP_MS) {
    gwLog('ask.skip-stalled', { model: model.label || model.name, note: 'gave no answer lately — asking the next model' });
    return { ok: false, status: 504, text: async () => JSON.stringify({
      error: { message: `${model.label || model.name} gave no answer lately — asking the next model` } }) };
  }
  gwLog('ask.model', { picked: model ? (model.label || model.name) : '(account default)', id: model?.id || '', available: models.map(m => m.label || m.name), chat: saved ? `continuing, turn ${saved.turns + 1}` : 'new' });
  const generate = async chat => {
    const prompt = promptFor(chat);
    const t = Date.now();
    gwLog('gen.send', { chat: chat ? 'continued' : 'new', model: model?.label || model?.name || '(default)', promptChars: prompt.length, instructionsSent: !(chat && chat.sys === gwHash(system)), passageSent: !!passage && !(chat && chat.passage === gwHash(passage)), picture: !!fileData });
    let r;
    try { r = await generateRaw(chat, prompt); }
    catch (e) { gwLog('gen.error', { ms: Date.now() - t, error: String(e?.message || e) }); throw e; }
    gwLog('gen.reply', {
      ms: Date.now() - t, ok: r.ok, status: r.status, failure: r.failure || '', code: r.code || 0, done: r.done,
      textChars: (r.text || '').length, text: String(r.text || '').slice(0, 200), thoughtsChars: (r.thoughts || '').length,
      detail: r.ok ? '' : String(r.detail || '').slice(0, 300), ids: r.cid ? 'yes' : 'no', ...(r.diag ? { tab: r.diag } : {}),
    });
    return r;
  };
  const generateRaw = (chat, prompt) => gwCall(tab.id, {
    type: 'gw-generate',
    session: sess.session,
    prompt,
    model,
    // The retry that follows a reply cut off mid-thought asks for less thinking rather than the
    // same amount; the account's own saved level is used otherwise.
    thinking: thinkingOff ? 'low' : (cfg.geminiWebThinking || ''),
    fileData,
    chat: chat ? [chat.cid, chat.rid, chat.rcid] : null,
    noTextMs: another ? GW_NO_TEXT_MS : 0,
  });

  const tGen = Date.now();
  let out = await generate(saved);
  // A remembered session the site no longer accepts shows up as a refused request. Ask again with
  // a fresh one before blaming the conversation, the account or the model; the same chat goes on.
  let sessionRefused = false;          // refused, then refused again with a fresh session: not the model's fault
  if (sess.cached && gwSessionStale(out)) {
    gwLog('retry.stale-session', { status: out.status, code: out.code || 0 });
    sessionRefused = true;
    await gwCacheDrop();
    sess = await gwSession(tab, cfg, { fresh: true });
    ({ models, model } = pick(sess.found));
    stage.cached = false;
    out = await generate(saved);
  }
  // The conversation was deleted from the site's list, or it would not be continued: ask again in
  // a fresh one, once. An empty allowance or a rate limit would fail the same way again.
  if (saved && gwChatLost(out)) {
    gwLog('retry.chat-lost', { note: 'the kept conversation would not continue — new one', code: out.code || 0 });
    if (out.code === 1097) {
      await chatSave(GW_NO_FOLLOWUP_KEY, { ...noFollowUp, [accountKey]: Date.now() });
      gwLog('chat.followups-off', { note: 'error 1097 on a follow-up: new conversations only, for a day' });
    }
    await chatClear(GW_CHAT_KEY);
    saved = null;
    out = await generate(null);
  }
  // Flash was picked here, not by the person: if the site will not have it, the account's own default
  // (no model named at all) is what used to work, so ask that way once, in a fresh conversation.
  // Only a refusal that is still there with a fresh session (a 400): a rate limit or an empty
  // allowance would only be spent again.
  if (!wanted && model && !out.ok && out.status === 400 && !sessionRefused) {
    gwLog('retry.default-model', { note: 'Flash refused — asking with the account default' });
    model = null;
    saved = null;
    out = await generate(null);
  }
  // The site's own error message came back as the reply. Nothing says why — a session gone stale, a
  // conversation that has gone bad, the site having a moment — so each retry changes both things
  // that are ours to change: a fresh session, and a fresh conversation (the one that just said this
  // is not one to go on with). It waits a little first, longer the second time.
  for (let n = 0; out.ok && !out.failure && gwErrorReply(out.text) && n < GW_ERROR_REPLY_WAITS.length; n++) {
    gwLog('retry.error-reply', { n: n + 1, text: String(out.text).slice(0, 120) });
    await chatClear(GW_CHAT_KEY);
    saved = null;
    await pause(GW_ERROR_REPLY_WAITS[n]);
    await gwCacheDrop();
    sess = await gwSession(tab, cfg, { fresh: true });
    ({ models, model } = pick(sess.found));
    stage.cached = false;
    out = await generate(null);
  }
  stage.ai = (stage.ai || 0) + (Date.now() - tGen);

  if (!out.ok) {
    gwLog('ask.failed', { status: out.status || 502, detail: String(out.detail || '').slice(0, 300) });
    // Not a word of answer in all that time: remember it, so the next questions go to the next model.
    if (out.status === 504 && model?.id && another) {
      await chatSave(GW_STALL_KEY, { ...stalled, [model.id]: Date.now() });
      gwLog('model.stalled', { model: model.label || model.name, note: `skipped for ${GW_STALL_SKIP_MS / 60000} min while another can answer` });
    }
    return { ok: false, status: out.status || 502, text: async () => JSON.stringify({
      error: { message: out.detail || 'the Gemini page refused the request' } }) };
  }
  if (out.failure) {
    gwLog('ask.refused', { code: out.code, failure: out.failure });
    // `retryable` and `code` ride along for askCore: a code that means "not now" is waited out.
    return { ok: false, status: 429, code: out.code, retryable: GW_RETRY_CODES.includes(out.code),
             text: async () => JSON.stringify({ error: { message: out.failure } }) };
  }

  // Still its own error message after all the tries: not an answer. (The conversation it came from is
  // not kept: each try cleared it first, and this is never saved.) 503 tells askCore it is worth
  // waiting out — a few times, not for ever (see askPatiently).
  if (gwErrorReply(out.text)) {
    return { ok: false, status: 503, text: async () => JSON.stringify({
      error: { message: `the Gemini site answered with its own error message: "${out.text.trim().slice(0, 140)}"` } }) };
  }

  if (reuse && out.text && out.cid && out.rid && out.rcid) {
    await chatSave(GW_CHAT_KEY, {
      cid: out.cid, rid: out.rid, rcid: out.rcid,
      turns: (saved?.turns || 0) + 1, model: model?.id || '', account: accountKey, at: Date.now(),
      sys: gwHash(system), passage: passage ? gwHash(passage) : (saved?.passage || 0),
    });
  }

  // It answered: whatever it did before, it is not stalled now.
  if (model?.id && stalled[model.id]) { delete stalled[model.id]; await chatSave(GW_STALL_KEY, stalled); }
  const finish = out.done ? 'stop' : 'length';
  gwLog('ask.done', { ms: Date.now() - tStart, finish, textChars: (out.text || '').length });
  return {
    ok: true,
    status: 200,
    text: async () => out.text,
    json: async () => ({ choices: [{ message: { content: out.text }, finish_reason: finish }] }),
  };
}

const GW_NO_FOLLOWUP_KEY = 'geminiWebNoFollowUp';

/** A short fingerprint of a text, to tell "the same as last time" without keeping the text. */
function gwHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** The passage block of a prompt (see buildQuestionText), or ''. */
function gwPassageOf(text) {
  const m = /^=== PASSAGE ===\n([\s\S]*?)\n\n\n(?====)/m.exec(text);
  return m && m[1].length > 200 ? m[1] : '';      // a short one is not worth the swap
}

/** The account's quickest model: a Flash that is not a thinking one, else any Flash, else none
 *  (the account's own default). */
function gwFastModel(models, avoid = '') {
  const name = m => `${m.name || ''} ${m.label || ''} ${m.id || ''}`.toLowerCase();
  const ok = m => !avoid || ![m.name, m.label, m.id].some(v => String(v || '').toLowerCase() === avoid);
  // Flash-Lite first: of the models the site offers, it is the one that answers soonest.
  return models.find(m => ok(m) && /flash.?lite/.test(name(m)))
      || models.find(m => ok(m) && /flash/.test(name(m)) && !/think|pro|deep|research/.test(name(m)))
      || models.find(m => ok(m) && /flash/.test(name(m))) || null;
}

/** The fallback put behind a chosen model when none was set (see the chain in ask). */
const GW_AUTO_FAST = '__fastest__';
/** Models that gave no answer at all lately, by id: skipped for GW_STALL_SKIP_MS while another
 *  model can be asked, rather than costing every question the wait. */
const GW_STALL_KEY = 'geminiWebStalled';
const GW_STALL_SKIP_MS = 30 * 60000;
/** How long a model with another behind it gets to start answering before that one is asked. */
const GW_NO_TEXT_MS = 30000;

/** Options' "Test key" for this provider: prove the tab, the login and the model list work,
 *  without asking the model anything. */
async function geminiWebSelfTest() {
  let tab;
  try { tab = await gwTab(); } catch (e) { return { error: String(e.message || e) }; }
  if (!tab) {
    return { error: 'No signed-in gemini.google.com tab is open. Open one, sign in, and leave it open, then try again.' };
  }
  let init;
  try { init = await gwCall(tab.id, { type: 'gw-init' }); } catch (e) { return { error: String(e.message || e) }; }
  if (!init.ok) return { error: init.detail || 'the page gave no session' };

  let found;
  try { found = await gwCall(tab.id, { type: 'gw-models', session: init.session }); } catch (e) { return { error: String(e.message || e) }; }
  if (!found.ok) return { error: found.detail || 'the model list could not be read' };

  const models = (found.models || []).map(m => ({ ...m, ...found.capacity }));
  if (models.length || String(found.status) === '1000') {
    try { await chrome.storage.local.set({ geminiWebModels: models }); } catch { /* only a cache */ }
  }

  // The status codes the site uses for "this account is not actually usable" — the login can be
  // live and the account still be barred, so this is worth saying rather than reporting success.
  const trouble = { 1016: 'the session is not signed in any more', 1014: 'access is restricted for this session',
                    1021: 'this account is not allowed', 1033: 'the account did not pass a safety check',
                    1040: 'a new terms of service has to be accepted on the site', 1042: 'the terms of service are out of date',
                    1054: 'a parent or guardian has blocked access', 1057: 'a parent or guardian must approve access',
                    1060: 'Gemini is not available in this country' }[found.status];
  if (trouble) return { error: `the login works, but ${trouble} — open gemini.google.com and sort that out` };

  if (!models.length) return { error: 'the login works, but no models came back — the site has probably changed' };
  // A login that has just been proved is worth keeping, so the first real question starts warm.
  if (found.status === 1000) await gwCachePut({ key: gwTabKey(tab), at: Date.now(), session: init.session, found });
  return { ok: true, note: `Signed in. ${models.length} model${models.length === 1 ? '' : 's'} available: ${models.map(m => m.label || m.name).join(', ')}.` };
}

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

/** One question, timed. The work is askCore(); this stamps the whole on the answer and keeps the
 *  numbers (see "speed"). A failed question is shown its timing but not logged: an error that
 *  came back quickly would make a switch look faster than it is. */
async function ask(payload) {
  const started = Date.now();
  speedStages = {};
  const out = await askCore(payload);
  if (out && typeof out === 'object') {
    const timing = { total: Date.now() - started, ...speedStages };
    if (Number.isFinite(payload?.shotMs)) timing.shot = Math.round(payload.shotMs);
    out.timing = timing;
    if (!out.error) await speedLogAdd(timing);
  }
  return out;
}

async function askCore(payload) {
  const cfg = await settings();
  speedStages.mode = speedMode(cfg);
  const gemini = cfg.provider === 'gemini';
  const openai = cfg.provider === 'openai';
  const deepseek = cfg.provider === 'deepseek';
  const gweb = cfg.provider === 'gemini-web';
  const missing = gemini ? 'No Gemini API key set — open the extension Options and paste one.'
                : openai ? 'No OpenAI API key set — open the extension Options and paste one.'
                : deepseek ? 'No DeepSeek token set — open Options and press “Copy token from the site”.'
                : gweb ? 'No signed-in gemini.google.com tab is open — open one and leave it open.'
                : 'No API key set — open the extension Options and paste one.';
  if (gemini ? !cfg.geminiKey : openai ? !cfg.openaiKey : deepseek ? !cfg.deepseekToken : gweb ? false : !cfg.apiKey) {
    return { error: missing };
  }

  // A model box saved empty means "the default", not "no model to ask". For the site itself an
  // empty box is a real choice — it means the account's own default model, which the site picks
  // when no model header is sent, and which every account has.
  const chain = (gemini ? [cfg.geminiModel || DEFAULTS.geminiModel, cfg.geminiFallbackModel]
               : openai ? [cfg.openaiModel || DEFAULTS.openaiModel, cfg.openaiFallbackModel]
               : deepseek ? [cfg.deepseekModel || DEFAULTS.deepseekModel, cfg.deepseekFallbackModel]
               : gweb ? [cfg.geminiWebModel, cfg.geminiWebFallbackModel || (cfg.geminiWebModel ? GW_AUTO_FAST : '')].filter(Boolean)
               : [cfg.model, cfg.fallbackModel]).filter(Boolean);
  if (gweb && !chain.length) chain.push('');   // the account's own default
  const oa = {};                 // OpenAI only: what a model has turned out not to accept (see toOpenAI)
  // DeepSeek's chat takes text only, so the picture is dropped here rather than failing a
  // request with it. The question text then says the figure could not be attached.
  const sent = deepseek ? { ...payload, image: null, images: [] } : payload;
  let body = buildBody(cfg, sent);
  let imageDropped = deepseek && !!(payload.image || payload.images?.length);
  const errors = [];
  // A rate limit is a wait, not a failure. When any try is turned away for asking too much, that is
  // remembered here — `limit` is { note, retryAfterMs } — and the answer says so, so the page can
  // wait and ask again instead of ending the run.
  let limit = null;
  const limited = (note, res, { retryLimit } = {}) => {
    limit = {
      note,
      retryAfterMs: Math.max(limit?.retryAfterMs || 0, retryAfterOf(res)),
      // Most limits are waited out for as long as it takes; one that is given a number is not (see 503).
      ...(retryLimit != null ? { retryLimit } : {}),
    };
  };
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
    if (deepseek) return deepseekComplete(cfg, body, model, thinking === 'off' || thinking === 'low');
    if (gweb) return geminiWebComplete(cfg, body, model, thinking === 'off' || thinking === 'low');
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
  const rebuilt = extra => { const b = buildBody(cfg, { ...sent, ...extra }); return tokensRaised ? forRetry(b) : b; };

  /** One round trip. Resolves { parsed } on success, or { error, then } where
   *  `then` says what the caller should do next: 'network' (give up on this
   *  model), 'format' (retry without response_format), 'model' (try the next
   *  model), 'again' (try the next way of asking this one) or 'stop' (give up
   *  altogether: the key is refused, and every model would be). */
  const attempt = async (model, structured) => {
    // The Gemini-site provider treats an empty model box as a real choice — the account's own
    // default — so its messages say that rather than starting with a bare colon.
    const named = model || (gweb ? 'the account\'s default model' : model);
    let res;
    try {
      res = await post(model, structured);
    } catch (e) {
      return { error: `${named}: ${e}`, then: 'network' };   // network is down, another model won't help
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);

      // Google says a wrong key as a plain 400, and a key that may not use this model as a 403:
      // another model or another way of asking will be refused the same way, so stop here and
      // say what to check.
      if (gemini && (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(detail))) {
        return { error: `${named}: Gemini refused the request (HTTP ${res.status}) — check the key in Options. ${detail.slice(0, 160)}`, then: 'stop' };
      }

      // OpenAI says a wrong key as a 401. Every model would be refused the same way: stop, and say what to check.
      if (openai && (res.status === 401 || /invalid_api_key|Incorrect API key/i.test(detail))) {
        return { error: `${named}: OpenAI refused the key (HTTP ${res.status}) — check it in Options. ${detail.slice(0, 160)}`, then: 'stop' };
      }

      // DeepSeek refuses a stale or wrong token the same way whatever the model: stop, and say
      // how to fix it rather than burning the whole chain on it.
      if (deepseek && (res.status === 401 || res.status === 403 || /invalid|expired|unauthor/i.test(detail))) {
        return { error: `${named}: DeepSeek refused the token (HTTP ${res.status}) — open the site, sign in, and press “Copy token from the site” in Options. ${detail.slice(0, 120)}`, then: 'stop' };
      }

      // The site throttles by account, not by model: a second model would be refused too.
      if (deepseek && res.status === 429) {
        limited('DeepSeek is rate-limiting this account', res);
        return { error: `${named}: DeepSeek is rate-limiting this account (HTTP 429) — wait a moment and try again. ${detail.slice(0, 120)}`, then: 'stop' };
      }

      // The Gemini site says the same thing about the account whatever model is named, so there
      // is no point walking the chain: stop and say which of the two usual causes it is.
      if (gweb && (res.status === 401 || res.status === 403 || /not signed in|no session token/i.test(detail))) {
        return { error: `${named}: gemini.google.com would not accept the session (HTTP ${res.status}) — open the site, sign in, and reload the tab. ${detail.slice(0, 140)}`, then: 'stop' };
      }
      // The site's own error message, still there after the quick tries inside geminiWebComplete: wait
      // and ask again, but only a few times — a question it keeps failing on must end the run with
      // a report, not hold it up for good.
      if (gweb && res.status === 503) {
        limited('the Gemini site answered with its own error message', res, { retryLimit: 4 });
        return { error: `${named}: ${detail.slice(0, 200)}`, then: 'stop' };
      }
      if (gweb && res.status === 429) {
        // Only a code that means "not now" is waited out; any other failure the page reports as it did.
        if (res.retryable !== false) limited(`the Gemini site is limiting this account${res.code ? ` (error ${res.code})` : ''}`, res);
        return { error: `${named}: the Gemini site is limiting this account (HTTP 429) — wait a while and try again, or pick another service. ${detail.slice(0, 140)}`, then: 'stop' };
      }

      // OpenRouter was told to switch thinking off and the model will not have it (some think whether asked
      // or not): ask for less of it instead.
      if (!gemini && !openai && thinking === 'off' && res.status === 400 && /reasoning/i.test(detail)) {
        thinking = 'low';
        errors.push(`${named}: cannot switch thinking off — asked for less of it`);
        return attempt(model, structured);
      }

      // The newer OpenAI models take no temperature and call the limit max_completion_tokens; older ones
      // want max_tokens. The first answer is a 400 naming the thing; ask again the other way, once each.
      if (openai && res.status === 400 && /temperature/i.test(detail) && !oa.noTemperature) {
        oa.noTemperature = true;
        errors.push(`${named}: takes no temperature — asked without`);
        return attempt(model, structured);
      }
      if (openai && res.status === 400 && /max_completion_tokens/i.test(detail) && !oa.legacyTokens) {
        oa.legacyTokens = true;
        errors.push(`${named}: takes max_tokens, not max_completion_tokens — asked that way`);
        return attempt(model, structured);
      }

      // A model that cannot read pictures at all says so — OpenRouter as a 404 ("No endpoints found
      // that support image input"), others as a 400. That is a fact about the model, not about this
      // picture: the next model may well read it, so it is tried next, picture and all. Only when
      // none can does the question go out without it (below).
      if (hasImages(body) && NO_VISION.test(detail)) {
        blind.add(model);
        return { error: `${named}: cannot read pictures (HTTP ${res.status})`, then: 'model' };
      }

      // A picture the provider can't fetch or read — a 401 on an image URL, an
      // unsupported format — must not cost the answer. Send the same request
      // without any images; the prompt then says the figure couldn't be attached.
      if (res.status === 400 && /image/i.test(detail) && hasImages(body)) {
        errors.push(`${named}: dropped the images (${detail.slice(0, 90)})`);
        body = rebuilt({ image: null, images: [] });
        imageDropped = true;
        return attempt(model, structured);
      }
      // A plain 429 from any other service is a wait too — unless OpenAI says the account's money has
      // run out (insufficient_quota), which waiting does not cure.
      if (res.status === 429 && !(openai && /insufficient_quota/i.test(detail))) {
        limited(`${gemini ? 'Gemini' : openai ? 'OpenAI' : 'OpenRouter'} is rate-limiting this account`, res);
      }
      return {
        error: `${named}${structured ? ' [json]' : ''}: HTTP ${res.status} ${detail}`,
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
      errors.push(`${named}: empty reply (finish_reason=${finish || 'none'}) — retried with ${RETRY_TOKENS} tokens, no extended thinking, and told to answer at once`);
      return attempt(model, structured);
    }

    return {
      error: `${named}: unparseable reply ${JSON.stringify(String(raw).slice(0, 120))} ` +
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
      // DeepSeek's own endpoint has no such setting, so it is asked exactly once: sending the
      // same question twice for a flag it ignores only burns the account's rate limit.
      for (const structured of deepseek || gweb ? [false] : [true, false]) {
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
  return {
    error: errors.join(' | ') || 'unknown failure',
    ...(limit ? { rateLimited: true, retryAfterMs: limit.retryAfterMs, limitNote: limit.note } : {}),
    ...(limit?.retryLimit != null ? { retryLimit: limit.retryLimit } : {}),
  };
}

/** How long a service said to wait before asking again (Retry-After: seconds, or a date), in
 *  milliseconds; 0 when it did not say, or when there was no response to ask. */
function retryAfterOf(res) {
  const v = res?.headers?.get?.('retry-after');
  if (v == null || v === '') return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/** Options' "Test key": ask for a challenge and answer it, without asking the model anything. */
async function deepseekSelfTest(token) {
  if (!token) return { error: 'no token given' };
  let res;
  try {
    res = await dsCall(DS_CHALLENGE, token, { target_path: DS_COMPLETION });
  } catch (e) {
    return { error: `could not reach chat.deepseek.com: ${e.message || e}` };
  }
  if (!res.ok) {
    const d = (await res.text().catch(() => '')).slice(0, 160);
    const hint = res.status === 401 || res.status === 403
      ? ' The token has probably expired: sign in on the site again and re-copy it.' : '';
    return { error: `DeepSeek refused it (HTTP ${res.status}).${hint} ${d}` };
  }
  let challenge;
  try {
    challenge = dsBiz(await res.json()).challenge;
  } catch (e) {
    return { error: `the reply was not a challenge (${e.message || e}) — the site has probably changed` };
  }
  if (!challenge?.challenge) return { error: 'the token works, but no challenge came back — the site has probably changed' };

  const t0 = Date.now();
  let answer = solvePow(challenge.challenge, challenge.salt, challenge.expire_at, challenge.difficulty, 1);
  let round = 1;
  if (answer === null) { round = 0; answer = solvePow(challenge.challenge, challenge.salt, challenge.expire_at, challenge.difficulty, 0); }
  if (answer === null) return { error: 'the token works, but the proof-of-work could not be solved — the site\'s puzzle has changed' };

  try { await chrome.storage.local.set({ deepseekPowRound: round }); } catch { /* best effort: only saves a retry */ }
  const ms = Date.now() - t0;
  return {
    ok: true,
    note: `Token works. Proof-of-work solved in ${ms} ms ` +
          `(answer ${answer}, difficulty ${challenge.difficulty}, ${round ? 'round-skipping' : 'standard'} digest).`,
  };
}

/* ------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ask') {
    ask(msg.payload)
      .then(r => { if (r?.error && /gemini/i.test(String(r.error))) gwLog('ask.gave-up', { error: String(r.error).slice(0, 400) }); respond(r); })
      .catch(e => { gwLog('ask.threw', { error: String(e?.message || e) }); respond({ error: String(e) }); });
    return true;
  }

  // Options checks a DeepSeek token with this: ask for a challenge and answer it, exactly as a
  // real question would, but without sending anything to the model. It proves the token is live
  // and that the proof-of-work is being solved correctly.
  if (msg.type === 'deepseek-test') {
    deepseekSelfTest(String(msg.token || '').trim())
      .then(respond)
      .catch(e => respond({ error: String(e) }));
    return true;
  }

  // Options checks the Gemini-site provider with this: is a signed-in tab open, and does the
  // site still hand out a model list for it? No question is sent to the model.
  if (msg.type === 'gemini-web-test') {
    geminiWebSelfTest()
      .then(respond)
      .catch(e => respond({ error: String(e) }));
    return true;
  }

  // The tab the extension will borrow, saying it is loaded and ready. Recorded so the popup can
  // say whether a usable tab exists without having to poll one every time it opens.
  // Failure reports and the popup's "Copy Gemini log" read the trace with this.
  if (msg.type === 'gw-log') {
    gwLogText({ limit: msg.limit || 120, sinceMs: msg.sinceMs || 0 }).then(text => respond({ text })).catch(e => respond({ text: '', error: String(e) }));
    return true;
  }
  if (msg.type === 'gw-log-clear') {
    gwLogBuf = [];
    chrome.storage.local.set({ [GW_LOG_KEY]: [] }).then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'gw-ready') {
    chrome.storage.local.set({ geminiWebTabSeen: Date.now() }).catch(() => {});
    return;
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
