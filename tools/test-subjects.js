#!/usr/bin/env node
/* Subject guidance in the prompt. Small models answer much better when told what the course expects in
 * that subject, so each question's system prompt starts with the exam rules and the guidance for its
 * subject — only that subject's, to keep the prompt short. The subject is the class the page names;
 * failing that, it is read off the question. Runs background.js in a sandbox: no browser, no model.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const ctx = vm.createContext({
  console,
  fetch: async () => { throw new Error('no network'); },
  chrome: { runtime: { onMessage: { addListener() { } } }, storage: { local: { get: async () => ({}), set: async () => {} } } },
});
vm.runInContext(SRC, ctx, { filename: 'background.js' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
const q = extra => ({ kind: 'choice', stem: 'Which one?', options: [{ text: 'a' }, { text: 'b' }], images: [], image: null, imageCount: 0, ...extra });

console.log('the class the page names');
for (const [cls, want] of [
  ['Math', 'math'], ['Physics', 'physics'], ['Chemistry', 'chemistry'], ['Biology', 'biology'],
  ['Arabic', 'arabic'], ['Islamic Studies', 'islamic'], ['Social Studies', 'social'], ['Moral Education', 'social'],
  ['English', 'english'], ['Science', 'science'], ['الرياضيات', 'math'], ['التربية الإسلامية', 'islamic'],
  ['اللغة العربية', 'arabic'], ['Bader | Safety Awareness (AR)', ''],
]) check(`${JSON.stringify(cls)} → ${want || '(none)'}`, ctx.subjectOf(q({ subject: cls })) === want, ctx.subjectOf(q({ subject: cls })));

console.log('\nno class named: read off the question');
for (const [stem, want] of [
  ['ما إعراب كلمة "الطالبُ" في الجملة؟', 'arabic'],
  ['ما حكم صلاة الجمعة؟', 'islamic'],
  ['How many moles of NaCl are in 58.5 g?', 'chemistry'],
  ['A car accelerates at 2 m/s for 5 s. What is its velocity?', 'physics'],
  ['Find the measure of the angle in the triangle.', 'math'],
  ['Who wrote the letter?', ''],
]) check(`${JSON.stringify(stem.slice(0, 40))} → ${want || '(none)'}`, ctx.subjectOf(q({ stem })) === want, ctx.subjectOf(q({ stem })));

console.log('\nthe prompt');
const sys = p => ctx.buildBody({}, p).messages[0].content;
const chem = sys(q({ subject: 'Chemistry' }));
check('every prompt carries the exam rules', /UAE Ministry of Education/.test(chem) && /NOT, EXCEPT/.test(chem) && /ليس، لا، عدا/.test(chem));
check('and its subject\'s guidance', /Subject: chemistry/.test(chem) && /molar/.test(chem));
check('but not the other subjects\'', !/Subject: physics/.test(chem) && !/التربية الإسلامية/.test(chem));
check('the answer format still comes last', /\{"work":"<steps, or empty>","answer":"<letter>"/.test(chem.split('\n').slice(-1)[0]), chem.split('\n').slice(-1)[0].slice(0, 80));
const ar = sys(q({ subject: 'Arabic', kind: 'dropdown', dropdown: { text: 'x [BLANK 1]', menus: [['a', 'b']] } }));
check('an Arabic dropdown gets the Arabic guidance and the dropdown format', /المادة: اللغة العربية/.test(ar) && /"picks"/.test(ar));
const none = sys(q({}));
check('a question with no subject still gets the exam rules, and no subject block', /UAE Ministry of Education/.test(none) && !/Subject:|المادة:/.test(none));
for (const kind of ['match', 'drag', 'sort']) {
  const extra = kind === 'match' ? { match: { left: ['a'], right: ['b'] } } : kind === 'drag' ? { drag: { items: ['a'], blanks: 1 } } : { sort: { items: ['a', 'b'] } };
  check(`the ${kind} prompt asks for its working first too`, /\{"work":/.test(sys(q({ kind, ...extra }))));
}
const words = s => s.split(/\s+/).length;
check('the whole system prompt stays short (under 450 words)', words(chem) < 450, `${words(chem)} words`);

console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
