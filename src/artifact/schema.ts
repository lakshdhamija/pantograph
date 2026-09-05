/**
 * The capability artifact: what a discovery run produces and what deterministic
 * replay consumes.
 *
 * It is a contract, not a step list -- typed inputs, typed outputs, a declared
 * success condition, and a declared set of business outcomes, so "no such
 * member" is a typed answer rather than an exception. Recoveries and failure
 * signatures are data, so the engine holds no app-specific knowledge. Targeting
 * is semantic; see src/surface/types.ts.
 */

import { z } from 'zod';
import type {
  ContainerPath,
  LocatorStrategy,
  Portability,
  StringMatcher,
  SurfaceKind,
  TargetDescriptor,
  UiRole,
} from '../surface/types.ts';

export const SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Primitives mirroring the surface seam
// ---------------------------------------------------------------------------

const zUiRole = z.enum([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'tab', 'menuitem', 'cell', 'columnheader', 'rowheader',
  'row', 'table', 'heading', 'text', 'image', 'dialog', 'alert', 'form',
  'group', 'document', 'unknown',
]) satisfies z.ZodType<UiRole>;

const zStringMatcher = z.discriminatedUnion('op', [
  z.object({ op: z.literal('equals'), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ op: z.literal('contains'), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ op: z.literal('startsWith'), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ op: z.literal('regex'), value: z.string(), flags: z.string().optional() }),
]) satisfies z.ZodType<StringMatcher>;

const zBBox = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const zContainerPath = z.array(z.string()) satisfies z.ZodType<ContainerPath extends readonly string[] ? string[] : never>;

const zPortability = z.enum(['any_surface', 'any_web', 'this_dom', 'pixel']) satisfies z.ZodType<Portability>;

/** Recursive: `relative` strategies embed a whole anchor descriptor. */
export const zTargetDescriptor: z.ZodType<TargetDescriptor> = z.lazy(() =>
  z.object({
    role: zUiRole,
    name: zStringMatcher.optional(),
    container: zContainerPath.optional(),
    strategies: z.array(zLocatorStrategy).min(1),
    observedAt: z
      .object({
        name: z.string().optional(),
        text: z.string().optional(),
        tag: z.string().optional(),
        nativePath: z.string().optional(),
        bbox: zBBox.optional(),
      })
      .optional(),
    rationale: z.string().optional(),
  }),
) as z.ZodType<TargetDescriptor>;

const zLocatorStrategy: z.ZodType<LocatorStrategy> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('role_name') }),
      z.object({ kind: z.literal('text'), text: zStringMatcher }),
    z.object({
      kind: z.literal('relative'),
      anchor: zTargetDescriptor,
      direction: z.enum(['same_row', 'same_column', 'right_of', 'left_of', 'below', 'above', 'within']),
      maxDistancePx: z.number().optional(),
    }),
    z.object({ kind: z.literal('ordinal'), index: z.number().int().min(0) }),
    z.object({ kind: z.literal('test_id'), value: z.string() }),
    z.object({ kind: z.literal('native_path'), path: z.string() }),
    z.object({ kind: z.literal('region'), bbox: zBBox, tolerancePx: z.number().optional() }),
  ]),
) as z.ZodType<LocatorStrategy>;

// ---------------------------------------------------------------------------
// Assertions -- the only way anything in this system decides "are we there yet"
// ---------------------------------------------------------------------------

export type Assertion =
  | { kind: 'location_matches'; pattern: string }
  | { kind: 'text_present'; text: StringMatcher; container?: string[] }
  | { kind: 'text_absent'; text: StringMatcher; container?: string[] }
  | { kind: 'element_present'; target: TargetDescriptor }
  | { kind: 'element_absent'; target: TargetDescriptor }
  | { kind: 'element_enabled'; target: TargetDescriptor }
  | { kind: 'value_matches'; target: TargetDescriptor; value: StringMatcher }
  | { kind: 'dialog_present'; message?: StringMatcher }
  | { kind: 'all'; of: Assertion[] }
  | { kind: 'any'; of: Assertion[] }
  | { kind: 'not'; of: Assertion };

export const zAssertion: z.ZodType<Assertion> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('location_matches'), pattern: z.string() }),
    z.object({ kind: z.literal('text_present'), text: zStringMatcher, container: z.array(z.string()).optional() }),
    z.object({ kind: z.literal('text_absent'), text: zStringMatcher, container: z.array(z.string()).optional() }),
    z.object({ kind: z.literal('element_present'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('element_absent'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('element_enabled'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('value_matches'), target: zTargetDescriptor, value: zStringMatcher }),
    z.object({ kind: z.literal('dialog_present'), message: zStringMatcher.optional() }),
    z.object({ kind: z.literal('all'), of: z.array(zAssertion) }),
    z.object({ kind: z.literal('any'), of: z.array(zAssertion) }),
    z.object({ kind: z.literal('not'), of: zAssertion }),
  ]),
) as z.ZodType<Assertion>;

