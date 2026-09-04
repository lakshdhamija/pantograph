/**
 * The two safety controls that guard data leaving the process: what reaches
 * disk, and who is allowed to drive.
 *
 * A scanner tested only against its own fixture's data proves the fixture, not
 * the scanner. So this is a corpus of realistic regulated-data shapes plus, more
 * importantly, a corpus of near misses: an account number is not a card, a
 * member id is not a routing number, and a scanner that cannot tell the
 * difference gets switched off within a week.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../src/evidence/redact.ts';
import { sensitiveHandles } from '../src/surface/guarded.ts';
import { node, observation } from './helpers.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MUST_REDACT: ReadonlyArray<readonly [string, string]> = [
  ['ssn dashed', 'Tax ID 123-45-6789 on file'],
  ['card, spaced', 'Card 4111 1111 1111 1111'],
  ['card, dashed', '5500-0000-0000-0004'],
  ['card, zero padded to a fixed width', 'PAN=000004111111111111111'],
  ['aba routing number', 'Routing 021000021'],
  ['aba, second bank', 'ABA 011401533 for the wire'],
  ['bearer token', 'Authorization: Bearer abcdefghijklmnop.qrstuvwx'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['api key', 'sk-live_ABCDEFGHIJKLMNOP'],
  ['password in a query string', 'POST /login?user=teller01&password=hunter2000'],
  ['email', 'member contact ada@example.com'],
];

// The expensive failure is not a miss, it is a false positive: it trains people
// to ignore the output, and via the compiler it also clears `idempotent`.
const MUST_NOT_REDACT: ReadonlyArray<readonly [string, string]> = [
  ['a member number', 'Member Number 100234'],
  ['a nine-digit number that fails the ABA checksum', 'Reference 100234567'],
  ['a long digit run that fails Luhn', 'Batch 4111111111111112'],
  ['a screen label', 'REGULAR SHARE (SAVINGS)'],
  ['a money amount', 'Current Balance 18,234.55'],
  ['a date', 'Opened 03-14-2019'],
  ['a core error code', 'CT-500 ORA-01722: invalid number'],
  ['a product code', 'Product S09'],
];

test('the corpus is redacted', () => {
  const r = new Redactor();
  const missed = MUST_REDACT.filter(([, s]) => r.text(s) === s).map(([label]) => label);
  assert.deepEqual(missed, [], 'these regulated shapes passed through unredacted');
});

test('the near misses are left alone', () => {
  const r = new Redactor();
  const wrong = MUST_NOT_REDACT.filter(([, s]) => r.text(s) !== s).map(([label, s]) => `${label}: ${s} -> ${r.text(s)}`);
  assert.deepEqual(wrong, [], 'these were redacted and should not have been');
});

test('a registered secret is scrubbed even when the app echoes it back', () => {
  const r = new Redactor();
  r.addLiteral('demo-only-not-a-secret');
  assert.equal(r.text('signed on as teller01 / demo-only-not-a-secret'), 'signed on as teller01 / [REDACTED:INPUT]');
  assert.ok(r.wouldRedact('value=demo-only-not-a-secret'));
});

test('wouldRedact agrees with text, which is what makes one policy cover both media', () => {
  const r = new Redactor();
  r.addLiteral('hunter2000');
  for (const [label, s] of [...MUST_REDACT, ...MUST_NOT_REDACT]) {
    assert.equal(r.wouldRedact(s), r.text(s) !== s, `disagreement on ${label}: ${s}`);
  }
});

test('screenshot masking covers the nodes whose text would be redacted, and no others', () => {
  // The point of deriving masks from the redactor rather than from the artifact:
  // this works during discovery, during replay, and while a human is driving,
  // and it covers a tax ID nobody declared an output for.
  const label = node({ role: 'cell', name: 'Tax ID' });
  const taxId = node({ role: 'cell', name: '123-45-6789' });
  const balanceLabel = node({ role: 'cell', name: 'Current Balance' });
  const balance = node({ role: 'cell', name: '18,234.55' });
  const card = node({ role: 'textbox', name: '', value: '4111 1111 1111 1111' });
  const obs = observation([label, taxId, balanceLabel, balance, card]);

  assert.deepEqual(sensitiveHandles(obs, new Redactor()), [taxId.handle, card.handle]);
});

// ---------------------------------------------------------------------------
// The console, against a real server on a real port
// ---------------------------------------------------------------------------

test('the operator console refuses every request without its token', async () => {
  // Binding to loopback is not authentication. It is an assumption about who
  // else is on the machine, and on a shared or containerised host it is false --
  // at which point anything able to reach the port could approve a write.
  const { startOperatorConsole } = await import('../src/escalation/operatorServer.ts');
  const { EscalationBroker } = await import('../src/escalation/broker.ts');
  const { ControlLease } = await import('../src/escalation/controlLease.ts');
  const { Recorder } = await import('../src/evidence/recorder.ts');
  const { PolicyEngine } = await import('../src/policy/policy.ts');

  const dir = mkdtempSync(join(tmpdir(), 'pantograph-console-'));
  const broker = new EscalationBroker({
    surface: {} as never,
    lease: new ControlLease(),
    recorder: new Recorder({ runId: 'console-test', dir }),
    policy: new PolicyEngine(),
    mode: 'abort',
  });

  const console_ = await startOperatorConsole({ broker, port: 0, operatorId: 'ada' });
  try {
    const port = (console_.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    for (const path of ['/', '/api/interventions', '/i/anything', '/i/anything/screen.png']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 401, `${path} answered ${res.status} without a token`);
    }

    // A wrong token of the same length must not be treated differently.
    const wrong = 'x'.repeat(console_.token.length);
    assert.equal((await fetch(`${base}/?t=${wrong}`)).status, 401);

    // POSTs are guarded too: the check runs before routing, not per handler.
    const post = await fetch(`${base}/i/anything/resolve`, { method: 'POST', body: 'decision=resume' });
    assert.equal(post.status, 401);

    // Both ways in work.
    assert.equal((await fetch(`${base}/?t=${encodeURIComponent(console_.token)}`)).status, 200);
    assert.equal((await fetch(`${base}/api/interventions`, { headers: { authorization: `Bearer ${console_.token}` } })).status, 200);

    // The printed URL is usable as printed.
    assert.ok(console_.url.includes(`t=${encodeURIComponent(console_.token)}`));
  } finally {
    await console_.close();
  }
});

test('the mask is installed on the surface, not on the wrapper that can be routed around', () => {
  // The escalation broker is handed the *raw* surface on purpose, because it
  // mints a guarded surface per operator. So masking that lived in the wrapper
  // would miss the one screenshot that matters most: the frame a human is shown
  // at a handoff.
  const src = readFileSync('src/runtime.ts', 'utf8');
  const install = src.indexOf('setScreenshotMask');
  const brokerCtor = src.indexOf('new EscalationBroker');
  const guardedCtor = src.indexOf('new GuardedSurface');

  assert.ok(install > 0, 'runtime must install a screenshot mask');
  assert.ok(install < brokerCtor, 'the mask must be installed before the broker gets the raw surface');
  assert.ok(install < guardedCtor, 'and before any wrapper exists to be routed around');

  // And the wrapper must not be where the decision lives, or the two can drift.
  const guarded = readFileSync('src/surface/guarded.ts', 'utf8');
  const body = guarded.slice(guarded.indexOf('screenshot(): Promise<Buffer | undefined> {'));
  assert.ok(body.slice(0, 200).includes('return this.inner.screenshot();'), 'GuardedSurface.screenshot should delegate, not decide');
});
