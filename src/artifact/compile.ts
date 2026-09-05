/**
 * Transcript -> capability artifact. Four jobs:
 *
 * 1. PARAMETERISE. Values the planner tagged with a run parameter become
 *    `{{inputs.x}}`, and URLs containing a literal parameter value are
 *    canonicalised the same way. Without this the capability is a recording of
 *    one member's transaction wearing a costume.
 *
 * 2. CHECKPOINT. Every step gets an `expect` derived from what actually changed
 *    when it ran. A step list with no checkpoints replays by faith.
 *
 * 3. CLASSIFY RISK, through the same policy engine that gates replay, so a
 *    reviewer can see without running it that the submit step writes.
 *
 * 4. MERGE THE PROFILE. The app's known quirks come from the vendor profile,
 *    not from this one run. See ./profiles.ts.
 *
 * The compiler also refuses to emit: a recording whose targets did not
 * round-trip, or that declared no success condition, is defective, and letting
 * replay discover that later would be worse than failing here.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DiscoveryResult, RecordedStep } from '../agent/loop.ts';
import type { PolicyEngine } from '../policy/policy.ts';
import type { AppProfile } from './profiles.ts';
import { has, type TargetDescriptor } from '../surface/types.ts';
import { applyTransforms, coerce } from '../replay/extract.ts';
import {
  SCHEMA_VERSION,
  parseCapability,
  type Assertion,
  type BusinessOutcome,
  type Capability,
  type OutputSpec,
  type ParamSpec,
  type Risk,
  type Step,
  type Transform,
} from './schema.ts';

export type CompileOptions = {
  readonly discovery: DiscoveryResult;
  readonly key: string;
  readonly version?: string;
  readonly title: string;
  readonly description?: string;
  readonly tenantId: string;
  readonly profile: AppProfile;
  readonly policy: PolicyEngine;
  readonly baseUrl: string;
  readonly recordedBy: string;
  readonly runId: string;
  readonly fixtureNote?: string;
};

export type CompileProblem = { readonly severity: 'error' | 'warning'; readonly message: string };

export type CompileResult =
  | { readonly ok: true; readonly capability: Capability; readonly problems: readonly CompileProblem[] }
  | { readonly ok: false; readonly problems: readonly CompileProblem[] };

export function compile(opts: CompileOptions): CompileResult {
  const { discovery: d, profile } = opts;
  const problems: CompileProblem[] = [];

  if (d.status !== 'succeeded') {
    return { ok: false, problems: [{ severity: 'error', message: `refusing to compile a discovery run that ended as "${d.status}"` }] };
  }
  if (!d.steps.length) {
    return { ok: false, problems: [{ severity: 'error', message: 'the discovery run recorded no steps' }] };
  }

  // -- inputs ---------------------------------------------------------------
  const inputs: ParamSpec[] = d.parameters.map((p) => ({
    name: p.name,
    type: declaredInputType(),
    description: p.description,
    required: true,
    sensitivity: p.sensitivity,
    // A pattern derived from one observed value is a guess, so it constrains
    // shape rather than content and is easy for a reviewer to tighten. Guessing
    // tightly here would reject valid callers.
    pattern: p.sensitivity === 'public' ? loosePattern(p.value) : undefined,
    // Only public values may become examples. An example is documentation, and
    // documentation gets pasted into tickets.
    example: p.sensitivity === 'public' ? p.value : undefined,
  }));

  const literalToParam = new Map<string, string>();
  for (const p of d.parameters) {
    if (p.value.length >= 3 && p.sensitivity !== 'secret') literalToParam.set(p.value, p.name);
  }

  // -- steps ----------------------------------------------------------------
  const steps: Step[] = [];
  const usedIds = new Set<string>();

  for (let i = 0; i < d.steps.length; i++) {
    const rec = d.steps[i]!;
    const id = uniqueId(stepId(rec) || `step-${i + 1}`, usedIds);

    if (rec.describe?.usedNonPortable) {
      problems.push({
        severity: 'warning',
        message: `step "${id}": no portable locator identified the target, so the artifact pins a DOM path and will not survive a surface change (${rec.describe.notes.join('; ')})`,
      });
    }
    if (rec.describe?.notes.some((n) => n.startsWith('NO strategy'))) {
      problems.push({ severity: 'error', message: `step "${id}": the recorded target does not resolve uniquely even against the screen it was recorded on` });
    }

    const action = toStepAction(rec, literalToParam, opts.baseUrl);
    if ('error' in action) {
      problems.push({ severity: 'error', message: `step "${id}": ${action.error}` });
      continue;
    }

    // Classified with the product's own vocabulary, so the risk stamped into
    // the artifact matches what the live check will conclude at replay time.
    const risk = opts.policy.classify(rec.action, rec.intent, { patterns: profile.riskPatterns });
    steps.push({
      id,
      intent: rec.intent,
      action: action.value,
      expect: deriveCheckpoint(rec, d.steps[i + 1], literalToParam),
      timeoutMs: 12_000,
      risk,
      optional: false,
    });

    // An irreversible step with no checkpoint replays on faith: it clicks, and
    // nothing confirms the write landed. A write you cannot verify is worse
    // than one you cannot record.
    if (risk === 'irreversible' && !steps[steps.length - 1]!.expect) {
      problems.push({
        severity: 'error',
        message: `step "${id}" is irreversible but has no checkpoint. Nothing would confirm the write landed. Give the flow a step that observes the result, or add an \`expect\` by hand before approving.`,
      });
    }
  }

  // -- outputs --------------------------------------------------------------
  const outputs: OutputSpec[] = d.outputs.map((o) => {
    const derived = transformsFor(o.type, o.rawSample);
    if (derived.problem) problems.push({ severity: 'error', message: `output "${o.name}": ${derived.problem}` });
    return {
      name: o.name,
      type: o.type,
      description: o.description,
      required: true,
      sensitivity: o.sensitivity,
      extract: { target: parameteriseDescriptor(o.target, literalToParam), property: o.property, transforms: derived.transforms },
    };
  });
  for (const o of d.outputs) {
    if (o.describe.usedNonPortable) {
      problems.push({ severity: 'warning', message: `output "${o.name}" fell back to a non-portable locator: ${o.describe.notes.join('; ')}` });
    }
  }

  // -- success condition ----------------------------------------------------
  if (!d.successText) {
    problems.push({
      severity: 'error',
      message: 'the discovery run finished without declaring text that proves the goal was reached, so there would be nothing to verify on replay',
    });
  }
  const successCondition: Assertion = {
    kind: 'all',
    of: [
      { kind: 'text_present', text: has(d.successText ?? '') },
      // A success condition that can also hold on an error screen is not a
      // success condition, so the product's own error banner is excluded -- it
      // also catches a form re-rendering under the same heading. The banner
      // comes from the profile: a clause naming another product's error code
      // can never fail, and a clause that can never fail is noise.
      ...(profile.errorBanner ? [{ kind: 'text_absent' as const, text: has(profile.errorBanner) }] : []),
    ],
  };

  // -- outcomes: what discovery saw, plus what the product always does -------
  const discovered: BusinessOutcome[] = d.outcomes.map((o) => ({
    code: o.code,
    title: o.title,
    description: o.description,
    detect: { kind: 'text_present', text: has(o.detectText) },
    afterSteps: [],
    data: [],
    severity: o.severity,
  }));
  const outcomes = dedupeBy([...discovered, ...profile.commonOutcomes], (o) => o.code);

  // -- policy ---------------------------------------------------------------
  const origin = safeOrigin(opts.baseUrl);
  const riskTier = steps.reduce<Risk>((worst, s) => (rank(s.risk) > rank(worst) ? s.risk : worst), 'safe');
  // The declared floor is the WEAKEST rung any descriptor actually needs. Set it
  // any higher and replay refuses a rung the recorder chose; any lower and the
  // artifact understates what it depends on.
  const ORDER = ['pixel', 'this_dom', 'any_web', 'any_surface'] as const;
  const effectiveFloor = [...d.steps, ...d.outputs]
    .map((x) => x.describe?.portability ?? 'any_surface')
    .reduce<(typeof ORDER)[number]>((weakest, p) => (ORDER.indexOf(p) < ORDER.indexOf(weakest) ? p : weakest), 'any_surface');

  const capability: Capability = {
    schemaVersion: SCHEMA_VERSION,
    id: `cap_${randomUUID()}`,
    key: opts.key,
    version: opts.version ?? '1.0.0',
    title: opts.title,
    description: opts.description ?? d.summary ?? opts.title,

    app: {
      profile: profile.id,
      surface: 'legacy_web',
      entrypointTemplate: canonicaliseUrl(d.entrypoint, opts.baseUrl, literalToParam),
    },

    tenant: { id: opts.tenantId, overrides: [] },

    inputs,
    outputs,

    preconditions: [],
    steps,
    successCondition,

    outcomes,
    // A capability must never inherit a recovery that re-runs itself. The
    // sign-on capability inheriting `reauthenticate` would recurse forever the
    // first time it saw its own login screen -- which is every time it runs.
    recoveries: profile.recoveries.filter((r) => !(r.remedy.kind === 'run_capability' && r.remedy.key === opts.key)),
    failureSignatures: [...profile.failureSignatures],

    policy: {
      allowedOrigins: origin ? [origin] : [],
      allowedActions: collectActionKinds(steps, profile),
      riskTier,
      // An irreversible capability requires a human decision by default. A
      // reviewer can clear this deliberately after reading the flow; nothing
      // clears it automatically.
      requiresHumanApproval: riskTier === 'irreversible',
      maxDurationMs: 120_000,
      // A capability that had to pin a DOM path cannot claim to be surface-
      // portable, so its floor is lowered honestly rather than aspirationally.
      portabilityFloor: effectiveFloor,
      // Restart safety turns on one question: would running this flow twice
      // write to a system of record twice? Only `irreversible` steps do. An
      // `elevated` step -- a search, a sign-on -- is repeatable by construction,
      // and treating it otherwise would deny a read-only inquiry the ability to
      // recover from a dropped session.
      idempotent: riskTier !== 'irreversible',
    },

    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: opts.recordedBy,
      discoveryRunId: opts.runId,
      goal: d.goal,
      planner: d.planner,
      transcriptDigest: digest(JSON.stringify(d.transcript)),
      fixtureNote: opts.fixtureNote,
    },

    approval: { state: 'draft' },
    stability: { replays: 0, successes: 0, businessOutcomes: 0, failures: 0, degradedResolutions: 0 },
  };

  // A secret must not survive into the artifact by any route. Parameterisation
  // skips secret values, which leaves the opposite hole: a credential that
  // reached a query string would be written out verbatim. So scan the finished
  // JSON for every secret value we were given.
  const emitted = JSON.stringify(capability);

  // An input the artifact never references is a lie in its own contract: the
  // caller supplies it, validation accepts it, and nothing uses it.
  for (const spec of inputs) {
    if (!emitted.includes(`{{inputs.${spec.name}}}`)) {
      problems.push({
        severity: 'error',
        message: `input "${spec.name}" is declared but never referenced by any step, URL, locator or output. Either the flow does not actually depend on it, or the value it should have parameterised was baked in as a literal.`,
      });
    }
  }

  for (const p of d.parameters) {
    if (p.sensitivity === 'public' || p.value.length < 3) continue;
    if (emitted.includes(p.value)) {
      problems.push({
        severity: 'error',
        message: `the value of "${p.name}" (declared ${p.sensitivity}) appears verbatim in the compiled artifact. Refusing to write it. This usually means the application carried the value in a URL, which the parameteriser skips for secrets.`,
      });
    }
  }

  if (problems.some((p) => p.severity === 'error')) return { ok: false, problems };

  // Validate against the schema before anyone else has to trust it.
  try {
    return { ok: true, capability: parseCapability(capability), problems };
  } catch (e) {
    return {
      ok: false,
      problems: [...problems, { severity: 'error', message: `the compiled artifact does not satisfy the schema: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}` }],
    };
  }
}

// ---------------------------------------------------------------------------

function toStepAction(
  rec: RecordedStep,
  literalToParam: Map<string, string>,
  baseUrl: string,
): { value: Step['action'] } | { error: string } {
  const a = rec.action;
  switch (a.kind) {
    case 'navigate':
      return { value: { kind: 'navigate', urlTemplate: canonicaliseUrl(a.url, baseUrl, literalToParam) } };
    case 'click':
      if (!rec.target) return { error: 'click was recorded without a synthesised target' };
      return { value: { kind: 'click', target: parameteriseDescriptor(rec.target, literalToParam) } };
    case 'fill': {
      if (!rec.target) return { error: 'fill was recorded without a synthesised target' };
      const template = rec.parameter ? `{{inputs.${rec.parameter}}}` : parameterise(a.value, literalToParam);
      return { value: { kind: 'fill', target: parameteriseDescriptor(rec.target, literalToParam), valueTemplate: template } };
    }
    case 'select': {
      if (!rec.target) return { error: 'select was recorded without a synthesised target' };
      const template = rec.parameter ? `{{inputs.${rec.parameter}}}` : parameterise(a.value, literalToParam);
      return { value: { kind: 'select', target: parameteriseDescriptor(rec.target, literalToParam), valueTemplate: template } };
    }
    case 'check':
      if (!rec.target) return { error: 'check was recorded without a synthesised target' };
      return { value: { kind: 'check', target: parameteriseDescriptor(rec.target, literalToParam), checked: a.checked } };
    case 'press':
      return { value: { kind: 'press', keys: a.keys, target: rec.target ? parameteriseDescriptor(rec.target, literalToParam) : undefined } };
    case 'answer_dialog':
      return { value: { kind: 'answer_dialog', accept: a.accept, text: a.text } };
    default:
      return { error: `action "${a.kind}" cannot be compiled into a step` };
  }
}

/**
 * Derive the step's checkpoint. Strongest first:
 *   1. the location changed             -> assert the new location's shape
 *   2. distinctive new text appeared    -> assert it is present
 *   3. the next step's control is there -> assert its presence
 *
 * (3) is weaker but never wrong: the next step cannot run without its target.
 * It also degrades sensibly -- for two fills on the same form it is trivially
 * true, which is correct, because filling a field should not change the screen.
 */
