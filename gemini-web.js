'use strict';
/**
 * Runs inside a gemini.google.com tab and does the talking, because that is the only place
 * the site's own requests can honestly come from: same origin, so the browser attaches the
 * session cookies by itself, and — for the accounts Google has switched Device Bound Session
 * Credentials on for — the proof-of-possession that Chrome keeps in the OS key store is added
 * by the network stack, not by us.
 *
 * A service worker cannot do either. It is a different origin, so a SameSite=Lax session
 * cookie is simply not sent, and it cannot produce the bound-session proof, so every request
 * would arrive signed out. Copying the cookies into an options box is worse still: that is
 * the one thing Device Bound Session Credentials exists to defeat, so a copied cookie stops
 * working within hours.
 *
 * So this file is a thin, faithful relay of what the page itself does: the same endpoints,
 * the same JSPB body, the same headers. The service worker decides *what* to ask; this decides
 * nothing and only carries it.
 */

/* ------------------------------------------------------------ reading responses */

/** Read field `index` of a JSPB array. A field is either in its own slot or, when the number
 *  is sparse, in a dict of high-numbered fields that always sits in the array's last slot,
 *  keyed by the field number plus one. Only one of the two ever holds a given field. */
function gwField(container, index, fallback = null) {
  if (!Array.isArray(container) || !container.length) return fallback;
  let v = index >= 0 && index < container.length ? container[index] : null;

  const empty = x => x === null || x === undefined || (Array.isArray(x) && !x.length);
  if (empty(v)) {
    const last = container[container.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) v = last[String(index + 1)];
  }
  return empty(v) ? fallback : v;
}

/** Walk a mixed path of list indices and dict keys, giving up rather than throwing. */
function gwPath(data, path, fallback = null) {
  let cur = data;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number') {
      const i = key < 0 ? cur.length + key : key;
      if (i < 0 || i >= cur.length) return fallback;
      cur = cur[i];
    } else if (cur && typeof cur === 'object' && typeof key === 'string' && key in cur) {
      cur = cur[key];
    } else {
      return fallback;
    }
  }
  return cur === null || cur === undefined ? fallback : cur;
}

/** Google's replies are `)]}'` and then frames of `<units>\n<json>`, where the count is in
 *  UTF-16 code units — which is exactly what a JavaScript string index counts, so the slice
 *  below needs no adjustment for astral characters. */
function gwFrames(raw) {
  let s = String(raw);
  if (s.startsWith(")]}'")) s = s.slice(4);

  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const m = /^(\d+)\n/.exec(s.slice(i, i + 32));
    if (!m) break;
    const start = i + m[0].length;
    const chunk = s.slice(start, start + Number(m[1]));
    i = start + Number(m[1]);
    if (!chunk.trim()) continue;
    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch { /* a frame we cannot read is skipped, not fatal */ }
  }
  return out;
}

/** Where the page leaves a placeholder for a rendered attachment instead of the thing itself. */
const GW_CARD = /^https?:\/\/googleusercontent\.com\/card_content\/\d+/;
const GW_ARTIFACT = /https?:\/\/googleusercontent\.com\/(?:\w+\/)+\d+\n*/g;

/** One candidate's answer text. The block is cumulative — each frame carries the whole text
 *  so far rather than the newest piece — so the caller keeps the last one it sees. */
function gwCandidateText(cand) {
  let t = gwPath(cand, [1, 0], '');
  if (typeof t !== 'string' || !t) return '';
  if (GW_CARD.test(t)) t = gwPath(cand, [22, 0]) || t;
  return t.replace(GW_ARTIFACT, '');
}

/* ------------------------------------------------------------------- the requests */

