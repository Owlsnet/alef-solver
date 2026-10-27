#!/usr/bin/env node
/* Typed math answers, tidied before they go in the box (cleanMathAnswer in content.js). A model writes
 * math its own way — LaTeX, dollar signs, the variable again, the unit the page already prints — and
 * typed as it comes that lands in the box as backslashes and words. No browser needed: the function
 * is plain string work, taken out of content.js and run here.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const from = SRC.indexOf('  const VULGAR = ');
const to = SRC.indexOf('  /** Fill in a cloze question\'s blanks');
if (from < 0 || to < 0) { console.error('✗ cleanMathAnswer not found in content.js'); process.exit(2); }
const { cleanMathAnswer, aroundBlank } = new Function(`${SRC.slice(from, to)}; return { cleanMathAnswer, aroundBlank };`)();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
const is = (input, want, ctx = {}, name) => {
  const got = cleanMathAnswer(input, ctx);
  check(name || `${JSON.stringify(input)} → ${JSON.stringify(want)}`, got === want, got === want ? '' : `got ${JSON.stringify(got)}`);
};

console.log('words are left exactly as they are');
is('increased', 'increased');
is('the Nile', 'the Nile');
is('  photosynthesis ', 'photosynthesis');

console.log('\nLaTeX becomes typed math');
is('\\frac{3}{4}', '3/4');
is('\\dfrac{x+1}{2}', '(x+1)/2');
is('\\frac{1}{x-3}', '1/(x-3)');
is('\\frac12', '1/2');
is('\\sqrt{2}', 'sqrt(2)');
is('3\\sqrt{5}', '3sqrt(5)');
is('\\sqrt[3]{8}', '(8)^(1/3)');
is('x^{2}+3x-4', 'x^2+3x-4');
is('2^{n+1}', '2^(n+1)');
is('4\\pi', '4pi');
is('x \\leq 5', 'x <= 5');
is('x\\geq -2', 'x>= -2');
is('3 \\times 10^{4}', '3 * 10^4');
is('\\left(2, 3\\right)', '(2, 3)');
is('12\\text{ cm}', '12 cm');
is('\\frac{\\sqrt{3}}{2}', '(sqrt(3))/2');          // the same number; the brackets do no harm

console.log('\ndollar signs, unicode and stray punctuation');
is('$\\frac{5}{8}$', '5/8');
is('$$x^2$$', 'x^2');
is('−7', '-7');
is('½', '1/2');
is('2½', '2 1/2');
is('√2', 'sqrt(2)');
is('√(x+1)', 'sqrt(x+1)');
is('2π', '2pi');
is('5.', '5');
is('x ≥ 3', 'x >= 3');

console.log('\nonly what goes in the box');
is('x = 5', '5', { before: 'Solve: 2x + 1 = 11, so x = ' }, 'the variable is dropped when the text already says "x ="');
is('x = 5', '5', {}, 'and around a bare number');
is('y = 2x + 3', 'y = 2x + 3', {}, 'but an equation that is the answer is kept');
is('35°', '35', { after: '°. Explain why' }, 'the unit the page prints after the box is dropped');
is('35^\\circ', '35', { after: '°' }, 'in LaTeX too');
is('35 degrees', '35', { after: '°' });
is('12 cm', '12', { after: ' cm' });
is('12 cm', '12 cm', { after: ' and' }, 'a unit the page does not print is kept');
is('45%', '45', { after: '% of the' });

console.log('\na box that takes only numbers');
is('3/4', '0.75', { numeric: true });
is('-1/8', '-0.125', { numeric: true });
is('2 1/2', '2.5', { numeric: true });
is('2/3', '0.6667', { numeric: true });
is('3/4', '3/4', {}, 'but a text or math box keeps the fraction');

console.log('\na math box (MathLive makes a fraction only of bracketed parts)');
is('3/4', '(3)/(4)', { math: true });
is('\\frac{3}{4}', '(3)/(4)', { math: true });
is('2 1/2', '2 (1)/(2)', { math: true });
is('(x+1)/2', '(x+1)/(2)', { math: true });
is('2/(x-1)', '(2)/(x-1)', { math: true });
is('(1)/(2)', '(1)/(2)', { math: true }, 'already bracketed: left alone');
is('3x^2 - 6x', '3x^2 - 6x', { math: true }, 'no fraction: left alone');
is('½', '(1)/(2)', { math: true });

console.log('\nthe words around a blank');
const t = 'The angle measures [BLANK 1]° and the side is [BLANK 2] cm.';
check('read before and after the right blank', aroundBlank(t, 0).after.startsWith('°') && aroundBlank(t, 1).after.startsWith(' cm') && aroundBlank(t, 1).before.endsWith('the side is '), JSON.stringify(aroundBlank(t, 1)));

console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