// ---------------------------------------------------------------------------
// Typed I/O contract
// ---------------------------------------------------------------------------

/**
 * Sensitivity is enforced, not documentation:
 *   public  logged and persisted freely
 *   pii     masked in every log and never written into the artifact
 *   secret  never logged, never persisted, never shown to the model at all
 */
export const zSensitivity = z.enum(['public', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof zSensitivity>;

export const zValueType = z.enum(['string', 'number', 'integer', 'boolean', 'money', 'date', 'enum']);
export type ValueType = z.infer<typeof zValueType>;

export const zParamSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: zValueType,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: zSensitivity.default('public'),
  enum: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Safe to log and to embed in generated docs. Must not be real data. */
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type ParamSpec = z.infer<typeof zParamSpec>;

/** Post-extraction normalisation. Keeps typing honest: "18,234.55" -> 18234.55 */
export const zTransform = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim') }),
  z.object({ op: z.literal('upper') }),
  z.object({ op: z.literal('lower') }),
  z.object({ op: z.literal('strip_grouping') }),
  z.object({ op: z.literal('strip_currency') }),
  z.object({ op: z.literal('to_number') }),
  z.object({ op: z.literal('regex_extract'), pattern: z.string(), group: z.number().int().min(0).default(0), flags: z.string().optional() }),
  z.object({ op: z.literal('replace'), pattern: z.string(), with: z.string(), flags: z.string().optional() }),
]);
export type Transform = z.infer<typeof zTransform>;

export const zExtraction = z.object({
  target: zTargetDescriptor,
  property: z.enum(['text', 'value', 'name', 'attribute', 'location']).default('text'),
  attribute: z.string().optional(),
  transforms: z.array(zTransform).default([]),
});
export type Extraction = z.infer<typeof zExtraction>;

export const zOutputSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: zValueType,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: zSensitivity.default('public'),
  extract: zExtraction,
});
export type OutputSpec = z.infer<typeof zOutputSpec>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** `irreversible` is anything that writes to a system of record. */
export const zRisk = z.enum(['safe', 'elevated', 'irreversible']);
export type Risk = z.infer<typeof zRisk>;

/** Values may reference inputs as {{inputs.name}}. Resolved at replay time. */
export const zStepAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), urlTemplate: z.string() }),
  z.object({ kind: z.literal('click'), target: zTargetDescriptor }),
  z.object({ kind: z.literal('fill'), target: zTargetDescriptor, valueTemplate: z.string() }),
  z.object({ kind: z.literal('select'), target: zTargetDescriptor, valueTemplate: z.string() }),
  z.object({ kind: z.literal('check'), target: zTargetDescriptor, checked: z.boolean() }),
  z.object({ kind: z.literal('press'), keys: z.string(), target: zTargetDescriptor.optional() }),
  z.object({ kind: z.literal('answer_dialog'), accept: z.boolean(), text: z.string().optional() }),
  z.object({ kind: z.literal('wait_for'), assertion: zAssertion }),
  z.object({ kind: z.literal('extract'), outputs: z.array(z.string()).min(1) }),
  /** Deliberate stop for a human. Used for irreversible steps under policy. */
  z.object({ kind: z.literal('escalate'), reason: z.string() }),
]);
export type StepAction = z.infer<typeof zStepAction>;

export const zStep = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** What this step is for, in the recording model's words. Reviewer-facing. */
  intent: z.string(),
  action: zStepAction,
  /** Gate: do not act until this holds. Replaces blind sleeps. */
  waitFor: zAssertion.optional(),
  /** Checkpoint: assert the action actually did what it claimed. */
  expect: zAssertion.optional(),
  timeoutMs: z.number().int().positive().default(10_000),
  /**
   * No `retries` field, deliberately: the only retry that exists is the polling
   * in `waitFor` / `expect`. Re-issuing an action that already reached the
   * server is something this engine must never do.
   */
  risk: zRisk.default('safe'),
  /** Skip silently if its target is absent. For known-optional interstitials. */
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof zStep>;

// ---------------------------------------------------------------------------
// Outcomes and recoveries -- the error taxonomy, as data
// ---------------------------------------------------------------------------

