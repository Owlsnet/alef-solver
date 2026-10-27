#!/usr/bin/env node
/* The Keccak in background.js against the test vectors that are not in dispute.
   Plain SHA3-256 (round 0 included) has published vectors, so it can be checked exactly.
   The DeepSeek variant (round 0 dropped) has no published vector here; what is checked for
   it is that the sponge, padding, ordering and finalisation are right — i.e. that it agrees
   with the plain one when the only difference is the dropped round. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const ctx = vm.createContext({
  console, Uint8Array, Uint32Array, btoa: s => Buffer.from(s, 'binary').toString('base64'),
  chrome: { runtime: { onMessage: { addListener() { } } }, storage: { local: { get: async () => ({}), set: async () => { } } } },
});
vm.runInContext(SRC, ctx, { filename: 'background.js' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const enc = { encode: s => Buffer.from(String(s), 'utf8') };
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const sha3 = (s, round = 0) => toHex(ctx.deepseekHash(enc.encode(s), round));

// The encoder inside background.js is hand-rolled, so it is checked against Node's own before
// anything is measured with it.
console.log('the UTF-8 encoder');
const utf8Cases = ['', 'abc', 'a'.repeat(136), 'héllo', '日本語テキスト', '😀 emoji', 'x'.repeat(300) + 'é'];
const badEnc = utf8Cases.filter(s => Buffer.from(ctx.utf8(s)).toString('hex') !== Buffer.from(s, 'utf8').toString('hex'));
check(`matches Node for ${utf8Cases.length} strings, including multi-byte and astral ones`, badEnc.length === 0, badEnc.join(' | '));


console.log('plain SHA3-256 (round 0 included) against published vectors');
check('empty', sha3('') === 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a', sha3(''));
check('"abc"', sha3('abc') === '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532', sha3('abc'));
check('448-bit message', sha3('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') === '41c0dba2a9d6240849100376a8235e2c82e1b9998a999e21db32dd97496d3376');
check('896-bit message', sha3('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu') === '916f6061fe879741ca6469b43971dfdb28b1a32dc36cb3254e812be27aad1d18');
check('exactly one rate block (136 bytes) — padding must add a whole block', sha3('a'.repeat(136)) === '3fc5559f14db8e453a0a3091edbd2bc25e11528d81c66fa570a4efdcc2695ee1', sha3('a'.repeat(136)));

// The vectors above are short; this is the same function against Node's own SHA3-256 over
// every length that exercises a different padding path, including the block boundaries.
// Bytes are handed over as bytes: round-tripping them through a string would re-encode them.
console.log('\n  …and against Node\'s own SHA3-256 at every awkward length');
const crypto = require('crypto');
const lengths = [0, 1, 2, 31, 32, 63, 64, 100, 135, 136, 137, 200, 271, 272, 273, 400, 1000];
const mismatches = lengths.filter(n => {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 0xff;
  return toHex(ctx.deepseekHash(new Uint8Array(buf), 0)) !== crypto.createHash('sha3-256').update(buf).digest('hex');
});
check(`all ${lengths.length} lengths match (mismatched: ${mismatches.join(',') || 'none'})`, mismatches.length === 0);

console.log('\nthe DeepSeek variant drops round 0, and nothing else');
const a = sha3('abc', 0), b = sha3('abc', 1);
check('the two variants differ (the dropped round really is dropped)', a !== b);
check('the variant is a 32-byte digest', /^[0-9a-f]{64}$/.test(b), b);
check('the same input always gives the same digest', sha3('abc', 1) === b);
check('a different input gives a different digest', sha3('abd', 1) !== b);

console.log('\nthe proof-of-work search finds the nonce that produced the challenge');
// Pick a nonce, derive the challenge from it, then check the solver finds that nonce back.
const salt = 'testsalt', expire = 1700000000;
for (const round of [1, 0]) {
  const nonce = 4242;
  const target = toHex(ctx.deepseekHash(enc.encode(`${salt}_${expire}_${nonce}`), round));
  const found = ctx.solvePow(target, salt, expire, 10000, round);
  check(`round-${round === 1 ? 'skipping' : 'standard'}: the nonce is recovered`, found === nonce, `found ${found}`);
}
const never = ctx.solvePow('00'.repeat(32), salt, expire, 500, 1);
check('a challenge with no answer in range returns null, not a wrong answer', never === null, String(never));

console.log('\nthe header');
const header = ctx.powHeader({ algorithm: 'DeepSeekHashV1', challenge: 'cc', salt: 'ss', signature: 'gg', target_path: '/api/v0/chat/completion' }, 4242);
const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
check('it is base64 of JSON the site can read', decoded.answer === 4242 && decoded.target_path === '/api/v0/chat/completion', JSON.stringify(decoded));
check('every field the site issued is echoed back', ['algorithm', 'challenge', 'salt', 'answer', 'signature', 'target_path'].every(k => k in decoded));

console.log('\nthe streamed reply');
const stream = [
  'data: {"v":{"response":{"message_id":12345,"fragments":[{"type":"RESPONSE","content":"{\\"answer\\":\\"B\\"}"}]}}}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":""}',
  'data: {"p":"response/thinking_content","o":"APPEND","v":"let me think"}',
  'data: {"v":"[DONE]"}',
].join('\n');
let r = ctx.parseDeepseekStream(stream);
check('the answer is assembled from the fragments', r.text === '{"answer":"B"}', JSON.stringify(r.text));
check('the message id is picked up', r.messageId === 12345, String(r.messageId));
check('the thinking is not mixed into the answer', !/think/.test(r.text), r.text);

r = ctx.parseDeepseekStream('data: {"p":"response/thinking_content","o":"APPEND","v":"reasoning only"}\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"final"}');
check('thinking on its own path is dropped, content is kept', r.text === 'final', r.text);

// The end marker must not be read as another piece of the answer, in either spelling.
r = ctx.parseDeepseekStream('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"answer"}\ndata: [DONE]');
check('a bare [DONE] ends the message and is not appended', r.text === 'answer' && r.finish === 'stop', JSON.stringify(r));
r = ctx.parseDeepseekStream('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"answer"}\ndata: {"v":"[DONE]"}');
check('a framed [DONE] is not appended either', r.text === 'answer' && r.finish === 'stop', JSON.stringify(r));

// Expert mode: the reasoning is a THINK fragment on the same content path as the answer, and the
// answer arrives as a second fragment appended later (the failure from the real run, build 0.6.37).
r = ctx.parseDeepseekStream([
  { v: { response: { message_id: 9, fragments: [{ type: 'THINK', content: 'We' }] } } },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: ' need answer JSON.' },
  { v: ' Need choose index 2.' },
  { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '{"picks"' }] },
  { p: 'response/fragments/-1/content', v: ': [2]' },
  { v: '}' },
  { p: 'response', o: 'BATCH', v: [{ p: 'status', v: 'FINISHED' }] },
].map(f => `data: ${JSON.stringify(f)}`).join('\n') + '\ndata: [DONE]');
check('THINK fragments are left out, the RESPONSE fragment is the answer', r.text === '{"picks": [2]}', JSON.stringify(r.text));

r = ctx.parseDeepseekStream('data: {broken json}\n\ndata: [DONE]');
check('a malformed frame is skipped, not fatal', r.text === '' && r.finish === 'stop', JSON.stringify(r));

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
