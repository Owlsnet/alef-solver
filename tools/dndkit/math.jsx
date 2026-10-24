/* A typed-math question, built on the real MathLive — the library behind the live site's answer boxes
   (its field is a <math-field> with aria-label "Math expression edit", wrapped in
   .InlineMathEditor_wrapper, with a "Type…" label of its own drawn beside it and a keyboard button).
   What MathLive does by itself — how a value is set, which events it sends, how it writes a formula
   back — is the real thing. The wrapper and the page around it copy the live page's structure, and the
   formulas in the question text are laid out the way MathJax lays them out (an invisible MathML copy
   beside the drawn one), which is what the page's own text then reads as.

   Query string:
     blanks=1|2        one box (f(x) = ▢ − 6x + 8) or two ("The vertex is ( ▢ , ▢ )")
     power=1           the question text has a power in it (x² − 4x + 4), as MathML                    */

import 'mathlive';

const q = new URLSearchParams(location.search);
const TWO = q.get('blanks') === '2';

window.__events = [];
window.__submitted = null;
window.__sideClicks = 0;

const mjx = (visual, mathml) =>
  `<mjx-container class="MathJax" style="display:inline-block"><mjx-math>${visual}</mjx-math>` +
  `<mjx-assistive-mml style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"><math xmlns="http://www.w3.org/1998/Math/MathML">${mathml}</math></mjx-assistive-mml></mjx-container>`;

const FIELD = i => `
  <span><div class="lib-fib-input-field-container lib-fib-math-editor-container" data-i="${i}">
    <span class="InlineMathEditor_wrapper lib-fib-math-editor" style="display:inline-flex;align-items:center;border:1px solid #333;border-radius:6px;padding:4px;position:relative">
      <span class="InlineMathEditor_fieldArea" style="position:relative;display:inline-block;min-width:140px">
        <math-field class="InlineMathEditor_field" aria-label="Math expression edit" style="min-width:4px;display:inline-block;font-size:20px;border:0;outline:0"></math-field>
        <span class="InlineMathEditor_placeholder" style="position:absolute;left:4px;top:4px;color:#888;pointer-events:none">Type...</span>
      </span>
      <button class="InlineMathEditor_keyboardButton" aria-label="Open math keyboard" type="button" style="width:36px;height:36px">⌨</button>
    </span>
  </div></span>`;

const SENTENCE = TWO
  ? `<p>The vertex coordinate of ${q.has('power') ? mjx('<mjx-mi>f</mjx-mi>', '<mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo><msup><mi>x</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>x</mi><mo>+</mo><mn>4</mn>') : 'the function'} is:</p>
     <p>( ${FIELD(1)} , ${FIELD(2)} )</p>`
  : `<p>Complete the polynomial function that has a degree of 2 and a leading coefficient of 3.</p>
     <p>${mjx('<mjx-mi>f</mjx-mi>', '<mi>f</mi><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow><mo>=</mo>')} ${FIELD(1)} ${mjx('<mjx-mo>−</mjx-mo>', '<mo>−</mo><mn>6</mn><mi>x</mi><mo>+</mo><mn>8</mn>')}</p>`;

document.getElementById('app').innerHTML = `
  <aside style="position:fixed; right:6px; top:70px; width:150px; z-index:5; font-size:12px"><nav>
    <button id="side" style="width:100%; padding:8px">Check My Understanding</button>
  </nav></aside>
  <div class="lib-template-container-wrapper" style="margin:60px 0 0 120px; width:900px">
    <div class="lib-fib-container lib-blankOnText lib-question-widget">
      <div class="lib-fib-container-box"><div class="lib-fib-container-wrapper" role="main"><div class="lib-fib-fields-container">
        <div class="lib-fib-content-container"><div class="lib-fib-fields-wrapper">
          <h3 id="question-instruction" class="lib-instruction-label">Type the correct answer(s).</h3>
          <span><div class="lib-fib-sentence-container">${SENTENCE}</div></span>
        </div></div>
      </div></div></div>
    </div>
  </div>
  <div id="widgets-navigation-container" class="lib-navigation-container" style="position:fixed;left:0;right:0;bottom:0;padding:12px 24px;display:flex;justify-content:flex-end;background:#fff;border-top:2px solid #e6e9ef">
    <div class="lib-navigation-next-skip-wrapper"><button id="submit" type="submit" class="lib-btn-next" disabled style="padding:10px 22px">Submit Answer ›</button></div>
  </div>`;

document.getElementById('side').addEventListener('click', () => { window.__sideClicks++; });

const fields = [...document.querySelectorAll('math-field')];
for (const mf of fields) {
  // (the default keyboard policy: focusing a field opens the math keyboard, as on the live page)
  mf.addEventListener('input', () => { window.__events.push('input'); update(); });
  mf.addEventListener('change', () => { window.__events.push('change'); update(); });
}
// The wrapper draws its own "Type…" while the field is empty, and Submit waits for every field.
function update() {
  let all = true;
  fields.forEach((mf, i) => {
    const empty = !mf.value;
    document.querySelectorAll('.InlineMathEditor_placeholder')[i].style.display = empty ? '' : 'none';
    if (empty) all = false;
  });
  document.getElementById('submit').disabled = !all || window.__submitted != null;
}
window.__values = () => fields.map(f => f.value);
document.getElementById('submit').addEventListener('click', () => {
  window.__submitted = fields.map(f => f.value);
  update();
});
update();
