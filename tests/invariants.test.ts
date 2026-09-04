/**
 * Invariants this design depends on, each of which fails silently when broken.
 *
 * They are kept together because the list is the most useful description of
 * where a system like this is easy to get subtly wrong: every one of them is a
 * case where the code would do something plausible-looking rather than throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/surface/resolve.ts';
import { describeNode } from '../src/artifact/describe.ts';
import { evaluateAssertion } from '../src/replay/assert.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../src/policy/policy.ts';
import { materialize, CapabilityStore } from '../src/artifact/store.ts';
import { parseCapability, type Capability } from '../src/artifact/schema.ts';
import { createAutoOperator } from '../src/escalation/autoOperator.ts';
import { compile } from '../src/artifact/compile.ts';
import { CORETELLER_PROFILE } from '../src/artifact/profiles.ts';
import { eq, has, isResolveFailure } from '../src/surface/types.ts';
import type { Intervention } from '../src/escalation/broker.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { node, observation } from './helpers.ts';

// ---------------------------------------------------------------------------
// Targeting: three paths that would turn "I cannot find it" into "here is a control"
// ---------------------------------------------------------------------------

test('ordinal refuses to index an unfiltered set when the prior rung matched nothing', () => {
  // Shipped behaviour: a descriptor for a button named "Post" resolved to
  // "Cancel" on a screen containing no Post button, and reported ok.
  const screen = observation([
    node({ role: 'button', name: 'Cancel', x: 0 }),
    node({ role: 'button', name: 'Post Payment', x: 100 }),
    node({ role: 'button', name: 'Post Payment', x: 200 }),
  ]);
  const r = resolveTarget(screen, {
    role: 'button',
    name: eq('Post'),
    container: ['content'],
    strategies: [{ kind: 'role_name' }, { kind: 'ordinal', index: 0 }],
  });
  assert.ok(isResolveFailure(r), 'must fail rather than return an arbitrary button');
  assert.equal(r.reason, 'no_match');
});

test('ordinal still works as a disambiguator when the prior rung DID match', () => {
  const screen = observation([node({ role: 'button', name: 'Post', x: 0 }), node({ role: 'button', name: 'Post', x: 100 })]);
  const r = resolveTarget(screen, {
    role: 'button',
    name: eq('Post'),
    container: ['content'],
    strategies: [{ kind: 'role_name' }, { kind: 'ordinal', index: 1 }],
  });
  assert.ok(!isResolveFailure(r));
  assert.equal(r.node.bbox?.x, 100);
});

test('a ladder where no single rung is unique fails instead of being intersected together', () => {
  // The removed intersection fallback treated rungs recorded as ALTERNATIVES as
  // a conjunction, and made the recorder's round-trip check pass for ladders in
  // which nothing was ever independently unique.
  const screen = observation([
    node({ role: 'link', name: 'View', text: 'Details', x: 0, y: 0 }),
    node({ role: 'link', name: 'View', text: 'Summary', x: 0, y: 40 }),
    node({ role: 'link', name: 'Open', text: 'Details', x: 0, y: 80 }),
  ]);
  const r = resolveTarget(screen, {
    role: 'link',
    name: eq('View'),
    container: ['content'],
    strategies: [{ kind: 'role_name' }, { kind: 'text', text: eq('Details') }],
  });
  assert.ok(isResolveFailure(r));
  assert.equal(r.reason, 'ambiguous');
});

// ---------------------------------------------------------------------------
// Assertions: absence must mean absence, not inability to answer
// ---------------------------------------------------------------------------

test('element_absent fails when the element is on screen more than once', () => {
  const screen = observation([node({ role: 'button', name: 'Post', y: 0 }), node({ role: 'button', name: 'Post', y: 40 })]);
  const target = { role: 'button' as const, name: eq('Post'), container: ['content'], strategies: [{ kind: 'role_name' as const }] };
  const r = evaluateAssertion(screen, { kind: 'element_absent', target });
  assert.equal(r.passed, false, 'ambiguous resolution is not evidence of absence');
  assert.match(r.detail, /cannot assert absence/);
});

test('element_absent fails when every locator rung was refused by the portability floor', () => {
  const screen = observation([node({ role: 'button', name: 'Post', testId: 'post-btn' })]);
  const target = { role: 'button' as const, container: ['content'], strategies: [{ kind: 'test_id' as const, value: 'post-btn' }] };
  const r = evaluateAssertion(screen, { kind: 'element_absent', target }, { portabilityFloor: 'any_surface' });
  assert.equal(r.passed, false, 'not being allowed to look is not evidence of absence');
});

test('element_absent still passes when the element is genuinely not there', () => {
  const screen = observation([node({ role: 'button', name: 'Cancel' })]);
  const target = { role: 'button' as const, name: eq('Post'), container: ['content'], strategies: [{ kind: 'role_name' as const }] };
  assert.equal(evaluateAssertion(screen, { kind: 'element_absent', target }).passed, true);
});

test('text_absent fails when the container it names is not in the observation', () => {
  // A frame mid-navigation, or one truncated out of the node list, would
  // otherwise satisfy every text_absent in the capability.
  const screen = observation([node({ role: 'text', name: 'CT-500 system error', frame: ['content'] })]);
  const r = evaluateAssertion(screen, { kind: 'text_absent', text: has('CT-500'), container: ['results'] });
  assert.equal(r.passed, false);
  assert.match(r.detail, /cannot evaluate/);
});

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

const p = new PolicyEngine();
const btn = (name: string) => ({ role: 'button' as const, name: eq(name), strategies: [{ kind: 'role_name' as const }] });

test('the verbs a teller screen actually uses are classified irreversible', () => {
  for (const label of ['Post Payment', 'Process Withdrawal', 'Stop Payment', 'Freeze Account', 'Originate ACH', 'Charge-Off', 'Hot Card', 'Escheat', 'Place Hold', 'Reverse Entry']) {
    assert.equal(p.classify({ kind: 'click', target: btn(label) }, `click ${label}`), 'irreversible', `${label} must escalate`);
  }
});

test('risk patterns match on word boundaries, not raw substrings', () => {
  // "Avoid" contains "void"; the substring version classified it irreversible.
  assert.equal(p.classify({ kind: 'click', target: btn('Avoid duplicate') }, 'click avoid duplicate'), 'safe');
  assert.equal(p.classify({ kind: 'click', target: btn('Go') }, 'run the member inquiry'), 'safe');
  // ...but a real hyphenated verb still matches whether or not it is hyphenated.
  assert.equal(p.classify({ kind: 'click', target: btn('Charge Off') }, 'click'), 'irreversible');
  assert.equal(p.classify({ kind: 'click', target: btn('Charge-Off') }, 'click'), 'irreversible');
});

test('signing on is elevated, not irreversible', () => {
  // Bare "submit" as an irreversible verb made every form submission -- including
  // sign-on -- require a human. A gate that fires on everything gets turned off.
  assert.equal(p.classify({ kind: 'click', target: btn('Sign On') }, 'submit the sign-on form'), 'elevated');
});

test('a targetless action is classified before being written off as safe', () => {
  // press has no target, and the old ordering short-circuited to safe first, so
  // submitting a transfer with Enter was never classified.
  assert.equal(p.classify({ kind: 'press', keys: 'Enter' }, 'submit the wire transfer'), 'irreversible');
  assert.equal(p.classify({ kind: 'press', keys: 'Tab' }, 'move to the next field'), 'safe');
});

test("a dialog's own message drives classification, not just the caller's intent", () => {
  const scary = p.classify({ kind: 'answer_dialog', accept: true }, 'confirm the prompt', {
    dialogMessage: 'This will permanently delete the member record. Continue?',
  });
  assert.equal(scary, 'irreversible');
  assert.equal(p.classify({ kind: 'answer_dialog', accept: true }, 'confirm the prompt', { dialogMessage: 'Show archived rows?' }), 'elevated');
  assert.equal(p.classify({ kind: 'answer_dialog', accept: false }, 'dismiss'), 'safe');
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

test('the scripted operator refuses to approve an irreversible action by default', async () => {
  // A scripted operator that approved unconditionally, combined with an HTTP
  // endpoint that let the caller select it, would let the invoking agent
  // authorise its own writes.
  const auto = createAutoOperator();
  const intervention = {
    id: 'iv_test', reason: 'approval_required', why: 'writes to a system of record',
    options: ['approve', 'reject', 'abort'], stepId: 'submit', humanActions: 0,
    pendingAction: { kind: 'click', target: { role: 'button', name: eq('Post Payment'), strategies: [{ kind: 'role_name' }] } },
  } as unknown as Intervention;

  const refused = await auto(intervention, { surface: null as never, observe: null as never });
  assert.equal(refused.decision, 'reject');
  assert.match(refused.note ?? '', /not authorised/);
  // Whatever it does report must describe the real pending action rather than
  // claim a review it never performed.
  assert.match(refused.note ?? '', /Post Payment/);

  const permitted = await createAutoOperator({ approveIrreversible: true })(intervention, { surface: null as never, observe: null as never });
  assert.equal(permitted.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Tenant inheritance must not be able to loosen the base
// ---------------------------------------------------------------------------

function writeCapability(dir: string, cap: Capability): void {
  writeFileSync(join(dir, `${cap.key}@${cap.version}.json`), JSON.stringify(cap));
}

test('a tenant specialisation cannot loosen the base capability policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantograph-policy-'));
  const store = new CapabilityStore(dir);

  const common = {
    schemaVersion: '1.0.0' as const,
    inputs: [], outputs: [], preconditions: [], outcomes: [], recoveries: [], failureSignatures: [],
    steps: [{ id: 'post', intent: 'post it', action: { kind: 'click', target: { role: 'button', name: eq('Post Payment'), strategies: [{ kind: 'role_name' }] } }, timeoutMs: 1000, risk: 'irreversible', optional: false }],
    successCondition: { kind: 'text_present', text: has('done') },
    provenance: { recordedAt: 'n', recordedBy: 't', discoveryRunId: 'r', goal: 'g', planner: { provider: 'p', model: 'm' }, transcriptDigest: 'd' },
    stability: {},
  };

  const base = parseCapability({
    ...common, id: 'b', key: 'core.post-payment', version: '1.0.0', title: 'base', description: '',
    app: { profile: 'coreteller', surface: 'legacy_web', entrypointTemplate: '{{env.baseUrl}}/login' },
    tenant: { id: 'a', overrides: [] },
    policy: { allowedOrigins: ['http://a'], allowedActions: ['click', 'navigate'], riskTier: 'irreversible', requiresHumanApproval: true, maxDurationMs: 60000, portabilityFloor: 'any_surface', idempotent: false },
    approval: { state: 'approved' },
  });

  // The specialisation says nothing about policy, so zod fills in every default:
  // riskTier "safe", requiresHumanApproval false, idempotent true, floor any_web.
  const spec = parseCapability({
    ...common, id: 's', key: 'granite.post-payment', version: '1.0.0', title: 'spec', description: '',
    app: { profile: 'coreteller', surface: 'legacy_web', entrypointTemplate: '{{env.baseUrl}}/login' },
    tenant: { id: 'granite', extends: { key: base.key, version: base.version }, overrides: [] },
    policy: {},
    approval: { state: 'draft' },
  });

  writeCapability(dir, base);
  writeCapability(dir, spec);
  const m = materialize(spec, store);

  assert.equal(m.policy.riskTier, 'irreversible', 'a patch must not downgrade the risk tier');
  assert.equal(m.policy.requiresHumanApproval, true, 'a patch must not remove the approval requirement');
  assert.equal(m.policy.idempotent, false, 'a patch must not declare a write flow restartable');
  assert.equal(m.policy.portabilityFloor, 'any_surface', 'a patch must not loosen the portability floor');
  assert.equal(m.policy.maxDurationMs, 60000);
});

test('a test_id rung lowers the declared floor instead of forbidding itself', () => {
  // Shipped behaviour: on an app WITH test IDs, the recorder chose the test_id
  // rung, reported the ladder as portable to any surface, and the compiler
  // stamped portabilityFloor: 'any_surface' -- which the resolver then uses to
  // refuse test_id, because it is only any_web. The capability could never
  // resolve on the one class of app where the cheap rung exists.
  const screen = observation([
    node({ role: 'button', name: 'Add to cart', testId: 'add-to-cart-backpack', y: 0 }),
    node({ role: 'button', name: 'Add to cart', testId: 'add-to-cart-bike-light', y: 40 }),
  ]);
  const target = screen.nodes[0]!;
  const described = describeNode(screen, target, 'add the item to the cart');

  const kinds = described.descriptor.strategies.map((s) => s.kind);
  assert.ok(kinds.includes('test_id'), 'a present test id is the cheapest unique rung and should be used');
  assert.equal(described.portability, 'any_web', 'the ladder is web-only, and must say so');
  assert.equal(described.usedNonPortable, true);

  // And the rung it chose must survive resolution under its own declared floor.
  const r = resolveTarget(screen, described.descriptor, { portabilityFloor: described.portability });
  assert.ok(!isResolveFailure(r), 'the declared floor must not forbid the rung the recorder picked');
  assert.equal(r.node.handle, target.handle);
});

test('a fully portable ladder still declares any_surface', () => {
  const screen = observation([node({ role: 'button', name: 'Go' })]);
  const described = describeNode(screen, screen.nodes[0]!, 'run it');
  assert.equal(described.portability, 'any_surface');
  assert.equal(described.usedNonPortable, false);
});

test('a locator may key on a run parameter, because the compiler templates it', () => {
  // Refusing this forced the ladder onto a product-specific test id, and produced
  // a capability that declared a `productName` input and silently ignored it:
  // replaying for a Fleece Jacket returned the Backpack's price.
  const screen = observation([
    node({ role: 'text', name: 'Sauce Labs Backpack', x: 0, y: 0, w: 200 }),
    node({ role: 'button', name: 'Add to cart', x: 0, y: 60, w: 100 }),
    node({ role: 'text', name: 'Sauce Labs Onesie', x: 300, y: 0, w: 200 }),
    node({ role: 'button', name: 'Add to cart', x: 300, y: 60, w: 100 }),
  ]);
  const described = describeNode(screen, screen.nodes[1]!, 'add the product to the cart', {
    volatileValues: ['Sauce Labs Backpack'],
  });
  const rel = described.descriptor.strategies.find((s) => s.kind === 'relative');
  assert.ok(rel, 'six identical "Add to cart" buttons force a relational anchor');
  assert.ok(rel.kind === 'relative' && rel.anchor.name?.value === 'Sauce Labs Backpack',
    'the anchor SHOULD be the product title; the compiler turns it into a template');
  assert.ok(described.notes.some((n) => n.includes('template')), 'and it should say so, for a reviewer');
});

test('a test id that embeds a parameter in slug form is refused', () => {
  // `add-to-cart-sauce-labs-backpack` cannot be templated -- the template
  // language has no slug transform -- so keying on it would hardcode a product.
  // Two buttons share the name, so role_name is ambiguous and the ladder must
  // reach the test_id rung. With one button the earlier rung wins and this test
  // would pass without testing anything.
  const screen = observation([
    node({ role: 'button', name: 'Add to cart', testId: 'add-to-cart-sauce-labs-backpack', y: 0 }),
    node({ role: 'button', name: 'Add to cart', testId: 'add-to-cart-sauce-labs-onesie', y: 400 }),
  ]);
  const described = describeNode(screen, screen.nodes[0]!, 'add it', { volatileValues: ['Sauce Labs Backpack'] });
  assert.ok(
    described.descriptor.strategies.every((s) => s.kind !== 'test_id'),
    'a slugified parameter inside a test id is still a locator keyed on one record',
  );
  assert.ok(described.notes.some((n) => n.includes('embeds the run value')));
});

test('a plain test id with no parameter in it is still used', () => {
  const screen = observation([
    node({ role: 'button', name: 'Checkout', testId: 'checkout-button', y: 0 }),
    node({ role: 'button', name: 'Checkout', testId: 'other', y: 40 }),
  ]);
  const described = describeNode(screen, screen.nodes[0]!, 'begin checkout', { volatileValues: ['Sauce Labs Backpack'] });
  assert.ok(described.descriptor.strategies.some((s) => s.kind === 'test_id'));
});

test('step ids are derived from the action and target, not the model\'s prose', () => {
  // Intent is free prose and varies by model, so slugging it made tenant
  // overrides break whenever the base was re-recorded: the same member-inquiry
  // step was `type-the-member-number-into-the` from one planner and
  // `enter-member-number-to-look-up` from another. Since a specialisation is a
  // patch keyed on step ids, that made "a base fix reaches every tenant" false
  // in exactly the case it exists for.
  const target = {
    role: 'textbox' as const,
    container: ['content'],
    strategies: [{
      kind: 'relative' as const,
      anchor: { role: 'cell' as const, name: eq('Member Number'), container: ['content'], strategies: [{ kind: 'role_name' as const }] },
      direction: 'right_of' as const,
    }],
  };
  const base = {
    action: { kind: 'fill' as const, target, value: '100234' },
    // `target` is the synthesised descriptor the compiler writes into the step;
    // `parameter` is what makes the value a template rather than a literal.
    target,
    parameter: 'memberId',
    locationBefore: 'a', locationAfter: 'a', titleAfter: '', newTexts: [],
  };

  // Same step, wildly different phrasings, same id.
  const a = compileOneStep({ ...base, intent: 'type the member number into the inquiry field' });
  const b = compileOneStep({ ...base, intent: 'Enter member number to look up' });
  const c = compileOneStep({ ...base, intent: 'populate MBR field' });
  assert.equal(a, 'fill-member-number');
  assert.equal(b, 'fill-member-number');
  assert.equal(c, 'fill-member-number');
});

/** Compiles a single recorded step and returns its id. */
function compileOneStep(rec: Record<string, unknown>): string {
  const result = compile({
    discovery: {
      status: 'succeeded', goal: 'g', entrypoint: 'http://127.0.0.1:8731/login',
      steps: [rec], outputs: [], outcomes: [],
      parameters: [{ name: 'memberId', value: '100234', description: 'member', sensitivity: 'public' }],
      successText: 'Share / Deposit Accounts', summary: 's', finalLocation: '', transcript: [], interventions: [],
      durationMs: 1, planner: { provider: 'test', model: 'test' },
    } as never,
    key: 'test.step-id', title: 't', tenantId: 'a',
    profile: CORETELLER_PROFILE, policy: new PolicyEngine(),
    baseUrl: 'http://127.0.0.1:8731', recordedBy: 't', runId: 'r',
  });
  assert.ok(result.ok, `compile failed: ${JSON.stringify(result.problems)}`);
  return result.capability.steps[0]!.id;
}

