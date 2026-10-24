/* Runs in the PAGE's own JavaScript world (manifest: "world": "MAIN"), not in the extension's.
 *
 * Why it exists: a math answer box is a <math-field> (MathLive), a custom element defined by the
 * page's own code. The extension's page script (content.js) runs in an isolated world, where that
 * element's methods and properties — insert, value, executeCommand — do not exist; writing .value
 * there only creates a property on the isolated world's private copy of the element, and the real
 * field never hears of it. So the field is driven from here instead.
 *
 * The two worlds share the DOM and nothing else, so the request goes in an attribute on the field
 * (data-alef-req, JSON) with an "alef-math" event, and the answer comes back in data-alef-out.
 * Nothing else is exposed, and nothing here touches anything but the field it is asked about.
 */
(() => {
  if (window.__alefBridge) return;
  window.__alefBridge = true;

  document.addEventListener('alef-math', ev => {
    const mf = ev.target;
    if (!mf || typeof mf.getAttribute !== 'function') return;

    let req = {};
    try { req = JSON.parse(mf.getAttribute('data-alef-req') || '{}'); } catch { /* an empty request reads the value */ }
    const text = String(req.text ?? '');
    const out = { reached: true, op: req.op, ok: false, has: typeof mf.insert === 'function' };

    try {
      switch (req.op) {
        case 'get': out.ok = true; break;
        case 'clear': mf.value = ''; out.ok = true; break;
        // MathLive's own insert — what the on-screen keyboard and a paste use. ASCII math ("x^2",
        // "sqrt(x)", "(a)/(b)") or LaTeX.
        case 'insert':
          mf.focus();
          mf.insert(text, { format: req.format || 'ascii-math', insertionMode: 'replaceAll', selectionMode: 'after' });
          out.ok = true; break;
        // Typed through MathLive's keystroke handling, as if each key were pressed.
        case 'typed': mf.focus(); mf.executeCommand(['typedText', text]); out.ok = true; break;
        // The browser's own text insertion into whatever is focused.
        case 'exec': mf.focus(); out.ok = document.execCommand('insertText', false, text); break;
        // Focusing a field opens the math keyboard; it is put away again afterwards.
        case 'hide': if (window.mathVirtualKeyboard && window.mathVirtualKeyboard.hide) window.mathVirtualKeyboard.hide(); out.ok = true; break;
      }
    } catch (e) { out.error = String((e && e.message) || e); }

    try { out.value = String(mf.value ?? ''); } catch { out.value = ''; }
    mf.setAttribute('data-alef-out', JSON.stringify(out));
  }, true);
})();