function deriveCheckpoint(
  rec: RecordedStep,
  next: RecordedStep | undefined,
  literalToParam: Map<string, string>,
): Assertion | undefined {
  // A modal the action raised is the strongest evidence there is: the
  // application acknowledging the click. It matters most where every other
  // signal is unavailable -- a submit guarded by `onsubmit="return confirm(...)"`
  // changes no URL and renders no new text, because the renderer is paused.
  if (rec.dialogAfter) {
    // The message routinely names the record ("...for member 100234. Continue?"),
    // so keep only the part before the first run value; otherwise the write is
    // verifiable for exactly one member.
    const stable = stableMessagePrefix(rec.dialogAfter, literalToParam);
    if (stable.length >= 12) return { kind: 'dialog_present', message: has(stable) };
    return { kind: 'dialog_present' };
  }

  // Exactly one checkpoint, from the strongest evidence available. Stacking a
  // location assertion and text assertions would not make the step safer, only
  // more brittle: each extra clause is another way to reject a valid screen.
  if (rec.locationAfter && rec.locationAfter !== rec.locationBefore) {
    const pattern = locationPattern(rec.locationAfter, literalToParam);
    if (pattern) return { kind: 'location_matches', pattern };
  }
  // Shortest first: a short new title is far more likely to be the screen's
  // identity than a long one, which tends to carry record detail.
  const title = [...rec.newTexts].sort((a, b) => a.length - b.length)[0];
  if (title) return { kind: 'text_present', text: has(title) };

  if (next?.target) return { kind: 'element_present', target: next.target as TargetDescriptor };
  return undefined;
}