// ---------------------------------------------------------------------------
// Three found in the last review pass, before publication
// ---------------------------------------------------------------------------

test("an operator's policy keeps the deployment's allowlists, not just its own stance", () => {
  // Building a fresh engine from DEFAULT_POLICY would drop every rule the
  // deployment declared, its origins, its routes and its forbidden list, on the
  // one path where a human authorises a write. The
  // fixture's fault-injection route is denied in policy.json; it must stay
  // denied for a human operator too.
  const deployment = new PolicyEngine({
    ...DEFAULT_POLICY,
    origins: [{ origin: 'http://127.0.0.1:8731', allow: ['^/(login|content)'], deny: ['^/_chaos'] }],
  });
  const operator = deployment.derive({ onIrreversible: 'allow', onElevated: 'allow' });

  assert.equal(operator.checkUrl('http://127.0.0.1:8731/_chaos').decision, 'deny');
  assert.equal(operator.checkUrl('http://127.0.0.1:8731/content?screen=x').decision, 'allow');
  assert.equal(operator.checkUrl('http://evil.example/').decision, 'deny');

  // ...and the stance it was derived for still took effect.
  const submit = { kind: 'click', target: { role: 'button', name: eq('Post Payment'), strategies: [{ kind: 'role_name' }] } } as const;
  assert.equal(deployment.check(submit, { intent: 'post the payment' }).decision, 'require_approval');
  assert.equal(operator.check(submit, { intent: 'post the payment' }).decision, 'allow');
});