const GW_ORIGIN = 'https://gemini.google.com';
const GW_GENERATE = `${GW_ORIGIN}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const GW_BATCH = `${GW_ORIGIN}/_/BardChatUi/data/batchexecute`;
const GW_MODEL_HEADER = 'x-goog-ext-525001261-jspb';
const GW_RPC_USER_STATUS = 'otAQ7b';
const GW_METADATA = ['', '', '', null, null, null, null, null, null, ''];
const GW_BROWSER_TYPE = 'chrome145';   // what the site sees for the browser these values came from

/** A fresh session id for this request, and the request counter the site expects to climb. */
const gwSessionId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toUpperCase();
let gwReqId = Math.floor(10000 + Math.random() * 89999);

/** The three headers that between them name a model. `capacity` is the account's tier value,
 *  read out of its own status reply, so an account is never offered a model it cannot use. */
function gwModelHeaders(modelId, capacity, capacityField, modelNumber) {
  const tail = capacityField === 13 ? `null,${capacity}` : String(capacity);
  return {
    [GW_MODEL_HEADER]: `[1,null,null,null,"${modelId}",null,null,0,[4,5,6,8],null,null,${tail},null,null,${modelNumber}]`,
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0,0,0]',
  };
}

/** The access token and friends, read out of the page's own HTML — the same five values the
 *  site's bundle reads out of the same place. Without them the site answers 400. */
async function gwInit() {
  const res = await fetch(`${GW_ORIGIN}/app`, { credentials: 'include' });
  if (!res.ok) throw new Error(`gemini.google.com answered HTTP ${res.status} for the page itself`);
  const html = await res.text();

  const pick = re => (re.exec(html) || [])[1] || '';
  const out = {
    at: pick(/"SNlM0e":\s*"(.*?)"/),
    bl: pick(/"cfb2h":\s*"(.*?)"/),
    sid: pick(/"FdrFJe":\s*"(.*?)"/),
    hl: pick(/"TuX5cc":\s*"(.*?)"/) || 'en',
    push: pick(/"qKIAYe":\s*"(.*?)"/),
  };
  if (!out.at) {
    // The page loaded but carried no token, which is what being signed out looks like.
    throw new Error('no session token in the page — sign in at gemini.google.com in this browser');
  }
  return { ...out, browser: GW_BROWSER_TYPE };
}

/** Every model this account may use, from the site's own status call. `tier` and `capability`
 *  are the account flags that decide which of them are actually selectable. */
async function gwModels(session) {
  const params = new URLSearchParams({
    rpcids: GW_RPC_USER_STATUS,
    hl: session.hl,
    _reqid: String((gwReqId += 100000)),
    rt: 'c',
    'source-path': '/app',
  });
  if (session.bl) params.set('bl', session.bl);
  if (session.sid) params.set('f.sid', session.sid);

  // The batch call sends its own model header: the same shape, with no model named.
  const header = JSON.parse('[1,null,null,null,null,null,null,null,[4,5,6,8],null,null,null,null,null,null,null]');
  header.push(gwSessionId());

  const res = await fetch(`${GW_BATCH}?${params}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      'x-goog-ext-73010989-jspb': '[0]',
      [GW_MODEL_HEADER]: JSON.stringify(header),
    },
    body: `at=${encodeURIComponent(session.at || '')}&f.req=${encodeURIComponent(
      JSON.stringify([[ [GW_RPC_USER_STATUS, '[]', null, 'generic'] ]]))}`,
  });
  if (!res.ok) throw new Error(`the site answered HTTP ${res.status} when asked for the model list`);

  const parts = gwFrames(await res.text());
  for (const part of parts) {
    if (gwPath(part, [1]) !== GW_RPC_USER_STATUS) continue;
    if (gwPath(part, [5, 0]) === 7) throw new Error('the site says this session is not signed in');
    const raw = gwPath(part, [2]);
    if (!raw) continue;
    let body;
    try { body = JSON.parse(raw); } catch { continue; }

    const status = gwPath(body, [14]);
    const list = gwPath(body, [15], []);
    const tier = gwPath(body, [16], []);
    const caps = gwPath(body, [17], []);
    return {
      status: typeof status === 'number' ? status : 1000,
      capacity: gwCapacity(Array.isArray(tier) ? tier : [], Array.isArray(caps) ? caps : []),
      models: (Array.isArray(list) ? list : []).map(gwModel).filter(Boolean),
    };
  }
  throw new Error('the model list did not arrive — the site has probably changed');
}

/** Which tier this account is on, as the two numbers the model header needs. Read from the
 *  account's own flags rather than guessed from a plan name. */
function gwCapacity(tier, caps) {
  if (tier.includes(21)) return { capacity: 1, capacityField: 13 };
  if (tier.includes(22)) return { capacity: 2, capacityField: 13 };
  if (caps.includes(115)) return { capacity: 4, capacityField: 12 };   // Plus
  if (tier.includes(16) || caps.includes(106)) return { capacity: 3, capacityField: 12 };
  return { capacity: tier.includes(8) || caps.includes(19) ? 2 : 1, capacityField: 12 };
}

/** One entry of that list, as something a person can pick in Options. */
function gwModel(entry) {
  if (!Array.isArray(entry) || !entry.length) return null;
  const id = gwPath(entry, [0], '');
  if (!id || typeof id !== 'string') return null;

  const category = String(gwPath(entry, [1], '') || gwPath(entry, [10], ''));
  const display = String(gwPath(entry, [11], '') || gwPath(entry, [19], '') || category);
  const description = String(gwPath(entry, [12], '') || gwPath(entry, [2], ''));
  const number = gwPath(entry, [17]);
  const secondary = gwPath(entry, [9]);

  // The site names its models by category ("Flash", "Pro"); the name below is that, in the
  // shape the rest of this extension already uses for Google's models.
  const slug = category.trim().toLowerCase().replace(/\s+/g, '-');
  const name = slug ? `gemini-${slug}` : `gemini-${id.slice(0, 8)}`;

  return {
    id, name,
    label: display || category || name,
    description,
    number: typeof number === 'number' ? number : (typeof secondary === 'number' ? secondary : 1),
  };
}

