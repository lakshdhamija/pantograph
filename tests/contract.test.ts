/**
 * The capability contract: input validation, templating, extraction typing,
 * assertions, tenant materialisation, policy and redaction.
 *
 * All of it runs without a browser, because all of it is pure. The one thing
 * that needs a live surface -- that the recorded flow actually replays -- is
 * covered by the evidence runs in /evidence and by `npm run demo`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateInputs, renderTemplate, TemplateError } from '../src/replay/params.ts';
import { extractOutput, coerce, applyTransforms } from '../src/replay/extract.ts';
import { evaluateAssertion } from '../src/replay/assert.ts';
import { CapabilityStore, lintSpecialisation, materialize } from '../src/artifact/store.ts';
import { parseCapability, type Capability, type ParamSpec } from '../src/artifact/schema.ts';
import { PolicyEngine } from '../src/policy/policy.ts';
import { Redactor, maskBySensitivity } from '../src/evidence/redact.ts';
import { catalogEntry, toolDefinitionFor } from '../src/capabilities/catalog.ts';
import { eq, has } from '../src/surface/types.ts';
import { memberDetailScreen, observation, node } from './helpers.ts';

// --- inputs -----------------------------------------------------------------

const memberIdSpec: ParamSpec = {
  name: 'memberId', type: 'string', description: 'member number', required: true,
  sensitivity: 'public', pattern: '^\\d{4,8}$',
};

test('input validation rejects a bad value before anything is driven', () => {
  const bad = validateInputs([memberIdSpec], { memberId: 'abc' });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0]!.problem, /pattern/);
});

test('an undeclared input is an error, not something to ignore', () => {
  // Silently dropping a typo'd parameter name is how a caller ends up querying
  // the wrong member and never finding out.
  const r = validateInputs([memberIdSpec], { memberId: '100234', memberID: '999999' });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.param, 'memberID');
});

test('a missing required input is reported by name', () => {
  const r = validateInputs([memberIdSpec], {});
  assert.equal(r.ok, false);
  assert.match(r.issues[0]!.problem, /required/);
});

test('numeric bounds are enforced', () => {
  const spec: ParamSpec = { name: 'amount', type: 'money', description: '', required: true, sensitivity: 'public', minimum: 25 };
  assert.equal(validateInputs([spec], { amount: '10' }).ok, false);
  assert.equal(validateInputs([spec], { amount: '25' }).ok, true);
});

// --- templates ---------------------------------------------------------------

test('templates resolve inputs and env', () => {
  const out = renderTemplate('{{env.baseUrl}}/content?screen=mbrdetail&id={{inputs.memberId}}', {
    inputs: { memberId: '100234' },
    env: { baseUrl: 'http://host' },
  });
  assert.equal(out, 'http://host/content?screen=mbrdetail&id=100234');
});

test('an unresolved template reference throws instead of producing an empty string', () => {
  // Substituting "" would navigate to /content?id= and fail somewhere far away
  // from the cause.
  assert.throws(() => renderTemplate('{{inputs.missing}}', { inputs: {}, env: {} }), TemplateError);
});

// --- extraction typing -------------------------------------------------------

test('a money output comes back as a number, not a string with a comma in it', () => {
  const obs = memberDetailScreen();
  const r = extractOutput(obs, {
    name: 'savingsBalance', type: 'money', description: '', required: true, sensitivity: 'public',
    extract: {
      target: {
        role: 'cell', container: ['content'],
        strategies: [{
          kind: 'relative',
          anchor: { role: 'cell', name: eq('REGULAR SHARE (SAVINGS)'), container: ['content'], strategies: [{ kind: 'role_name' }] },
          direction: 'right_of', maxDistancePx: 300,
        }],
      },
      property: 'text',
      transforms: [{ op: 'trim' }, { op: 'strip_currency' }, { op: 'strip_grouping' }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 18234.55);
  assert.equal(typeof r.value, 'number');
});

test('a value that cannot be coerced to its declared type is an error, not NaN', () => {
  assert.equal(coerce('n/a', 'money').ok, false);
  assert.equal(coerce('12.5', 'integer').ok, false);
  assert.equal(coerce('  42 ', 'integer').ok, true);
});

test('transforms compose in order', () => {
  assert.equal(applyTransforms('$ 1,234.50 ', [{ op: 'trim' }, { op: 'strip_currency' }, { op: 'strip_grouping' }]), '1234.50');
  assert.equal(applyTransforms('CT-9F3A21C4', [{ op: 'regex_extract', pattern: 'CT-([A-Z0-9]+)', group: 1 }]), '9F3A21C4');
});

// --- assertions --------------------------------------------------------------

test('assertions combine and negate', () => {
  const obs = observation([node({ role: 'text', name: 'Request Confirmed', text: 'Request Confirmed' })], {
    location: 'http://h/content?screen=subacct',
  });
  assert.equal(evaluateAssertion(obs, { kind: 'text_present', text: has('Request Confirmed') }).passed, true);
  assert.equal(evaluateAssertion(obs, { kind: 'text_absent', text: has('CT-500') }).passed, true);
  assert.equal(
    evaluateAssertion(obs, { kind: 'all', of: [{ kind: 'text_present', text: has('Request Confirmed') }, { kind: 'location_matches', pattern: 'subacct' }] }).passed,
    true,
  );
  assert.equal(evaluateAssertion(obs, { kind: 'not', of: { kind: 'text_present', text: has('Request Confirmed') } }).passed, false);
});

test('a blocking dialog is observable state, and its message is matchable', () => {
  const obs = observation([], { dialog: { kind: 'confirm', message: 'This will create a new sub-account. Continue?' } });
  assert.equal(evaluateAssertion(obs, { kind: 'dialog_present' }).passed, true);
  assert.equal(evaluateAssertion(obs, { kind: 'dialog_present', message: has('create a new sub-account') }).passed, true);
  assert.equal(evaluateAssertion(obs, { kind: 'dialog_present', message: has('delete') }).passed, false);
});

// --- policy ------------------------------------------------------------------

test('the allowlist refuses an origin nobody approved', () => {
  const p = new PolicyEngine();
  assert.equal(p.checkUrl('http://127.0.0.1:8731/content?screen=mbrsearch').decision, 'allow');
  assert.equal(p.checkUrl('https://evil.example.com/x').decision, 'deny');
});

test('an irreversible action requires a human, and a search does not', () => {
  const p = new PolicyEngine();
  const submit = p.check(
    { kind: 'click', target: { role: 'button', name: eq('Submit Request'), strategies: [{ kind: 'role_name' }] } },
    { intent: 'submit the new sub-account request' },
  );
  assert.equal(submit.decision, 'require_approval');
  assert.equal(submit.risk, 'irreversible');

  const search = p.check(
    { kind: 'click', target: { role: 'button', name: eq('Go'), strategies: [{ kind: 'role_name' }] } },
    { intent: 'run the member inquiry' },
  );
  assert.equal(search.decision, 'allow');
});

test('a forbidden action is refused outright, whatever risk the artifact declared', () => {
  const p = new PolicyEngine();
  const d = p.check(
    { kind: 'click', target: { role: 'link', name: eq('Security Administration'), strategies: [{ kind: 'role_name' }] } },
    { intent: 'open security administration', declaredRisk: 'safe' },
  );
  assert.equal(d.decision, 'deny');
});

test('a live classification can raise the recorded risk but never lower it', () => {
  const p = new PolicyEngine();
  const d = p.check({ kind: 'click', target: { role: 'button', name: eq('OK'), strategies: [{ kind: 'role_name' }] } }, {
    intent: 'click ok',
    declaredRisk: 'irreversible',
  });
  assert.equal(d.risk, 'irreversible');
  assert.equal(d.decision, 'require_approval');
});

// --- redaction ---------------------------------------------------------------

test('regulated data is redacted, and a supplied secret never survives round-trip', () => {
  const r = new Redactor();
  r.addLiteral('hunter2-not-real');
  const out = r.text('Tax ID 999-01-0234 pwd=hunter2-not-real card 4111 1111 1111 1111 a@b.example');
  assert.ok(!out.includes('999-01-0234'));
  assert.ok(!out.includes('hunter2-not-real'));
  assert.ok(!out.includes('4111 1111 1111 1111'));
  assert.match(out, /\*{4}0234/, 'a PII suffix is kept so a human can still correlate a run with a record');
});

test('a number that is not a card is left alone', () => {
  const r = new Redactor();
  assert.match(r.text('reference 1234567890123456789'), /1234567890123456789/);
});

test('sensitivity masking distinguishes secret from pii', () => {
  assert.equal(maskBySensitivity('abc', 'public'), 'abc');
  assert.equal(maskBySensitivity('supersecret', 'secret'), '[REDACTED:SECRET]');
  assert.equal(maskBySensitivity('DELACROIX, RENE M', 'pii'), '[REDACTED:PII:****NE M]');
});

test('redaction reaches nested structures and telling key names', () => {
  const r = new Redactor();
  const out = r.deep({ inputs: { password: 'p@ssw0rd-real', memberId: '100234' }, note: 'ssn 999-01-0234' });
  assert.equal(out.inputs.password, '[REDACTED]');
  assert.equal(out.inputs.memberId, '100234');
  assert.ok(!JSON.stringify(out).includes('999-01-0234'));
});

// --- tenant materialisation --------------------------------------------------

function baseCapability(): Capability {
  return parseCapability({
    schemaVersion: '1.0.0',
    id: 'cap_base', key: 'member.read-savings-balance', version: '1.0.0',
    title: 'base', description: 'base',
    app: { profile: 'coreteller', surface: 'legacy_web', entrypointTemplate: '{{env.baseUrl}}/login' },
    tenant: { id: 'tenant-a', overrides: [] },
    inputs: [memberIdSpec],
    outputs: [],
    preconditions: [],
    steps: [
      {
        id: 'type-member', intent: 'type the member number',
        action: { kind: 'fill', target: { role: 'textbox', container: ['content'], strategies: [{ kind: 'role_name' }] }, valueTemplate: '{{inputs.memberId}}' },
        expect: { kind: 'element_present', target: { role: 'button', name: eq('Go'), container: ['content'], strategies: [{ kind: 'role_name' }] } },
        timeoutMs: 10000, risk: 'safe', optional: false,
      },
      {
        id: 'run-inquiry', intent: 'run the inquiry',
        action: { kind: 'click', target: { role: 'button', name: eq('Go'), container: ['content'], strategies: [{ kind: 'role_name' }] } },
        timeoutMs: 10000, risk: 'safe', optional: false,
      },
    ],
    successCondition: { kind: 'text_present', text: has('Inquiry Results') },
    outcomes: [], recoveries: [], failureSignatures: [],
    policy: { allowedOrigins: [], allowedActions: [], riskTier: 'safe', requiresHumanApproval: false, maxDurationMs: 120000, portabilityFloor: 'any_surface', idempotent: true },
    provenance: { recordedAt: 'now', recordedBy: 'test', discoveryRunId: 'r', goal: 'g', planner: { provider: 'test', model: 'test' }, transcriptDigest: 'd' },
    approval: { state: 'approved' },
    stability: {},
  });
}

function specialisation(overrides: unknown[]): Capability {
  const base = baseCapability();
  return parseCapability({
    ...base,
    id: 'cap_granite', key: 'granite.member.read-savings-balance', title: 'granite',
    tenant: { id: 'granite', extends: { key: base.key, version: base.version }, overrides },
    approval: { state: 'draft' },
  });
}

function storeWith(caps: Capability[]): CapabilityStore {
  const dir = mkdtempSync(join(tmpdir(), 'pantograph-caps-'));
  const store = new CapabilityStore(dir);
  for (const c of caps) writeFileSync(join(dir, `${c.key}@${c.version}.json`), JSON.stringify(c));
  return store;
}

test('a tenant specialisation patches the base instead of copying it', () => {
  const overrides = [
    { op: 'set_entrypoint', urlTemplate: '{{env.baseUrl}}/t/granite/login' },
    { op: 'replace_step_target', stepId: 'run-inquiry', target: { role: 'button', name: eq('Search'), container: ['content'], strategies: [{ kind: 'role_name' }] } },
    { op: 'replace_step_expect', stepId: 'type-member', expect: { kind: 'element_present', target: { role: 'button', name: eq('Search'), container: ['content'], strategies: [{ kind: 'role_name' }] } } },
  ];
  const spec = specialisation(overrides);
  const store = storeWith([baseCapability(), spec]);

  const m = materialize(spec, store);
  assert.equal(m.app.entrypointTemplate, '{{env.baseUrl}}/t/granite/login');
  assert.equal(m.steps.length, 2, 'the base steps come through unchanged apart from the patch');
  const inquiry = m.steps.find((s) => s.id === 'run-inquiry')!;
  const inquiryTarget = 'target' in inquiry.action ? inquiry.action.target : undefined;
  assert.equal(inquiryTarget?.name?.value, 'Search');
  // The point of patching rather than copying: the untouched step is still the
  // base's, so fixing the base fixes every tenant that did not override it.
  assert.equal(m.steps[0]!.intent, 'type the member number');
});

test('lint catches an override that leaves an assertion pointing at the old control', () => {
  // Overriding a control and forgetting the assertions that point at it is the
  // easiest way to break a specialisation, so it is caught at review time.
  const incomplete = specialisation([
    { op: 'replace_step_target', stepId: 'run-inquiry', target: { role: 'button', name: eq('Search'), container: ['content'], strategies: [{ kind: 'role_name' }] } },
  ]);
  const store = storeWith([baseCapability(), incomplete]);
  const problems = lintSpecialisation(incomplete, store);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /type-member/);
  assert.match(problems[0]!, /replace_step_expect/);
});

test('lint is quiet once the override set is complete', () => {
  const complete = specialisation([
    { op: 'replace_step_target', stepId: 'run-inquiry', target: { role: 'button', name: eq('Search'), container: ['content'], strategies: [{ kind: 'role_name' }] } },
    { op: 'replace_step_expect', stepId: 'type-member', expect: { kind: 'element_present', target: { role: 'button', name: eq('Search'), container: ['content'], strategies: [{ kind: 'role_name' }] } } },
  ]);
  const store = storeWith([baseCapability(), complete]);
  assert.deepEqual(lintSpecialisation(complete, store), []);
});

test('an override naming a step that does not exist fails loudly', () => {
  const bad = specialisation([{ op: 'remove_step', stepId: 'run-inquiry' }, { op: 'replace_step_expect', stepId: 'nope', expect: { kind: 'text_present', text: has('x') } }]);
  const store = storeWith([baseCapability(), bad]);
  assert.throws(() => materialize(bad, store), /does not exist in its base/);
});

// --- agent-facing projection --------------------------------------------------

test('the catalog refuses to advertise a draft capability as invocable', () => {
  const draft = parseCapability({ ...baseCapability(), approval: { state: 'draft' } });
  const e = catalogEntry(draft);
  assert.equal(e.invocable, false);
  assert.match(e.notInvocableReason ?? '', /draft/);
  assert.equal(catalogEntry(baseCapability()).invocable, true);
});

test('the tool definition tells a calling model that outcomes are data, not errors', () => {
  const cap = parseCapability({
    ...baseCapability(),
    outcomes: [{ code: 'MEMBER_NOT_FOUND', title: 'no such member', description: '', detect: { kind: 'text_present', text: has('NO MATCHING') }, afterSteps: [], data: [], severity: 'info' }],
  });
  const tool = toolDefinitionFor(cap) as { name: string; description: string; input_schema: { required: string[] } };
  assert.equal(tool.name, 'member_read_savings_balance');
  assert.match(tool.description, /MEMBER_NOT_FOUND/);
  assert.match(tool.description, /not errors/);
  assert.deepEqual(tool.input_schema.required, ['memberId']);
});