/**
 * A legitimate, expected, non-success answer -- not a bug. Detectors run at
 * every step boundary before any assertion may fail, so "no such member"
 * surfaces as MEMBER_NOT_FOUND rather than "expected element not found".
 */
export const zBusinessOutcome = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  title: z.string(),
  description: z.string().default(''),
  detect: zAssertion,
  /** Where this outcome can legitimately appear. Empty = any step boundary. */
  afterSteps: z.array(z.string()).default([]),
  /** Extra typed data to return with the outcome (e.g. the app's message). */
  data: z.array(zOutputSpec).default([]),
  severity: z.enum(['info', 'warning']).default('info'),
});
export type BusinessOutcome = z.infer<typeof zBusinessOutcome>;

/**
 * A condition replay can fix by itself, within a budget. Exhausting the budget
 * promotes it to a hard failure or an escalation, never to silence.
 */
export const zRecovery = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  detect: zAssertion,
  remedy: z.discriminatedUnion('kind', [
    /** Perform a short fixed action sequence, e.g. click "Continue". */
    z.object({ kind: z.literal('actions'), steps: z.array(zStep).min(1) }),
    /** Wait and re-evaluate. For transient slowness. */
    z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
    /** Re-run the prerequisite capability (e.g. sign-on), then retry the step. */
    z.object({ kind: z.literal('run_capability'), key: z.string(), version: z.string().optional() }),
    /** Hand to a human. The only remedy that is allowed to be open-ended. */
    z.object({ kind: z.literal('escalate'), reason: z.string() }),
  ]),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /** Restrict to particular steps, or leave empty for "any step boundary". */
  atSteps: z.array(z.string()).default([]),
  /**
   * Where to pick up once the remedy worked. The engine first re-checks the
   * interrupted step's own checkpoint, because some remedies complete the step
   * as a side effect and retrying would click a control that is gone.
   *
   *   retry_step          the remedy left us where the step began.
   *   restart_capability  we lost our place entirely -- re-authentication lands
   *                       on the home screen, not mid-inquiry. Honoured only
   *                       when the capability is idempotent; else escalate.
   *   escalate            hand to a human.
   */
  resume: z.enum(['retry_step', 'restart_capability', 'escalate']).default('retry_step'),
});
export type Recovery = z.infer<typeof zRecovery>;

/**
 * A screen we can positively identify as broken, mapped to the failure class
 * it really is. Without this, "CT-500 ORA-01722: invalid number" is reported as
 * `checkpoint_failed: expected text "Request Confirmed"` -- true, and
 * indistinguishable from a locator problem. These are failures, not outcomes:
 * no input avoids them and no recovery clears them.
 */
export const zFailureSignature = z.object({
  code: z.string(),
  title: z.string(),
  detect: zAssertion,
  /** Maps onto the FailureClass union in src/replay/outcomes.ts. */
  failureClass: z.enum(['app_error', 'session_expired', 'policy_denied', 'surface_error', 'timeout']),
  /** Extra detail to lift off the screen for the error report, e.g. a ref number. */
  data: z.array(zOutputSpec).default([]),
});
export type FailureSignature = z.infer<typeof zFailureSignature>;

// ---------------------------------------------------------------------------
// Multi-tenant specialisation
// ---------------------------------------------------------------------------

/**
 * A tenant artifact does not copy the base; it patches it. Overrides are a
 * closed, reviewable set of operations, so a reviewer can see exactly how one
 * institution's build of the vendor product differs -- and so drift in the base
 * propagates to every tenant that has not overridden that specific point.
 */
export const zOverride = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_entrypoint'), urlTemplate: z.string() }),
  z.object({ op: z.literal('replace_step_target'), stepId: z.string(), target: zTargetDescriptor }),
  z.object({ op: z.literal('replace_step_expect'), stepId: z.string(), expect: zAssertion }),
  z.object({ op: z.literal('insert_step'), after: z.string().nullable(), step: zStep }),
  z.object({ op: z.literal('remove_step'), stepId: z.string() }),
  z.object({ op: z.literal('replace_output_extraction'), outputName: z.string(), extract: zExtraction }),
  z.object({ op: z.literal('replace_success_condition'), assertion: zAssertion }),
  z.object({ op: z.literal('add_input'), param: zParamSpec }),
  z.object({ op: z.literal('add_outcome'), outcome: zBusinessOutcome }),
  z.object({ op: z.literal('add_recovery'), recovery: zRecovery }),
  z.object({ op: z.literal('add_failure_signature'), signature: zFailureSignature }),
]);
export type Override = z.infer<typeof zOverride>;