test("a success condition excludes its own product's error banner, not another's", () => {
  // `CT-500` was hardcoded into every compiled capability, so the storefront
  // artifact asserted the absence of a CORETELLER error code on a site that has
  // never emitted one. A clause that can never fail is not a guardrail.
  const goButton = { role: 'button' as const, name: eq('Go'), strategies: [{ kind: 'role_name' as const }] };
  const clauses = (profile: typeof CORETELLER_PROFILE): string[] => {
    const result = compile({
      discovery: {
        status: 'succeeded', goal: 'g', entrypoint: 'http://127.0.0.1:8731/login',
        steps: [{
          intent: 'click go',
          action: { kind: 'click', target: goButton },
          target: goButton,
          locationBefore: 'a', locationAfter: 'a', titleAfter: '',
          newTexts: ['Share / Deposit Accounts'],
        }],
        outputs: [], outcomes: [], parameters: [],
        successText: 'Share / Deposit Accounts', summary: 's', finalLocation: '', transcript: [], interventions: [],
        durationMs: 1, planner: { provider: 'test', model: 'test' },
      } as never,
      key: 'test.banner', title: 't', tenantId: 'a',
      profile, policy: new PolicyEngine(),
      baseUrl: 'http://127.0.0.1:8731', recordedBy: 't', runId: 'r',
    });
    assert.ok(result.ok, JSON.stringify(result.problems));
    const success = result.capability.successCondition;
    assert.equal(success.kind, 'all');
    return success.kind === 'all' ? success.of.filter((a) => a.kind === 'text_absent').map((a) => JSON.stringify(a)) : [];
  };

  assert.ok(clauses(CORETELLER_PROFILE).some((c) => c.includes('CT-500')));
  assert.deepEqual(clauses({ ...CORETELLER_PROFILE, errorBanner: undefined }), []);
});

test('a tenant specialisation may declare no steps at all', () => {
  // A specialisation contributes overrides; the base contributes steps. A
  // schema that demanded at least one step would force every specialisation to
  // carry a placeholder that means nothing.
  const base = parseCapability(JSON.parse(readFileSync('artifacts/member.read-savings-balance@1.0.0.json', 'utf8')));
  const raw = JSON.parse(readFileSync('artifacts/granite.member.read-savings-balance@1.0.0.json', 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['steps'], []);

  const materialised = materialize(parseCapability(raw), new CapabilityStore('artifacts'));
  assert.equal(materialised.steps.length, base.steps.length);
  assert.ok(!materialised.steps.some((s) => s.id === 'placeholder'));

  // A base with no steps is still a defect.
  assert.throws(() => parseCapability({ ...(base as unknown as Record<string, unknown>), steps: [] }));
});
