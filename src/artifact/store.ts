/**
 * Capability storage and the multi-tenant materialisation rule.
 *
 * Artifacts are plain JSON files on disk, one per (key, version). That is a
 * deliberate non-decision: a registry service, signing, and RBAC all belong
 * here eventually, but none of them change the shape of the problem, and
 * building them now would be the "scaling infrastructure" the brief says not to
 * reward. What does matter is `materialize()`.
 *
 * MATERIALISATION. A tenant does not get a copy of a capability; it gets a
 * patch. `member.read-savings-balance@1.0.0` is recorded once against the
 * vendor product, and `granite.member.read-savings-balance@1.0.0` declares
 * `extends` plus a short list of overrides for the two things that institution
 * renamed. Consequences that matter at hundreds of tenants:
 *
 *   - A fix to the base flow reaches every tenant that has not overridden that
 *     specific point, with no re-recording.
 *   - A reviewer can see a tenant's entire deviation from the vendor baseline on
 *     one screen. "How is Granite different?" is a diff, not an archaeology dig.
 *   - Drift is localised. If the base changes a step a tenant has overridden,
 *     that override is now suspect and can be flagged mechanically, rather than
 *     the whole capability being suspect.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityFileName, parseCapability, type Capability, type CapabilityPolicy, type Override, type Step } from './schema.ts';

export class CapabilityStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  save(cap: Capability): string {
    const path = join(this.dir, capabilityFileName(cap));
    writeFileSync(path, JSON.stringify(cap, null, 2) + '\n');
    return path;
  }

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    const out: Capability[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(parseCapability(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))));
      } catch {
        // A malformed file should not take down the catalog. `validate` reports
        // it explicitly for anyone who cares.
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key) || compareVersions(b.version, a.version));
  }

  /** Files that exist but do not parse. Surfaced by `pantograph catalog`. */
  invalid(): Array<{ file: string; error: string }> {
    if (!existsSync(this.dir)) return [];
    const bad: Array<{ file: string; error: string }> = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        parseCapability(JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
      } catch (e) {
        bad.push({ file: f, error: e instanceof Error ? e.message.slice(0, 400) : String(e) });
      }
    }
    return bad;
  }

  load(key: string, version?: string): Capability | undefined {
    const all = this.list().filter((c) => c.key === key);
    if (version) return all.find((c) => c.version === version);
    return all[0];
  }

  /** Load and resolve inheritance in one step. Throws on a broken base ref. */
  materialize(key: string, version?: string): Capability {
    const cap = this.load(key, version);
    if (!cap) throw new Error(`no capability "${key}"${version ? `@${version}` : ''} in ${this.dir}`);
    return materialize(cap, this);
  }
}

export function materialize(cap: Capability, store: CapabilityStore, seen = new Set<string>()): Capability {
  if (!cap.tenant.extends) return cap;

  const ref = `${cap.tenant.extends.key}@${cap.tenant.extends.version}`;
  if (seen.has(ref)) throw new Error(`circular capability inheritance at ${ref}`);
  seen.add(ref);

  const baseRaw = store.load(cap.tenant.extends.key, cap.tenant.extends.version);
  if (!baseRaw) throw new Error(`capability "${cap.key}" extends ${ref}, which is not in the store`);
  const base = materialize(baseRaw, store, seen);

  let steps: Step[] = base.steps.map((s) => ({ ...s }));
  let outputs = base.outputs.map((o) => ({ ...o }));
  let inputs = base.inputs.map((i) => ({ ...i }));
  let successCondition = base.successCondition;
  let entrypointTemplate = base.app.entrypointTemplate;
  const outcomes = [...base.outcomes];
  const recoveries = [...base.recoveries];
  const failureSignatures = [...base.failureSignatures];

  for (const ov of cap.tenant.overrides as Override[]) {
    switch (ov.op) {
      case 'set_entrypoint':
        entrypointTemplate = ov.urlTemplate;
        break;
      case 'replace_step_target': {
        const i = requireStep(steps, ov.stepId, cap.key);
        const step = steps[i]!;
        if (!('target' in step.action)) throw new Error(`override replace_step_target: step "${ov.stepId}" has no target`);
        steps[i] = { ...step, action: { ...step.action, target: ov.target } as Step['action'] };
        break;
      }
      case 'replace_step_expect': {
        const i = requireStep(steps, ov.stepId, cap.key);
        steps[i] = { ...steps[i]!, expect: ov.expect };
        break;
      }
      case 'insert_step': {
        if (ov.after === null) steps = [ov.step, ...steps];
        else {
          const i = requireStep(steps, ov.after, cap.key);
          steps = [...steps.slice(0, i + 1), ov.step, ...steps.slice(i + 1)];
        }
        break;
      }
      case 'remove_step':
        steps = steps.filter((s) => s.id !== ov.stepId);
        break;
      case 'replace_output_extraction': {
        const i = outputs.findIndex((o) => o.name === ov.outputName);
        if (i < 0) throw new Error(`override replace_output_extraction: "${cap.key}" has no output "${ov.outputName}"`);
        outputs[i] = { ...outputs[i]!, extract: ov.extract };
        break;
      }
      case 'replace_success_condition':
        successCondition = ov.assertion;
        break;
      case 'add_input':
        inputs = [...inputs.filter((p) => p.name !== ov.param.name), ov.param];
        break;
      case 'add_outcome':
        outcomes.push(ov.outcome);
        break;
      case 'add_recovery':
        recoveries.push(ov.recovery);
        break;
      case 'add_failure_signature':
        failureSignatures.push(ov.signature);
        break;
    }
  }

  return {
    ...base,
    id: cap.id,
    key: cap.key,
    version: cap.version,
    title: cap.title,
    description: cap.description,
    app: { ...base.app, ...cap.app, entrypointTemplate },
    tenant: cap.tenant,
    inputs,
    outputs,
    steps,
    successCondition,
    outcomes,
    recoveries,
    failureSignatures,
    policy: combinePolicy(base.policy, cap.policy),
    provenance: cap.provenance,
    approval: cap.approval,
    stability: cap.stability,
  };
}