// ---------------------------------------------------------------------------
// Policy, provenance, lifecycle
// ---------------------------------------------------------------------------

export const zCapabilityPolicy = z.object({
  /**
   * Origins and action kinds this capability may use.
   *
   * Enforced at act() time as an INTERSECTION with the deployment's policy: an
   * artifact can only ever narrow what the process already permits, never widen
   * it. That direction matters -- these fields travel inside a file, and a file
   * that could grant itself reach would be an escalation primitive rather than
   * a guardrail. Empty means "no additional restriction beyond the deployment
   * policy", which is what a hand-written specialisation usually wants.
   */
  allowedOrigins: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).default([]),
  /** Highest risk any step in this capability carries. Derived on compile. */
  riskTier: zRisk.default('safe'),
  /** Irreversible capabilities default to requiring a human decision. */
  requiresHumanApproval: z.boolean().default(false),
  maxDurationMs: z.number().int().positive().default(120_000),
  /** Locator strategies below this floor are refused during replay. */
  portabilityFloor: zPortability.default('any_web'),
  /**
   * Is re-running this capability from the beginning harmless? True for reads.
   * False for anything that writes, because a restart would submit twice. Gates
   * the `restart_capability` recovery strategy.
   */
  idempotent: z.boolean().default(false),
});
export type CapabilityPolicy = z.infer<typeof zCapabilityPolicy>;

export const zProvenance = z.object({
  recordedAt: z.string(),
  recordedBy: z.string(),
  discoveryRunId: z.string(),
  goal: z.string(),
  planner: z.object({ provider: z.string(), model: z.string() }),
  /** Digest only. The raw transcript is evidence, not part of the contract. */
  transcriptDigest: z.string(),
  fixtureNote: z.string().optional(),
});
export type Provenance = z.infer<typeof zProvenance>;

export const zApproval = z.object({
  state: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  note: z.string().optional(),
});

export const zStability = z.object({
  replays: z.number().int().min(0).default(0),
  successes: z.number().int().min(0).default(0),
  businessOutcomes: z.number().int().min(0).default(0),
  failures: z.number().int().min(0).default(0),
  lastReplayAt: z.string().optional(),
  /** Times replay had to fall past the preferred locator strategy. Drift alarm. */
  degradedResolutions: z.number().int().min(0).default(0),
});
export type Stability = z.infer<typeof zStability>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

const zSurfaceKind = z.enum(['web', 'legacy_web', 'desktop_mac', 'desktop_win', 'mock']) satisfies z.ZodType<SurfaceKind>;

export const zCapability = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  /** Stable, human-meaningful name an agent calls it by. */
  key: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/, 'expected dotted.kebab key, e.g. member.read-savings-balance'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string(),
  description: z.string(),

  app: z.object({
    /** Vendor product identity, shared across every tenant running it. */
    profile: z.string(),
    productVersion: z.string().optional(),
    surface: zSurfaceKind,
    /** May contain {{inputs.*}} and {{env.baseUrl}}. */
    entrypointTemplate: z.string(),
  }),

  tenant: z.object({
    id: z.string(),
    /** Present on a tenant specialisation; absent on a base capability. */
    extends: z.object({ key: z.string(), version: z.string() }).optional(),
    overrides: z.array(zOverride).default([]),
  }),

  inputs: z.array(zParamSpec).default([]),
  outputs: z.array(zOutputSpec).default([]),

  preconditions: z.array(zAssertion).default([]),
  /**
   * Empty only on a tenant specialisation, which contributes overrides rather
   * than steps and takes the base capability's list at materialisation. A base
   * with no steps is a defect, which the refinement below rejects.
   */
  steps: z.array(zStep),
  successCondition: zAssertion,

  outcomes: z.array(zBusinessOutcome).default([]),
  recoveries: z.array(zRecovery).default([]),
  failureSignatures: z.array(zFailureSignature).default([]),

  policy: zCapabilityPolicy,
  provenance: zProvenance,
  approval: zApproval.default({ state: 'draft' }),
  stability: zStability.default({}),
}).superRefine((c, ctx) => {
  if (!c.tenant?.extends && c.steps.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'a base capability must declare at least one step' });
  }
});

export type Capability = z.infer<typeof zCapability>;

export function parseCapability(raw: unknown): Capability {
  return zCapability.parse(raw);
}

/** Filename convention: one file per (key, version). */
export function capabilityFileName(c: Pick<Capability, 'key' | 'version'>): string {
  return `${c.key}@${c.version}.json`;
}