/** One question. Returns the answer text, what the model was thinking if it says, and why it
 *  stopped — in the same shape every other provider in this extension returns. */
async function gwGenerate(session, opts) {
  const { prompt, model, extendedThinking, fileData } = opts;
  const modelNumber = model?.number || 1;

  // An 81-slot body where only the slots the site fills are written, and everything else stays
  // null. This is the same layout the page's own bundle builds; the gaps are not ours to fill.
  const inner = new Array(81).fill(null);
  const uuid = gwSessionId();
  inner[0] = [prompt, 0, null, fileData || null, null, null, 0];
  inner[1] = [session.hl];
  inner[2] = GW_METADATA;
  inner[6] = [1];
  inner[7] = 1;                    // streaming
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = uuid;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelNumber;
  inner[80] = extendedThinking ? 2 : 1;

  // The model header carries its own copy of the model number, and the site's bundle extends
  // it with the thinking flag and the session id before sending. Both are mirrored here.
  const headers = model ? gwModelHeaders(model.id, model.capacity, model.capacityField, model.number) : {};
  if (headers[GW_MODEL_HEADER]) {
    const parsed = JSON.parse(headers[GW_MODEL_HEADER]);
    const last = parsed[parsed.length - 1];
    if (Number.isInteger(last)) inner[79] = last;
    parsed.push(extendedThinking ? 2 : 1);
    parsed.push(uuid);
    headers[GW_MODEL_HEADER] = JSON.stringify(parsed);
  }

  const params = new URLSearchParams({ hl: session.hl, _reqid: String((gwReqId += 100000)), rt: 'c' });
  if (session.bl) params.set('bl', session.bl);
  if (session.sid) params.set('f.sid', session.sid);

  const res = await fetch(`${GW_GENERATE}?${params}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      'x-goog-ext-525005358-jspb': `["${uuid}",1]`,
      ...headers,
    },
    body: `at=${encodeURIComponent(session.at || '')}&f.req=${encodeURIComponent(
      JSON.stringify([null, JSON.stringify(inner)]))}`,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: String(detail).slice(0, 300) };
  }

  const parts = gwFrames(await res.text());
  let text = '', thoughts = '', cid = '', rid = '', rcid = '', done = false, code = 0;

  for (const part of parts) {
    const err = gwPath(part, [5, 2, 0, 1, 0]);
    if (err) { code = err; continue; }

    const raw = gwPath(part, [2]);
    if (!raw) continue;
    let body;
    try { body = JSON.parse(raw); } catch { continue; }

    const meta = gwPath(body, [1]);
    if (meta) {
      if (gwPath(meta, [0])) cid = gwPath(meta, [0]);
      if (gwPath(meta, [1])) rid = gwPath(meta, [1]);
    }

    const candidates = gwPath(body, [4], []);
    if (!Array.isArray(candidates) || !candidates.length) continue;
    for (const cand of candidates) {
      const id = gwPath(cand, [0]);
      if (!id) continue;
      rcid = id;
      const t = gwCandidateText(cand);
      if (t) text = t;
      const th = gwPath(cand, [37, 0, 0]);
      if (typeof th === 'string' && th) thoughts = th;
      if (gwPath(cand, [8, 0]) === 2) done = true;   // 2 is "this turn is finished"
    }
  }

  return { ok: true, text, thoughts, done, code, cid, rid, rcid };
}

/* -------------------------------------------------------------- what the worker asks for */

const GW_ERRORS = {
  1013: 'the site had a temporary error — trying again may work',
  1037: 'this account is out of Gemini allowance for now — wait, or pick another service',
  1050: 'the model no longer matches this conversation — start a fresh one',
  1052: 'the site would not accept the model header — the model list needs refreshing',
  1060: 'the site has temporarily blocked this network address',
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const run = async () => {
    switch (msg?.type) {
      case 'gw-ping':
        return { ok: true };
      case 'gw-init':
        return { ok: true, session: await gwInit() };
      case 'gw-models':
        return { ok: true, ...(await gwModels(msg.session)) };
      case 'gw-generate': {
        const out = await gwGenerate(msg.session, msg);
        if (out.ok && out.code) {
          return { ok: true, text: '', failure: GW_ERRORS[out.code] || `the site reported error ${out.code}` };
        }
        return out;
      }
      default:
        return { ok: false, detail: `unknown request ${msg?.type}` };
    }
  };

  run().then(respond).catch(e => respond({ ok: false, detail: String(e?.message || e) }));
  return true;   // the reply comes later
});

// Tell the worker this tab is ready to be used, so a tab opened for the job is not polled for.
chrome.runtime.sendMessage({ type: 'gw-ready' }).catch(() => { /* no worker listening yet */ });