/** The leading run of a dialog message that contains no record-specific value. */
function stableMessagePrefix(message: string, literalToParam: Map<string, string>): string {
  let cut = message.length;
  for (const literal of literalToParam.keys()) {
    const at = message.indexOf(literal);
    if (at >= 0 && at < cut) cut = at;
  }
  return message.slice(0, cut).trim().replace(/[\s,;:.-]+$/, '');
}

/**
 * Canonicalisation: a concrete URL becomes a template.
 * `http://host/content?screen=mbrdetail&id=100234` becomes
 * `{{env.baseUrl}}/content?screen=mbrdetail&id={{inputs.memberId}}` -- host
 * externalised so one artifact runs against any tenant, record id externalised
 * so the artifact is a capability rather than a bookmark.
 */
export function canonicaliseUrl(url: string, baseUrl: string, literalToParam: Map<string, string>): string {
  let out = url;
  const base = baseUrl.replace(/\/+$/, '');
  if (out.startsWith(base)) out = '{{env.baseUrl}}' + out.slice(base.length);
  return parameterise(out, literalToParam);
}

/**
 * Substitute run parameters into the string matchers inside a descriptor.
 *
 * A target identified by a product's own title is a target for one product:
 * "the button beside the card titled Sauce Labs Backpack" has to become
 * "...titled {{inputs.productName}}", or the `productName` input is decoration.
 * This is URL canonicalisation applied to locators.
 */
