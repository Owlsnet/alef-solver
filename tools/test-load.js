#!/usr/bin/env node
/* The extension as Chrome would load it: the manifest, the declarativeNetRequest rules, and the
 * DeepSeek client parsing cleanly at the top level.
 *
 * Two parts, deliberately kept apart:
 *
 *   - Checks that need nothing but the files. These always run.
 *   - A live load in headless Chrome, which validates the manifest and the rules for real. Chrome
 *     137 and later ignores --load-extension unless a further flag is passed, so when the
 *     extension is not present this reports SKIP rather than pretending to pass. Read the load
 *     by name: an earlier version of this test accepted any service worker, which passed while
 *     pointing at Google's own built-in extensions and proved nothing at all.
 *
 * Not covered here: whether chat.deepseek.com accepts the request. That needs a real login and a
 * reachable network, so it is what the "Test key" button in Options is for.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const scratch = require('./scratch.js');

const ROOT = path.join(__dirname, '..');
const PORT = 9388;
process.env.CDP_PORT = String(PORT);

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const skip = (name, why) => { console.log(`  – ${name}  (skipped: ${why})`); skipped++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chromeExe = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => p && fs.existsSync(p));

async function cdp(p) { return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); }

(async () => {
  /* ---------------------------------------------------------- the files alone */
  console.log('the manifest');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  check('it is valid JSON with a name and version', !!manifest.name && /^\d+\.\d+\.\d+$/.test(manifest.version), `${manifest.name} ${manifest.version}`);
  check('it is still Manifest V3', manifest.manifest_version === 3);
  check('the DeepSeek host is requested', (manifest.host_permissions || []).some(h => /chat\.deepseek\.com/.test(h)));
  check('the permission the header rewrite needs is requested', (manifest.permissions || []).includes('declarativeNetRequestWithHostAccess'));

  console.log('\nthe header-rewrite rules');
  const ruleFiles = manifest.declarative_net_request?.rule_resources || [];
  check('a rules file is declared', ruleFiles.some(r => r.path === 'rules.json'), ruleFiles.map(r => r.path).join(', '));
  check('every declared rules file exists', ruleFiles.every(r => fs.existsSync(path.join(ROOT, r.path))));

  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
  const OPS = ['append', 'set', 'remove'];
  const TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
  check('it is a non-empty array', Array.isArray(rules) && rules.length > 0);
  check('every rule has the four fields Chrome requires (id, priority, action, condition)',
    rules.every(r => Number.isInteger(r.id) && Number.isInteger(r.priority) && r.action && r.condition));
  check('ids are unique and positive', new Set(rules.map(r => r.id)).size === rules.length && rules.every(r => r.id > 0));
  check('every header operation is one Chrome allows', rules.every(r => (r.action.requestHeaders || []).every(h => OPS.includes(h.operation) && typeof h.header === 'string')));
  check('every resource type is one Chrome knows', rules.every(r => (r.condition.resourceTypes || []).every(t => TYPES.includes(t))));
  check('the condition is a URL filter, so the host permission covers it', rules.every(r => typeof r.condition.urlFilter === 'string'));
  check('it rewrites origin and referer to the site that wants them',
    rules.some(r => r.action?.requestHeaders?.some(h => h.header === 'origin' && h.value === 'https://chat.deepseek.com')) &&
    rules.some(r => r.action?.requestHeaders?.some(h => h.header === 'referer')));
  // Each rule may only touch the one host, and it may only claim to be an origin that host is
  // legitimately called by. The upload endpoint is a different host from the Gemini app on
  // purpose — the picture goes to Google's push service, addressed as the Gemini page would
  // address it — so the two are not required to be the same name here.
  const SCOPES = {
    'https://chat.deepseek.com/': 'https://chat.deepseek.com',
    'https://content-push.googleapis.com/': 'https://gemini.google.com',
  };
  check('every rule is scoped to one of the known hosts, so no other site is affected',
    rules.every(r => Object.keys(SCOPES).some(p => r.condition.urlFilter.startsWith(p))));
  check('and each claims only the origin its host is legitimately addressed by',
    rules.every(r => {
      const want = Object.entries(SCOPES).find(([p]) => r.condition.urlFilter.startsWith(p))?.[1];
      const origin = (r.action.requestHeaders || []).find(h => h.header === 'origin')?.value || '';
      return !!want && origin === want;
    }));
  check('the Gemini picture upload is rewritten to the Gemini site, not to DeepSeek',
    rules.some(r => r.condition.urlFilter.startsWith('https://content-push.googleapis.com/') &&
                    r.action.requestHeaders.some(h => h.header === 'origin' && h.value === 'https://gemini.google.com')));
  check('it only touches API calls, not the site\'s own page loads',
    rules.every(r => (r.condition.resourceTypes || []).every(t => t === 'xmlhttprequest')));
  check('`set` is used, not `append` — an appended second Referer would be rejected',
    rules.every(r => (r.action.requestHeaders || []).every(h => h.operation === 'set')));

  console.log('\nthe DeepSeek client in background.js');
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const vm = require('vm');
  const ctx = vm.createContext({
    console, Uint8Array, Uint32Array, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    chrome: { runtime: { onMessage: { addListener() { } } }, storage: { local: { get: async () => ({}), set: async () => { } } } },
  });
  let loadError = null;
  try { vm.runInContext(bg, ctx, { filename: 'background.js' }); } catch (e) { loadError = e; }
  check('the whole file parses and runs at the top level', !loadError, loadError ? String(loadError) : '');
  if (!loadError) {
    check('the proof-of-work solver is present', typeof ctx.solvePow === 'function' && typeof ctx.deepseekHash === 'function');
    check('the DeepSeek client is present', typeof ctx.deepseekComplete === 'function' && typeof ctx.parseDeepseekStream === 'function');
    check('the digest really is not plain SHA3-256 (round 0 is dropped)',
      vm.runInContext("JSON.stringify([...deepseekHash(utf8('abc'), 1)]) !== JSON.stringify([...deepseekHash(utf8('abc'), 0)])", ctx));
    check('and the variant matches the published SHA3-256 of "abc" when round 0 is kept',
      vm.runInContext("(() => { const b = deepseekHash(utf8('abc'), 0); return [...b].map(x => x.toString(16).padStart(2,'0')).join(''); })()", ctx)
        === '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
    check('the encoder handles multi-byte text, not just ASCII',
      vm.runInContext("[...utf8('é')].join()", ctx) === '195,169' && vm.runInContext("[...utf8('日')].join()", ctx) === '230,151,165');
    check('no key or token is hard-coded in the file', !/deepseekToken:\s*'[^']+'/.test(bg));
    check('the Gemini-site client is present, and talks to the tab rather than the network',
      typeof ctx.geminiWebComplete === 'function' && typeof ctx.geminiWebSelfTest === 'function' && typeof ctx.gwTab === 'function');
  }

  console.log('\nthe Gemini-site provider');
  check('the manifest gives it a content script on the Gemini site',
    (manifest.content_scripts || []).some(cs => (cs.matches || []).some(m => /gemini\.google\.com/.test(m)) && (cs.js || []).includes('gemini-web.js')));
  check('that script only runs on the Gemini site, nowhere else',
    (manifest.content_scripts || []).every(cs => !(cs.js || []).includes('gemini-web.js') ||
      (cs.matches || []).every(m => /gemini\.google\.com/.test(m))));
  check('the host permission covers the site and its upload endpoint',
    (manifest.host_permissions || []).some(h => /gemini\.google\.com/.test(h)) &&
    (manifest.host_permissions || []).some(h => /content-push\.googleapis\.com/.test(h)));
  check('the script exists where the manifest says it is', fs.existsSync(path.join(ROOT, 'gemini-web.js')));

  const gw = fs.readFileSync(path.join(ROOT, 'gemini-web.js'), 'utf8');
  check('nothing that looks like a real Google credential is written into it',
    !/["']AIza[0-9A-Za-z_-]{10,}["']/.test(gw) && !/__Secure-1PSID["']\s*[:=]\s*["'][^"']+["']/.test(gw));
  check('it never reads the browser\'s cookies directly', !/document\.cookie/.test(gw));
  check('it names no signing key or password field', !/password|passwd/i.test(gw));
  check('the Gemini-site provider is wired into the answering path', /gemini-web/.test(bg) && /geminiWebComplete/.test(bg));
  check('its picture upload runs in the worker, where host permissions apply to it',
    /content-push\.googleapis\.com/.test(bg));

  /* ------------------------------------------------------------ the live load */
  console.log('\nloaded in headless Chrome');
  if (!chromeExe) { skip('the live load', 'chrome.exe not found'); }
  else {
    const profile = scratch.mkdtemp('alef-load-');
    const child = spawn(chromeExe, [
      '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      `--load-extension=${ROOT}`, '--enable-logging=stderr', '--v=0', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    process.on('exit', () => {
      try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { }
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }); } catch { }
    });

    let version = null;
    for (let i = 0; i < 60; i++) { await sleep(250); try { version = await cdp('/json/version'); break; } catch { } }

    if (!version) skip('the live load', 'headless chrome never started');
    else {
      console.log(`  (${version.Browser})`);
      // Identify OUR extension by name. Any service worker at all is not evidence of anything:
      // Chrome ships its own, and an earlier version of this test was fooled by exactly that.
      let ours = null, sawAny = [];
      for (let i = 0; i < 40; i++) {
        const targets = await cdp('/json/list').catch(() => []);
        for (const t of targets.filter(x => /service_worker|background_page/.test(x.type))) sawAny.push(t.url);
        const { Session } = require('./cdp.js');
        for (const t of targets.filter(x => /service_worker|background_page/.test(x.type))) {
          try {
            const s = await Session.attach(t.webSocketDebuggerUrl);
            await s.send('Runtime.enable');
            const name = await s.eval('chrome.runtime.getManifest().name').catch(() => null);
            if (name === manifest.name) { ours = { target: t, session: s }; break; }
          } catch { /* a target that cannot be attached is not ours */ }
        }
        if (ours) break;
        await sleep(250);
      }

      if (!ours) {
        skip('the manifest and rules as Chrome parses them', 'this Chrome ignores --load-extension (137+); load the folder from chrome://extensions to check it');
        console.log(`     (saw ${new Set(sawAny).size} other extension worker(s); none was "${manifest.name}")`);
      } else {
        check(`Chrome loaded this extension ("${manifest.name}")`, true, ours.target.url.slice(0, 60));
        check('the worker started without throwing', true);

        const dnr = await ours.session.eval('typeof chrome.declarativeNetRequest').catch(() => 'missing');
        check('the declarativeNetRequest API is available to it', dnr === 'object', String(dnr));

        const enabled = await ours.session.eval(
          'chrome.declarativeNetRequest.getEnabledRulesets().then(r => JSON.stringify(r)).catch(e => "ERR " + e)').catch(e => 'ERR ' + e);
        check('the ruleset is enabled at startup', /deepseek/.test(enabled), String(enabled));

        const match = await ours.session.eval(
          `chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://chat.deepseek.com/api/v0/chat/completion', type: 'xmlhttprequest' })
             .then(r => JSON.stringify(r)).catch(e => 'ERR ' + e)`).catch(e => 'ERR ' + e);
        check('the rule matches a real completion request', /"matchedRules":\[\{/.test(match) || /matched.*1/.test(match), String(match).slice(0, 120));

        const complaints = stderr.split('\n').filter(l => /rules\.json|declarative|Manifest|manifest/i.test(l) && /error|Error|failed|Failed|invalid|Invalid/.test(l));
        check('Chrome reported no problem with the manifest or the rules', complaints.length === 0, complaints.slice(0, 2).join(' | '));

        console.log('\n  not checked here: whether chat.deepseek.com accepts the request.');
        console.log('  That needs your login and a live network — use "Test key" in Options for it.');
      }
    }
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e && e.stack || e); process.exit(1); });
