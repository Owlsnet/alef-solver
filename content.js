/* Alef Solver — content script.
 *
 * Runs in every frame of the page so it can find the one holding the question.
 * Hotkey fires in the top frame only; the background then fans a "do-solve"
 * message out to all frames and whichever one has a question does the work.
 */
(() => {
  'use strict';

  if (window.__alefSolverLoaded) return;
  window.__alefSolverLoaded = true;

  const IS_TOP = window === window.top;
  // Which copy of this script is running. The popup compares it with its own, so a
  // tab left on an older copy after the extension was reloaded can be told apart
  // from a page that simply has no question on it.
  const BUILD = (() => { try { return chrome.runtime.getManifest().version; } catch { return 'dev'; } })();
  const CFG = {
    autoSubmit: true,
    openPassage: true,
    screenshot: 'auto',
    answerDelay: 120,
    advance: true,        // click Next after each question
    cachePassage: true,   // reuse the passage across a lesson
    stepDelay: 250,       // settle time after the next question renders
    retries: 3,           // "Try Again" clicks allowed on a question marked wrong; 0 = off
    devMode: false,       // shows Dump / Copy last report; set in Options
    hotkeys: null,        // shortcuts set in Options; an action it does not name keeps its default
    autoNextLesson: false, // after the last question: press Done and go on to the next lesson
    maxLessons: 100,      // lessons per run when autoNextLesson is on
    slideWaitMs: 45000,   // how long to wait for a greyed-out Next on a slide to unlock (not in Options)
    skipLater: true,      // a question that offers "I'll try later" is skipped with it, not answered
  };

  // What each shortcut was before it could be changed. Options and the popup keep the
  // same table (a test checks all three agree). `null` is "no shortcut".
  const DEFAULT_HOTKEYS = {
    solve:  { code: 'KeyS', key: 's', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+S' },
    lesson: null,
    stop:   { code: 'KeyX', key: 'x', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+X' },
    dump:   { code: 'KeyD', key: 'd', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+D' },
  };
  const MAX_QUESTIONS = 50;   // runaway guard on the lesson loop
  let busy = false;
  let stopRun = false;

  // Visible to the test harness so it can tell when a run has finished.
  Object.defineProperty(window, '__alefSolverRunning', { get: () => busy });

  /* ============================================================ utilities */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  /** Arabic with its marks taken off: vowel signs, shadda and tatweel removed, the
   *  alef forms made one letter, and ى / ة written as ي / ه. أُرسلُ إجابتي and
   *  ارسل اجابتي then compare equal, which is how every Arabic test here is written. */
  const arNorm = s => (s || '')
    .replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  const AR_LETTER = '\\u0621-\\u064A';     // what ends a word in Arabic: \b and \w see none of it

  /** The words an instruction line uses for a kind of question. The detectors are
   *  expensive, so they only run on a page that asks for what they find — and that
   *  must hold in Arabic, where "drag" is أسحب. Tested on marks-free text. */
  const SAYS = {
    drag: new RegExp(`\\bdrag\\b|(?<![${AR_LETTER}])(?:ا?سحب|اجرر)`, 'i'),
    match: new RegExp(`\\bmatch\\b|(?<![${AR_LETTER}])(?:طابق|وصل|اربط|اقرن)|(?<![${AR_LETTER}])صل(?![${AR_LETTER}])`, 'i'),
  };
  const says = (kind, text) => { const t = text ?? (document.body.innerText || ''); return SAYS[kind].test(arNorm(t)); };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  function disabled(el) {
    // data-disabled="" means disabled (Radix and friends); data-disabled="false" is a
    // control that is not.
    const dd = el.getAttribute('data-disabled');
    return el.disabled === true ||
           el.getAttribute('aria-disabled') === 'true' ||
           (dd != null && dd !== 'false');
  }

  function txt(el) {
    if (!el) return '';
    return norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
  }

  /** Dispatch a full pointer/mouse sequence at an element.
   *
   *  Radix and friends listen on pointerdown, so a bare .click() often does
   *  nothing. Coordinates matter too: libraries that hit-test the event against
   *  the target ignore a click at (0,0). */
  function fireClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, detail: 1,
    };
    const up = { ...opts, buttons: 0 };
    const seq = [
      ['pointerdown', PointerEvent, opts],
      ['mousedown', MouseEvent, opts],
      ['pointerup', PointerEvent, up],
      ['mouseup', MouseEvent, up],
      ['click', MouseEvent, up],
    ];
    for (const [type, Ctor, init] of seq) {
      try { el.dispatchEvent(new Ctor(type, init)); }
      catch { try { el.dispatchEvent(new MouseEvent(type, init)); } catch { /* ignore */ } }
    }
  }

  /** Exactly one click. Never fire this twice "to be safe": clicks are not
   *  idempotent — Read Passage is a toggle, and Submit can turn into Next. */
  function realClick(el) {
    if (!el) return false;
    fireClick(el);
    return true;
  }

  /** A cheap fingerprint of what the user would see change when a click lands:
   *  the page text, plus the state and class of every control.
   *
   *  Typed values are deliberately left out, so filling a blank doesn't count
   *  as a change — only the page reacting does. The HUD is skipped, since it
   *  rewrites itself while we work. */
  function pageSignature() {
    let h = 5381;
    const mix = s => { for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0; };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        const tag = n.parentElement?.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (hudEl && hudEl.contains(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode());) {
      const t = n.nodeValue.trim();
      if (t) mix(t + '\u0001');
    }

    const controls = 'button, [role="button"], [role="radio"], [role="option"], input, textarea, a';
    for (const el of document.querySelectorAll(controls)) {
      if (hudEl && hudEl.contains(el)) continue;
      mix([
        el.tagName,
        el.offsetParent === null ? 'h' : '',          // shown or hidden: a dialog's buttons often just toggle
        el.disabled ? 'd' : '', el.readOnly ? 'r' : '',
        el.getAttribute('aria-checked'), el.getAttribute('aria-disabled'),
        el.getAttribute('data-state'), el.getAttribute('class'),
      ].join('|'));
    }
    return `${h}:${document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live]').length}`;
  }

  /** Click once and check the page reacted. Resolves { ok, via }.
   *
   *  Only if the page is demonstrably unchanged after `settle` ms does it try
   *  something else: sites often bind the handler to a wrapper rather than the
   *  button, so it walks up two ancestors, then falls back to a native
   *  .click(). Waiting first matters — grading can be a network round trip,
   *  and a second click while the first is landing is how you submit twice. */
  async function clickConfirmed(el, { settle = 1200 } = {}) {
    const before = pageSignature();
    const reacted = async ms => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (!el.isConnected || pageSignature() !== before) return true;
        await sleep(80);
      }
      return false;
    };

    fireClick(el);
    if (await reacted(settle)) return { ok: true, via: 'element' };

    let up = el.parentElement;
    for (let d = 1; up && d <= 2 && up !== document.body; d++, up = up.parentElement) {
      fireClick(up);
      if (await reacted(600)) return { ok: true, via: `ancestor+${d}` };
    }

    el.click?.();
    if (await reacted(600)) return { ok: true, via: 'native' };
    return { ok: false, via: null };
  }

  /** Click whatever element in the row actually carries the click handler. */
  // Buttons on an answer card that do something else: on a picture card the first button is the
  // magnifier ("Zoom In"), which opens the picture instead of choosing it.
  const NOT_A_CHOICE = /zoom|enlarge|magnif|expand|full-?screen|\bplay\b|audio|speak|hint|help|close/i;

  const sideAction = b => NOT_A_CHOICE.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${typeof b.className === 'string' ? b.className : ''} ${b.getAttribute('data-testid') || ''}`);

  /** Where a person's press lands on a card: the element under its middle (failing that, near its
   *  tick mark). An event aimed there rises through the card and everything above it, so a handler on
   *  anything in that chain sees it; one aimed at the card's own box never reaches a handler below it.
   *  Never one of the card's own buttons (a picture's magnifier), and never outside the card. */
  function whereAPersonPresses(card) {
    try { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
    const r = card.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.12, 0.35], [0.5, 0.15]]) {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (!hit || !card.contains(hit)) continue;
      const own = hit.closest('button, a, [role="button"]');
      if (own && own !== card && card.contains(own)) continue;
      if (sideAction(hit)) continue;
      return hit;
    }
    return card;
  }

  /** The tick mark of a card: its small, square, wordless shape nearest the left edge. */
  function markIn(card) {
    let best = null, edge = Infinity;
    for (const el of card.querySelectorAll('*')) {
      if (sideAction(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.width > 44 || r.height < 8 || r.height > 44 || el.textContent.trim() || !visible(el)) continue;
      if (r.left < edge) { edge = r.left; best = el; }
    }
    return best;
  }

  /** A control inside the card that may be what carries the handler: its own box, label or button. */
  const controlIn = card => [...card.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label, button')]
    .find(b => !sideAction(b) && !disabled(b)) || null;

  /** Press a card until the page shows it as wanted (`on`: chosen, or for a tick-box either way).
   *  Each press is looked at before the next is tried — a card may take a moment to show it, and
   *  a tick-box turns OFF when pressed twice. `shown` is any other sign the page took it. What was
   *  tried, and what it did, goes into `trail`. Resolves whether the card ended up as wanted. */
  async function pressCard(cardAt, i, on, trail, shown = () => false) {
    // The other sign only counts if it was not already showing: a Submit left enabled by an earlier
    // answer says nothing about this press.
    const had = shown();
    const settled = async () => {
      for (let t = 0; t < 12; t++) {
        const el = cardAt(i);
        if ((el && selected(el) === on) || (!had && shown())) return true;
        await sleep(50);
      }
      return false;
    };
    const rungs = [
      ['pressed where a person would', el => fireClick(whereAPersonPresses(el))],
      ['pressed the card itself', el => fireClick(el)],
      ['pressed its tick mark', el => { const m = markIn(el); if (!m) return false; fireClick(m); }],
      ['pressed the control inside it', el => { const c = controlIn(el); if (!c) return false; fireClick(c); }],
      ['pressed Space on it', el => {
        el.focus?.({ preventScroll: true });
        for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true }));
      }],
      ['clicked it natively', el => el.click?.()],
    ];
    for (const [name, run] of rungs) {
      const el = cardAt(i);
      if (!el) { trail.push('the card went away'); return false; }
      if (selected(el) === on) return true;
      if (run(el) === false) continue;              // nothing to press at this step
      if (await settled()) { trail.push(`${name}: it took`); return true; }
      trail.push(`${name}: no change`);
    }
    return false;
  }

  /** One line on how a card looks to this script, for an error message. */
  const cardState = el => (el
    ? `aria-checked=${el.getAttribute('aria-checked')} class="${String(el.className || '').slice(0, 80)}"`
    : 'not on the page');

  /** A picture viewer (or any dialog) left open on a question gets in the way of everything behind
   *  it. Close it the way a person does: Escape, then its close button. Resolves true if one was open. */
  async function dismissStrayDialog() {
    const form = feedbackForm();
    const open = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(d => visible(d) && !(hudEl && hudEl.contains(d)) && !(form && form.contains(d)));
    if (!open().length) return false;
    for (let i = 0; i < 3 && open().length; i++) {
      for (const t of [document.activeElement, document]) {
        try { t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch { /* ignore */ }
      }
      await sleep(250);
      for (const d of open()) {
        const x = d.querySelector('button[aria-label*="close" i], [data-testid*="close" i], [class*="close" i]');
        if (x) fireClick(x);
      }
      await sleep(250);
    }
    return true;
  }

  function selected(row) {
    return row.getAttribute('aria-checked') === 'true' ||
           row.getAttribute('aria-selected') === 'true' ||
           row.getAttribute('data-state') === 'checked' ||
           row.getAttribute('data-state') === 'on' ||
           !!row.querySelector('[aria-checked="true"], [data-state="checked"], input:checked') ||
           /(^|\s)(?:lib-)?(selected|checked|active|chosen|is-selected)(\s|$)/i.test(row.className || '');
  }

  /* ============================================================== scraping */

  /** Score an element as a candidate passage: text-heavy, not a choice list. */
  function passageScore(el) {
    const t = txt(el);
    if (t.length < 120) return 0;
    if (el.querySelectorAll('[role="radio"], [role="checkbox"]').length > 1) return 0; // that's the choices
    const paras = el.querySelectorAll('p').length;
    return t.length + paras * 200;
  }

  /** The page's own frame: navigation, and any sidebar that holds navigation.
   *  A passage is never one of these, never inside one, and never a block that
   *  contains one. On a page with no radio choices (fill-in, drop-down, matching,
   *  drag-and-drop) the biggest block of text is the whole app, which starts with
   *  the sidebar — and that was cached per lesson and sent with every later
   *  question as though it were a reading passage. */
  function appFrames() {
    const nav = 'nav, [role="navigation"]';
    return [...document.querySelectorAll(`aside, [role="complementary"], ${nav}`)]
      .filter(f => f.matches(nav) || f.querySelector(nav));
  }

  function findPassage(optionsRoot) {
    const frames = appFrames();
    const inFrame = el => frames.some(f => f === el || f.contains(el) || el.contains(f));
    const sels = [
      '[class*="passage" i]', '[id*="passage" i]', '[data-testid*="passage" i]',
      '[class*="reading" i]', '[class*="stimulus" i]', '[class*="text-wrap" i]',
      '[class*="article" i]', '[role="article"]', '[class*="content" i]',
    ];
    const seen = new Set();
    let best = null, bestScore = 0;

    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || (optionsRoot && (el === optionsRoot || el.contains(optionsRoot)))) continue;
        seen.add(el);
        if (!visible(el) || inFrame(el)) continue;
        const s = passageScore(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
    }
    if (best) return richText(best).slice(0, 12000);

    // Fallback: biggest <p>-bearing block on the page that isn't the choices.
    // Must be visible — a collapsed passage panel still has its text in the DOM,
    // and treating that as "passage already available" makes maybeOpenPassage()
    // skip the button that would actually reveal it.
    let fb = null, fbLen = 0;
    for (const el of document.querySelectorAll('div, section, article, main')) {
      if (optionsRoot && (el === optionsRoot || el.contains(optionsRoot))) continue;
      if (el.querySelectorAll('[role="radio"], [role="checkbox"]').length > 1) continue;
      if (!visible(el) || inFrame(el)) continue;
      const t = txt(el);
      if (t.length > fbLen && t.length > 400) { fbLen = t.length; fb = el; }
    }
    return fb ? richText(fb).slice(0, 12000) : '';
  }

  const CTRL = '[role="radio"], input[type="radio"], [role="checkbox"]';

  /** From one answer control, find the element that clicks it and the element
   *  that carries its text.
   *
   *  On this site a choice is TWO grid cells — a narrow one with the radio and a
   *  wide one with the text — so the text is a *sibling*, not an ancestor. The
   *  one rule that must never break: a row may not contain a second control. If
   *  it does, every row resolves to the same container and every click lands on
   *  the first choice, which silently answers "A" every time. */
  function findRow(control, groupRoot) {
    const stop = groupRoot || document.body;

    let click = control;
    let textEl = txt(control).length > 2 ? control : null;

    // A card among sibling cards holds its own text, however short ("ℝ", "10", "−2"): the cells
    // beside it are other choices, so none of them can be its label. (Taking the nearest text
    // sibling instead would give it its neighbour's words.)
    // (Not where the choices come as radio cell, text cell, radio cell…: there the text is in the
    // cell beside it, and a radio holding a letter is a marker, not the answer.)
    if (!textEl && txt(control).length >= 1 && control.parentElement) {
      const kin = [...control.parentElement.children].filter(k => k !== control);
      if (kin.some(k => k.matches?.(CTRL)) && kin.every(k => k.matches?.(CTRL) || !txt(k))) textEl = control;
    }

    if (!textEl) {
      let el = control.parentElement;
      while (el && el !== stop && el !== document.body) {
        if (el.querySelectorAll(CTRL).length > 1) break; // spans another choice
        click = el;
        if (txt(el).length > 2) { textEl = el; break; }
        el = el.parentElement;
      }
    }

    // Text lives in a sibling cell. It must be the NEAREST one, not the first
    // one found: in a grid the cells run radio,text,radio,text… so choice B's
    // text follows B's radio but choice A's text precedes it. Taking the first
    // text sibling shifts every label onto the previous choice — the model then
    // reasons about the right answer and the click lands one option off.
    if (!textEl) {
      let n = click;
      for (let d = 0; d < 3 && n && n !== stop; d++) {
        const p = n.parentElement;
        if (!p) break;

        const kids = [...p.children];
        const at = kids.indexOf(n);
        const after = kids.slice(at + 1);
        const before = kids.slice(0, at).reverse();

        for (const list of [after, before]) {
          for (const sib of list) {
            if (sib.contains(n)) continue;
            // A sibling holding another control marks the next choice's cell.
            if (sib.querySelectorAll(CTRL).length) break;
            if (txt(sib).length > 2) { textEl = sib; break; }
          }
          if (textEl) break;
        }
        if (textEl) break;
        n = p;
      }
    }

    const text = textEl || click;
    click.__textEl = text;   // expose to the dump so I can verify the pairing
    return { el: click, textEl: text };
  }

  /** The group of answer choices. Vet candidates by radio count, then size. */
  function findOptions() {
    const groups = [];
    const seen = new Set();
    const push = (root, controls, multi = false) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      const rows = (controls || [...root.querySelectorAll('[role="radio"]')]).filter(visible);
      if (rows.length >= 2) groups.push({ root, rows: rows.map(findRow), multi });
    };

    for (const r of document.querySelectorAll('[role="radio"]')) push(r.parentElement);

    // "Select the correct answers": cards that tick on and off, more than one of them right. A
    // checkbox only counts as an answer when it comes with text in a group of its own — the site's
    // header and its menus carry switches too.
    for (const c of document.querySelectorAll('[role="checkbox"][aria-checked]')) {
      const root = c.parentElement;
      if (!root || seen.has(root) || inSiteChrome(root) || (hudEl && hudEl.contains(root))) continue;
      const cards = [...root.children].filter(k => k.matches('[role="checkbox"][aria-checked]') && visible(k) && txt(k).length >= 1);
      push(root, cards, true);
    }

    // Native radios, grouped by shared name attribute.
    const native = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
    if (native.length >= 2) {
      const byName = new Map();
      for (const n of native) {
        const k = n.name || '__noname';
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(n);
      }
      for (const [, ns] of byName) {
        if (ns.length < 2) continue;
        // Walk up until the ancestor would swallow a second choice.
        let root = ns[0].parentElement;
        while (root?.parentElement &&
               root.parentElement.querySelectorAll('input[type="radio"]').length === ns.length) {
          root = root.parentElement;
        }
        push(root, ns);
      }
    }

    // Radix-style composite widgets: the control is a nested element and the
    // clickable thing is an ancestor marked as an option.
    for (const sel of ['[role="option"]', '[role="menuitemradio"]']) {
      const opts = [...document.querySelectorAll(sel)];
      if (opts.length >= 2) push(opts[0].parentElement, opts);
    }

    // Last resort: a list whose items look like short choices (A. / 1) / bullet).
    if (!groups.length) {
      for (const ul of document.querySelectorAll('ul, ol, [role="list"], [role="radiogroup"]')) {
        const items = [...ul.children].filter(visible);
        if (items.length < 2 || items.length > 10) continue;
        const looks = items.every(i => {
          const t = txt(i);
          return t.length > 0 && t.length < 400;
        });
        if (looks) { push(ul, [...ul.children]); }
      }
    }

    if (!groups.length) return null;

    // A group whose choices carry no text is useless — rank those last, then by
    // how many choices it holds, then by how much text it carries.
    const score = g => {
      const filled = g.rows.filter(r => txt(r.textEl).length > 2).length;
      return [filled, g.rows.length, txt(g.root).length];
    };
    groups.sort((a, b) => {
      const A = score(a), B = score(b);
      for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return B[i] - A[i];
      return 0;
    });

    const g = groups[0];
    const rows = g.rows.slice(0, 10);
    // Guard: a row that holds another control means the grouping collapsed and
    // the index→choice mapping is meaningless. Refuse rather than answer wrong.
    const sane = rows.every(r => r.el.querySelectorAll(CTRL).length <= 1);
    return { root: g.root, rows, texts: rows.map(r => richText(r.textEl)), sane, multi: g.multi };
  }

  /** The question stem — the text that isn't the passage and isn't a choice. */
  function findStem(optionsRoot) {
    const sels = [
      '[class*="question" i]:not([class*="questionnaire"])',
      '[class*="stem" i]', '[class*="prompt" i]', '[data-testid*="question" i]',
      '[role="dialog"] h1', '[role="dialog"] h2', '[role="dialog"] h3',
    ];
    let best = null, bestScore = 0;
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (optionsRoot && (el === optionsRoot || el.contains(optionsRoot))) continue;
        if (el.querySelectorAll('[role="radio"], [role="checkbox"]').length > 1) continue;
        const t = richText(el);
        if (t.length < 8 || t.length > 1200) continue;
        if (selected(el)) continue;
        const score = 1000 - Math.abs(260 - t.length); // stems are ~1-2 sentences
        if (score > bestScore) { bestScore = score; best = t; }
      }
    }
    if (best) return best;
    if (optionsRoot?.previousElementSibling && visible(optionsRoot.previousElementSibling)) {
      const t = txt(optionsRoot.previousElementSibling);
      if (t.length > 8) return t.slice(0, 800);
    }
    return '';
  }

  /** The line above the choices that says how to answer ("Select the correct answers."). */
  function findInstruction(optionsRoot) {
    const sels = ['[data-testid*="instruction" i]', '[class*="instruction" i]', '[id*="instruction" i]'];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || (optionsRoot && (el === optionsRoot || el.contains(optionsRoot) || optionsRoot.contains(el)))) continue;
        const t = richText(el);
        if (t.length >= 4 && t.length <= 300) return t;
      }
    }
    const prev = optionsRoot?.previousElementSibling;
    if (prev && visible(prev)) { const t = richText(prev); if (t.length >= 4 && t.length <= 200) return t; }
    return '';
  }

  /** Images that plausibly belong to the question (skip icons and logos). */
  function findImages(optionsRoot) {
    const out = [];
    for (const img of document.querySelectorAll('img, svg image, canvas')) {
      if (!visible(img)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;      // icons/avatars
      if (r.width * r.height < 20000) continue;
      if (img.tagName === 'IMG' && /logo|avatar|icon|sprite|flag/i.test(img.src + img.className)) continue;
      if (optionsRoot && optionsRoot.contains(img)) continue;
      let src = null;
      if (img.tagName === 'IMG') {
        if (!/^https?:/.test(img.src)) continue;
        src = img.src;
      } else if (img.tagName === 'CANVAS') {
        try { src = img.toDataURL('image/jpeg', 0.8); } catch { continue; }
      } else continue;
      if (!out.includes(src)) out.push(src);
      if (out.length >= 3) break;
    }
    return out;
  }

  /* ------------------------------------------------------- cloze / fill-in */

  function isTextInput(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const t = (el.type || 'text').toLowerCase();
    return t === 'text' || t === 'search' || t === '';
  }

  /** Type into a controlled input the way React will actually notice.
   *  Assigning .value directly is invisible to React — it keeps its own value
   *  tracker on the instance. The prototype's setter is the documented way
   *  past that. */
  function nativeSet(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (desc?.set) { desc.set.call(input, value); }
    else { input.value = value; }
  }

  /** Type into an input so the framework's own state actually updates.
   *
   *  Two strategies, because one alone isn't enough on a controlled input:
   *
   *   - the native value setter plus dispatched input/change events. React's
   *     value tracker is bypassed this way, which is what makes the event look
   *     like a real one to it.
   *   - execCommand('insertText'), which produces an event the browser itself
   *     generates. Some editors only trust this.
   *
   *  The caller must verify afterwards — a controlled component can accept the
   *  value here and wipe it on its next render, and only a second read reveals
   *  that. */
  function setInputValue(input, value) {
    input.focus();
    try { input.select?.(); } catch { }

    nativeSet(input, '');
    try { document.execCommand('insertText', false, value); } catch { }
    if (input.value !== value) {
      // insertText didn't take (or isn't supported) — fall back to the setter.
      nativeSet(input, value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    return input.value;
  }

  /** Re-read inputs after a beat. A controlled component that rejected the
   *  value will have reverted it by now. Returns the ones that came back empty
   *  or wrong, so the caller can retry instead of submitting stale state. */
  async function verifyInputs(blanks, words, settle = 220) {
    await sleep(settle);
    const bad = [];
    for (const [i, b] of blanks.entries()) {
      // A math field hands its content back as LaTeX, written its own way ("\frac12" for 1/2), so it
      // cannot be compared with what was typed: it is only checked that it kept something, and that
      // the page itself still shows it as filled in.
      const now = b.math ? mathValue(b.el) : (b.el.value || '').trim();
      const wrong = b.math ? (!now || pageSawIt(b.el) === false) : now !== words[i].trim();
      if (wrong) bad.push({ i, want: words[i], got: now });
    }
    return bad;
  }

  /* A math answer box is a <math-field> (MathLive): a custom element defined by the PAGE's own
   * JavaScript. This script runs in an isolated world, where that element's methods and properties
   * (insert, value, executeCommand) do not exist — reading .value finds nothing, and writing it
   * only makes a property on this world's private copy, which then "reads back" as if it had
   * worked while the real field stays empty. So the field is reached through bridge-main.js, which
   * runs in the page's own world. The worlds share the DOM and nothing else: the request goes in an
   * attribute on the field with an event, and the answer comes back in another attribute. */
  function mathCall(mf, req) {
    try {
      mf.setAttribute('data-alef-req', JSON.stringify(req));
      mf.removeAttribute('data-alef-out');
      mf.dispatchEvent(new CustomEvent('alef-math', { bubbles: true, composed: true }));   // answered synchronously
      const raw = mf.getAttribute('data-alef-out');
      mf.removeAttribute('data-alef-req');
      mf.removeAttribute('data-alef-out');
      return raw ? JSON.parse(raw) : { reached: false, value: '' };
    } catch { return { reached: false, value: '' }; }
  }
  const mathValue = mf => String(mathCall(mf, { op: 'get' }).value || '').trim();

  /** Has the page itself taken the answer in? Its own "Type…" label goes when the field has
   *  something, and Submit comes on: a value that sits in the field without the page hearing of it
   *  is no answer. null when there is no label to go by. */
  function pageSawIt(mf) {
    const ph = mathBox(mf).querySelector('[class*="laceholder"]');
    return ph ? !visible(ph) : null;
  }

  /** Put an answer into a math field. Tried in turn, each checked against what the page does: MathLive's
   *  own insert (ASCII math — "x^2", "sqrt(x)", "(a)/(b)"), then typed as keystrokes, then insert as
   *  LaTeX, then the browser's own text insertion. Resolves { value, via, tried, reached }. */
  async function setMathValue(mf, text) {
    const s = String(text).replace(/−/g, '-').trim();
    const tried = [];
    const first = mathCall(mf, { op: 'get' });
    if (!first.reached) return { value: '', via: null, reached: false, tried: ['the page-side helper (bridge-main.js) did not answer'] };

    const ways = [
      ['insert (ASCII math)', { op: 'insert', text: s, format: 'ascii-math' }],
      ['typed keystrokes', { op: 'typed', text: s }],
      ['insert (LaTeX)', { op: 'insert', text: s, format: 'latex' }],
      ['browser text insertion', { op: 'exec', text: s }],
    ];
    let value = '';
    for (const [name, req] of ways) {
      mathCall(mf, { op: 'clear' });
      const r = mathCall(mf, req);
      value = String(r.value || '').trim();
      await sleep(220);                                    // the page's own handlers run, and it redraws
      const saw = pageSawIt(mf);
      tried.push(`${name}: ${value ? JSON.stringify(value) : '(empty)'}${r.error ? ` error: ${r.error}` : ''}${value && saw === false ? ' — the page did not react' : ''}`);
      if (value && saw !== false) { mathCall(mf, { op: 'hide' }); return { value, via: name, reached: true, tried }; }
    }
    mathCall(mf, { op: 'hide' });
    return { value: mathValue(mf), via: null, reached: true, tried };
  }

  function nearestCommonAncestor(els) {
    if (!els.length) return null;
    let node = els[0];
    while (node && !els.every(e => node.contains(e))) node = node.parentElement;
    return node;
  }

  /** The Word Bank, if this question has one. It constrains the answer, so it's
   *  worth finding: the tempting wrong pick is usually the same word in the
   *  wrong part of speech (increase vs increased). */
  function findWordBank() {
    const heading = [...document.querySelectorAll('*')]
      .filter(el => el.children.length === 0 && visible(el))
      .find(el => /^\s*word\s*bank\b/i.test(txt(el)));
    if (!heading) return [];

    // Terms live in the heading's container: list items, or one word per line.
    let scope = heading.parentElement;
    for (let d = 0; d < 3 && scope; d++) {
      const items = [...scope.querySelectorAll('li, [role="listitem"]')].filter(visible).map(txt);
      if (items.length >= 3) return items.filter(Boolean).slice(0, 30);

      // Rendered as a stack of elements rather than a list — take the short ones.
      const shorts = [...scope.querySelectorAll('div, span, p, button, [role="button"]')]
        .filter(visible)
        .filter(el => el.children.length === 0)
        .map(txt)
        .filter(t => t && t.length <= 24 && !/word bank/i.test(t));
      if (shorts.length >= 3) return [...new Set(shorts)].slice(0, 30);

      scope = scope.parentElement;
    }
    return [];
  }

  /** Text that is in the page but not meant to be read: a screen-reader
   *  announcement (dnd-kit renders one beside every drag-and-drop question, and it
   *  repeats the last drop), or anything not displayed. Deliberately NOT
   *  aria-hidden or pixel-clipped boxes — math renderers hide one of their two
   *  copies of an equation each way, and the question needs one of them. */
  function notShown(el) {
    if (el.hidden || el.matches('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')) return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  /** What a sighted reader sees inside an element. innerText still holds
   *  screen-reader-only text (clipped to a pixel, not removed), textContent holds
   *  an SVG's <title>, and txt() falls back to aria-label — none of which makes a
   *  box look anything but empty to someone looking at the page. */
  function shownText(el) {
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) if (isShown(n)) out += n.nodeValue;
    return norm(out);
  }

  /** Can a person looking at the page read this text node? Its box can still have
   *  a full-size layout when its parent is clipped to a pixel, so test the parent. */
  function isShown(textNode) {
    const p = textNode.parentElement;
    if (!p || !textNode.nodeValue.trim() || p.closest('svg, script, style, noscript, template')) return false;
    if (notShown(p)) return false;
    const r = p.getBoundingClientRect();
    return r.width > 1 && r.height > 1;                  // clipped, or inside something not displayed
  }

  /** Rebuild the sentence with [BLANK n] where each input sits, so the model
   *  sees the grammar around every gap — which is what decides
   *  "increase" vs "increased". */
  /** A formula as plain text, from its MathML: "x^2 - 4x + 4". The page's own text for it reads
   *  "x 2 − 4 x + 4", with the power gone, and a question cannot be answered from that. */
  function mathmlText(n) {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, ' ').trim();
    if (n.nodeType !== 1) return '';
    const kids = [...n.childNodes].filter(c => c.nodeType === 1 || (c.nodeType === 3 && c.nodeValue.trim()));
    const part = i => (kids[i] ? mathmlText(kids[i]) : '');
    const all = () => kids.map(mathmlText).join('');
    const grp = s => (/^[\w.]+$/.test(s) || /^\(.*\)$/.test(s) ? s : `(${s})`);
    switch (n.localName) {
      case 'msup': return `${grp(part(0))}^${grp(part(1))}`;
      case 'msub': return `${grp(part(0))}_${grp(part(1))}`;
      case 'msubsup': return `${grp(part(0))}_${grp(part(1))}^${grp(part(2))}`;
      case 'mfrac': return `${grp(part(0))}/${grp(part(1))}`;
      case 'msqrt': return `sqrt(${all()})`;
      case 'mroot': return `root(${part(0)}, ${part(1)})`;
      case 'mo': { const o = n.textContent.trim(); return o === ',' ? ', ' : /^[+\-−=<>≤≥≠×÷·±∪∩∈∉⊂⊆]$/.test(o) ? ` ${o} ` : o; }
      case 'mtext': return ` ${n.textContent.trim()} `;
      case 'mspace': return ' ';
      default: return kids.length ? all() : n.textContent.trim();
    }
  }
  const formulaText = el => {
    const m = el.querySelector('mjx-assistive-mml math, math');
    if (!m) return '';
    // A minus that opens a bracket or follows a comparison is a sign ("x ≤ −2", "(−∞, −2.89]"), and
    // read with a space after it ("− 2") it looks like a subtraction with nothing before it.
    return mathmlText(m).replace(/\s+/g, ' ').trim()
      .replace(/([(\[{])\s*−\s+(?=[\w.(∞])/g, '$1−')
      .replace(/([|,=<>≤≥≠±∪∩]\s?)−\s+(?=[\w.(∞])/g, '$1−');
  };

  /** An element's text, with each drawn formula read from its MathML copy ("2x^2 + 3x − 8 ≥ 0") rather
   *  than from the page's own text for it ("2 𝑥 2 + 3 𝑥 − 8 ≥ 0", where the power has become a
   *  stray digit). The same as txt() on anything with no formula in it. */
  function richText(el) {
    if (!el || !el.querySelector || !el.querySelector('mjx-container')) return txt(el);
    const out = [];
    const visit = n => {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      if (n.tagName === 'MJX-CONTAINER') { const f = formulaText(n); out.push(f ? ` ${f} ` : txt(n)); return; }
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return;
      const block = !/^(inline|contents)/.test(cs.display);
      if (block) out.push(' ');
      for (const c of n.childNodes) visit(c);
      if (block) out.push(' ');
    };
    visit(el);
    return norm(out.join(''));
  }

  function walkWithBlanks(root, inputs, bankRoot, marks = inputs) {
    const out = [];
    const visit = node => {
      if (node.nodeType === 3) { out.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      const idx = marks.indexOf(node);
      if (idx >= 0) { out.push(` [BLANK ${idx + 1}] `); return; }
      // A drawn formula (MathJax): its MathML copy says it properly, powers and all.
      if (node.tagName === 'MJX-CONTAINER') { const f = formulaText(node); if (f) { out.push(` ${f} `); return; } }
      if (bankRoot && (bankRoot === node || bankRoot.contains(node))) return;
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      if (notShown(node)) return;
      // Buttons and links are chrome, not question text.
      if (node.tagName === 'BUTTON') return;
      if (node.tagName === 'A' && txt(node).length < 40) return;
      if (node.getAttribute('role') === 'button' || node.tagName === 'NAV') return;
      // Block elements break a line. Without this, "figures." and "Choose" in
      // two paragraphs run together as "figures.Choose".
      const block = /^(P|DIV|H[1-6]|LI|UL|OL|BR|SECTION|ARTICLE|TR)$/.test(node.tagName);
      if (block) out.push(' ');
      for (const c of node.childNodes) visit(c);
      if (block) out.push(' ');
    };
    visit(root);
    return out.join('').replace(/\s+/g, ' ').trim();
  }

  /** Expand out from a question's answer fields to the card that holds its
   *  instructions ("Use these figures: ...") — without them a data question
   *  can't be answered at all.
   *
   *  Stop before the region swallows page chrome. The reliable signal is a
   *  button appearing: the instructions sit in the question card, and the
   *  first ancestor that introduces buttons is the nav/footer bar. Climb past
   *  that only while the text is still too thin to be the whole question. */
  function regionAround(els) {
    const textLen = el => txt(el).length;

    let region = nearestCommonAncestor(els) || els[0].parentElement;
    // The player's footer (Go Back, Submit, Next) is never part of a question. With little text to
    // go on, the climb below would otherwise carry on up to the container that holds it too.
    const footer = document.querySelector('#widgets-navigation-container, .lib-navigation-container, [data-testid="navigation-container"]');
    for (let guard = 0; guard < 8; guard++) {
      const p = region?.parentElement;
      if (!p || p === document.body) break;
      if (footer && p.contains(footer)) break;

      const addsChrome = p.querySelectorAll('button, [role="button"], nav, footer').length > 0;
      if (addsChrome && textLen(region) > 200) break;   // have enough; don't take the button bar
      if (textLen(p) > 1200) break;                     // too far up the tree
      region = p;
    }
    return region;
  }

  /** A fill-in-the-blank question, or null if this isn't one. */
  /* ------------------------------------------------------------ the rating box */

  // After a lesson the live site asks "Rate your lesson!": smileys, a text area, Cancel and
  // Submit. It is not a question, and the box's Submit and Cancel are not <button>s. (Its text
  // area, placeholder "Submit", was once taken for a fill-in-the-blank and typed into.)
  const RATE = /\brate (?:your|the|this) (?:lesson|activity|experience|session)\b|\bhow was (?:your|the|this) (?:lesson|activity)\b/i;
  const AR_RATE = /قيم (?:درسك|الدرس|النشاط|تجربتك)/;
  const isRateText = t => RATE.test(t) || AR_RATE.test(arNorm(t));
  const RATE_SUBMIT = /^(?:submit|send)\W*$/;
  const AR_RATE_SUBMIT = /^(?:ارسال|ارسل)\W*$/;

  /** The box that asks for a rating, if one is open: the smallest ancestor of its heading
   *  that also holds a Submit. null when there is none. */
  function feedbackForm() {
    if (!isRateText(document.body.innerText || '')) return null;     // the usual case, and cheap
    for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, span, label')) {
      if (el.children.length > 2) continue;                          // a heading, not a container
      const t = txt(el);
      if (t.length > 60 || !isRateText(t) || !visible(el)) continue;
      let box = el;
      for (let i = 0; i < 7 && box.parentElement && box.parentElement !== document.body; i++) {
        box = box.parentElement;
        const bt = txt(box);
        if (bt.length > 600) break;
        if (/submit|ارسال|إرسال/i.test(bt)) return box;          // no \b: side by side, "CancelSubmit" is how it can read
      }
    }
    return null;
  }

  /** The Submit in the rating box: the innermost visible element in it that says just that. */
  function feedbackSubmit() {
    const box = feedbackForm();
    if (!box) return null;
    const says = el => { const t = txt(el).toLowerCase(); return RATE_SUBMIT.test(t) || AR_RATE_SUBMIT.test(arNorm(t)); };
    const hits = [...box.querySelectorAll('*')].filter(el => visible(el) && says(el) && ![...el.children].some(says));
    return hits[hits.length - 1] || null;
  }

  /** The box around a math answer field — its wrapper, which also holds the "Type…" label and the
   *  keyboard button: that whole box is the blank. */
  const mathBox = el => {
    const box = el.closest('.lib-fib-math-editor-container');
    if (box) return box;
    // Otherwise the outermost wrapper whose name says it belongs to the editor.
    let top = el;
    for (let n = el.parentElement; n && n !== document.body && /MathEditor|math-editor/i.test(String(n.className)); n = n.parentElement) top = n;
    return top;
  };

  function findCloze(optionsRoot, dropdownEls = []) {
    // A <math-field> (MathLive) is an answer box like any other, though not an <input>.
    const all = [...document.querySelectorAll('input, textarea, math-field')].filter(el => el.tagName === 'MATH-FIELD' || isTextInput(el)).filter(visible);
    const rateBox = all.length ? feedbackForm() : null;
    const inputs = all.filter(el => {
      if (optionsRoot?.contains(el)) return false;
      if (rateBox && rateBox.contains(el)) return false;            // the rating box's text area is not a blank
      // A custom select often hides a typeahead <input> inside its box.
      if (dropdownEls.some(d => d.contains(el))) return false;
      // Skip search boxes and other chrome that isn't part of the question.
      const ph = (el.placeholder || '').toLowerCase();
      const nm = (el.name || '') + (el.id || '');
      if (/search|filter|query/.test(ph + nm)) return false;
      return true;
    }).slice(0, 12);

    if (!inputs.length) return null;

    const region = regionAround(inputs);

    const wordBank = findWordBank();
    const bankRoot = wordBank.length ? (() => {
      const h = [...document.querySelectorAll('*')]
        .filter(el => el.children.length === 0 && visible(el))
        .find(el => /^\s*word\s*bank\b/i.test(txt(el)));
      return h?.parentElement || null;
    })() : null;

    const text = walkWithBlanks(region, inputs, bankRoot, inputs.map(el => (el.tagName === 'MATH-FIELD' ? mathBox(el) : el)));
    return { inputs, text, wordBank, region };
  }

  /* ------------------------------------------------------ drop-down blanks */

  // What a custom select shows before anything is picked: "Select…", "Select...".
  const PLACEHOLDER = /^(select|choose|pick)\b.{0,12}$/i;
  const normKey = s => norm(s).toLowerCase().replace(/[\s.,;:]+$/, '');

  /** From a placeholder's element, climb to the box a person would click: the
   *  largest ancestor that adds no text of its own. */
  function triggerBox(leaf) {
    let box = leaf;
    for (let i = 0; i < 4; i++) {
      const p = box.parentElement;
      if (!p || p === document.body) break;
      if (txt(p) !== txt(box)) break;                  // parent carries other text → stop
      const r = p.getBoundingClientRect();
      if (r.width > 420 || r.height > 90) break;       // too big to be a control
      box = p;
    }
    return box;
  }

  /** The site's own header and menus: the profile menu with its "Select Language", the class
   *  picker, the notification box, the language dialog. None of it is part of a question, and a
   *  detector that reads "Select Language" as a drop-down blank clicks the person's name. */
  const SITE_CHROME = /profile|class-selector|select-language|notification-center|navigation_|header__/i;
  function inSiteChrome(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'HEADER' || n.getAttribute?.('role') === 'banner') return true;
      const cls = typeof n.className === 'string' ? n.className : '';
      if (SITE_CHROME.test(cls) || SITE_CHROME.test(n.id || '') || SITE_CHROME.test(n.getAttribute?.('data-testid') || '')) return true;
    }
    return false;
  }

  /** Every drop-down in the question, in reading order. Native <select>s are
   *  taken as they are. Custom ones have no tag to find them by, so they're
   *  found the way a person finds them: by the "Select…" they all start with,
   *  plus any ARIA combobox. */
  function findDropdowns() {
    const found = [];
    const add = (el, native) => { if (el && visible(el) && !inSiteChrome(el)) found.push({ el, native }); };

    for (const el of document.querySelectorAll('select')) {
      if (!el.closest('header, nav, footer')) add(el, true);
    }
    for (const el of document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')) {
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') add(el, false);
      // A react-select keeps its combobox in a hidden <input> (0×0) and shows the value in a box
      // beside it. The box is what a person presses — and it is the only thing there to find once an
      // answer is in, when the "Select…" it started with is gone.
      else if (el.tagName === 'INPUT') {
        const box = el.closest('[class*="Select__control" i], [class*="select-control" i]');
        if (box) add(box, false);
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const t = n.nodeValue.trim();
      if (t.length < 3 || t.length > 24 || !PLACEHOLDER.test(t)) continue;
      const leaf = n.parentElement;
      if (!leaf || (hudEl && hudEl.contains(leaf)) || !visible(leaf) || inSiteChrome(leaf)) continue;
      add(triggerBox(leaf), false);
    }

    // Keep the outermost box of any nested pair, once each, in page order.
    const uniq = found.filter((f, i) => found.findIndex(o => o.el === f.el) === i);
    const outer = uniq.filter(f => !uniq.some(o => o !== f && o.el.contains(f.el)));
    outer.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return outer.slice(0, 12);
  }

  /** A drop-down question, or null if this isn't one. */
  function findDropdownQuestion() {
    const triggers = findDropdowns();
    if (!triggers.length) return null;
    const els = triggers.map(t => t.el);
    const region = regionAround(els);
    return { triggers, region, text: walkWithBlanks(region, els, null) };
  }

  /** Leaf elements showing text right now — a "before" picture, so whatever a
   *  menu adds when it opens can be told apart from the page around it. */
  function visibleLeaves() {
    const set = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length === 0 && el.textContent.trim() && visible(el)) set.add(el);
    }
    return set;
  }

  /** The option rows of a menu that is open now. ARIA options when the site has
   *  them; otherwise whatever appeared since `before`, grouped into the biggest
   *  run of sibling rows — which is what a list of options is. */
  function menuRows(before) {
    const aria = [...document.querySelectorAll('[role="option"]')].filter(visible);
    if (aria.length >= 2) return aria;

    const fresh = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length || before.has(el) || !el.textContent.trim() || !visible(el)) continue;
      if (hudEl && hudEl.contains(el)) continue;
      fresh.push(el);
    }
    if (fresh.length < 2) return [];

    const hasFresh = c => fresh.some(f => c.contains(f));
    const groups = new Map();
    for (const leaf of fresh) {
      let row = leaf;
      while (row.parentElement && row.parentElement !== document.body &&
             [...row.parentElement.children].filter(hasFresh).length < 2) row = row.parentElement;
      const p = row.parentElement;
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, new Set());
      groups.get(p).add(row);
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.size > best.size) best = g;
    return best && best.size >= 2 ? [...best].filter(r => txt(r).length && txt(r).length < 160) : [];
  }

  /** Click where a person would: the element under the middle of the box. A
   *  handler bound to an inner span never sees an event aimed at its wrapper. */
  function clickAtCenter(el) {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    fireClick(hit && el.contains(hit) ? hit : el);
  }

  async function openMenu(el) {
    const before = visibleLeaves();
    clickAtCenter(el);
    for (let i = 0; i < 12; i++) {                     // ~1s
      await sleep(80);
      if (menuRows(before).length >= 2) {
        await sleep(80);                               // let an opening animation finish
        return { rows: menuRows(before), before };
      }
    }
    return { rows: [], before };
  }

  async function closeMenu(el, before) {
    for (const t of [document.activeElement, el, document]) {
      try { t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); }
      catch { /* ignore */ }
    }
    await sleep(150);
    if (menuRows(before).length >= 2) { fireClick(document.body); await sleep(150); }   // click outside
  }

  const nativeTexts = sel => [...sel.options]
    .filter(o => !o.disabled && o.value !== '' && !/^(select|choose|pick)\b/i.test(o.text.trim()))
    .map(o => norm(o.text));

  /** The options of every drop-down, as text, in order. Custom menus have to be
   *  opened to be read, so this clicks — and closes each one again. */
  async function readDropdownOptions(blanks) {
    const menus = [];
    for (const b of blanks) {
      if (b.native) { menus.push(nativeTexts(b.el)); continue; }
      const { rows, before } = await openMenu(b.el);
      const seen = new Set(), texts = [];
      for (const r of rows) {
        const t = txt(r), k = normKey(t);
        if (t && !seen.has(k) && !PLACEHOLDER.test(t)) { seen.add(k); texts.push(t); }
      }
      menus.push(texts);
      await closeMenu(b.el, before);
    }
    return menus;
  }

  const findRowByText = (rows, want) => {
    const k = normKey(want);
    return rows.find(r => normKey(txt(r)) === k) || rows.find(r => normKey(txt(r)).includes(k));
  };

  async function chooseDropdown(b, want) {
    if (b.native) {
      const opt = [...b.el.options].find(o => normKey(o.text) === normKey(want)) ||
                  [...b.el.options].find(o => normKey(o.text).includes(normKey(want)));
      if (!opt) return { ok: false, error: `"${want}" is not one of the options` };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(b.el, opt.value);
      b.el.dispatchEvent(new Event('input', { bubbles: true }));
      b.el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(60);
      const shows = norm(b.el.options[b.el.selectedIndex]?.text);
      return { ok: normKey(shows) === normKey(opt.text), shows };
    }

    const { rows, before } = await openMenu(b.el);
    if (!rows.length) return { ok: false, error: 'the menu did not open' };
    const row = findRowByText(rows, want);
    if (!row) { await closeMenu(b.el, before); return { ok: false, error: `"${want}" is not in the list` }; }

    clickAtCenter(row);
    for (let i = 0; i < 15; i++) {                     // ~1.2s
      await sleep(80);
      // A re-rendered box is gone from the page; otherwise it should now show the pick.
      if (!b.el.isConnected || normKey(txt(b.el)).includes(normKey(want))) {
        return { ok: true, shows: b.el.isConnected ? txt(b.el) : '(re-rendered)' };
      }
    }
    return { ok: false, error: `clicked "${want}" but the box still shows "${txt(b.el)}"` };
  }

  /** Pick one option per drop-down, then (optionally) submit. `picks` are the
   *  option texts, one per blank, in reading order. */
  async function commitDropdown(picks, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'dropdown', chosen: [], selected: false, submitted: false };

    const p = scrape();
    const blanks = p.dropdown?.blanks || [];
    if (!blanks.length) { out.error = 'no drop-downs found'; return out; }
    if (picks.length !== blanks.length) {
      out.error = `answer count mismatch: ${picks.length} answers for ${blanks.length} drop-downs`;
      return out;
    }

    for (const [i, b] of blanks.entries()) {
      const r = await chooseDropdown(b, picks[i]);
      out.chosen.push({ blank: i + 1, want: picks[i], ...r });
      if (!r.ok) { out.error = `drop-down ${i + 1}: ${r.error || 'selection did not register'}`; return out; }
    }
    out.selected = true;

    if (!autoSubmit) return out;

    await sleep(delay);
    const btn = await waitForSubmit(p.dropdown.region || null);
    if (!btn) { out.error = 'no enabled submit button found'; return out; }

    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    out.submitted = c.ok;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    return out;
  }

  /* ------------------------------------------------------------- matching */

  /** The thing on an item you click or grab to link it: a small, roughly square
   *  shape — a div, an svg, a radio — at the edge that faces the other column.
   *  Falls back to the row itself, which is clickable too.
   *
   *  Deliberately NOT how items are found. A first version looked for round
   *  "dot" elements, but how a site draws its dots (div, svg, input, or a CSS
   *  pseudo-element with no element at all) can't be known from outside, and on
   *  the real page it found nothing. */
  function findHandle(row, facing) {
    const cands = [];
    for (const el of row.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.width > 36 || r.height < 8 || r.height > 36 || Math.abs(r.width - r.height) > 4) continue;
      if (el.textContent.trim() || !visible(el)) continue;
      cands.push({ el, edge: facing === 'right' ? r.right : -r.left });
    }
    cands.sort((a, b) => b.edge - a.edge);               // stable: an outer shape beats the svg inside it
    return cands.length ? cands[0].el : row;
  }

  let lastMatchDiag = null;   // why the last look for a matching question did or didn't find one

  /** A matching question: two columns of equal-sized rows that line up side by
   *  side, row for row. That layout is the one thing every such page shares, so
   *  it's what's looked for. Returns the items in reading order, or null. */
  function findMatch() {
    // Cheap guard first — this runs on every scrape. "match" alone: words like
    // link or pair turn up in ordinary reading passages. innerText, not
    // textContent: the latter includes script and style blobs that can push the
    // instructions out of any prefix window.
    lastMatchDiag = null;
    if (!says('match')) return null;
    const diag = lastMatchDiag = { guard: true, boxes: 0, columns: [], result: 'no two aligned columns' };

    const boxes = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.width > 650 || r.height < 28 || r.height > 100) continue;
      const t = txt(el);
      if (t.length < 3 || t.length > 90) continue;
      if (el.closest('aside, nav, [role="navigation"], [role="complementary"]')) continue;   // the lesson sidebar
      if (hudEl && hudEl.contains(el)) continue;
      boxes.push({ el, r, text: t });
    }
    // A wrapper and the row inside it are one item: keep the outer.
    const items = boxes.filter(b => !boxes.some(o => o !== b && o.el.contains(b.el) &&
      Math.abs(o.r.top - b.r.top) < 30 && Math.abs(o.r.left - b.r.left) < 40 && Math.abs(o.r.height - b.r.height) < 40));
    diag.boxes = items.length;

    // Group by left edge and width: each group is a column.
    const cols = [];
    for (const b of items) {
      const c = cols.find(c => Math.abs(c.left - b.r.left) <= 8 && Math.abs(c.width - b.r.width) <= 0.1 * c.width);
      if (c) c.items.push(b); else cols.push({ left: b.r.left, width: b.r.width, items: [b] });
    }
    diag.columns = cols.filter(c => c.items.length >= 2)
      .map(c => `x=${Math.round(c.left)} w=${Math.round(c.width)} n=${c.items.length}`);
    const tall = cols.filter(c => c.items.length >= 3)
      .map(c => ({ ...c, items: c.items.sort((a, b) => a.r.top - b.r.top) }));

    // Two columns of the same length whose rows sit at the same heights.
    let pair = null;
    for (let i = 0; i < tall.length && !pair; i++) {
      for (let j = i + 1; j < tall.length; j++) {
        const A = tall[i], B = tall[j];
        if (A.items.length !== B.items.length || Math.abs(A.left - B.left) < 100) continue;
        if (A.items.every((a, k) => Math.abs(a.r.top - B.items[k].r.top) <= 10)) {
          pair = A.left < B.left ? [A, B] : [B, A];
          break;
        }
      }
    }
    if (!pair) return null;

    const [L, R] = pair;
    diag.result = `found ${L.items.length} pairs`;
    const all = [...L.items, ...R.items];
    return {
      left: L.items.map(b => ({ row: b.el, marker: findHandle(b.el, 'right'), text: b.text })),
      right: R.items.map(b => ({ row: b.el, marker: findHandle(b.el, 'left'), text: b.text })),
      region: regionAround(all.map(b => b.el)),
      intro: textAbove(Math.min(...all.map(b => b.r.top)), all.map(b => ({ row: b.el }))),
    };
  }

  /** The instructions and column headings: whatever readable text sits above the
   *  first item. A container-based region can't be trusted to include them — it
   *  stops climbing at the page body, and the instructions are often outside it. */
  function textAbove(y, items) {
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const t = n.nodeValue.trim();
      const el = n.parentElement;
      if (!t || !el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      if (/^\d+\s*\/\s*\d+$/.test(t)) continue;                       // "5/5" progress label
      // The sidebar sits beside the question and starts at the top of the page, so
      // its title would otherwise count as text "above the first item".
      if (el.closest('button, [role="button"], nav, a, aside, [role="complementary"]') || (hudEl && hudEl.contains(el))) continue;
      if (items.some(i => i.row.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom > y + 2 || !visible(el)) continue;
      parts.push(t);
    }
    return norm(parts.join(' ')).slice(0, 600);
  }

  /** What a link looks like to the page: colours and shapes, not just text. A
   *  filled ring or a drawn line changes neither the text nor any control. */
  function matchSignature(m) {
    let h = 5381;
    const mix = s => { for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0; };
    mix(pageSignature());
    for (const it of [...m.left, ...m.right]) {
      for (const el of [it.row, it.marker]) {
        const cs = getComputedStyle(el);
        mix([cs.backgroundColor, cs.borderTopColor, cs.boxShadow, el.getAttribute('class'), el.getAttribute('style')].join('|'));
      }
    }
    for (const el of document.querySelectorAll('svg line, svg path, svg polyline, svg circle, canvas')) {
      if (hudEl && hudEl.contains(el)) continue;
      mix(`${el.tagName}|${el.getAttribute('d') || el.getAttribute('x2') || ''}|${el.getAttribute('stroke') || ''}`);
    }
    return h;
  }

  const centerOf = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const hitAt = (x, y, fallback) => document.elementFromPoint(x, y) || fallback;

  /** Press on one thing, move across the page in steps, release on another —
   *  as pointer events and then the mouse events a browser sends after them.
   *  `hold` waits after the press before moving: touch-friendly drag libraries
   *  (dnd-kit's delay constraint) cancel a drag that starts moving at once. */
  /** The middle of what an item shows — its label and icon — as opposed to the middle of the box around
   *  it. A tray row can be far wider than its word, and a drag library that draws the dragged item as a
   *  small overlay anchors it at the row's left edge: aim the row's middle at a gap and the label ends up
   *  a hundred pixels to the side of it, over nothing ("dropped."). A person grabs the label. */
  function contentCenter(el) {
    const own = el.getBoundingClientRect();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const c of el.querySelectorAll('*')) {
      const k = c.getBoundingClientRect();
      if (k.width < 2 || k.height < 2) continue;
      if (c.children.length > 0 && k.width > own.width * 0.9) continue;      // a full-width wrapper says nothing about the label
      l = Math.min(l, k.left); t = Math.min(t, k.top); r = Math.max(r, k.right); b = Math.max(b, k.bottom);
    }
    return Number.isFinite(l) ? { x: (l + r) / 2, y: (t + b) / 2, width: r - l } : { ...centerOf(el), width: own.width };
  }
  /** Is this item's box much wider than what it shows? Then it is grabbed by its label first. */
  const stretched = el => el.getBoundingClientRect().width > contentCenter(el).width * 1.8;
  const grabPoint = (el, aim) => (aim === 'label' ? contentCenter(el) : centerOf(el));

  async function pointerDrag(from, to, { hold = 0, dwell = 180, steps = 8, stepMs = 16, aim = 'row' } = {}) {
    const a = grabPoint(from, aim), b = centerOf(to);
    const init = (x, y, buttons) => ({
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons,
    });
    const fire = (target, type, x, y, buttons) => {
      try { target.dispatchEvent(new PointerEvent(`pointer${type}`, { ...init(x, y, buttons), pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch { }
      target.dispatchEvent(new MouseEvent(`mouse${type}`, init(x, y, buttons)));
    };

    fire(hitAt(a.x, a.y, from), 'down', a.x, a.y, 1);
    if (hold) await sleep(hold);
    for (let i = 1; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
      fire(hitAt(x, y, to), 'move', x, y, 1);
      await sleep(stepMs);
    }
    // Rest on the target before letting go. A drag library works out what the item is over a
    // moment after each move (after the page has redrawn); let go at once, on a page that is busy
    // drawing formulas, and it still has "over nothing" from earlier in the drag: "dropped."
    await sleep(dwell);
    fire(hitAt(b.x, b.y, to), 'up', b.x, b.y, 0);
  }

  /** Move an item with the keyboard, as a drag library's keyboard sensor allows: Space picks it up,
   *  the arrow keys move it (25px each, by default), Space puts it down. Walks it towards the target
   *  by what it measures, then lets go. */
  async function keyboardDrag(from, to) {
    const press = (key, code) => {
      const t = document.activeElement && document.activeElement !== document.body ? document.activeElement : from;
      t.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    };
    try { from.focus({ preventScroll: true }); } catch { /* not focusable */ }
    press(' ', 'Space');
    await sleep(160);
    // Measured by the label, not the row: it is the label that has to end up over the gap.
    const target = centerOf(to), base = contentCenter(from), moved = { x: 0, y: 0 };
    for (let i = 0; i < 100; i++) {
      const now = contentCenter(from);
      // The item itself moves with the keys; when it stays put (an overlay carries the picture), count the presses.
      const cur = Math.abs(now.x - base.x) + Math.abs(now.y - base.y) > 1 ? now : { x: base.x + moved.x, y: base.y + moved.y };
      const dx = target.x - cur.x, dy = target.y - cur.y;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) break;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const key = horizontal ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
      press(key, key);
      if (horizontal) moved.x += dx > 0 ? 25 : -25; else moved.y += dy > 0 ? 25 : -25;
      await sleep(60);
    }
    await sleep(180);
    press(' ', 'Space');
    await sleep(200);
  }

  /** The browser's own drag-and-drop events, for pages built on draggable=true. */
  async function html5Drag(from, to) {
    const a = centerOf(from), b = centerOf(to);
    const dt = new DataTransfer();
    const ev = (type, x, y) => new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, dataTransfer: dt,
    });
    const src = hitAt(a.x, a.y, from), dst = hitAt(b.x, b.y, to);
    src.dispatchEvent(ev('dragstart', a.x, a.y));
    await sleep(30);
    dst.dispatchEvent(ev('dragenter', b.x, b.y));
    dst.dispatchEvent(ev('dragover', b.x, b.y));
    dst.dispatchEvent(ev('drop', b.x, b.y));
    src.dispatchEvent(ev('dragend', b.x, b.y));
  }

  /** Clear any half-finished gesture: a selection, a rubber-band line. */
  async function resetGesture() {
    for (const t of [document.activeElement, document]) {
      try { t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch { }
    }
    fireClick(document.body);
    await sleep(120);
  }

  /** The ways a link between two items might be made, most likely first. Which
   *  one a site wants isn't knowable from outside, so each is tried and checked. */
  const LINK_STRATEGIES = [
    ['click row, then row',       async (L, R) => { clickAtCenter(L.row); await sleep(140); clickAtCenter(R.row); }],
    ['click dot, then dot',       async (L, R) => { clickAtCenter(L.marker); await sleep(140); clickAtCenter(R.marker); }],
    ['drag dot to dot',           (L, R) => pointerDrag(L.marker, R.marker)],
    ['drag dot to row',           (L, R) => pointerDrag(L.marker, R.row)],
    ['drag row to row',           (L, R) => pointerDrag(L.row, R.row)],
    ['browser drag, dot to row',  (L, R) => html5Drag(L.marker, R.row)],
    ['browser drag, row to row',  (L, R) => html5Drag(L.row, R.row)],
  ];

  /** Link one left item to one right item. A strategy only counts if the page
   *  is still different after the gesture is cleared — a highlight or a
   *  rubber-band line disappears on reset, a real link does not. */
  async function linkItems(m, L, R, start = 0) {
    const tried = [];
    for (let s = start; s < LINK_STRATEGIES.length; s++) {
      const [name, run] = LINK_STRATEGIES[s];
      if (/browser drag/.test(name) && !(L.marker.closest('[draggable="true"]') || L.row.closest('[draggable="true"]'))) continue;

      const before = matchSignature(m);
      try { await run(L, R); } catch (e) { tried.push(`${name}: ${e.message}`); continue; }
      await sleep(350);
      await resetGesture();
      if (matchSignature(m) !== before) return { ok: true, via: name, strategy: s, tried };
      tried.push(name);
    }
    return { ok: false, tried };
  }

  /** Link every left item to its right item, then (optionally) submit. `pairs[i]`
   *  is the index of the right item that goes with left item i. */
  async function commitMatch(pairs, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'match', links: [], selected: false, submitted: false };

    const p = scrape();
    const m = p.match;
    if (!m) { out.error = 'no matching question found'; return out; }
    if (pairs.length !== m.left.length) {
      out.error = `answer count mismatch: ${pairs.length} answers for ${m.left.length} items`;
      return out;
    }
    if (new Set(pairs).size !== pairs.length || pairs.some(i => !Number.isInteger(i) || i < 0 || i >= m.right.length)) {
      out.error = 'answers must pair each item with a different, existing sentence';
      return out;
    }

    let start = 0;                                      // what worked last time works first this time
    for (const [i, j] of pairs.entries()) {
      const r = await linkItems(m, m.left[i], m.right[j], start);
      out.links.push({ left: i, right: j, ...r });
      if (!r.ok) {
        out.error = `could not link item ${i + 1} to "${m.right[j].text}" — tried: ${r.tried.join('; ') || 'nothing'}`;
        return out;
      }
      start = r.strategy;
    }

    // The page's own opinion: Submit becomes usable once everything is linked.
    const btn = await waitForSubmit(m.region || null, 2500);
    out.selected = !!btn;
    if (!btn) {
      out.error = 'every link made a change, but Submit never became available — they may not have registered';
      return out;
    }
    if (!autoSubmit) return out;

    await sleep(delay);
    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    out.submitted = c.ok;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    return out;
  }

  /** When a page mentions "match" or "drag" but no question of that kind was found,
   *  the part of the page worth outlining is around that instruction line: the
   *  largest block that stops short of the app's own sidebar. Starting from the page
   *  root spends the whole node budget on the sidebar before reaching the question. */
  function nearInstruction() {
    if (!lastMatchDiag && !lastDragDiag) return null;
    const frames = appFrames();
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length || !(says('match', el.textContent) || says('drag', el.textContent)) || !visible(el)) continue;
      if (frames.some(f => f === el || f.contains(el))) continue;
      let root = el;
      for (let i = 0; i < 10 && root.parentElement && root.parentElement !== document.body; i++) {
        if (frames.some(f => root.parentElement.contains(f))) break;
        root = root.parentElement;
      }
      return root;
    }
    return null;
  }

  /** An outline of the DOM — tags, classes, roles, sizes, colours of small
   *  things — for the failure report. When a question type can't be driven, this
   *  is what says how the page is actually built. */
  function skeleton(root, { maxDepth = 8, maxNodes = 180 } = {}) {
    const lines = [];
    let n = 0;
    const walk = (el, depth) => {
      if (n >= maxNodes || depth > maxDepth) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|PATH|G|DEFS)$/i.test(el.tagName)) return;
      if (hudEl && hudEl.contains(el)) return;
      n++;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push(`#${el.id}`);
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) bits.push(`.${cls.join('.')}`);
      for (const a of ['role', 'draggable', 'aria-roledescription', 'aria-checked', 'aria-pressed', 'aria-label', 'type', 'data-testid']) {
        const v = el.getAttribute(a);
        if (v) bits.push(`[${a}=${v.slice(0, 20)}]`);
      }
      bits.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
      if (cs.cursor === 'pointer') bits.push('cursor:pointer');
      if (['Top', 'Right', 'Bottom', 'Left'].some(s => /dashed|dotted/.test(cs[`border${s}Style`]) && parseFloat(cs[`border${s}Width`]) > 0)) bits.push('border:dashed');
      if (r.width <= 40 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bits.push(`bg:${cs.backgroundColor}`);
      if (!el.children.length && el.textContent.trim()) bits.push(JSON.stringify(txt(el).slice(0, 36)));
      lines.push(`${'  '.repeat(depth)}${bits.join(' ')}`);
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(root, 0);
    if (n >= maxNodes) lines.push('  … (truncated)');
    return lines.join('\n');
  }

  /* ---------------------------------------------------------- drag and drop */

  // Attributes the common drag-and-drop libraries leave on their elements.
  const ZONE_HINT = '[data-rbd-droppable-id], [aria-dropeffect], [data-droppable], [class*="droppable" i], [class*="dropzone" i], [class*="drop-zone" i]';
  const ITEM_HINT = '[draggable="true"], [data-rbd-draggable-id], [aria-roledescription="draggable"], [data-draggable], [class*="draggable" i]';

  const inChrome = el => !!el.closest('aside, nav, [role="navigation"], [role="complementary"]') || inSiteChrome(el) || !!(hudEl && hudEl.contains(el));
  // Top to bottom; along a line, the order the page is written in. That is the DOM
  // order — left to right in English, right to left in Arabic — where comparing
  // left edges would number the gaps of an Arabic sentence backwards.
  const byReading = (a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (Math.abs(ra.top - rb.top) > 12) return ra.top - rb.top;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  };

  let lastDragDiag = null;    // why the last look for a drag question did or didn't find one

  /** An input, or a box wrapped around one. A fill-in's blanks are dashed, empty
   *  and box-sized too, and a page can say "drag" in its instructions. */
  const isField = el => el.matches('input, textarea, select') || !!el.querySelector('input, textarea, select');

  /** The gaps to drop into: empty boxes drawn with a dashed outline, or marked as
   *  drop targets by the library. In reading order. */
  function findDropZones() {
    const zones = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length > 3) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.width > 340 || r.height < 22 || r.height > 90) continue;
      if (shownText(el) || inChrome(el)) continue;
      if (isField(el)) continue;                          // a typed blank, not a drop target
      const cs = getComputedStyle(el);
      const dashed = ['Top', 'Right', 'Bottom', 'Left'].some(s =>
        /dashed|dotted/.test(cs[`border${s}Style`]) && parseFloat(cs[`border${s}Width`]) > 0) ||
        (/dashed|dotted/.test(cs.outlineStyle) && parseFloat(cs.outlineWidth) > 0);   // some sites use an outline
      if (!(dashed || el.matches(ZONE_HINT)) || !visible(el)) continue;
      zones.push(el);
    }
    return zones.filter(z => !zones.some(o => o !== z && o.contains(z))).sort(byReading).slice(0, 12);
  }

  /** Gaps found by where the text ISN'T: a wide empty stretch between two words
   *  on the same line, with an empty element sitting in it. Doesn't care how the
   *  box is drawn — a dashed border, a pseudo-element ring, a background image —
   *  which matters because drag-and-drop libraries leave no marker on a drop area
   *  (dnd-kit adds nothing to the DOM for one), so the only common thing about a
   *  gap is that it's a hole in a sentence. */
  function findGapsByText() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || inChrome(el)) continue;
      if (el.closest('button, [role="button"], [aria-hidden="true"], [aria-live], [role="status"], [role="alert"], header, footer')) continue;
      if (!isShown(n)) continue;       // a clipped screen-reader label has a real box, and would shrink the hole
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
      if (rects.length) nodes.push({ first: rects[0], last: rects[rects.length - 1] });
    }

    const boxes = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i].last, b = nodes[i + 1].first;
      const w = b.left - a.right;
      const sameLine = Math.abs(a.top - b.top) < 12 && Math.abs(a.bottom - b.bottom) < 14;
      if (!sameLine || w < 60 || w > 340) continue;

      const hit = document.elementFromPoint(a.right + w / 2, (a.top + a.bottom) / 2);
      if (!hit || shownText(hit) || inChrome(hit)) continue;     // a hole, with something empty in it
      let box = hit;                                              // grow to the whole box
      for (let k = 0; k < 4; k++) {
        const p = box.parentElement;
        if (!p || shownText(p)) break;
        const r = p.getBoundingClientRect();
        if (r.width > w + 30 || r.height > 90) break;
        box = p;
      }
      if (isField(hit) || isField(box)) continue;
      if (!boxes.includes(box)) boxes.push(box);
    }
    return boxes;
  }

  /** The things to drag: elements the library marked draggable, or — since not
   *  every page leaves a marker — the longest stack of equal-sized, short-text
   *  boxes that isn't a drop zone. Resolves { els, via } so a report can say which. */
  function findDragItems(zones) {
    const usable = el => visible(el) && !inChrome(el) && !zones.some(z => z.contains(el) || el.contains(z));
    // Length is counted without vowel marks: Arabic text carries about a quarter
    // more characters than it has letters. An item can be a whole sentence.
    const ok = el => { const n = arNorm(txt(el)).length; return n >= 1 && n <= 110; };

    let marked = [...document.querySelectorAll(ITEM_HINT)].filter(el => usable(el) && ok(el));
    marked = marked.filter(c => !marked.some(o => o !== c && o.contains(c)));
    if (marked.length >= 2) return { els: marked.sort(byReading), via: 'markers' };

    const boxes = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.width > 520 || r.height < 28 || r.height > 140) continue;
      const t = arNorm(txt(el));
      if (t.length < 2 || t.length > 110 || !usable(el)) continue;
      boxes.push({ el, r });
    }
    const items = boxes.filter(b => !boxes.some(o => o !== b && o.el.contains(b.el) &&
      Math.abs(o.r.top - b.r.top) < 30 && Math.abs(o.r.left - b.r.left) < 40 && Math.abs(o.r.height - b.r.height) < 40));
    const groups = [];
    for (const b of items) {
      const g = groups.find(g => Math.abs(g.left - b.r.left) <= 8 && Math.abs(g.width - b.r.width) <= 0.1 * g.width);
      if (g) g.items.push(b); else groups.push({ left: b.r.left, width: b.r.width, items: [b] });
    }
    const best = groups.filter(g => g.items.length >= 3).sort((a, b) => b.items.length - a.items.length)[0];
    return { els: best ? best.items.map(b => b.el).sort(byReading) : [], via: 'layout' };
  }

  /** A drag-and-drop question: dashed gaps in a sentence and a tray of items. */
  function findDrag() {
    lastDragDiag = null;
    // The page asks for a drag in words (in any language), or marks its items the way
    // a drag library does — which needs no language at all.
    const marked = document.querySelectorAll('[aria-roledescription="draggable"], [data-rbd-draggable-id]').length >= 2;
    if (!marked && !says('drag')) return null;
    const diag = lastDragDiag = { guard: true, zones: 0, items: 0, result: 'no gaps found' };

    // Dashed boxes first; failing that, the holes in the sentences.
    let zones = findDropZones();
    diag.via = 'dashed boxes';
    if (!zones.length) { zones = findGapsByText(); diag.via = 'gaps in the text'; }
    diag.zones = zones.length;
    if (!zones.length) return null;

    const found = findDragItems(zones);
    const items = found.els;
    diag.items = items.length;
    diag.itemsVia = found.via;
    diag.result = `${zones.length} gaps, ${items.length} items`;
    if (items.length < zones.length) { diag.result += ' — fewer items than gaps'; return null; }

    // The tray, kept out of the sentence text — unless it contains the gaps too.
    let tray = nearestCommonAncestor(items);
    if (tray && zones.some(z => tray.contains(z))) tray = null;

    const region = regionAround(zones);
    diag.result = `found ${zones.length} gaps and ${items.length} items`;
    return {
      zones: zones.map(el => ({ el })),
      items: items.map(el => ({ el, text: txt(el) })),
      tray, region,
      text: walkWithBlanks(region, zones, tray),
      intro: textAbove(Math.min(...zones.map(z => z.getBoundingClientRect().top)), []),
    };
  }

  /** What the drag detector had to work with, for a report when it found nothing:
   *  every dashed box on the page whatever its size or contents, how many things
   *  carry a library's draggable marker, and how many holes sit in the text. */
  function dragEvidence() {
    const dashed = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (hudEl && hudEl.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 14) continue;
      const cs = getComputedStyle(el);
      const how = ['Top', 'Right', 'Bottom', 'Left'].some(s => /dashed|dotted/.test(cs[`border${s}Style`]) && parseFloat(cs[`border${s}Width`]) > 0)
        ? 'border' : (/dashed|dotted/.test(cs.outlineStyle) && parseFloat(cs.outlineWidth) > 0 ? 'outline' : '');
      if (!how) continue;
      dashed.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)} ${how} kids=${el.children.length} shows=${JSON.stringify(shownText(el).slice(0, 24))}`);
    }
    const marked = [...document.querySelectorAll(ITEM_HINT)];
    return {
      dashed: dashed.slice(0, 8), dashedTotal: dashed.length,
      marked: marked.length,
      markedSample: marked.slice(0, 2).map(el => `${describe(el)} ${JSON.stringify(txt(el).slice(0, 24))}`),
      holes: findGapsByText().length,
    };
  }

  /** How many times a word appears in the page outside the tray. A word dropped
   *  into a gap adds one; a word still waiting in the tray does not. */
  function countOutside(text, tray) {
    const key = normKey(text);
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement;
      if (!el || !node.nodeValue.trim() || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      if ((tray && tray.isConnected && tray.contains(el)) || (hudEl && hudEl.contains(el))) continue;
      if (normKey(node.nodeValue).includes(key)) n++;
    }
    return n;
  }

  /** The ways an item might be moved into a gap, most likely first. A function
   *  may return 'skip' to say it doesn't apply to this page. */
  const DRAG_STRATEGIES = [
    // Grabbed by the label when the row is much wider than its word; by the row's middle otherwise.
    // The next one tries the other way round, for a page that wants it.
    ['drag the item',               (it, z) => pointerDrag(it.el, z.el, { aim: stretched(it.el) ? 'label' : 'row' })],
    ['drag the item by the other grab point', (it, z) => pointerDrag(it.el, z.el, { aim: stretched(it.el) ? 'row' : 'label' })],
    ['press, hold, then drag',      (it, z) => pointerDrag(it.el, z.el, { hold: 350, aim: stretched(it.el) ? 'label' : 'row' })],
    ['slow drag, resting on the gap', (it, z) => pointerDrag(it.el, z.el, { hold: 350, steps: 24, stepMs: 30, dwell: 450, aim: 'label' })],
    ['drag by its grip',            async (it, z) => { const g = findHandle(it.el, 'left'); return g === it.el ? 'skip' : pointerDrag(g, z.el); }],
    ['keyboard',                    (it, z) => keyboardDrag(it.el, z.el)],
    ['browser drag and drop',       async (it, z) => document.querySelector('[draggable="true"]') ? html5Drag(it.el, z.el) : 'skip'],
    ['click the item, then the gap', async (it, z) => { clickAtCenter(it.el); await sleep(140); clickAtCenter(z.el); }],
  ];

  /** Move one item into one gap and check the word really landed. */
  async function dropItem(item, zone, tray, start = 0) {
    const tried = [];
    for (let s = start; s < DRAG_STRATEGIES.length; s++) {
      const [name, run] = DRAG_STRATEGIES[s];
      const before = countOutside(item.text, tray);
      const sig = pageSignature();
      // A gap found by its position may be a box that already sits in a sentence
      // containing the word; only a NEW appearance of it inside the box counts.
      const hadWord = normKey(txt(zone.el)).includes(normKey(item.text));

      let r;
      try { r = await run(item, zone); } catch (e) { tried.push(`${name}: ${e.message}`); continue; }
      if (r === 'skip') continue;
      await sleep(400);
      await resetGesture();

      // Landed if the gap now shows the word, the word turned up outside the
      // tray, or the gap itself was replaced and the page visibly changed.
      const inGap = !hadWord && zone.el.isConnected && normKey(txt(zone.el)).includes(normKey(item.text));
      const added = countOutside(item.text, tray) > before;
      const replaced = !zone.el.isConnected && pageSignature() !== sig;
      if (inGap || added || replaced) return { ok: true, via: name, strategy: s, tried };
      // What the page's own screen-reader line said ("…was dropped over droppable area…" or just "…was
      // dropped."): the one thing that shows whether the page saw the item over the gap.
      const said = (document.querySelector('[id^="DndLiveRegion"], [role="status"][aria-live]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      tried.push(said ? `${name} (page said: "${said}")` : name);
    }
    return { ok: false, tried };
  }

  /** Fill the gaps in order, then (optionally) submit. `fills[i]` is the index of
   *  the item that goes in gap i; there can be more items than gaps. */
  async function commitDrag(fills, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'drag', placed: [], selected: false, submitted: false };

    const p = scrape();
    const d = p.drag;
    if (!d) { out.error = 'no drag-and-drop question found'; return out; }
    if (fills.length !== d.zones.length) {
      out.error = `answer count mismatch: ${fills.length} answers for ${d.zones.length} gaps`;
      return out;
    }
    if (new Set(fills).size !== fills.length || fills.some(i => !Number.isInteger(i) || i < 0 || i >= d.items.length)) {
      out.error = 'answers must use a different, existing item for each gap';
      return out;
    }

    const words = fills.map(j => d.items[j].text);
    let start = 0;                                      // what worked last time works first this time
    for (let k = 0; k < words.length; k++) {
      // The layout moves after every drop: gaps widen, the tray closes up. Look again.
      const cur = k === 0 ? d : scrape().drag;
      const left = words.length - k;
      if (!cur || cur.zones.length < left) {
        out.error = `after ${k} drops the page no longer shows ${left} empty gaps`;
        return out;
      }
      const item = cur.items.find(it => normKey(it.text) === normKey(words[k]));
      if (!item) { out.error = `"${words[k]}" is no longer in the tray`; return out; }
      const zone = cur.zones[cur.zones.length - left];   // the earliest gaps are the ones already filled

      const r = await dropItem(item, zone, cur.tray, start);
      out.placed.push({ gap: k + 1, word: words[k], ...r });
      if (!r.ok) {
        out.error = `could not drop "${words[k]}" into gap ${k + 1} — tried: ${r.tried.join('; ') || 'nothing'}`;
        return out;
      }
      start = r.strategy;
    }

    // Not scoped to the question's region: that is a guess, and a guess wide enough
    // to take in the footer would hide Submit from the search.
    const btn = await waitForSubmit(null, 2500);
    out.selected = !!btn;
    if (!btn) {
      out.error = 'every word was placed, but Submit never became available — they may not have registered';
      return out;
    }
    if (!autoSubmit) return out;

    await sleep(delay);
    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    out.submitted = c.ok;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    return out;
  }

  /* ------------------------------------------------------------- ordering */

  /** An ordering question: a list of items to put in order by dragging, built with a
   *  sortable-list library. dnd-kit's useSortable marks every item
   *  aria-roledescription="sortable", which says it in any language and needs no
   *  guess about how the page is drawn. Resolves { items, region, intro } or null. */
  function findSort() {
    const marked = [...document.querySelectorAll('[aria-roledescription="sortable"]')].filter(el => visible(el) && !inChrome(el));
    const els = marked.filter(c => !marked.some(o => o !== c && o.contains(c))).sort(byReading);
    if (els.length < 2) return null;
    const top = Math.min(...els.map(el => el.getBoundingClientRect().top));
    return {
      items: els.map(el => ({ el, text: txt(el) })),
      region: nearestCommonAncestor(els),
      intro: textAbove(top, els.map(row => ({ row }))),     // the instruction, without the items or the page's frame
    };
  }

  /** The grip an ordering item is picked up by, if it has one: a small picture or icon. */
  function sortHandle(el) {
    for (const h of el.querySelectorAll('img, svg, [class*="handle" i], [class*="grip" i]')) {
      const r = h.getBoundingClientRect();
      if (r.width >= 6 && r.width <= 48 && r.height >= 6 && r.height <= 48 && !txt(h) && visible(h)) return h;
    }
    return null;
  }

  /** Move an item with the keyboard, the way a dnd-kit list allows: Space picks it up,
   *  the arrows move it one place each, Space puts it down. */
  async function keyboardMove(el, places) {
    const key = (code, key, target) => (target || document).dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }));
    try { el.focus?.({ preventScroll: true }); } catch { /* not focusable */ }
    key('Space', ' ', el);
    await sleep(120);
    const arrow = places > 0 ? 'ArrowDown' : 'ArrowUp';
    for (let i = 0; i < Math.abs(places); i++) { key(arrow, arrow, document.activeElement || el); await sleep(90); }
    key('Space', ' ', document.activeElement || el);
    await sleep(200);
  }

  /** The ways an ordering item might be moved to another's place, most likely first. */
  const SORT_STRATEGIES = [
    ['drag the item',          (it, tg) => pointerDrag(it.el, tg.el)],
    ['press, hold, then drag', (it, tg) => pointerDrag(it.el, tg.el, { hold: 350 })],
    ['drag by its handle',     async (it, tg) => { const g = sortHandle(it.el); return g ? pointerDrag(g, tg.el) : 'skip'; }],
    ['keyboard',               (it, tg, from, to) => keyboardMove(it.el, to - from)],
  ];

  /** Put the items in the order given — `order[k]` is the item (counting from 0, as they
   *  were shown) that belongs in place k — then (optionally) submit. Works from the top:
   *  the item for place 0 is dragged there first, and so on, looking at the list again
   *  after every move because the others shuffle. */
  async function commitSort(order, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'sort', moves: [], selected: false, submitted: false };

    const p = scrape();
    const s = p.sort;
    if (!s) { out.error = 'no ordering question found'; return out; }
    const n = s.items.length;
    if (order.length !== n || new Set(order).size !== n || order.some(i => !Number.isInteger(i) || i < 0 || i >= n)) {
      out.error = `the order must use each of the ${n} items exactly once`;
      return out;
    }
    const want = order.map(i => s.items[i].text);
    const textsNow = () => (scrape().sort?.items || []).map(it => normKey(it.text));

    const moveTo = async (k, start) => {
      const tried = [];
      for (let st = start; st < SORT_STRATEGIES.length; st++) {
        const cur = scrape().sort;
        if (!cur || cur.items.length !== n) return { ok: false, tried, error: 'the list changed while it was being ordered' };
        const from = cur.items.findIndex(it => normKey(it.text) === normKey(want[k]));
        if (from < 0) return { ok: false, tried, error: `"${want[k]}" is no longer in the list` };
        if (from === k) return { ok: true, via: tried.length ? 'moved' : 'already there', strategy: st, tried };
        const [name, run] = SORT_STRATEGIES[st];
        let r;
        try { r = await run(cur.items[from], cur.items[k], from, k); } catch (e) { tried.push(`${name}: ${e.message}`); continue; }
        if (r === 'skip') continue;
        await sleep(400);
        await resetGesture();
        if (textsNow()[k] === normKey(want[k])) return { ok: true, via: name, strategy: st, tried };
        tried.push(name);
      }
      return { ok: false, tried };
    };

    let start = 0;                                      // what worked last time works first this time
    for (let k = 0; k < n; k++) {
      const r = await moveTo(k, start);
      if (r.via !== 'already there') out.moves.push({ item: want[k], to: k + 1, ...r });
      if (!r.ok) {
        out.error = r.error || `could not move "${want[k]}" to place ${k + 1} — tried: ${r.tried.join('; ') || 'nothing'}`;
        return out;
      }
      start = r.strategy;
    }

    // It has to be what was asked for, whatever each move reported.
    const finalOrder = textsNow();
    if (finalOrder.some((t, k) => t !== normKey(want[k]))) {
      out.error = 'the list does not end up in the order asked for';
      return out;
    }

    // Submit is often greyed out until the list has been changed. If the order wanted is
    // the one already shown, nothing was changed: move the first item down and back.
    let btn = await waitForSubmit(null, out.moves.length ? 2500 : 800);
    if (!btn && !out.moves.length && n >= 2) {
      for (const [a, b] of [[0, 1], [1, 0]]) {
        const cur = scrape().sort;
        const r = cur ? await (async () => { for (const [, run] of SORT_STRATEGIES) { try { const x = await run(cur.items[a], cur.items[b], a, b); if (x !== 'skip') return true; } catch { /* next */ } } return false; })() : false;
        await sleep(400); await resetGesture();
        if (!r) break;
      }
      btn = await waitForSubmit(null, 2500);
    }
    out.selected = !!btn;
    if (!btn) { out.error = 'the list is in order, but Submit never became available'; return out; }
    if (!autoSubmit) return out;

    await sleep(delay);
    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    out.submitted = c.ok;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    return out;
  }

  function scrape() {
    const match = findMatch();
    const drag = match ? null : findDrag();
    const sort = (match || drag) ? null : findSort();
    const opts = (match || drag || sort) ? null : findOptions();
    const optionsRoot = opts?.root || null;
    const passage = findPassage(optionsRoot);
    const stem = findStem(optionsRoot);
    const images = findImages(optionsRoot);
    const dropdown = (opts || match || drag || sort) ? null : findDropdownQuestion();
    const cloze = (opts || match || drag || sort) ? null : findCloze(optionsRoot, dropdown ? dropdown.triggers.map(t => t.el) : []);

    // What are we actually plugged into?
    const dlg = document.querySelector('[role="dialog"], [class*="modal" i]');
    const frame = IS_TOP ? 'top' : (window.name || 'child-frame');

    const kind = match ? 'match'
               : drag ? 'drag'
               : sort ? 'sort'
               : (opts?.rows.length >= 2) ? 'choice'
               : dropdown ? 'dropdown'
               : cloze ? 'cloze' : null;

    return {
      frame,
      url: location.href,
      title: document.title,
      kind,
      stem,
      passage,
      options: opts ? opts.rows.map((r, i) => ({ text: opts.texts[i], el: r.el })) : [],
      optionsSane: opts ? opts.sane : true,
      multi: !!(opts && opts.multi && opts.rows.length >= 2),      // "Select the correct answers": tick every right one
      instruction: opts && opts.multi ? findInstruction(optionsRoot) : '',
      cloze: cloze ? {
        text: cloze.text,
        wordBank: cloze.wordBank,
        blanks: cloze.inputs.map(el => ({
          el,
          math: el.tagName === 'MATH-FIELD',      // a math answer box: typed as math, not as text
          placeholder: el.placeholder || '',
          value: el.tagName === 'MATH-FIELD' ? '' : (el.value || ''),     // (a math field's value is not readable from here)
          len: el.maxLength > 0 ? el.maxLength : null,
        })),
      } : null,
      dropdown: dropdown ? {
        text: dropdown.text,
        region: dropdown.region,
        blanks: dropdown.triggers.map(t => ({ el: t.el, native: t.native, shows: txt(t.el).slice(0, 40) })),
      } : null,
      match,
      drag,
      sort,
      images,
      dialogFound: !!dlg,
      score: (stem ? 3 : 0) + (kind ? 3 : 0) + (passage ? 1 : 0),
    };
  }

  /* ========================================================= screenshotting */

  /** Words that say a question is about something drawn, and words that say it is about a passage.
   *  English and Arabic, because both lessons are met. These only ever ADD a screenshot to "smart"
   *  mode: a false alarm costs a second, a miss costs a question answered blind. */
  const FIGURE_WORDS = /\b(graph|chart|figure|diagram|picture|image|photo|map|table|illustration|drawing|sketch)s?\b|الشكل|الأشكال|الرسم|الصورة|الصور|الجدول|المخطط|البياني|الخريطة/i;
  const PASSAGE_WORDS = /\b(passage|paragraph|excerpt|poem|story|article|text|extract)s?\b|الفقرة|القطعة|القصة|القصيدة|المقال|النص/i;
  // What the page puts where a picture answer has no words.
  const PICTURE_ANSWER = /image content/i;

  /** Whether to take a screenshot before asking, for the popup's Screenshot setting.
   *   always   every time.
   *   auto     when it is likely to matter: a figure, or a choice question whose passage was not
   *            read (a fill-in or drop-down already carries its instructions in the text).
   *   smart    only when the words are not enough, and the words are trusted
   *            otherwise: no capture, no upload, nothing extra for the model to read. It takes one
   *            for a figure, for a stem that is empty or only the instruction (the question is in
   *            a picture), for answers that are pictures or blank, for a stem that names a figure,
   *            and for a stem that names a passage nobody read. A plain question with a stem and
   *            worded answers goes without.
   *   never    (or anything else) not at all.
   *  `q` is { kind, imageCount, passageLen, stem, instruction, optionTexts }. */
  function wantsScreenshot(mode, q) {
    if (mode === 'always') return true;
    if (mode === 'auto') return q.imageCount > 0 || (q.kind === 'choice' && q.passageLen < 250);
    if (mode !== 'smart') return false;

    if (q.imageCount > 0) return true;
    const stem = String(q.stem || '').trim();
    if (FIGURE_WORDS.test(stem)) return true;
    if (q.kind !== 'choice') return false;               // the other kinds carry their words in their own parts

    if (!stem || stem === String(q.instruction || '').trim()) return true;
    if ((q.optionTexts || []).some(t => !String(t || '').trim() || PICTURE_ANSWER.test(t))) return true;
    return PASSAGE_WORDS.test(stem) && q.passageLen < 250;
  }

  /** Grab the page, scrolling and stitching when the question is taller than
   *  the viewport. Returns a JPEG data URL, or null if capture is blocked. */
  async function screenshot(maxCaptures) {
    const first = await Promise.race([
      chrome.runtime.sendMessage({ type: 'capture' }).catch(() => null),
      new Promise(r => setTimeout(() => r(null), 3000)),
    ]);
    if (!first || first.error || !first.dataUrl) return null;

    const vw = window.innerWidth, vh = window.innerHeight;
    const pageH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const scroller = document.scrollingElement || document.documentElement;

    // Whole question fits on screen — one shot, no scroll gymnastics.
    if (pageH <= vh + 120) return downscale(first.dataUrl, vw, vh, pageH);

    // Taller than the viewport: scroll, capture, stitch.
    const startY = scroller.scrollTop;
    const shots = [{ y: 0, url: first.dataUrl }];
    const step = Math.floor(vh * 0.88);
    for (let i = 1; i < maxCaptures && startY + i * step < pageH - 40; i++) {
      scroller.scrollTop = startY + i * step;
      await sleep(620); // captureVisibleTab is rate-limited; don't outrun it
      const s = await chrome.runtime.sendMessage({ type: 'capture' }).catch(() => null);
      if (!s || s.error || !s.dataUrl) break;
      shots.push({ y: i * step, url: s.dataUrl });
    }
    scroller.scrollTop = startY;

    return stitch(shots, vw, vh);
  }

  async function stitch(shots, vw, vh) {
    const total = Math.max(...shots.map(s => s.y)) + vh;
    const canvas = document.createElement('canvas');
    canvas.width = vw; canvas.height = total;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, vw, total);

    for (const s of shots) {
      const img = await loadImage(s.url);
      if (img) ctx.drawImage(img, 0, s.y, vw, vh);
    }
    return downscaleCanvas(canvas);
  }

  function loadImage(url) {
    return new Promise(res => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = url;
    });
  }

  /** Shrink to at most 1568px on the long edge — what vision models actually
   *  consume. Larger just costs tokens and latency for no extra detail. */
  function downscaleCanvas(canvas, keep = 1568) {
    const { width: w, height: h } = canvas;
    const scale = Math.min(1, keep / Math.max(w, h));
    if (scale >= 1) return canvas.toDataURL('image/jpeg', 0.85);
    const c2 = document.createElement('canvas');
    c2.width = Math.round(w * scale);
    c2.height = Math.round(h * scale);
    const cx = c2.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, 0, 0, c2.width, c2.height);
    return c2.toDataURL('image/jpeg', 0.85);
  }

  async function downscale(dataUrl, w, h, cropTo) {
    const img = await loadImage(dataUrl);
    if (!img) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = Math.min(h, Math.max(cropTo, 100));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, w, h);
    return downscaleCanvas(canvas);
  }

  /* ============================================================== settings */

  const SETTING_KEYS = ['autoSubmit', 'openPassage', 'screenshot', 'answerDelay',
                        'advance', 'cachePassage', 'stepDelay', 'retries', 'devMode', 'hotkeys',
                        'autoNextLesson', 'maxLessons', 'slideWaitMs', 'skipLater'];

  async function loadSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    try {
      const s = await chrome.storage.local.get(SETTING_KEYS);
      Object.assign(CFG, s);
    } catch { /* keep defaults */ }
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [k, v] of Object.entries(changes)) CFG[k] = v.newValue;
    });
  }

  /* ============================================ advanced button discovery */

  /** Score a button, distinguishing "finish my answer" from "move on".
   *
   *  These are different actions and must not be confused: submitting an
   *  unanswered question often does nothing or locks in a blank, while failing
   *  to advance leaves the run stuck. So they're found separately. */
  function buttonScore(el, kind) {
    const label = txt(el);
    if (!label || label.length > 30) return -1;      // not a control label
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const hay = `${label} ${aria} ${el.title || ''}`.toLowerCase();

    // The WHOLE label has to be a submit phrase. A prefix match took the
    // sidebar's "Check My Understanding" for the Submit button — it is always
    // enabled, while the real Submit stays disabled until the answers register,
    // so it was the only candidate and got clicked instead.
    // "Done" is NOT a submit phrase: on the last question of a lesson it is the
    // button that ends the lesson, and treating it as Submit would mean pressing
    // it as if it were an answer.
    const SUBMIT = /^(submit|check|verify|confirm)( (my )?(answer|answers|quiz|response|it))?\W*$|^answer\W*$/;
    const FINISH = /^(done|finish|finished|complete|end lesson)\W*$/;
    // What a wrong answer offers instead of Next: the whole label, like Submit.
    const RETRY = /^(try again|retry|try once more|try one more time)\W*$/;
    const NEXT = /^(next|continue|forward|proceed|keep going|go on)\b/;
    const HE_SUBMIT = /^(שלח|בדוק|אשר)\b/;
    const HE_NEXT = /^(המשך|הבא|קדימה)\b/;

    // Arabic, compared without vowel marks (see arNorm). "أُرسلُ إجابتي" — "I send my
    // answer" — is the Submit seen on the live page; the rest are the usual wordings.
    // Like the English, the whole label has to be the phrase, except Next, which may
    // carry more ("السؤال التالي ›"). \b does not work on Arabic, so a word ends where
    // the next character is not an Arabic letter.
    const END = `(?![${AR_LETTER}])`, TAIL = `[^${AR_LETTER}a-z0-9]*$`;
    const AR_SUBMIT = new RegExp(`^(?:ارسل(?: (?:اجابتي|الاجابه|اجابه|الحل|اجاباتي))?|ارسال(?: (?:الاجابه|اجابتي))?|تحقق(?: من (?:اجابتي|الاجابه))?|تاكيد(?: الاجابه)?)${TAIL}`);
    const AR_NEXT = new RegExp(`^(?:(?:السؤال )?التالي|(?:ال)?متابعه|استمرار|استمر|تابع)${END}`);
    const AR_FINISH = new RegExp(`^(?:انهاء(?: الدرس| النشاط)?|انهي|تم|اكتمل|انتهيت)${TAIL}`);
    // The live page words its buttons as the person speaking ("أحاولُ ثانيـةً": "I try again", as its
    // Submit is "أُرسلُ إجابتي" and its Back "أعودُ"), so the first-person forms count with the commands.
    const AR_RETRY = new RegExp(`^(?:ا?حاول (?:مره اخري|مجددا|ثانيه|من جديد)|جرب مره اخري|جرب مجددا|اعد المحاوله|اعيد المحاوله|اعاده المحاوله|المحاوله مره اخري)${TAIL}`);
    // The way to the next LESSON, not the next question: "Next Lesson", "Start next
    // lesson", "الدرس التالي". The Next button must not take these for itself, or a
    // run would jump lessons from the middle of one.
    const NEXT_LESSON = /^(?:(?:start|go to|continue to|open|begin) )?(?:the )?next (?:lesson|activity|unit|topic)[^a-z0-9]*$/;
    const AR_NEXT_LESSON = new RegExp(`^(?:(?:ابدا|انتقل الي|اذهب الي|الانتقال الي|فتح) )?(?:ال)?(?:درس|نشاط|وحده|موضوع) (?:ال)?تالي${TAIL}`);
    // After Finish the live site shows "Back to Coursework", which returns to the page
    // listing the tasks; each task there has a "Start" (not begun) or "Continue" (begun). Both
    // are taken, in the list's order. The list is not always up to date, and may still offer a
    // lesson this run has just finished: reopenedDone() goes back from one and takes the next.
    const BACK_COURSE = /^[^a-z]*back to (?:my )?course ?work[^a-z]*$/;
    const AR_BACK_COURSE = new RegExp(`^[^${AR_LETTER}]*(?:العوده|رجوع) الي (?:ال)?(?:واجبات|اعمال دراسيه|مهام|مقرر|دروس)${TAIL}`);
    const START_TASK = /^start$/;
    const AR_START_TASK = new RegExp(`^ابدا${TAIL}`);
    // The skip button on a question: "I'll try later" on the live site. It only moves on.
    const SKIP = /^(?:i['‘’`]?ll )?try later[^a-z]*$|^skip(?: question)?[^a-z]*$/;
    const AR_SKIP = new RegExp(`^ساحاول لاحقا${TAIL}`);
    const arTexts = [arNorm(label), arNorm(aria)].filter(Boolean);
    const arHas = re => arTexts.some(t => re.test(t));
    const isNextLesson = [label.toLowerCase(), aria].some(t => t && NEXT_LESSON.test(t)) || arHas(AR_NEXT_LESSON);

    const isSubmit = kind === 'submit'
      ? [label.toLowerCase(), aria].some(t => t && (SUBMIT.test(t) || HE_SUBMIT.test(t))) || arHas(AR_SUBMIT)
      : kind === 'finish'
        ? [label.toLowerCase(), aria].some(t => t && FINISH.test(t)) || arHas(AR_FINISH)
        : kind === 'retry'
          ? [label.toLowerCase(), aria].some(t => t && RETRY.test(t)) || arHas(AR_RETRY)
          : kind === 'nextLesson'
            ? isNextLesson
            : kind === 'backToCoursework'
              ? [label.toLowerCase(), aria].some(t => t && BACK_COURSE.test(t)) || arHas(AR_BACK_COURSE)
              : kind === 'startTask'
                ? [label.toLowerCase(), aria].some(t => t && START_TASK.test(t)) || arHas(AR_START_TASK)
                : kind === 'skip'
                  ? [label.toLowerCase(), aria].some(t => t && SKIP.test(t)) || arHas(AR_SKIP)
                  : !isNextLesson && (NEXT.test(hay) || HE_NEXT.test(hay) || arHas(AR_NEXT));
    if (!isSubmit) return -1;
    // An arrow glyph or aria-label on its own is a strong Next signal.
    let score = 10;
    if (kind === 'next' && /[›»→▶➜]/.test(label)) score += 4;
    if (!disabled(el)) score += 5; else score -= 8;
    return score;
  }

  /** Is this inside the card for one ATTEMPT at a lesson ("2nd Attempt … Start")? The results
   *  screen after Finish has one per attempt, and the Start on them begins another go at the
   *  same lesson — it is not the next lesson. Looks only at the small box around the button. */
  const ATTEMPT_CARD = new RegExp(`\\b(?:\\d+(?:st|nd|rd|th)|first|second|third|fourth)\\s+attempt\\b|المحاوله (?:ال)?(?:اولي|ثانيه|ثالثه|رابعه)`, 'i');
  function inAttemptCard(el) {
    let node = el.parentElement;
    for (let i = 0; node && i < 4 && node !== document.body; i++, node = node.parentElement) {
      const t = txt(node);
      if (t.length > 240) return false;                  // out of the card, into the page
      if (ATTEMPT_CARD.test(t) || ATTEMPT_CARD.test(arNorm(t))) return true;
    }
    return false;
  }

  /** Is this button one of a list of tasks — a "Continue" on a task someone already began —
   *  rather than the Next of a slide? A row says "2 Tasks Assigned"; and a list has several
   *  Start / Continue buttons where a slide has one Next. */
  function inTaskList(el) {
    if (/\d+\s*tasks?\s*assigned/i.test(taskRowText(el))) return true;
    let n = 0;
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (visible(b) && /^(start|continue|resume)\W*$/i.test(txt(b))) n++;
    }
    return n >= 2;
  }

  /** Is this in the lesson player's own footer bar (Submit Answer, Next, Done, Start all
   *  live in it, on the live site)? Not a list of tasks, whose Start buttons are rows. */
  function inPlayerFooter(el) {
    return !!el.closest('#widgets-navigation-container, .lib-navigation-container, [data-testid="navigation-container"], [data-testid="navigation-buttons"]');
  }

  /** The row a Start button on the task list belongs to: its title and "2 Tasks Assigned". */
  function taskRowText(el) {
    const own = txt(el).length;
    for (let n = el.parentElement, i = 0; n && i < 5 && n !== document.body; i++, n = n.parentElement) {
      const t = txt(n);
      if (t.length > 300) return '';
      if (t.length >= own + 10) return t;
    }
    return '';
  }

  /* ---------------------------------------------------- a lesson already done */

  // The task list can still show a lesson that has just been finished, first among the ones that
  // say Start, and pressing it reopens a lesson that is done. A lesson is told from another by the
  // id in the address ("…/lesson/14ecc41b-…/…"); the rows of the list carry nothing to match it to.
  const lessonId = () => (location.hash.match(/\/lesson\/([0-9a-f-]{8,})/i) || [])[1] || null;
  let visitedLessons = new Set();                 // the lessons this run has been in
  const badRows = new Set();                      // list rows that opened a lesson already done (by their text)
  const rowKey = el => taskRowText(el).replace(/\s*\d+ tasks? assigned.*$/i, '').replace(/\s*(?:start|continue|resume)\s*$/i, '').trim().toLowerCase();
  const rowTitle = el => taskRowText(el).replace(/\s*\d+ tasks? assigned.*$/i, '').replace(/\s*(?:start|continue|resume)\s*$/i, '').trim().slice(0, 60);
  /** What the list offers, for a report: each row's title and its button, and which were found to be
   *  a lesson already done. */
  const startRows = () => [...document.querySelectorAll('button, [role="button"], a')]
    .filter(b => visible(b) && /^(start|continue|resume)\W*$/i.test(txt(b)) && !inPlayerFooter(b))
    .slice(0, 8).map(b => `${rowTitle(b)} [${txt(b)}]${badRows.has(rowKey(b)) ? ' (already done)' : ''}`);

  /** After a Start pressed on the task list: did it open a lesson this run has already been in?
   *  If so, go back to the list, remember the row, and say so; the caller then takes the next
   *  Start. Resolves true when it went back. */
  async function reopenedDone(key) {
    let id = null;
    const t0 = Date.now();
    while (!(id = lessonId()) && Date.now() - t0 < 4000) await sleep(150);
    if (!id) return false;                        // no lesson id to go by
    if (!visitedLessons.has(id)) { visitedLessons.add(id); return false; }
    badRows.add(key);
    hud('that lesson is already done — going back to the list for another one');
    history.back();
    const t1 = Date.now();
    while ((lessonId() || !findButton('startTask', null)) && Date.now() - t1 < 8000) await sleep(200);
    return true;
  }

  /** After a press that should open another lesson: wait for the page to show a screen the lesson run
   *  can go on from — a question that is not the last one, or (once the lesson's id in the address has
   *  changed) a slide, an opening screen, a box to skip. A video slide as the first screen was not
   *  recognised as having arrived, and the run stopped on it. */
  async function waitForOpened(before, idBefore, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (stopRun) return false;
      if (scrape().kind && currentQuestionKey() !== before) return true;
      const id = lessonId();
      if (id && id !== idBefore && (contentScreen() || skipScreen())) return true;
      await sleep(200);
    }
    return false;
  }

  /** The list can show last minute's rows for a moment and then refresh (a lesson just finished is
   *  still on it). Wait until it has held still before choosing from it. */
  async function settleList(maxMs = 6000, quietMs = 1200) {
    const sig = () => norm((document.querySelector('main') || document.body).innerText || '');
    let last = sig(), since = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(200);
      const now = sig();
      if (now !== last) { last = now; since = Date.now(); }
      else if (Date.now() - since >= quietMs) return;
    }
  }

  function findButton(kind, optionsRoot, { requireEnabled = true, exclude = null } = {}) {
    const cands = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a')]
      .filter(el => el.tagName !== 'INPUT' || el.type === 'submit')
      .filter(visible);

    // On a lesson page the player has its own footer bar (Go Back, Submit Answer, Next, Done, "I'll
    // try later"), and the buttons that move the lesson on are in it. When there is one, Next, Submit
    // and the skip button are looked for there and nowhere else: an answer reading "next steps" in
    // the tray was taken for Next, and the unanswered question for an answered one.
    // Only a footer that is showing, with a button showing in it: the opening screen's footer is
    // still in the page, hidden, while a question is up.
    const footers = (kind === 'next' || kind === 'submit' || kind === 'skip')
      ? [...document.querySelectorAll('#widgets-navigation-container, .lib-navigation-container, [data-testid="navigation-container"]')].filter(visible) : [];
    const onlyIn = footers.find(f => [...f.querySelectorAll('button, [role="button"]')].some(visible)) || null;

    const scored = [];
    for (const el of cands) {
      if (exclude && exclude.has(el)) continue;                  // already pressed: not again
      // An item to be dragged or sorted is an answer, whatever it says — "next steps", "submit".
      if (el.closest('[aria-roledescription="draggable"], [aria-roledescription="sortable"], [draggable="true"]')) continue;
      if (onlyIn && !onlyIn.contains(el)) continue;
      // The lesson sidebar has its own always-enabled buttons ("Check My
      // Understanding", "Let's Go!"). Submit and Next live in the question
      // footer, never in an aside or a navigation list.
      // The way to the next lesson, or back to the coursework, often sits in that
      // sidebar; both are matched on their whole label, so nothing else there can pass.
      if (kind !== 'nextLesson' && kind !== 'backToCoursework') {
        if (el.closest('aside, [role="complementary"]')) continue;
        if (kind !== 'next' && el.closest('nav, [role="navigation"]')) continue;
      }
      let s = buttonScore(el, kind);
      // On the list of tasks, a lesson begun and not finished says Continue (or Resume): it is
      // picked up where it was left, like a Start. Only on the list — in the lesson itself a
      // Continue is a Next. Ranked with Start, so the list's own order decides which comes first.
      if (s < 0 && kind === 'startTask' && (/^(continue|resume)\W*$/i.test(txt(el)) || /^(?:ال)?(?:متابعه|استئناف)/.test(arNorm(txt(el))))
          && !inPlayerFooter(el) && inTaskList(el)) s = disabled(el) ? 2 : 15;
      if (s < 0) continue;
      if (kind === 'startTask' && inAttemptCard(el)) continue;     // another go at this lesson, not the next one
      if (kind === 'startTask' && badRows.size && !inPlayerFooter(el) && badRows.has(rowKey(el))) continue;     // opened a lesson already done
      const t = txt(el);
      // Inside the choices — but never the player's own footer: it is not part of any question, even
      // when the area taken for the question has grown until it holds it.
      if (optionsRoot && !(onlyIn && onlyIn.contains(el)) && (el.contains(optionsRoot) || optionsRoot.contains(el))) continue;
      // Prefer buttons that sit below the choices.
      if (optionsRoot && (el.compareDocumentPosition(optionsRoot) & Node.DOCUMENT_POSITION_PRECEDING)) {
        scored.push({ el, score: s + 1, t });
      } else {
        scored.push({ el, score: s, t });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return (requireEnabled ? scored.find(s => !disabled(s.el)) : scored[0])?.el || null;
  }

  /** Is the current question already answered? Used only to resume a
   *  half-finished lesson, so it errs toward "no": skipping an unanswered
   *  question is silent and wrong, while trying to answer an answered one fails
   *  loudly. Class names are deliberately not used — a score tracker can carry
   *  "correct" in its classes on a page nobody has answered yet. */
  function isGraded() {
    return !!(findButton('next', null) || findButton('finish', null)) && !findButton('submit', null);
  }

  function currentQuestionKey() {
    const p = scrape();
    // Include the cloze text so a lesson of fill-in-the-blank items (which have
    // no choices) still yields a distinct key per question.
    return [
      location.hash,
      (p.stem || '').slice(0, 80),
      p.options.map(o => o.text).join('|').length,
      (p.cloze?.text || '').slice(0, 120),
      (p.dropdown?.text || '').slice(0, 120),
      p.match ? p.match.left.map(i => i.text).join('/').slice(0, 160) : '',
      (p.drag?.text || '').slice(0, 120),
      p.sort ? p.sort.items.map(i => i.text).sort().join('/').slice(0, 160) : '',     // sorted: the order changes as it is answered
    ].join('|');
  }

  /* ==================================================== passage, per lesson */

  /** The lesson id from the URL, so a cached passage can never leak between
   *  lessons. Falls back to the path when the URL isn't the expected shape. */
  function lessonKey() {
    const m = location.href.match(/\/lesson\/([A-Za-z0-9-]+)/i);
    return m ? m[1] : `${location.origin}${location.pathname}`;
  }

  const passageMem = new Map();   // lessonKey -> passage text (this page load)

  function rememberPassage(text) {
    if (!CFG.cachePassage || !text || text.length < 200) return;
    passageMem.set(lessonKey(), text);
  }

  function recallPassage() {
    if (!CFG.cachePassage) return '';
    return passageMem.get(lessonKey()) || '';
  }

  function forgetPassage() {
    passageMem.delete(lessonKey());
  }

  /** If the passage sits behind a "Read Passage" button, open it and wait for
   *  the text to actually appear rather than guessing at a fixed delay. */
  async function maybeOpenPassage() {
    if (!CFG.openPassage) return '';
    if (findPassage(null).length > 200) return '';     // already on screen

    const RE = /(read passage|show passage|view passage|passage)/i;
    const btn = [...document.querySelectorAll('button, [role="button"], a')]
      .filter(visible)
      .find(el => RE.test(txt(el)) && !disabled(el));
    if (!btn) return '';

    realClick(btn);
    // Poll for the text instead of sleeping a fixed 700ms.
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const t = findPassage(null);
      if (t.length > 200) return t;
    }
    return '';
  }

  /** The passage for this lesson, from cache when we've seen it, otherwise by
   *  opening the panel and then closing it so it doesn't cover the question. */
  async function acquirePassage(p) {
    // On a fill-in, drop-down or matching page the scraper can mistake the
    // exercise's own instructions for a passage. Caching that would send the
    // previous question's text along with every later one in the lesson.
    const own = [p.dropdown?.text, p.cloze?.text, p.match?.intro, p.drag?.text].filter(Boolean).join(' ');
    const isQuestionText = t => !!own && own.includes(norm(t).slice(0, 60));

    if (p.passage && p.passage.length > 200 && !isQuestionText(p.passage)) {
      rememberPassage(p.passage);
      return p.passage;
    }
    if (p.passage && isQuestionText(p.passage)) p = { ...p, passage: '' };

    const cached = recallPassage();
    if (cached) return cached;

    const opened = await maybeOpenPassage();
    if (opened) {
      rememberPassage(opened);
      await closePassagePanel();
      return opened;
    }
    return '';
  }

  /** Re-click "Read Passage" to collapse it — the panel covers the choices. */
  async function closePassagePanel() {
    const open = document.querySelector('[class*="passage" i], [class*="drawer" i]');
    if (!open) return;
    const btns = [...document.querySelectorAll('button, [role="button"], a, [aria-label]')].filter(visible);
    // A control marked as expanded/close, or an X, inside or near the panel.
    const closer = btns.find(el => {
      const h = `${txt(el)} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      return /(close|dismiss|hide)/.test(h) || /^(×|✕|✖|x)$/i.test(txt(el));
    }) || btns.find(el => /read passage|hide passage/i.test(txt(el)));

    if (closer && !disabled(closer)) { realClick(closer); await sleep(400); }
  }

  async function waitForSubmit(optionsRoot, timeout = 2500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const s = findButton('submit', optionsRoot);
      if (s) return s;
      await sleep(80);
    }
    return null;
  }

  /** After a confirmed submit, wait for the page to say how it went: Next (right,
   *  more to come) or Try Again (wrong). Resolves { kind, el }, or null if neither
   *  shows up — the last question has no Next, and the caller looks for Done.
   *
   *  Try Again is looked for first: a page that offers both has marked the answer
   *  wrong, and moving on would leave the question failed. */
  async function waitForOutcome(timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      for (const kind of ['retry', 'next']) {
        const el = findButton(kind, null);
        if (el) return { kind, el };
      }
      await sleep(120);
    }
    return null;
  }

  /** Is the question on screen one the page has marked wrong and offered back? */
  function offersRetry() {
    return !!findButton('retry', null) && !findButton('submit', null);
  }

  /** Words for an answer that was just marked wrong, so the model is not handed
   *  the same question and left to give the same answer. */
  function attemptLabel(p, picks) {
    const list = xs => xs.map((x, i) => `${i + 1}: ${x}`).join('; ');
    switch (p.kind) {
      case 'choice': {
        if (picks.indices) return picks.indices.map(j => `${'ABCDEFGHIJ'[j]}. ${p.options[j]?.text ?? ''}`).join(' + ');
        const i = picks.index;
        return `${'ABCDEFGHIJ'[i]}. ${p.options[i]?.text ?? ''}`;
      }
      case 'match': return list(picks.pairs.map((j, i) => `${p.match.left[i]?.text} → ${p.match.right[j]?.text}`));
      case 'sort': return picks.order.map(j => p.sort.items[j]?.text).join(' → ');
      default: return list(picks.words || []);
    }
  }

  /** The choice the page still shows as picked, for a question we meet already
   *  marked wrong (the run was started, or resumed, after the answer went in). */
  function pickedBeforeRetry() {
    const p = scrape();
    if (p.kind === 'choice' && p.multi) {
      const on = p.options.map((o, i) => (selected(o.el) ? i : -1)).filter(i => i >= 0);
      if (on.length) return { label: on.map(i => `${'ABCDEFGHIJ'[i]}. ${p.options[i].text}`).join(' + ') };
    } else if (p.kind === 'choice') {
      const i = p.options.findIndex(o => selected(o.el));
      if (i >= 0) return { label: `${'ABCDEFGHIJ'[i]}. ${p.options[i].text}` };
    } else if (p.kind === 'dropdown') {
      const shown = p.dropdown.blanks.map(b => b.shows).filter(t => t && !PLACEHOLDER.test(t));
      if (shown.length) return { label: shown.join(' / ') };
    } else if (p.kind === 'cloze') {
      const typed = p.cloze.blanks.map(b => b.value).filter(Boolean);
      if (typed.length) return { label: typed.join(' / ') };
    }
    return { label: '(not recorded: it was given before this run started)' };
  }

  /** Click Try Again and wait until the question is back and answerable.
   *  Resolves false if the page never reacted. */
  async function takeRetry(el) {
    const r = await clickConfirmed(el, { settle: 1500 });
    if (!r.ok) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      if (!findButton('retry', null, { requireEnabled: false }) && scrape().kind) {
        await sleep(CFG.stepDelay);
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  /** Answer the question on screen. If the page marks it wrong and offers Try
   *  Again, take it — up to CFG.retries times — telling the model each time what
   *  was already wrong. Resolves { r, outcome, tried, wrong, stuck }:
   *    r        the last solveOne result
   *    outcome  { kind, el } from waitForOutcome, when the answer went through
   *    tried    every answer marked wrong so far
   *    wrong    true if it gave up while the page still said wrong
   *    stuck    why Try Again could not be used, if that is what stopped it */
  async function answerQuestion(quiet) {
    const tried = [];

    // The page offers "I'll try later" on some questions. It only moves on, so press it
    // whatever kind of question this is: no tokens spent, no time lost.
    if (CFG.skipLater) {
      const skip = findButton('skip', null);
      if (skip) {
        hud(`the page offers "${txt(skip)}" — pressing it instead of answering`);
        const c = await clickConfirmed(skip, { settle: 1500 });
        return c.ok
          ? { r: { ok: true }, tried, skipped: true }
          : { r: { ok: false, reason: `"${txt(skip)}" was pressed but nothing changed` }, tried };
      }
    }

    if (offersRetry()) {
      tried.push(pickedBeforeRetry());
      if (tried.length > CFG.retries) return { r: { ok: true }, tried, wrong: true };
      hud('this one is marked wrong — trying again');
      if (!(await takeRetry(findButton('retry', null)))) {
        return { r: { ok: true }, tried, stuck: 'Try Again was clicked but the question did not come back' };
      }
    }

    for (;;) {
      const r = await solveOne(quiet, { tried });
      const c = r.commit || {};
      if (!r.ok || !CFG.autoSubmit || !c.submitted) return { r, tried };

      const outcome = await waitForOutcome(4000);
      if (!outcome || outcome.kind !== 'retry') return { r, outcome, tried };

      tried.push({ label: r.attempt || '(not recorded)' });
      if (tried.length > CFG.retries) return { r, tried, wrong: true };

      hud(`✗ ${(r.attempt || 'that').slice(0, 60)} was wrong — Try Again (${tried.length}/${CFG.retries})`);
      if (!(await takeRetry(outcome.el))) {
        return { r, tried, stuck: 'Try Again was clicked but the question did not come back' };
      }
    }
  }

  /** The run stops on a wrong answer it may not retry. Say why in words the
   *  person can act on; give a report only when retries were actually spent. */
  async function giveUpOnWrong(n, a) {
    if (CFG.retries <= 0) {
      hud(`✗ #${n + 1} was marked wrong and retries are off — press Try Again yourself`, true);
      return;
    }
    const was = a.tried.map(t => t.label.slice(0, 50)).join(' | ');
    await failRun(n, 'wrong', `still wrong after ${a.tried.length} tries (${was})`, { tried: a.tried });
  }

  /** Wait for the page to move to a different question. */
  async function waitForNextQuestion(prevKey, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(200);
      const p = scrape();
      if (p.kind && currentQuestionKey() !== prevKey) return true;
    }
    return false;
  }

  /** Push the top frame's settings down to the frame that holds the question,
   *  so both halves agree on what to do. */
  async function pushSettingsToFrames() {
    if (!IS_TOP) return;
    const frames = [...document.querySelectorAll('iframe')].map(f => {
      try { return f.contentWindow; } catch { return null; }   // cross-origin
    }).filter(Boolean);

    const cfg = await new Promise(res => {
      try { chrome.storage.local.get(SETTING_KEYS, s => res({ ...CFG, ...s })); } catch { res(CFG); }
    });

    for (const w of frames) {
      try { w.postMessage({ __alefCfg: cfg }, '*'); } catch { /* ignore */ }
    }
  }

  if (typeof window !== 'undefined' && IS_TOP) {
    // Child frames relay their status up so the progress stays visible even
    // when the question lives in an iframe.
    window.addEventListener('message', e => {
      const d = e.data;
      if (d && typeof d === 'object' && d.__alefHud) hud(d.__alefHud, d.sticky);
    });
  } else {
    window.addEventListener('message', e => {
      const d = e.data;
      if (d && typeof d === 'object' && d.__alefCfg) Object.assign(CFG, d.__alefCfg);
    });
  }

  /** How long to wait, in seconds, before asking again after the 1st, 2nd, 3rd... time a service
   *  said it was limiting the account. The last one repeats, so a limit that lasts is asked about
   *  every five minutes rather than never, or every few seconds. */
  const RATE_WAITS = [15, 30, 60, 120, 180, 300];

  /** The wait, in milliseconds, before the (tries+1)th ask after a rate limit: the service's own
   *  Retry-After when it gave one (but never more than ten minutes), otherwise the schedule. */
  function rateWaitMs(tries, retryAfterMs) {
    const said = Number(retryAfterMs) || 0;
    if (said > 0) return Math.min(said, 10 * 60 * 1000);
    return RATE_WAITS[Math.min(Math.max(0, tries), RATE_WAITS.length - 1)] * 1000;
  }

  /** Wait `ms`, with the time left on the status line, ending early if Stop is pressed.
   *  Resolves false when it was stopped. */
  async function waitWithCountdown(ms, why) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopRun) return false;
      const left = Math.ceil((end - Date.now()) / 1000);
      hud(`⏳ ${why} — trying again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} (Stop cancels)`, true);
      await sleep(Math.min(1000, Math.max(0, end - Date.now())));
    }
    return !stopRun;
  }

  /** Ask the model, and when the answer is "the service is limiting this account", wait for it to
   *  stop and ask the same question again — as many times as it takes — instead of ending the
   *  run on it. The wait is the service's own Retry-After when it gave one, otherwise RATE_WAITS.
   *  Resolves { ans, ms } (ms being the last try's time, not the waiting), or { stopped: true }
   *  when Stop was pressed during a wait. */
  async function askPatiently(message) {
    for (let tries = 0; ; tries++) {
      const t0 = performance.now();
      const ans = await chrome.runtime.sendMessage(message);
      const ms = Math.round(performance.now() - t0);
      if (!ans || !ans.rateLimited) return { ans, ms };
      if (stopRun) return { stopped: true };
      // Some waits have an end (the site's own error message is given four): past it the failure stands.
      if (Number.isFinite(ans.retryLimit) && tries >= ans.retryLimit) return { ans, ms };

      const wait = rateWaitMs(tries, ans.retryAfterMs);
      console.warn('[alef-solver] rate limited:', ans.limitNote || ans.error);
      if (!(await waitWithCountdown(wait, ans.limitNote || 'rate limited'))) return { stopped: true };
    }
  }

  /** Solve one question. Returns a result the run loop can act on. `tried` is
   *  every answer the page has already marked wrong; the result's `attempt` says
   *  what was answered this time, so the caller can add it to that list. */
  async function solveOne(quiet = false, { tried = [], limit = 0, need = 0, again = 0 } = {}) {
    const say = m => { if (!quiet) hud(m); };

    const p0 = scrape();
    if (!p0.kind) {
      // The question may live in a child frame; the broadcast reaches it.
      hud('no question found here');
      return { ok: false, reason: 'no-question' };
    }

    say('reading page…');
    const passage = await acquirePassage(p0);

    const p = scrape();
    if (p.kind === 'choice' && !p.optionsSane) {
      hud('⚠ choice grouping ambiguous — refusing');
      return { ok: false, reason: 'ambiguous' };
    }

    // A menu's options are only readable once it's open, and the model can't
    // pick between choices it hasn't seen.
    let menus = null;
    if (p.kind === 'dropdown') {
      say('reading the menus…');
      menus = await readDropdownOptions(p.dropdown.blanks);
      const bad = menus.findIndex(m => !m.length);
      if (bad >= 0) {
        hud(`⚠ could not read the options of drop-down ${bad + 1}`);
        return { ok: false, reason: `options of drop-down ${bad + 1} not readable`, menus };
      }
    }

    // A screenshot is the slow part of a question, so it is only taken when it is likely to matter.
    const wantsShot = wantsScreenshot(CFG.screenshot, {
      kind: p.kind, imageCount: p.images.length, passageLen: passage ? passage.length : 0,
      stem: p.stem, instruction: p.instruction, optionTexts: p.options.map(o => o.text),
    });

    let image = null, shotMs = 0;
    if (wantsShot) {
      say('capturing page…');
      const tShot = performance.now();
      image = await screenshot(4).catch(() => null);
      shotMs = Math.round(performance.now() - tShot);
      // A cached passage makes the screenshot redundant unless there's a figure.
      if (image && passage.length > 250 && p.images.length === 0) image = null;
    }

    say('asking ai…');
    const { ans, ms, stopped } = await askPatiently({
      type: 'ask',
      payload: {
        kind: p.kind,
        stem: p.stem,
        passage,
        options: p.options.map(o => ({ text: o.text })),
        multi: p.multi,
        maxPicks: p.multi && limit ? limit : undefined,      // how many ticks the page was seen to take
        minPicks: p.multi && need ? need : undefined,        // how many it was seen to want before Submit goes on
        instruction: p.instruction,
        tried: [...tried],          // a copy: the caller keeps adding to its own list
        cloze: p.cloze,
        dropdown: menus ? { text: p.dropdown.text, menus } : null,
        match: p.match ? {
          intro: p.match.intro,
          left: p.match.left.map(i => i.text),
          right: p.match.right.map(i => i.text),
        } : null,
        drag: p.drag ? {
          intro: p.drag.intro,
          text: p.drag.text,
          items: p.drag.items.map(i => i.text),
          blanks: p.drag.zones.length,
        } : null,
        sort: p.sort ? { intro: p.sort.intro, items: p.sort.items.map(i => i.text) } : null,
        // Only images the page can hand over as data. A URL is fetched by the
        // model provider, which has no login: Alef's file server answers it with
        // a 401 and the whole request fails. The screenshot shows the figure.
        images: p.images.filter(u => u.startsWith('data:')),
        imageCount: p.images.length,
        image,
        shotMs,                     // how long the capture took, for the timing log
      },
    });
    if (stopped) {
      hud('stopped while waiting for the rate limit to clear');
      return { ok: false, reason: 'stopped', stopped: true };
    }
    // No model on the list could read the picture, so this answer is a guess from the words.
    const blind = ans?.imageDropped ? ' · ⚠ could not see the picture' : '';
    const speedNote = speedNoteOf(ans?.timing, shotMs);

    if (!ans || ans.error) {
      hud(`✗ ${ans?.error || 'no response'}`);
      console.warn('[alef-solver]', ans);
      return { ok: false, reason: 'api', error: ans?.error };
    }

    /* ---- put the items in order ---- */
    if (p.kind === 'sort') {
      const order = ans.pairs || [];
      if (order.length !== p.sort.items.length) {
        hud(`✗ model ordered ${order.length} of ${p.sort.items.length} items`);
        return { ok: false, reason: 'sort-count', order };
      }
      hud(`→ ${order.map(j => j + 1).join(' ')} · ${ms}ms${blind}${speedNote}`);
      console.log('[alef-solver]', ans.why, ans.raw);

      if (CFG.autoSubmit) hud('ordering…');
      const out = await commitSort(order, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      out.ms = ms;
      out.confidence = ans.confidence;
      out.order = order;

      if (out.submitted) hud(`✓ ordered ${order.length} items and submitted`);
      else if (out.selected) hud(`✓ ordered ${order.length} items`);
      else hud(`⚠ ${out.error || 'could not put the items in order'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { order }) };
    }

    /* ---- drag items into the gaps ---- */
    if (p.kind === 'drag') {
      const fills = ans.fills || [];
      if (fills.length !== p.drag.zones.length) {
        hud(`✗ model gave ${fills.length} answers for ${p.drag.zones.length} gaps`);
        return { ok: false, reason: 'drag-count', fills };
      }
      const words = fills.map(j => p.drag.items[j]?.text);
      if (words.some(w => w == null)) { hud('✗ an answer was out of range'); return { ok: false, reason: 'drag-range', fills }; }

      hud(`→ ${words.join(' / ')} · ${ms}ms${blind}${speedNote}`);
      console.log('[alef-solver]', ans.why, ans.raw);

      if (CFG.autoSubmit) hud('dragging…');
      const out = await commitDrag(fills, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      out.ms = ms;
      out.confidence = ans.confidence;
      out.words = words;

      if (out.submitted) hud(`✓ placed ${words.length} and submitted`);
      else if (out.selected) hud(`✓ placed ${words.length}`);
      else hud(`⚠ ${out.error || 'could not place the words'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { words }) };
    }

    /* ---- match the two columns ---- */
    if (p.kind === 'match') {
      const pairs = ans.pairs || [];
      if (pairs.length !== p.match.left.length) {
        hud(`✗ model gave ${pairs.length} pairs for ${p.match.left.length} items`);
        return { ok: false, reason: 'match-count', pairs };
      }

      hud(`→ ${pairs.map(j => j + 1).join(' ')} · ${ms}ms${blind}${speedNote}`);
      console.log('[alef-solver]', ans.why, ans.raw);

      if (CFG.autoSubmit) hud('linking…');
      const out = await commitMatch(pairs, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      out.ms = ms;
      out.confidence = ans.confidence;
      out.pairs = pairs;

      if (out.submitted) hud(`✓ linked ${pairs.length} and submitted`);
      else if (out.selected) hud(`✓ linked ${pairs.length}`);
      else hud(`⚠ ${out.error || 'could not link the items'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { pairs }) };
    }

    /* ---- pick from the drop-downs ---- */
    if (p.kind === 'dropdown') {
      const picks = ans.picks || [];
      if (picks.length !== menus.length) {
        hud(`✗ model gave ${picks.length} picks for ${menus.length} drop-downs`);
        return { ok: false, reason: 'dropdown-count', picks, menus };
      }
      const words = picks.map((ix, i) => menus[i][ix]);
      if (words.some(w => w == null)) {
        hud('✗ a pick was out of range');
        return { ok: false, reason: 'dropdown-range', picks, menus };
      }

      hud(`→ ${words.join(' / ')} · ${ms}ms${blind}${speedNote}`);
      console.log('[alef-solver]', ans.why, ans.raw);

      if (CFG.autoSubmit) hud('submitting…');
      const out = await commitDropdown(words, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      out.ms = ms;
      out.confidence = ans.confidence;
      out.words = words;

      if (out.submitted) hud(`✓ chose ${words.length} and submitted`);
      else if (out.selected) hud(`✓ chose ${words.length} options`);
      else hud(`⚠ ${out.error || 'could not choose the options'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { words }) };
    }

    /* ---- fill in the blanks ---- */
    if (p.kind === 'cloze') {
      const words = ans.words || [];
      if (!words.length) { hud('✗ no blanks returned'); return { ok: false, reason: 'cloze-empty' }; }

      hud(`→ ${words.join(' / ')} · ${ms}ms${blind}${speedNote}`);
      console.log('[alef-solver]', ans.why, ans.raw, ans.mismatch || '');

      if (CFG.autoSubmit) hud('submitting…');
      const out = await commitCloze(words, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      out.ms = ms;
      out.confidence = ans.confidence;
      out.words = words;

      if (out.submitted) hud(`✓ filled ${words.length} blanks and submitted`);
      else if (out.selected) hud(`✓ filled ${out.filled.length} blanks`);
      else hud(`⚠ ${out.error || 'could not fill the blanks'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { words }) };
    }

    /* ---- tick every right answer ---- */
    if (p.multi) {
      const picks = ans.indices || [];
      if (!picks.length || picks.some(i => !Number.isInteger(i) || i < 0 || i >= p.options.length)) {
        hud(`✗ answer out of range (${JSON.stringify(picks)})`);
        return { ok: false, reason: 'range', picks };
      }
      const letters = picks.map(i => 'ABCDEFGHIJ'[i]);
      hud(`→ ${letters.join(' + ')} · ${ms}ms${blind}${speedNote}${ans.confidence != null ? ` · ${(ans.confidence * 100) | 0}%` : ''}`);
      console.log('[alef-solver]', ans.why, ans.raw);

      if (CFG.autoSubmit) hud('ticking…');
      const out = await commitMulti(picks, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
      // The page took fewer ticks than the model chose: it allows only so many, and does not say how
      // many. Ask once more, told the number.
      if (!out.selected && out.limit && !limit && again < 2) {
        hud(`the page takes only ${out.limit} ticks — asking again for ${out.limit}`, true);
        return solveOne(quiet, { tried, limit: out.limit, need, again: again + 1 });
      }
      // The reverse: every tick went in and Submit stays off, because the page wants more of them.
      // Ask again for at least one more than were ticked — twice at most, so it cannot go on for ever.
      if (out.selected && !out.submitted && out.needMore && out.needMore > need && (!limit || out.needMore <= limit) && again < 2) {
        hud(`Submit stays off with ${out.needMore - 1} ticked — asking again for at least ${out.needMore}`, true);
        return solveOne(quiet, { tried, limit, need: out.needMore, again: again + 1 });
      }
      out.letter = letters.join('');
      out.ms = ms;
      out.confidence = ans.confidence;

      if (out.submitted) hud(`✓ ${letters.join(' + ')} submitted`);
      else if (out.selected) hud(`✓ ticked ${letters.join(' + ')}`);
      else hud(`⚠ ${out.error || 'could not tick the answers'}`);

      return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { indices: picks }) };
    }

    /* ---- pick a choice ---- */
    const idx = ans.index;
    if (idx == null || idx >= p.options.length) {
      hud(`✗ answer out of range (${ans.letter})`);
      return { ok: false, reason: 'range' };
    }

    hud(`→ ${'ABCDEFGHIJ'[idx]} · ${ms}ms${blind}${speedNote}${ans.confidence != null ? ` · ${(ans.confidence * 100) | 0}%` : ''}`);
    console.log('[alef-solver]', ans.why, ans.raw);

    if (CFG.autoSubmit) hud('submitting…');
    const out = await commit(idx, { autoSubmit: CFG.autoSubmit, answerDelay: CFG.answerDelay });
    out.letter = 'ABCDEFGHIJ'[idx];
    out.ms = ms;
    out.confidence = ans.confidence;

    if (out.submitted) hud(`✓ ${out.letter} submitted`);
    else if (out.selected) hud(`✓ picked ${out.letter}`);
    else hud(`⚠ click did not register on ${out.letter}`);

    return { ok: !!out.selected, commit: out, reason: out.error, attempt: attemptLabel(p, { index: idx }) };
  }

  /** One press, one question. */
  async function solve() {
    if (busy) return hud('already running');
    busy = true;
    stopRun = false;               // a Stop pressed while nothing was running must not cancel this
    try {
      await loadSettings();
      // A question of a type this cannot read: skip it all the same, if it offers that.
      const skipBtn = skipScreen();
      if (skipBtn) {
        const c = await clickConfirmed(skipBtn, { settle: 1500 });
        if (c.ok) hud('skipped: the page offers "I\'ll try later", so I pressed it instead of answering', true);
        else await failRun(0, 'skip', `"${txt(skipBtn)}" was pressed but nothing changed`, { label: txt(skipBtn) });
        return;
      }
      const a = await answerQuestion(false);
      const r = a.r;
      // Same rule as a lesson run: a failure leaves a report you can paste, not
      // just a notification that fades.
      const c = r.commit || {};
      if (a.skipped) hud('skipped: the page offers "I\'ll try later", so I pressed it instead of answering', true);
      else if (a.wrong) await giveUpOnWrong(0, a);
      else if (a.stuck) await failRun(0, 'retry', a.stuck, { tried: a.tried });
      else if (r.stopped) { /* Stop was pressed while waiting out a rate limit; already said */ }
      else if (!r.ok) await failRun(0, 'answer', r.reason || r.error || 'could not answer', r);
      else if (CFG.autoSubmit && !c.submitted) await failRun(0, 'submit', c.error || 'submit did not register', c);
    } catch (e) {
      hud(`✗ ${e.message || e}`);
      console.error('[alef-solver]', e);
      await failRun(0, 'exception', String(e.message || e), { stack: String(e.stack || '').slice(0, 600) });
    } finally {
      busy = false;
      stopRun = false;
    }
  }

  /** One line on how a lesson-navigation button (next, finish, submit) looks to this
   *  script, for a report: whether it is found, and — when it is greyed out — why. */
  function describeNav(kind) {
    const b = findButton(kind, null, { requireEnabled: false });
    if (!b) return 'none found';
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return [
      `${b.tagName.toLowerCase()} ${JSON.stringify(txt(b).slice(0, 30))}`,
      `disabled=${disabled(b)}`,
      `attr:disabled=${b.disabled === true} aria-disabled=${b.getAttribute('aria-disabled')} data-disabled=${b.getAttribute('data-disabled')}`,
      `opacity=${cs.opacity} pointer-events=${cs.pointerEvents} ${Math.round(r.width)}x${Math.round(r.height)}`,
      `class=${String(b.className || '').slice(0, 60)}`,
    ].join(' · ');
  }

  /** What a person sees to press, for a report when the way on could not be found. */
  function buttonLabels() {
    return [...document.querySelectorAll('button, [role="button"], a, input[type="submit"]')]
      .filter(visible).map(txt).filter(t => t && t.length <= 60).slice(0, 20);
  }

  /** The last question is answered and the page offers Done. Press it, then leave the
   *  lesson the way a person does and get to the next one. On the live site that is:
   *  Done → the results page and its own Finish → a Submit → Back to Coursework → the
   *  page listing the tasks → the Start beside the next one. Other pages may offer a Next
   *  Lesson button, or a Continue first, or move on by themselves; all are handled.
   *  `openNext: false` (the limit was reached) does the same as far as Back to
   *  Coursework, and starts nothing.
   *  Resolves { ok: true } once a different question is on screen (or, with openNext
   *  false, once the lesson has been left), or { ok: false, why, ... }:
   *    noNext   no way on appeared — the end of the course, or a button it did not know
   *    stopped  the run was stopped meanwhile
   *  `pressed` lists what was pressed on the way, for a report. */
  async function finishAndOpenNext(fin, { openNext }) {
    const before = currentQuestionKey();
    const pressed = [txt(fin)];
    const used = new Set([fin]);                        // Finish and Submit are each pressed once
    const done = await clickConfirmed(fin, { settle: 1500 });
    if (!done.ok) return { ok: false, why: `"${txt(fin)}" was pressed but nothing changed`, pressed };

    let atCoursework = false;
    for (let screen = 0; screen < 14; screen++) {
      let el = null, how = '';
      const t0 = Date.now();
      const patience = openNext ? 8000 : 5000;
      while (!el && Date.now() - t0 < patience) {
        if (stopRun) return { ok: false, stopped: true, pressed };
        const onQuestion = !!scrape().kind;
        if (openNext && onQuestion && currentQuestionKey() !== before) return { ok: true, pressed };   // the page moved on by itself
        // The rating box ("Rate your lesson!") first: Back to Coursework is already showing
        // behind it, and a press goes straight through the overlay.
        const rate = feedbackSubmit();
        if (rate && !used.has(rate)) { el = rate; how = 'rate'; }
        else if (openNext && (el = findButton('nextLesson', null))) how = 'lesson';
        else if ((el = findButton('backToCoursework', null))) how = 'back';
        else if (openNext && (el = findButton('startTask', null))) how = 'start';
        // The results page has its own Finish, and then a Submit. Only with no question on
        // screen, so an answer is never mistaken for them; Submit first, because a Submit
        // that has appeared is a dialog over a Finish that is still showing.
        else if (!atCoursework && !onQuestion && (el = findButton('submit', null, { exclude: used }))) how = 'submit';
        else if (!atCoursework && !onQuestion && (el = findButton('finish', null, { exclude: used }))) how = 'finish';
        // A Continue is how some pages move on. (On the list of tasks it is a lesson begun, and is
        // taken above as a start.) Not once back at the list, where a Next would be a stray.
        else if (openNext && !atCoursework && (el = findButton('next', null))) how = 'continue';
        if (!el) await sleep(150);
      }
      // A Start that turns up before the way back does could be on a results page whose
      // Back to Coursework is still loading. Give that a moment to appear, and prefer it.
      if (el && how === 'start' && !atCoursework) {
        await sleep(1500);
        const early = findButton('nextLesson', null) || findButton('backToCoursework', null);
        if (early) { el = early; how = findButton('nextLesson', null) === early ? 'lesson' : 'back'; }
      }
      if (!el) {
        // With no next lesson to open, having left what could be left is the whole job.
        if (!openNext) return { ok: true, last: true, pressed };
        return {
          // "At the coursework page" only if the address says so: a lesson's id in it means a lesson
          // has opened since, and the run is in that.
          ok: false, noNext: true, atCoursework: atCoursework && !lessonId(), buttons: buttonLabels(), pressed,
          submit: describeNav('submit'), finish: describeNav('finish'),
          back: describeNav('backToCoursework'), nextLesson: describeNav('nextLesson'), start: describeNav('startTask'), rows: startRows(),
          why: atCoursework && !lessonId() ? 'nothing left to start on the coursework page' : 'no next lesson button appeared after Done',
        };
      }

      // A Start on the task list: remember which row, to tell if it opens a lesson already done.
      const key = how === 'start' && !inPlayerFooter(el) ? rowKey(el) : '';
      hud(how === 'back' ? `back to the coursework ("${txt(el)}")`
        : how === 'rate' ? `the lesson's rating box — pressing "${txt(el)}"`
        : how === 'finish' || how === 'submit' ? `leaving the lesson ("${txt(el)}")`
        : key ? `the task list — starting "${rowTitle(el)}"`
        : `opening the next lesson ("${txt(el)}")`);
      if (how === 'finish' || how === 'submit' || how === 'rate') used.add(el);
      pressed.push(key ? `${txt(el)} (${rowTitle(el)})` : txt(el));
      const idBefore = lessonId();                      // the lesson this press leaves (none, on the task list)
      const c = await clickConfirmed(el, { settle: 1500 });
      let landed = c.ok;
      if (!landed && how === 'back') {
        // Leaving a lesson is a route change and can take longer than the click's own wait (the
        // page may be fetching the task list). Look for the address moving, the button going, or
        // the list of tasks, before calling it a press that did nothing.
        const h0 = location.href, t2 = Date.now();
        while (!landed && Date.now() - t2 < 8000) {
          landed = location.href !== h0 || !el.isConnected || !!findButton('startTask', null);
          if (!landed) await sleep(200);
        }
      }
      if (!landed) return { ok: false, why: `"${txt(el)}" was pressed but nothing changed`, buttons: buttonLabels(), pressed, back: describeNav('backToCoursework') };
      if (how === 'rate') {
        // Gone, or it did not take: the box may want a rating chosen first, and choosing one is
        // not something to do on the person's behalf.
        const t1 = Date.now();
        while (feedbackForm() && Date.now() - t1 < 3000) await sleep(150);
        if (feedbackForm()) return { ok: false, why: 'the rating box stayed open after Submit — it may need a rating chosen first', buttons: buttonLabels(), pressed };
        continue;
      }
      if (how === 'back') {
        atCoursework = true;
        if (!openNext) return { ok: true, last: true, pressed };
        await settleList();                             // the list may refresh; do not pick from the old one
        continue;                                       // the page loads; look again
      }
      if (how === 'finish' || how === 'submit') continue;     // the page moves on a step; look again
      if (key && await reopenedDone(key)) { atCoursework = true; continue; }     // a lesson already done: another row
      // Opened — whatever its first screen is: a question, but also a video slide with a Next, or an
      // opening screen with a Start. The lesson run itself goes on from any of those.
      if (await waitForOpened(before, idBefore, 10000)) return { ok: true, pressed };
    }
    return { ok: false, why: 'pressed through fourteen screens without reaching a question', buttons: buttonLabels(), pressed, rows: startRows() };
  }

  /** One press, the whole lesson: submit, Next, repeat until it runs out. With
   *  autoNextLesson on, press Done and go on to the next lesson too, up to maxLessons. */
  async function solveLesson() {
    if (busy) return hud('already running');
    busy = true;
    stopRun = false;

    await loadSettings();
    await pushSettingsToFrames();

    let n = 0;
    let lessons = 1;                          // the lesson this run is in
    visitedLessons = new Set();               // which lessons this run has been in, to tell a done one from a new one
    badRows.clear();
    if (lessonId()) visitedLessons.add(lessonId());
    const maxLessons = Math.max(1, Number(CFG.maxLessons) || 1);
    const cap = MAX_QUESTIONS * (CFG.autoNextLesson ? maxLessons : 1);
    const plural = k => `${k} lesson${k === 1 ? '' : 's'}`;
    const MAX_SLIDES = 20;                    // screens with no question, in a row, before giving up
    console.log('[alef-solver] run started', { cachePassage: CFG.cachePassage, advance: CFG.advance, autoNextLesson: CFG.autoNextLesson, maxLessons });

    /** The lesson's last screen is done and the page offers Finish. Pressing it ends the
     *  lesson, a bigger step than answering a question, so it is only pressed when going
     *  on to the next lesson is switched on; otherwise say so and leave it to the person.
     *  Resolves 'next' (another lesson is open: carry on) or 'stop'. */
    const endOfLesson = async (fin, answered, what) => {
      if (!CFG.autoNextLesson) {
        hud(`✓ that was the last ${what} (${answered} answered). Press "${txt(fin)}" to finish the lesson — or switch on "Go to the next lesson when done" in the popup and I will, then carry on.`, true);
        return 'stop';
      }
      hud(`that was the last ${what} — pressing "${txt(fin)}"`);
      const r = await finishAndOpenNext(fin, { openNext: lessons < maxLessons });
      if (r.stopped) { hud(`stopped after ${answered}`); return 'stop'; }
      if (r.ok && r.last) {
        hud(`✓ ${plural(lessons)} done — that is the limit set in Options. Stopping.`, true);
        return 'stop';
      }
      if (r.ok) {
        lessons++;
        if (lessonId()) visitedLessons.add(lessonId());
        hud(`lesson ${lessons} opened`);
        await sleep(CFG.stepDelay);
        return 'next';
      }
      if (r.noNext) {
        // The end of the course, or a button this does not know. It cannot tell which,
        // so say both and keep the evidence.
        await saveReport('next-lesson', r.why, { lessons, pressed: r.pressed, rows: r.rows, back: r.back, nextLesson: r.nextLesson, start: r.start, submit: r.submit, finish: r.finish, buttons: r.buttons }, n);
        hud(r.atCoursework
          ? `✓ ${plural(lessons)} done. Back at the coursework page with nothing left to start (${reportHint()} if there should be)`
          : `✓ ${plural(lessons)} done. No next lesson button appeared, so I stopped (${reportHint()} if there should have been one)`, true);
        return 'stop';
      }
      await failRun(n, 'next-lesson', r.why, { lessons, pressed: r.pressed, rows: r.rows, back: r.back, buttons: r.buttons });
      return 'stop';
    };

    try {
      lessonLoop:
      for (; n < cap; n++) {
        if (stopRun) { hud(`stopped after ${n}`); break; }

        // The question must actually be on screen — don't click Next blindly. Screens
        // with no question on them (a picture to explore, text to read) are the one
        // exception: Next goes past those, unless something there wants an answer.
        let found = await waitForQuestion(1500);
        for (let slides = 0; !found && !stopRun; slides++) {
          // A question of a type this cannot read is skipped all the same, if it offers that.
          const skipBtn = skipScreen();
          if (skipBtn) {
            const before = currentQuestionKey();
            hud(`the page offers "${txt(skipBtn)}" — pressing it`);
            const k = await clickConfirmed(skipBtn, { settle: 1500 });
            if (!k.ok) { await failRun(n, 'skip', `"${txt(skipBtn)}" was pressed but nothing changed`, { label: txt(skipBtn) }); break lessonLoop; }
            if (!(await waitAfterSkip(before, 9000))) {
              await saveReport('after-skip', 'no screen appeared after "I\'ll try later"', { buttons: buttonLabels(), next: describeNav('next') }, n);
              hud(`⚠ nothing new appeared after skipping a question (${reportHint()})`, true);
              break lessonLoop;
            }
            await sleep(CFG.stepDelay);
            found = await waitForQuestion(1500);
            continue;
          }
          const screen = contentScreen();
          if (!screen) { found = await waitForQuestion(4500); break; }     // still loading, or not something it can read
          if (screen.finish) {
            if ((await endOfLesson(screen.finish, n, 'screen')) === 'next') continue lessonLoop;
            break lessonLoop;
          }
          if (screen.locked) {
            // Wait for it to unlock; that is all a person does too.
            hud('this slide\'s Next is greyed out — waiting for it to unlock…');
            const t0 = Date.now();
            while (Date.now() - t0 < CFG.slideWaitMs && !stopRun) {
              await sleep(250);
              if (scrape().kind || findButton('next', null) || findButton('finish', null)) break;
            }
            if (stopRun) break lessonLoop;
            if (!scrape().kind && !findButton('next', null) && !findButton('finish', null)) {
              await saveReport('slide-locked', 'Next stayed greyed out on a slide', {
                waitedSeconds: Math.round((Date.now() - t0) / 1000), next: describeNav('next'), buttons: buttonLabels(),
              }, n);
              hud(`⚠ Next stayed greyed out for ${Math.round((Date.now() - t0) / 1000)} s — the slide may need something clicked first (${reportHint()})`, true);
              break lessonLoop;
            }
            found = scrape().kind;
            slides--;                                  // waiting is not a slide skipped
            continue;
          }
          if (slides >= MAX_SLIDES) { hud(`⚠ ${MAX_SLIDES} slides in a row with no question — stopping`, true); break lessonLoop; }
          hud(screen.splash ? `the activity's opening screen — pressing "${txt(screen.next)}"`
            : screen.rating ? `the lesson's rating box — pressing "${txt(screen.next)}"`
            : screen.coursework ? `the task list — starting "${taskRowText(screen.next).replace(/\s*\d+ tasks? assigned.*$/i, '').slice(0, 60)}"`
            : `a slide with no question — Next (${slides + 1})`);
          const taskKey = screen.coursework ? rowKey(screen.next) : '';
          const k = await clickConfirmed(screen.next, { settle: 1500 });
          if (!k.ok) { await failRun(n, 'next', 'Next was pressed on a slide but nothing changed', { label: txt(screen.next), rows: startRows() }); break lessonLoop; }
          if (taskKey && await reopenedDone(taskKey)) { found = false; continue; }     // a lesson already done: the next row
          await sleep(CFG.stepDelay);
          found = await waitForQuestion(1500);
        }
        if (!found) {
          // Keep what the page looked like: without this, "Copy last report" handed back an older
          // report from some other page, and a question this cannot read was never seen.
          await saveReport('no-question', 'no question found on this screen of the lesson', { answered: n, why: whyNone(), buttons: buttonLabels() }, n);
          hud(`⚠ no question found after ${n} — stopping (${reportHint()})`, true);
          break;
        }

        const key = currentQuestionKey();
        let next = null;

        if (isGraded()) {                    // resuming mid-lesson
          hud(`#${n + 1} already answered — moving on`);
          next = findButton('next', null);
        } else {
          hud(`#${n + 1} · reading page…`);
          const a = await answerQuestion(true);
          const r = a.r;
          const c = r.commit || {};
          if (a.skipped) {
            // Skipped, not answered: on to whatever the page shows next.
            const where = await waitAfterSkip(key, 9000);
            if (where === 'finish') {
              const fin = findButton('finish', null);
              if (fin && (await endOfLesson(fin, n + 1, 'question')) === 'next') continue;
              break;
            }
            if (!where) {
              await saveReport('after-skip', 'no question or slide appeared after "I\'ll try later"', { buttons: buttonLabels(), next: describeNav('next') }, n);
              hud(`⚠ nothing new appeared after skipping #${n + 1} (${reportHint()})`, true);
              break;
            }
            await sleep(CFG.stepDelay);
            continue;
          }
          // A wrong answer that cannot be retried ends the run, and says so — not
          // "no Next button", which would read as a lesson that finished.
          if (a.wrong) { await giveUpOnWrong(n, a); break; }
          if (a.stuck) { await failRun(n, 'retry', a.stuck, { tried: a.tried }); break; }
          if (r.stopped) break;                     // Stop was pressed while waiting out a rate limit; already said
          if (!r.ok) {
            await failRun(n, 'answer', r.reason || 'could not answer', r);
            break;
          }

          if (!CFG.autoSubmit || !CFG.advance) {
            hud(`✓ #${n + 1} filled${CFG.autoSubmit ? '' : ' — submit it yourself'}`);
            break;
          }

          // Say what actually went wrong. "Not graded" would hide a click that
          // never landed, which is the only useful fact.
          if (!c.submitted) {
            await failRun(n, 'submit', c.error || 'submit did not register', c);
            break;
          }

          next = a.outcome?.kind === 'next' ? a.outcome.el : null;
        }

        if (!CFG.advance) { hud(`✓ #${n + 1} done`); break; }
        if (!next) {
          // No Next means the last question — or a lesson that moves on by itself: after Submit the next
          // question is simply there, with no Next button at all. Look for that before taking it for the
          // end. The page's own way out of a lesson is a button like "Finish" or "Done".
          let fin = findButton('finish', null);
          if (!fin && await waitForNextQuestion(key, 3500)) {
            hud(`#${n + 1} done → the page moved on by itself`);
            await sleep(CFG.stepDelay);
            continue;
          }
          fin = fin || findButton('finish', null);       // it may have turned up while waiting
          if (fin) {
            if ((await endOfLesson(fin, n + 1, 'question')) === 'next') continue;
            break;
          }
          // Keep what the page looked like: this stop used to leave no report, so "Copy last report"
          // handed back one from some other page.
          await saveReport('no-next', 'answered, but there is no Next button, no Finish, and no new question', { answered: n + 1, next: describeNav('next'), finish: describeNav('finish'), buttons: buttonLabels() }, n);
          hud(`✓ #${n + 1} answered; no Next button, so nothing more to do here (${reportHint()} if the lesson had more).`, true);
          break;
        }

        hud(`#${n + 1} done → next`);
        const nx = await clickConfirmed(next, { settle: 1500 });
        if (!nx.ok) {
          await failRun(n, 'next', 'Next button clicked but nothing changed', { label: txt(next) });
          break;
        }
        // The next screen is a question, or one with no question that the lesson goes on from.
        if (!(await waitForNextScreen(key, 9000))) {
          // The lesson is over, or a screen came up that this does not know. It cannot
          // tell which, so keep what the page looked like in case it matters.
          await saveReport('after-next', 'no question or slide appeared after Next', { answered: n + 1, next: describeNav('next'), finish: describeNav('finish'), buttons: buttonLabels() }, n);
          hud(`✓ no further questions · ${n + 1} completed (${reportHint()} if the lesson had more)`, true);
          break;
        }
        await sleep(CFG.stepDelay);
      }

      if (n >= cap) hud(`⚠ stopped at the ${cap}-question cap`);
      console.log('[alef-solver] run finished after', n);
    } catch (e) {
      hud(`✗ ${e.message || e}`);
      console.error('[alef-solver]', e);
    } finally {
      busy = false;
      stopRun = false;
    }
  }

  async function waitForQuestion(timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const p = scrape();
      if (p.kind) return true;
      await sleep(150);
    }
    return false;
  }

  /** A screen with no question on it that the lesson goes on from by itself: a picture to
   *  explore, text to read (a Next to press), or the closing screen (a Finish). Resolves
   *  { next } or { finish }, or null for anything else. A Submit button anywhere means an
   *  answer is wanted — probably a question this cannot read — and Next must not be
   *  pressed past that. */
  function contentScreen() {
    if (scrape().kind) return null;
    // The lesson's rating box, when a run that is going on to the next lesson meets it. Before
    // the check below: its Submit is a Submit, but there is nothing to answer.
    const rate = CFG.autoNextLesson ? feedbackSubmit() : null;
    if (rate) return { next: rate, rating: true };
    if (findButton('submit', null, { requireEnabled: false })) return null;
    const next = findButton('next', null);
    if (next && !inTaskList(next)) return { next };       // a "Continue" in a list of tasks is a task, not a slide's Next
    // The opening screen of an activity: its title, and a Start in the player's own footer.
    // (A Start in a list of tasks is not this — that one belongs to the coursework page.)
    const start = findButton('startTask', null);
    if (start && inPlayerFooter(start)) return { next: start, splash: true };
    // The page that lists the tasks, each with its own Start. A run that is going on to the
    // next lesson starts the first one on it (Start or Continue); without that switch it is left alone, as a
    // press there is a bigger step than answering a question.
    if (start && CFG.autoNextLesson) return { next: start, coursework: true };
    const finish = findButton('finish', null);
    if (finish) return { finish };
    // A Next that is there but greyed out: slides often hold it back for a few seconds
    // (narration, an animation) or until something on them is opened.
    const locked = findButton('next', null, { requireEnabled: false });
    return locked && !inTaskList(locked) ? { locked } : null;
  }

  /** A screen this script cannot read as a question (a type it does not know — "select the
   *  correct answers", say) that offers the skip button ("I'll try later"). Skipping needs no
   *  understanding of the question. Resolves that button, or null. */
  function skipScreen() {
    if (!CFG.skipLater) return null;
    if (scrape().kind) return null;                // a readable question goes through answerQuestion
    return findButton('skip', null);
  }

  /** After a skip: wait for what follows — a different question, a slide, a different screen
   *  this cannot read, or (when it was the last question) the finish button on the same
   *  screen. Resolves 'question', 'slide', 'screen', 'finish', or null. */
  async function waitAfterSkip(prevKey, timeout = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(200);
      const p = scrape();
      const key = currentQuestionKey();
      if (p.kind) {
        if (key !== prevKey) return 'question';
        if (findButton('finish', null)) return 'finish';
      } else {
        if (contentScreen()) return 'slide';
        if (key !== prevKey) return 'screen';
      }
    }
    return null;
  }

  /** After Next: wait for the lesson's next screen — a different question, or a screen
   *  with no question that it can go on from. Resolves 'question', 'slide', or null. */
  async function waitForNextScreen(prevKey, timeout = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(200);
      const p = scrape();
      if (p.kind) { if (currentQuestionKey() !== prevKey) return 'question'; }
      else if (contentScreen() || skipScreen()) return 'slide';
    }
    return null;
  }

  /* ================================================================== HUD */

  /** Where an answer's time went, for the end of its status line: the screenshot,
   *  the setup the service needed before it could be asked (marked when it was remembered from
   *  the last question), the picture upload, and the model itself. A stage that did not happen
   *  is left out rather than shown as 0.0s. */
  function speedNoteOf(t, shotMs) {
    if (!t) return '';
    const sec = ms => `${(ms / 1000).toFixed(1)}s`;
    const parts = [];
    if (shotMs) parts.push(`shot ${sec(shotMs)}`);
    if (t.setup != null) parts.push(`setup ${sec(t.setup)}${t.cached ? ' (kept)' : ''}`);
    if (t.upload) parts.push(`pic ${sec(t.upload)}`);
    if (t.ai != null) parts.push(`ai ${sec(t.ai)}`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  let hudEl = null, hudTimer = null;
  function hud(msg, sticky) {
    if (!IS_TOP) {
      // The question may live in a child frame; relay so the user can still see
      // what's happening instead of watching a silent iframe.
      try { window.top?.postMessage({ __alefHud: msg, sticky }, '*'); } catch { /* cross-origin */ }
      return;
    }
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'alef-solver-hud';
      document.body.appendChild(hudEl);
    }
    hudEl.textContent = `alef · ${msg}`;
    hudEl.classList.add('on');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hudEl.classList.remove('on'), sticky ? 8000 : 4000);
  }

  /* ================================================================ debug */

  function report() {
    const p = scrape();
    return {
      frame: p.frame, url: p.url, title: p.title, score: p.score,
      kind: p.kind,
      dialogFound: p.dialogFound,
      stem: p.stem,
      passageLen: p.passage.length,
      passageHead: p.passage.slice(0, 300),
      options: p.options.map(o => o.text),
      images: p.images.length,
      optionsSane: p.optionsSane,
      // Fill-in-the-blank detail, so a cloze dump is as useful as a choice one.
      // Drop-down detail: what was found as a box, and the sentence built around it.
      dropdownBlanks: p.dropdown ? p.dropdown.blanks.map(b => ({
        native: b.native, shows: b.shows, selector: describe(b.el),
      })) : [],
      dropdownText: p.dropdown ? p.dropdown.text : '',
      matchIntro: p.match ? p.match.intro : '',
      matchLeft: p.match ? p.match.left.map(i => i.text) : [],
      matchRight: p.match ? p.match.right.map(i => i.text) : [],
      // How the page is built, for the types that can't be driven blind.
      matchDiag: lastMatchDiag,
      dragDiag: lastDragDiag,
      dragEvidence: lastDragDiag ? dragEvidence() : null,
      dragText: p.drag ? p.drag.text : '',
      dragItems: p.drag ? p.drag.items.map(i => i.text) : [],
      sortItems: p.sort ? p.sort.items.map(i => i.text) : [],
      sortIntro: p.sort ? p.sort.intro : '',
      dragGaps: p.drag ? p.drag.zones.map(z => describe(z.el)) : [],
      // A choice question whose "question" is only its own instruction ("Select the correct answers.") has
      // lost its real text somewhere — a picture, perhaps — and the outline is what shows where.
      skeleton: (!p.kind || p.kind === 'match' || p.kind === 'dropdown' || p.kind === 'drag' || p.kind === 'sort' ||
                 (p.kind === 'choice' && (!p.stem || (p.instruction && norm(p.stem) === norm(p.instruction)) || /^(?:select|choose|اخت)/i.test(arNorm(p.stem)) && p.stem.length < 60)))
        // From the page's main area, not the root: the sidebar would use up the whole budget
        // before the question was reached (it did, twice). And deeper when nothing was
        // recognised — a question type this does not know sits under many wrappers.
        // With nothing recognised, from the lesson player's own container when there is one: from
        // main, the answer area sat deeper than the outline goes (a math question's did).
        ? skeleton(p.match?.region || p.dropdown?.region || p.drag?.region || p.sort?.region ||
                   (!p.kind && document.querySelector('#template-container, .lib-template-container')) || nearInstruction() ||
                   document.querySelector('main, [role="main"]') || document.querySelector('#root, #app') || document.body,
                   p.kind ? { maxNodes: 320, maxDepth: 10 } : { maxNodes: 450, maxDepth: 22 })
        : '',
      // Whatever a typed answer could go into — an <input>, a text area, an editable box, a math
      // field — hidden ones too: a math editor keeps its real text area out of sight.
      editables: [...document.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], math-field, [class*="mq-"], [class*="mathfield" i], [class*="math-field" i]')]
        .slice(0, 24).map(el => {
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return `${describe(el)} · ${Math.round(r.width)}x${Math.round(r.height)} · ${visible(el) ? 'visible' : 'NOT visible'} · type=${el.getAttribute('type')} tabindex=${el.getAttribute('tabindex')} contenteditable=${el.getAttribute('contenteditable')} placeholder=${JSON.stringify(el.getAttribute('placeholder') || '')} value=${JSON.stringify((el.tagName === 'MATH-FIELD' ? mathValue(el) : String(el.value ?? '')).slice(0, 20))}${el.tagName === 'MATH-FIELD' ? ` (read through the page-side helper: ${mathCall(el, { op: 'get' }).reached ? 'it answered' : 'NO ANSWER — bridge-main.js is not running'})` : ''} text=${JSON.stringify(txt(el).slice(0, 24))} overflow=${cs.overflow} position=${cs.position}`;
        }),
      // Where a "Type…" placeholder sits: the box around it is the answer field, whatever it is made of.
      placeholders: (() => {
        const out = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode()) && out.length < 8;) {
          const e = n.parentElement;
          if (e && /^\s*type(\.{1,3}|…)?\s*$/i.test(n.nodeValue) && visible(e)) out.push(`${describe(e)} (inside ${describe(e.parentElement || e)})`);
        }
        return out;
      })(),
      clozeBlanks: p.cloze ? p.cloze.blanks.length : 0,
      clozeWords: p.cloze ? p.cloze.wordBank : [],
      clozeText: p.cloze ? p.cloze.text : '',
      choiceSelector: p.options[0]?.el ? describe(p.options[0].el) : null,
      navButtons: ['next', 'finish', 'submit', 'retry', 'startTask', 'backToCoursework', 'nextLesson'].map(k => `${k.padEnd(16)} ${describeNav(k)}`),
      // The rating box, if one is open, and what looks clickable on the page without being a
      // button — the box's Submit and Cancel are not buttons, and nothing else would show them.
      rateBox: (() => { const b = feedbackForm(); return b ? skeleton(b, { maxNodes: 120, maxDepth: 14 }) : ''; })(),
      rateSubmit: (() => { const e = feedbackSubmit(); return e ? `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).trim().split(/\s+/).slice(0, 3).join('.') : ''} ${JSON.stringify(txt(e))} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}` : 'none'; })(),
      clickables: [...document.querySelectorAll('div, span, li, p, img, svg, label')]
        .filter(el => visible(el) && !el.closest('button, a, [role="button"]') && getComputedStyle(el).cursor === 'pointer'
                      && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer'))
        .slice(0, 18).map(el => {
          const r = el.getBoundingClientRect();
          return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''} ${Math.round(r.width)}x${Math.round(r.height)} ${JSON.stringify(txt(el).slice(0, 30))}`;
        }),
      contentScreen: (() => { const c = contentScreen(); return !c ? 'no' : c.locked ? 'yes, Next greyed out' : c.finish ? 'yes, closing screen (finish)' : c.splash ? 'yes, opening screen (Start)' : c.coursework ? 'yes, task list (Start)' : c.rating ? 'yes, rating box (Submit)' : 'yes, slide (Next)'; })(),
      submitCandidates: [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible).map(el => `${disabled(el) ? '[x]' : '[ ]'} ${txt(el).slice(0, 40)}`).slice(0, 25),
      // What the submit button actually is, and whether it looks wired up.
      submitDetail: (() => {
        const b = findButton('submit', null, { requireEnabled: false });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return {
          tag: b.tagName.toLowerCase(),
          type: b.type || null,
          disabled: disabled(b),
          text: txt(b).slice(0, 40),
          classes: (b.className || '').toString().slice(0, 80),
          selector: describe(b),
          parentTag: b.parentElement?.tagName.toLowerCase(),
          parentClasses: (b.parentElement?.className || '').toString().slice(0, 60),
          // Which event types the element (or ancestors) has handlers for. If
          // click shows 0 everywhere, the handler is delegated and a synthetic
          // click on any of them may be ignored.
          listeners: typeof getEventListeners === 'function'
            ? ['click', 'pointerdown', 'mousedown']
                .map(t => `${t}:${(getEventListeners(b)[t] || []).length}`).join(' ')
            : 'n/a (not DevTools console)',
          parentListeners: typeof getEventListeners === 'function' && b.parentElement
            ? ['click', 'pointerdown']
                .map(t => `${t}:${(getEventListeners(b.parentElement)[t] || []).length}`).join(' ')
            : 'n/a',
          rect: `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`,
        };
      })(),
      radios: document.querySelectorAll('[role="radio"]').length,
      nativeRadios: document.querySelectorAll('input[type="radio"]').length,
      checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
      roleCheckboxes: document.querySelectorAll('[role="checkbox"], [aria-checked]').length,
      multi: p.multi,
      instruction: p.instruction,
      ticked: p.multi ? p.options.map((o, i) => (selected(o.el) ? 'ABCDEFGHIJ'[i] : '')).join('') : '',
      // Structural detail needed to pin selectors instead of guessing.
      choiceRows: p.options.map((o, i) => ({
        i,
        click: describe(o.el),
        text: describe(o.el.__textEl || o.el),
        same: (o.el.__textEl || o.el) === o.el,
        len: o.text.length,
      })),
      group: p.options[0]?.el ? describe(p.options[0].el.parentElement) : null,
    };
  }

  /** Emit the report as copy-pasteable text. A collapsed console object is
   *  useless to anyone trying to send it back. */
  function buildDump() {
    const r = report();
    const L = [];
    const add = (k, v) => L.push(`  ${String(k).padEnd(16)} ${v}`);

    L.push('=== alef-solver dump ===');
    add('build', BUILD);
    add('taken', new Date().toISOString());
    add('frame', r.frame);
    add('title', r.title);
    add('url', r.url);
    add('score', r.score);
    add('kind', r.kind || '— NONE —');
    add('dialogFound', r.dialogFound);
    L.push('');
    L.push('--- question ---');
    add('stem', r.stem ? JSON.stringify(r.stem) : '— NOT FOUND —');
    add('passageLen', r.passageLen);
    add('passageHead', JSON.stringify((r.passageHead || '').slice(0, 120)));

    if (r.kind === 'cloze' || r.clozeBlanks) {
      L.push('');
      L.push('--- fill in the blanks ---');
      add('blanks', r.clozeBlanks);
      add('wordBank', r.clozeWords.length ? `${r.clozeWords.length} terms` : '— NONE FOUND —');
      if (r.clozeWords.length) L.push(`  bank: ${r.clozeWords.join(', ')}`);
      L.push('  reconstructed sentence:');
      L.push(`  ${r.clozeText || '(empty)'}`);
    }

    if (r.kind === 'dropdown' || r.dropdownBlanks.length) {
      L.push('');
      L.push('--- drop-downs ---');
      add('boxes', r.dropdownBlanks.length);
      r.dropdownBlanks.forEach((b, i) => {
        L.push(`  [${i + 1}] ${b.native ? 'native <select>' : 'custom'}  shows ${JSON.stringify(b.shows)}`);
        L.push(`      ${b.selector}`);
      });
      L.push('  reconstructed sentence:');
      L.push(`  ${r.dropdownText || '(empty)'}`);
    }

    if (r.dragDiag) {
      L.push('');
      L.push('--- drag-and-drop detector ---');
      add('result', r.dragDiag.result);
      add('gaps found', `${r.dragDiag.zones} (${r.dragDiag.via || 'none'})`);
      add('items found', `${r.dragDiag.items}${r.dragDiag.itemsVia ? ` (by ${r.dragDiag.itemsVia})` : ''}`);
      if (r.dragEvidence) {
        const e = r.dragEvidence;
        add('draggable-marked', `${e.marked}${e.markedSample.length ? `  e.g. ${e.markedSample[0]}` : ''}`);
        add('holes in text', e.holes);
        add('dashed boxes', e.dashedTotal);
        e.dashed.forEach(d => L.push(`    ${d}`));
      }
    }
    if (r.kind === 'drag') {
      L.push('  items in the tray:');
      r.dragItems.forEach((t, i) => L.push(`    ${i}. ${t}`));
      L.push('  gaps:');
      r.dragGaps.forEach((g, i) => L.push(`    ${i + 1}. ${g}`));
      L.push('  reconstructed text:');
      L.push(`  ${r.dragText || '(empty)'}`);
    }

    if (r.matchDiag) {
      L.push('');
      L.push('--- matching detector ---');
      add('result', r.matchDiag.result);
      add('candidate rows', r.matchDiag.boxes);
      add('columns seen', r.matchDiag.columns.length ? r.matchDiag.columns.join(' | ') : '(none with 2+ rows)');
    }

    if (r.kind === 'match') {
      L.push('');
      L.push('--- matching ---');
      add('intro', JSON.stringify(r.matchIntro.slice(0, 160)));
      L.push('  left column:');
      r.matchLeft.forEach((t, i) => L.push(`    ${i + 1}. ${t}`));
      L.push('  right column:');
      r.matchRight.forEach((t, i) => L.push(`    ${i + 1}. ${t}`));
    }

    if (r.skeleton) {
      L.push('');
      L.push('--- page outline (tag .class [attrs] WxH, text) ---');
      L.push(r.skeleton);
    }

    L.push('');
    L.push('--- choices ---');
    add('count', r.options.length);
    add('optionsSane', r.optionsSane);
    add('roleRadio', `${r.radios} role=radio`);
    add('nativeRadio', `${r.nativeRadios} input[type=radio]`);
    add('checkboxes', r.checkboxes);
    add('roleCheckbox', `${r.roleCheckboxes} [role=checkbox] or [aria-checked]`);
    if (r.multi) {
      add('multi-select', `yes — instruction ${JSON.stringify(r.instruction)}, ticked now: ${r.ticked || 'none'}`);
    }
    L.push(`  group:           ${r.group}`);
    for (const row of r.choiceRows) {
      L.push(`  [${row.i}] same=${row.same ? 'y' : 'n'} len=${String(row.len).padEnd(4)} ${row.text.slice(0, 70)}`);
      L.push(`      text:  ${row.text}`);
      L.push(`      click: ${row.click}`);
    }
    L.push('');
    L.push('--- choices text ---');
    r.options.forEach((t, i) => L.push(`  ${'ABCDEFGHIJ'[i]}. ${t}`));
    L.push('');
    L.push('--- buttons ---');
    for (const b of r.submitCandidates) L.push(`  ${b}`);

    L.push('');
    L.push('--- lesson navigation (how this script sees the buttons that move a lesson on) ---');
    for (const line of r.navButtons) L.push(`  ${line}`);
    L.push(`  content screen   ${r.contentScreen}`);
    L.push(`  rating box submit ${r.rateSubmit}`);

    if (r.rateBox) {
      L.push('');
      L.push('--- the rating box ("Rate your lesson!") ---');
      L.push(r.rateBox);
    }
    L.push('');
    L.push('--- clickable things that are not buttons (cursor:pointer, outermost) ---');
    if (!r.clickables.length) L.push('  — none —');
    for (const c of r.clickables) L.push(`  ${c}`);

    L.push('');
    L.push('--- everything a typed answer could go into (hidden ones too) ---');
    if (!r.editables.length) L.push('  — none —');
    for (const e of r.editables) L.push(`  ${e}`);
    L.push('');
    L.push('--- "Type…" placeholders, and what they sit in ---');
    if (!r.placeholders.length) L.push('  — none —');
    for (const e of r.placeholders) L.push(`  ${e}`);

    L.push('');
    L.push('--- submit button detail ---');
    const d = r.submitDetail;
    if (!d) {
      L.push('  — NO SUBMIT BUTTON FOUND —');
    } else {
      add('tag', `${d.tag}${d.type ? `[type=${d.type}]` : ''}`);
      add('disabled', d.disabled);
      add('text', JSON.stringify(d.text));
      add('selector', d.selector);
      add('rect', d.rect);
      add('classes', d.classes);
      add('parent', `${d.parentTag} .${d.parentClasses}`);
      add('listeners', d.listeners);
      add('parentListeners', d.parentListeners);
    }
    L.push('=== end ===');
    return { text: L.join('\n'), score: r.score };
  }

  function dump() {
    let built;
    try { built = buildDump(); }
    catch (e) {
      // A dump that throws must not leave the popup's copy button holding an OLD report.
      console.error('[alef-solver] dump failed', e);
      hud(`dump failed: ${e.message} — report saved`, true);
      saveReport('exception', `dump failed: ${e.message}`, { stack: String(e.stack || '').slice(0, 800) });
      return;
    }
    const { text, score } = built;
    console.clear();
    console.log(text);
    // Park it for the popup's copy button in case the clipboard write below is refused.
    try { chrome.storage.local.set({ lastReport: text, lastReportAt: Date.now() }); } catch { /* not in an extension */ }
    // Also drop a string on the clipboard — one paste beats screenshotting.
    try {
      navigator.clipboard?.writeText(text).then(
        () => hud('dump copied to clipboard', true),
        () => hud(`dump → console (score ${score})`, true));
    } catch {
      hud(`dump → console (score ${score})`, true);
    }
  }

  /** Stop a run and keep what's needed to diagnose it. A clipboard write needs
   *  a user gesture, which a background run doesn't have — so the report goes
   *  to extension storage and the popup's "Copy last failure report" button
   *  (a real click) puts it on the clipboard. */
  async function failRun(n, stage, message, detail) {
    hud(`⚠ #${n + 1} ${message} — stopped. Report saved: ${reportHint()}`, true);
    console.warn('[alef-solver]', stage, message, detail);
    await saveReport(stage, message, detail, n);
  }

  // Dump and Copy last report are for sending a bug report, so they sit behind the
  // Developer mode setting. Reports are saved either way; only the way to copy one,
  // and the dump hotkey, depend on it.
  const DEV_OFF = 'Developer mode is off — turn it on in Options to dump the page';
  const reportHint = () => (CFG.devMode ? 'extension popup → Copy last report' : 'turn on Developer mode in Options to copy it');
  async function devOn() { await loadSettings(); return CFG.devMode === true; }

  /** Build a report and park it for the popup's "Copy last report" button. Every
   *  call saves something fresh, so a stale report can't be mistaken for the one
   *  just asked for. */
  async function saveReport(stage, message, detail, n = 0) {
    let extra = '';
    try {
      extra = JSON.stringify(detail, (k, v) => (v instanceof Element ? describe(v) : v), 1) || '';
    } catch { extra = String(detail); }

    let dumped = '(dump failed)';
    try { dumped = buildDump().text; } catch (e) { dumped = `(dump failed: ${e.message})\n${String(e.stack || '').slice(0, 800)}`; }

    const report = [
      '=== alef-solver failure ===',
      `build:       ${BUILD}`,
      `question #:  ${n + 1}`,
      `stage:       ${stage}`,
      `message:     ${message}`,
      `when:        ${new Date().toISOString()}`,
      extra ? `detail:\n${extra.slice(0, 3000)}` : '',
      '',
      dumped,
    ].join('\n');

    try { await chrome.storage.local.set({ lastReport: report, lastReportAt: Date.now() }); }
    catch { /* storage unavailable — the console still has it */ }
    return report;
  }

  function describe(el) {
    const path = [];
    let n = el;
    while (n && n.nodeType === 1 && path.length < 5) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += `#${n.id}`;
      const cls = (n.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += `.${cls.join('.')}`;
      const role = n.getAttribute('role');
      if (role) s += `[role=${role}]`;
      path.unshift(s);
      n = n.parentElement;
    }
    return path.join(' > ');
  }

  /** Pick the answer and (optionally) submit. Shared by the extension's own
   *  solve() and by the CDP driver in tools/, so the two cannot drift apart. */
  async function commit(index, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { clicked: false, selected: false, submitted: false };

    const p = scrape();
    if (!p.optionsSane) {
      out.error = 'choice grouping is ambiguous — refusing to click (would risk the wrong answer)';
      return out;
    }
    const row = p.options[index]?.el;
    if (!row) { out.error = `no choice at index ${index}`; return out; }

    const cardAt = i => findOptions()?.rows[i]?.el || row;     // looked up afresh: the page may redraw a card
    const trail = [];
    // A page can show a card as chosen in a way selected() cannot read; an enabled Submit says it too.
    out.clicked = true;
    out.selected = await pressCard(cardAt, index, true, trail, () => !!findButton('submit', null));
    out.trail = trail;

    if (!autoSubmit) {
      if (!out.selected) out.error = `the card did not show as chosen — ${trail.join('; ')} (${cardState(cardAt(index))})`;
      return out;
    }
    await submitChoice(out, p, delay);
    if (!out.submitted && !out.selected && out.error) out.error += ` — the card never showed as chosen: ${trail.join('; ')} (${cardState(cardAt(index))})`;
    return out;
  }

  /** The answers are picked: press Submit, and say in `out` whether the page took them. */
  async function submitChoice(out, p, delay) {
    await sleep(delay);
    // A picture viewer left open would take the Submit press, and its closing looks like the page
    // reacting. Put it away first.
    if (await dismissStrayDialog()) { out.closedDialog = true; hud('closed a picture that was open'); }
    // Submit only — never Next. Clicking Next here would skip the question.
    const btn = await waitForSubmit(p.options[0]?.el?.parentElement || null);
    if (!btn) { out.error = 'no enabled submit button found'; return; }

    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    // The page changing is not the answer being taken: it can be a dialog closing, a toast. Taken
    // means no enabled Submit is left showing (it becomes Next, Done or Try Again, or goes grey).
    let taken = c.ok;
    if (c.ok) {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000 && findButton('submit', null)) await sleep(150);
      taken = !findButton('submit', null);
    }
    out.submitted = taken;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    else if (!taken) out.error = 'Submit was pressed and the page changed, but an enabled Submit is still showing: the answer was not taken';
  }

  /** Tick the right cards of a "select the correct answers" question and (optionally) submit.
   *  A card is a switch, not a button: pressing one that is already on turns it off. So each is
   *  looked at first and pressed only if it is not as wanted, once, and given a moment to show
   *  the change before anything else is tried — a second press "to be safe" would undo the first. */
  async function commitMulti(indices, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'multi', picks: [...indices], clicked: false, selected: false, submitted: false };

    const p = scrape();
    if (!p.multi) { out.error = 'this question has no tick-boxes'; return out; }
    if (!p.optionsSane) {
      out.error = 'choice grouping is ambiguous — refusing to click (would risk the wrong answer)';
      return out;
    }
    if (indices.some(i => !p.options[i])) { out.error = `no choice at index ${indices.find(i => !p.options[i])}`; return out; }

    const want = new Set(indices);
    const cardAt = i => findOptions()?.rows[i]?.el || null;     // looked up afresh: the page may redraw a card
    const trails = {};
    // Switch off what should not be on before switching on what should: a page that takes only so
    // many ticks has no room for a new one until an old one is gone.
    const order = p.options.map((_, i) => i).sort((a, b) => Number(want.has(a)) - Number(want.has(b)));
    for (const i of order) {
      const on = want.has(i);
      const el = cardAt(i);
      if (!el || selected(el) === on) continue;
      out.clicked = true;
      trails[i] = [];
      await pressCard(cardAt, i, on, trails[i]);
    }
    out.trails = trails;

    // A page that does not hold the tick in its own state puts it back on its next redraw: look again
    // after it has had the chance to, as a filled-in box is looked at again.
    await sleep(200);
    const now = p.options.map((_, i) => { const el = cardAt(i); return !!el && selected(el); });
    out.ticked = now.map((v, i) => (v ? 'ABCDEFGHIJ'[i] : '')).join('');
    const wrong = now.map((v, i) => (v !== want.has(i) ? 'ABCDEFGHIJ'[i] : '')).filter(Boolean);
    out.selected = wrong.length === 0;
    if (!out.selected) {
      const tried = now.map((v, i) => (v !== want.has(i) && trails[i] ? `${'ABCDEFGHIJ'[i]}: ${trails[i].join(', ') || 'not pressed'}` : '')).filter(Boolean).join(' | ');
      // Cards that would not tick while others stand ticked, and nothing wrong left on, is how a page
      // says "no more": it takes only so many, and does not say how many. Report the number it took,
      // so the caller can ask again for that many.
      const badAt = now.map((v, i) => (v !== want.has(i) ? i : -1)).filter(i => i >= 0);
      const stuck = now.filter(Boolean).length;
      if (stuck > 0 && stuck < indices.length && badAt.every(i => want.has(i) && !now[i])) out.limit = stuck;
      out.error = `the page did not keep the ticks on ${wrong.join(', ')} (ticked now: ${out.ticked || 'none'}, wanted: ${indices.map(i => 'ABCDEFGHIJ'[i]).join('')})${out.limit ? ` — it seems to take only ${out.limit} ticks` : ''}${tried ? ` — ${tried}` : ''}`;
      return out;
    }

    if (!autoSubmit) return out;
    await submitChoice(out, p, delay);
    // Every wanted card is ticked and Submit still stands switched off: the page is waiting for more
    // ticks (it wants as many as there are right answers, and does not say how many). Report the least
    // it can want, so the caller can ask again for at least that many.
    if (!out.submitted && out.error === 'no enabled submit button found') {
      const off = findButton('submit', null, { requireEnabled: false });
      const ticks = (out.ticked || '').length;
      if (off && disabled(off) && ticks < p.options.length) {
        out.needMore = ticks + 1;
        out.error += ` — Submit stays off with ${ticks} ticked; the page may want more`;
      }
    }
    return out;
  }

  /** Fill in a cloze question's blanks and (optionally) submit. */
  async function commitCloze(words, opts = {}) {
    const autoSubmit = opts.autoSubmit !== false;
    const delay = opts.answerDelay ?? CFG.answerDelay;
    const out = { kind: 'cloze', filled: [], selected: false, submitted: false };

    const p = scrape();
    const blanks = p.cloze?.blanks || [];
    if (!blanks.length) { out.error = 'no blanks found'; return out; }
    if (words.length !== blanks.length) {
      out.error = `answer count mismatch: ${words.length} answers for ${blanks.length} blanks`;
      return out;
    }

    const fillAll = async () => {
      const done = [];
      for (const [i, b] of blanks.entries()) {
        if (b.math) {
          const m = await setMathValue(b.el, words[i]);
          done.push({ blank: i + 1, wrote: words[i], landed: m.value, via: m.via, reached: m.reached, tried: m.tried });
        } else {
          done.push({ blank: i + 1, wrote: words[i], landed: setInputValue(b.el, words[i]) });
        }
      }
      return done;
    };

    out.filled = await fillAll();
    if (out.filled.some(f => f.reached === false)) {
      out.error = 'the math answer box could not be reached: the extension\'s page-side helper (bridge-main.js) did not answer — reload the extension at chrome://extensions, then reload this tab';
      return out;
    }

    // A controlled input can accept the value and then revert it on its own
    // next render — the DOM looks right and the component's state is still
    // empty, so Submit enables but does nothing. Read back again to find out.
    let bad = await verifyInputs(blanks, words);
    if (bad.length) {
      console.warn('[alef-solver] inputs reverted, retrying', bad);
      hud('retyping…');
      out.filled = await fillAll();
      bad = await verifyInputs(blanks, words, 350);
    }

    out.selected = bad.length === 0;
    out.reverted = bad;
    if (!out.selected) {
      out.error = `a blank did not keep the text: ${bad.map(b => `#${b.i + 1} "${b.got}"≠"${b.want}"`).join(', ')}`;
    }

    if (!autoSubmit) return out;

    await sleep(delay);
    const btn = await waitForSubmit(p.cloze?.region || null);
    if (!btn) { out.error = 'no enabled submit button found'; return out; }

    // An enabled button that ignores a synthetic click looks identical to
    // success unless the page is checked afterwards.
    out.submitLabel = txt(btn);
    const c = await clickConfirmed(btn);
    out.submitted = c.ok;
    out.clickedVia = c.via;
    if (!c.ok) out.error = 'submit button was clickable but the click had no effect';
    return out;
  }

  /* ============================================================== plumbing */

  // Exposed for the CDP driver (tools/solve.js) and for manual poking.
  window.__alefSolver = {
    scrape, commit, commitMulti, commitCloze, commitDropdown, readDropdownOptions, commitMatch, commitDrag,
    report, solve, solveOne, solveLesson,
    dump, screenshot, wantsScreenshot, rateWaitMs, selected, findButton,
    findSubmit: (root) => findButton('submit', root),
    findCloze, findWordBank, setInputValue,
    forgetPassage, lessonKey, isGraded, contentScreen, commitSort, feedbackForm, feedbackSubmit, stop: () => { stopRun = true; },
  };

  // Only wire up extension messaging when we're actually inside an extension.
  // (The CDP driver injects this same file into a plain page, where there is no
  // chrome.runtime — `chrome` may not even be declared.)
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;

  /** One line on what the detector sees, for the popup. */
  function summary(p) {
    switch (p.kind) {
      case 'choice': return `multiple choice (${p.options.length} options)`;
      case 'cloze': return `fill in the blanks (${p.cloze.blanks.length})`;
      case 'dropdown': return `drop-downs (${p.dropdown.blanks.length})`;
      case 'match': return `matching (${p.match.left.length} pairs)`;
      case 'drag': return `drag and drop (${p.drag.zones.length} gaps, ${p.drag.items.length} items)`;
      case 'sort': return `put in order (${p.sort.items.length} items)`;
      default: return 'no question';
    }
  }

  /** Why the detector found nothing, as far as it can say. */
  const whyNone = () => {
    if (lastDragDiag && lastDragDiag.result) return lastDragDiag.result;
    if (lastMatchDiag && lastMatchDiag.result) return lastMatchDiag.result;
    if (skipScreen()) return 'a question this cannot read, but the page offers "I\'ll try later", so it will be skipped';
    if (feedbackForm()) return 'the lesson\'s rating box ("Rate your lesson!"), not a question — a lesson run with "Go to the next lesson when done" switched on presses its Submit';
    const task = findButton('startTask', null);
    if (task && !inPlayerFooter(task) && !CFG.autoNextLesson) return 'a list of tasks, not a lesson — switch on "Go to the next lesson when done" and a lesson run will start the first task it can do';
    // A list where every row is a lesson found to be already done. Nothing is wrong; there is just
    // nothing left for it to do.
    if (!task) {
      const rows = startRows();
      if (rows.length) return `the list has nothing left that I can start — ${rows.join('; ')}`;
    }
    const cs = contentScreen();
    if (cs && cs.locked) return 'a slide whose Next is greyed out (it may unlock after a few seconds, or once something on it is clicked)';
    if (cs && cs.coursework) return 'a list of tasks, not a lesson: a lesson run starts the first task that says Start';
    if (cs && cs.splash) return 'the opening screen of an activity, not a question: it has only Start (Solve whole lesson presses it)';
    if (cs && cs.next) return 'a slide, not a question: it has Next and nothing to answer (Solve whole lesson goes past these)';
    if (cs && cs.finish) return 'the closing screen, not a question: it has only a finish button';
    return '';
  };

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg?.type) {
      case 'do-solve':
      case 'do-lesson': {
        // Only the frame that holds the question takes the job. The top frame always
        // answers, so the popup can say what happened; a child frame answers only if
        // it has a question, so its "no" can't win the race against a "yes". A report
        // is saved on every miss: "Copy last report" must never hand back a stale one.
        (async () => {
          try {
            const p = scrape();
            // A whole-lesson run may begin on a screen with no question (a slide, the
            // opening screen): it goes past those. A single answer has nothing to answer there.
            const lessonFromHere = msg.type === 'do-lesson' && !p.kind && !!contentScreen();
            if (p.kind || skipScreen() || lessonFromHere) {
              if (msg.type === 'do-lesson') solveLesson(); else solve();
              respond({ handled: true, score: p.score, kind: p.kind || (lessonFromHere ? 'slide' : 'skippable'), build: BUILD });
              return;
            }
            if (!IS_TOP) return;
            await saveReport('no-question', 'nothing on this page looks like a question', { score: p.score, why: whyNone() });
            await devOn();
            const why = whyNone();
            hud(why ? `${why}` : `no question detected — report saved (${reportHint()})`, true);
            respond({ handled: false, saved: true, score: p.score, why, build: BUILD });
          } catch (e) {
            console.error('[alef-solver]', e);
            if (!IS_TOP) return;
            await saveReport('exception', String(e && e.message || e), { stack: String(e && e.stack || '').slice(0, 800) });
            respond({ handled: false, error: String(e && e.message || e), build: BUILD });
          }
        })();
        return true;
      }
      case 'do-ping': {
        // The popup asks on opening: is this tab running this version, and what does it see?
        if (!IS_TOP) return false;
        try {
          const p = scrape();
          respond({ build: BUILD, kind: p.kind, summary: summary(p), why: p.kind ? '' : whyNone() });
        } catch (e) {
          respond({ build: BUILD, error: String(e && e.message || e) });
        }
        return true;
      }
      case 'do-stop': {
        stopRun = true;
        if (IS_TOP) hud('stopping…');
        respond({ stopping: true });
        return true;
      }
      case 'do-dump': {
        (async () => {
          try {
            if (!(await devOn())) {
              if (!IS_TOP) return;
              hud(DEV_OFF, true);
              respond({ ok: false, devOff: true, build: BUILD });
              return;
            }
            const p = scrape();
            if (p.score > 2 || IS_TOP) dump();
            respond({ ok: true, build: BUILD });
          } catch (e) {
            console.error('[alef-solver]', e);
            if (!IS_TOP) return;
            await saveReport('exception', String(e && e.message || e), { stack: String(e && e.stack || '').slice(0, 800) });
            respond({ ok: false, error: String(e && e.message || e), build: BUILD });
          }
        })();
        return true;
      }
    }
  });

  /* ------------------------------------------------------------- shortcuts */

  // The shortcut for an action. Options saves all four, `null` meaning "none"; an
  // action it does not name (settings from before shortcuts could be changed) keeps
  // its default.
  const hotkeyOf = action => (CFG.hotkeys && action in CFG.hotkeys ? CFG.hotkeys[action] : DEFAULT_HOTKEYS[action]);

  const isPressed = (e, b) => !!b && e.code === b.code &&
    e.ctrlKey === !!b.ctrl && e.shiftKey === !!b.shift && e.altKey === !!b.alt && e.metaKey === !!b.meta;

  /** Would this key, pressed on its own, put a character in a text field or move the
   *  cursor there? Those must stay the field's; F-keys and the like do neither. */
  const editsText = b => !(b.ctrl || b.alt || b.meta) &&
    (String(b.key).length === 1 || /^(Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow\w+)$/.test(b.key));
  const inTextField = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  /** Every frame listens: a key pressed inside an iframe never reaches the top window,
   *  and the question often lives in one. The background sends the job to all frames,
   *  and the one holding the question does it. */
  window.addEventListener('keydown', e => {
    if (e.repeat || e.isComposing) return;
    const action = ['solve', 'lesson', 'stop', 'dump'].find(a => isPressed(e, hotkeyOf(a)));
    if (!action) return;
    if (inTextField(e.target) && editsText(hotkeyOf(action))) return;
    e.preventDefault();
    e.stopPropagation();
    // A page left over from before the extension was reloaded throws here, and would
    // otherwise just do nothing.
    try { chrome.runtime.sendMessage({ type: 'hotkey', action }).catch(() => {}); }
    catch { hud('⚠ the extension was reloaded since this page loaded — press F5', true); }
  }, true);

  loadSettings();                          // the shortcuts, before the first key press
})();