function parameteriseDescriptor(target: TargetDescriptor, literalToParam: Map<string, string>): TargetDescriptor {
  const matcher = (m: TargetDescriptor['name']): TargetDescriptor['name'] => {
    if (!m) return m;
    const substituted = parameterise(m.value, literalToParam);
    return substituted === m.value ? m : { ...m, value: substituted };
  };
  return {
    ...target,
    name: matcher(target.name),
    strategies: target.strategies.map((st) => {
      if (st.kind === 'relative') return { ...st, anchor: parameteriseDescriptor(st.anchor, literalToParam) };
      if (st.kind === 'text') return { ...st, text: matcher(st.text)! };
      if (st.kind === 'test_id') return { ...st, value: parameterise(st.value, literalToParam) };
      return st;
    }),
  };
}

function parameterise(value: string, literalToParam: Map<string, string>): string {
  let out = value;
  // Longest literals first, so a parameter whose value contains another's does
  // not get half-substituted.
  for (const [literal, param] of [...literalToParam.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(literal)) out = out.split(literal).join(`{{inputs.${param}}}`);
  }
  return out;
}

/** A regex over path+query with parameter values replaced by wildcards. */
function locationPattern(url: string, literalToParam: Map<string, string>): string | undefined {
  try {
    const u = new URL(url);
    let path = u.pathname + u.search;
    const SENTINEL = '\u0000';
    for (const literal of [...literalToParam.keys()].sort((a, b) => b.length - a.length)) {
      if (path.includes(literal)) path = path.split(literal).join(SENTINEL);
    }
    return escapeRegex(path).split(SENTINEL).join('[^&]+') + '$';
  } catch {
    return undefined;
  }
}