/**
 * Combine a base capability's policy with a specialisation's, CONSERVATIVELY.
 *
 * The obvious `{...base.policy, ...spec.policy}` is wrong, and dangerously so:
 * every field of `zCapabilityPolicy` carries a zod `.default()`, so after
 * parsing they are all populated and the spread is a wholesale replacement, not
 * a merge. A tenant that extends a write capability and writes `"policy": {}`
 * inherits all twelve steps including the irreversible submit -- with
 * `riskTier: "safe"`, `requiresHumanApproval: false`, and the portability floor
 * loosened. The strongest safety declarations in the artifact were the ones
 * inheritance was most likely to erase.
 *
 * So each field combines in whichever direction is safer, and a specialisation
 * can tighten but never loosen. The two allowlists are unions rather than
 * intersections because both describe the same materialised flow (an override
 * may insert a step needing another action kind), and they are separately
 * intersected with the deployment policy at act() time, which is where the
 * actual guarantee lives.
 */
function combinePolicy(base: CapabilityPolicy, spec: CapabilityPolicy): CapabilityPolicy {
  const RISK = { safe: 0, elevated: 1, irreversible: 2 } as const;
  const FLOOR = { pixel: 0, this_dom: 1, any_web: 2, any_surface: 3 } as const;
  return {
    allowedOrigins: [...new Set([...base.allowedOrigins, ...spec.allowedOrigins])],
    allowedActions: [...new Set([...base.allowedActions, ...spec.allowedActions])],
    riskTier: RISK[spec.riskTier] > RISK[base.riskTier] ? spec.riskTier : base.riskTier,
    requiresHumanApproval: base.requiresHumanApproval || spec.requiresHumanApproval,
    idempotent: base.idempotent && spec.idempotent,
    maxDurationMs: Math.min(base.maxDurationMs, spec.maxDurationMs),
    portabilityFloor: FLOOR[spec.portabilityFloor] > FLOOR[base.portabilityFloor] ? spec.portabilityFloor : base.portabilityFloor,
  };
}

function requireStep(steps: readonly Step[], id: string, capKey: string): number {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`capability "${capKey}" overrides step "${id}", which does not exist in its base`);
  return i;
}

/**
 * Lint a tenant specialisation against its base.
 *
 * The failure this exists to catch, learned the hard way: an override replaces a
 * step's target, but an ASSERTION elsewhere in the capability still points at
 * the control the base recorded. The specialisation looks complete, materialises
 * without complaint, and then dies mid-run on a checkpoint nobody thought to
 * update. Since the compiler derives each step's checkpoint from the NEXT step's
 * control, renaming one control routinely strands the assertion on the step
 * before it.
 *
 * Reported at review time rather than run time, because "your override set is
 * incomplete" is a code-review finding, not a production incident.
 */
export function lintSpecialisation(cap: Capability, store: CapabilityStore): string[] {
  if (!cap.tenant.extends) return [];
  const base = store.load(cap.tenant.extends.key, cap.tenant.extends.version);
  if (!base) return [`extends ${cap.tenant.extends.key}@${cap.tenant.extends.version}, which is not in the store`];

  const problems: string[] = [];
  const replaced = cap.tenant.overrides.filter((o) => o.op === 'replace_step_target');

  for (const ov of replaced) {
    const baseStep = base.steps.find((s) => s.id === ov.stepId);
    if (!baseStep) {
      problems.push(`override targets step "${ov.stepId}", which does not exist in the base`);
      continue;
    }
    const oldTarget = 'target' in baseStep.action ? baseStep.action.target : undefined;
    if (!oldTarget) continue;
    const oldJson = JSON.stringify(stripObserved(oldTarget));

    const materialised = materialize(cap, store);
    for (const step of materialised.steps) {
      for (const [label, assertion] of [['expect', step.expect], ['waitFor', step.waitFor]] as const) {
        if (!assertion) continue;
        if (assertionMentions(assertion, oldJson)) {
          problems.push(
            `step "${step.id}" still asserts (${label}) against the control that the override for "${ov.stepId}" replaced. ` +
              `Add a replace_step_expect override for "${step.id}", or this specialisation will fail mid-run.`,
          );
        }
      }
    }
  }
  return [...new Set(problems)];
}

function stripObserved(t: unknown): unknown {
  if (Array.isArray(t)) return t.map(stripObserved);
  if (t && typeof t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
      if (k === 'observedAt' || k === 'rationale') continue;
      out[k] = stripObserved(v);
    }
    return out;
  }
  return t;
}

function assertionMentions(a: unknown, targetJson: string): boolean {
  if (Array.isArray(a)) return a.some((x) => assertionMentions(x, targetJson));
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    if (o['target'] && JSON.stringify(stripObserved(o['target'])) === targetJson) return true;
    return Object.values(o).some((v) => assertionMentions(v, targetJson));
  }
  return false;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