/**
 * Derive the transform pipeline, then verify it against the value discovery
 * actually saw.
 *
 * A storefront renders its order total as "Total: $32.39": the money pipeline
 * strips the currency symbol and separators and leaves the label behind. So the
 * pipeline is tried against the recorded sample, and a numeric extraction is
 * added if it does not coerce. If it still does not, the recording is defective
 * and the compiler says so.
 */
function transformsFor(type: OutputSpec['type'], rawSample: string): { transforms: Transform[]; problem?: string } {
  const base: Transform[] = (() => {
    switch (type) {
      case 'money':
        return [{ op: 'trim' }, { op: 'strip_currency' }, { op: 'strip_grouping' }];
      case 'number':
      case 'integer':
        return [{ op: 'trim' }, { op: 'strip_grouping' }];
      default:
        return [{ op: 'trim' }];
    }
  })();

  if (!rawSample) return { transforms: base };
  if (coerce(applyTransforms(rawSample, base), type).ok) return { transforms: base };

  const numeric = ['money', 'number', 'integer'].includes(type);
  if (numeric) {
    // Isolate the number from whatever label it is embedded in, before the
    // grouping separators are removed.
    const isolating: Transform[] = [
      { op: 'trim' },
      { op: 'strip_currency' },
      { op: 'regex_extract', pattern: '-?[\\d.,]+', group: 0 },
      { op: 'strip_grouping' },
    ];
    if (coerce(applyTransforms(rawSample, isolating), type).ok) return { transforms: isolating };
  }

  return {
    transforms: base,
    problem: `the value discovery observed, ${JSON.stringify(rawSample)}, does not coerce to the declared type "${type}" under any transform pipeline this compiler can derive. Either the declared type is wrong or the target is reading the wrong element.`,
  };
}

/**
 * The declared type of a discovered input. Always `string`, deliberately.
 *
 * Promoting a value that looks like an amount to `money` would be wrong in a way
 * that only shows up at replay: a `money` input is coerced to a JS number, so
 * `openingDeposit = "100.00"` would be typed back into the form as `100`. And an
 * identifier that is all digits must stay a string, because leading zeros are
 * meaningful in account numbers. So the compiler declares the safe type and a
 * reviewer tightens it in the artifact, which is a JSON edit.
 */
function declaredInputType(): ParamSpec['type'] {
  return 'string';
}

/** Shape, not content: `100234` becomes `^\d{4,8}$`, never `^100234$`. */
function loosePattern(value: string): string | undefined {
  if (/^\d+$/.test(value)) {
    const n = value.length;
    return `^\\d{${Math.max(1, n - 2)},${n + 2}}$`;
  }
  if (/^[A-Za-z0-9]{2,8}$/.test(value)) return '^[A-Za-z0-9]{2,12}$';
  return undefined;
}

/**
 * A step's id, derived from what it does rather than how the model described it.
 *
 * Intent is free prose and varies by model and by run. Tenant specialisations
 * are patches keyed on step ids, so ids drawn from prose break every override
 * the moment the base is re-recorded. Action plus target identity is stable
 * across models for the same flow. For a control with no accessible name -- the
 * common legacy case -- the relational anchor's label is the identity.
 */
function stepId(rec: RecordedStep): string {
  const a = rec.action;
  const kind = a.kind === 'answer_dialog' ? 'confirm' : a.kind;
  const target = 'target' in a ? a.target : undefined;

  const named = target?.name?.value;
  const anchored = target?.strategies.find((st) => st.kind === 'relative')?.anchor.name?.value;
  const identity = named || anchored || target?.role || '';

  return slugify(`${kind} ${identity}`.trim());
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base || 'step';
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function dedupeBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    const k = key(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

/**
 * Every surface action this capability can legitimately perform. Wider than the
 * step list: the engine navigates to the entrypoint before step one, and a
 * recovery's remedy performs actions of its own.
 */
function collectActionKinds(steps: readonly Step[], profile: AppProfile): string[] {
  const kinds = new Set<string>(['navigate']);
  const add = (list: readonly Step[]) => {
    for (const s of list) {
      if (['wait_for', 'extract', 'escalate'].includes(s.action.kind)) continue;
      kinds.add(s.action.kind);
    }
  };
  add(steps);
  for (const r of profile.recoveries) {
    if (r.remedy.kind === 'actions') add(r.remedy.steps);
  }
  return [...kinds].sort();
}

function rank(r: Risk): number {
  return { safe: 0, elevated: 1, irreversible: 2 }[r];
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function digest(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 32);
}
