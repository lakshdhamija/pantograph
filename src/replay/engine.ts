/**
 * Deterministic replay -- the production execution path.
 *
 * No model is consulted for any decision. Everything is driven by the artifact:
 * which control to touch, how long to wait, what proves the step worked, which
 * non-happy states are legitimate answers, and what it may fix by itself.
 *
 * TRIAGE PRECEDENCE. When a checkpoint does not hold, the engine does not fail
 * immediately -- it works down a fixed ladder from "nothing can be read yet"
 * (a modal) through "every reading is meaningless" (a lost session) and "this is
 * an answer, not a fault" (a business outcome) to a hard failure carrying the
 * step, the expectation and the screen. The rungs are numbered (1)-(6) inline in
 * `triage` below, which is the only place they are stated, so the code and the
 * explanation cannot disagree.
 *
 * Outcomes outrank recoveries because they are the more specific signal: a
 * recovery is a guess that retrying helps, and retrying past "no such member"
 * never does.
 */

import type { Capability, Recovery, Step } from '../artifact/schema.ts';
import type { GuardedSurface } from '../surface/guarded.ts';
import { actionFingerprint } from '../surface/guarded.ts';
import type { Recorder } from '../evidence/recorder.ts';
import type { EscalationBroker, InterventionReason } from '../escalation/broker.ts';
import type { Action, Observation, TargetDescriptor } from '../surface/types.ts';
import { plannerCalls } from '../util/plannerCalls.ts';
import { describeTarget, targetOf } from '../surface/types.ts';
import { profileFor } from '../artifact/profiles.ts';
import { describeAssertion, evaluateAssertion, waitForAssertion } from './assert.ts';
import { extractOutput } from './extract.ts';
import { renderTemplate, TemplateError, validateInputs, type TemplateScope } from './params.ts';
import type { EvidenceRef, FailureClass, ReplayOutcome, ReplayResult, StepTrace } from './outcomes.ts';
import { RETRYABLE } from './outcomes.ts';
import { maskBySensitivity } from '../evidence/redact.ts';
import { join } from 'node:path';

export type SubReplay = (key: string, version: string | undefined, inputs: Record<string, unknown>) => Promise<ReplayResult>;

export type ReplayOptions = {
  readonly capability: Capability;
  readonly inputs: Record<string, unknown>;
  readonly surface: GuardedSurface;
  readonly recorder: Recorder;
  readonly broker: EscalationBroker;
  readonly env: Record<string, string>;
  /** Used by `run_capability` recoveries (typically re-authentication). */
  readonly subReplay?: SubReplay;
  /** Overall budget. Defaults to the capability's own policy. */
  readonly maxDurationMs?: number;
};

/**
 * Replay a capability. Wraps the engine so every result carries the number of
 * provider requests made while it ran -- which is 0, and is now checkable per
 * run rather than only per repository. See src/util/plannerCalls.ts.
 */
export async function replayCapability(opts: ReplayOptions): Promise<ReplayResult> {
  const before = plannerCalls();
  const result = await runReplay(opts);
  return { ...result, plannerCalls: plannerCalls() - before };
}

async function runReplay(opts: ReplayOptions): Promise<ReplayOutcome> {
  const { capability: cap, surface, recorder, broker, env } = opts;
  const startedAt = Date.now();
  const budgetMs = opts.maxDurationMs ?? cap.policy.maxDurationMs;
  const traces: StepTrace[] = [];
  const outputs: Record<string, unknown> = {};
  const recoveriesTried: string[] = [];
  const recoveryBudget = new Map<string, number>();
  /**
   * Wall-clock time spent parked waiting for a human, excluded from the run
   * budget. The budget bounds how long the automation may flail; a person
   * deliberating is not flailing. Counting their thinking time meant an operator
   * who took three minutes got their approval honoured, the write performed, and
   * the run then reported `run_timeout, retryable: true` -- for a capability
   * that must never be re-run.
   */
  let parkedMs = 0;
  /** One restart is a recovered session; a second is a loop. */
  const MAX_RESTARTS = 1;
  let restarts = 0;
  let degradedResolutions = 0;

  const evidence = (): EvidenceRef => ({
    runId: recorder.runId,
    dir: recorder.dir,
    eventsFile: join(recorder.dir, 'events.jsonl'),
    blobs: recorder.blobs(),
  });

  const fail = (
    cls: FailureClass,
    expected: string,
    observed: string,
    extra: { step?: Step; index?: number; detail?: string } = {},
  ): ReplayOutcome => ({
    status: 'failed',
    capability: `${cap.key}@${cap.version}`,
    failure: {
      class: cls,
      retryable: RETRYABLE[cls],
      stepId: extra.step?.id,
      stepIntent: extra.step?.intent,
      stepIndex: extra.index,
      expected,
      observed,
      detail: extra.detail,
      recoveriesTried: [...recoveriesTried],
    },
    steps: traces,
    durationMs: Date.now() - startedAt,
    evidence: evidence(),
  });

  // -- 1. Validate the caller's inputs before touching anything -------------
  const validated = validateInputs(cap.inputs, opts.inputs);
  if (!validated.ok) {
    recorder.emit({ type: 'note', message: 'input validation failed', data: validated.issues });
    return fail(
      'input_invalid',
      `inputs matching the declared contract (${cap.inputs.map((i) => `${i.name}: ${i.type}${i.required ? '' : '?'}`).join(', ')})`,
      validated.issues.map((i) => `${i.param}: ${i.problem}`).join('; '),
    );
  }

  // Bound once: control-flow narrowing of `validated` does not survive into the
  // nested helpers below.
  const inputValues = validated.values;

  // Any value the caller marked sensitive is registered with the redactor
  // before a single byte of evidence is written.
  for (const spec of cap.inputs) {
    if (spec.sensitivity !== 'public') recorder.redactor.addLiteral(String(inputValues[spec.name] ?? ''));
  }
  recorder.emit({
    type: 'run_started',
    mode: 'replay',
    capability: `${cap.key}@${cap.version}`,
    inputs: Object.fromEntries(
      cap.inputs.map((s) => [s.name, maskBySensitivity(inputValues[s.name], s.sensitivity)]),
    ),
  });

  // A capability that declares itself surface-portable must not act through a
  // DOM path, so the floor binds the live surface for the whole run, not just
  // the assertions that happen to pass it.
  surface.setPortabilityFloor(cap.policy.portabilityFloor);
  surface.setCapabilityScope({ allowedOrigins: cap.policy.allowedOrigins, allowedActions: cap.policy.allowedActions });
  surface.setRiskPatterns(profileFor(cap.app.profile)?.riskPatterns);

  const scope = { inputs: inputValues, env, outputs };

  // -- 2. Entry point -------------------------------------------------------
  let entrypoint: string;
  try {
    entrypoint = renderTemplate(cap.app.entrypointTemplate, scope);
  } catch (e) {
    return fail('capability_invalid', 'a resolvable entrypoint template', e instanceof TemplateError ? e.message : String(e));
  }
  const nav = await surface.withContext({ intent: 'open the capability entry point' }).act({ kind: 'navigate', url: entrypoint });
  if (!nav.ok) {
    const f = nav.failure;
    const isPolicy = f && 'rule' in f;
    return fail(
      isPolicy ? 'policy_denied' : 'surface_error',
      `navigation to ${entrypoint}`,
      f && 'message' in f ? f.message : 'navigation failed',
    );
  }

  // -- 3. Preconditions -----------------------------------------------------
  for (const pre of cap.preconditions) {
    const r = await waitForAssertion(surface, pre, 5_000, { portabilityFloor: cap.policy.portabilityFloor });
    recorder.emit({ type: 'assertion', label: 'precondition', assertion: pre, passed: r.passed, detail: r.detail });
    if (!r.passed) {
      await captureFailureEvidence(surface, recorder, 'precondition');
      return fail('checkpoint_failed', describeAssertion(pre), r.detail);
    }
  }

  // -- 4. Steps -------------------------------------------------------------
  let index = 0;
  let escalationInfo: { id: string; reason: string; decision: string; note?: string; humanActions: number } | undefined;

  while (index < cap.steps.length) {
    const activeMs = Date.now() - startedAt - parkedMs;
    if (activeMs > budgetMs) {
      await captureFailureEvidence(surface, recorder, 'run-timeout');
      return fail(
        'run_timeout',
        `the whole capability to finish within ${budgetMs}ms of automation time`,
        `still on step ${index + 1} after ${activeMs}ms of automation time` +
          (parkedMs ? ` (plus ${parkedMs}ms parked awaiting a human, which is not counted)` : ''),
        { step: cap.steps[index], index },
      );
    }

    const step = cap.steps[index]!;
    const stepStarted = Date.now();
    recorder.emit({ type: 'step_started', stepId: step.id, intent: step.intent, index, total: cap.steps.length });

    const outcome = await runStep(step, index);

    if (outcome.kind === 'advance') {
      traces.push({
        stepId: step.id,
        intent: step.intent,
        index,
        status: outcome.status,
        durationMs: Date.now() - stepStarted,
        strategyIndex: outcome.strategyIndex,
        strategyKind: outcome.strategyKind,
        degraded: outcome.degraded,
        recoveriesApplied: outcome.recoveriesApplied,
        detail: outcome.detail,
      });
      if (outcome.degraded) degradedResolutions++;
      index += 1;
      continue;
    }
    if (outcome.kind === 'retry') {
      traces.push({ stepId: step.id, intent: step.intent, index, status: 'recovered', durationMs: Date.now() - stepStarted, recoveriesApplied: outcome.recoveriesApplied, detail: outcome.detail });
      continue; // same index
    }
    if (outcome.kind === 'restart') {
      traces.push({ stepId: step.id, intent: step.intent, index, status: 'recovered', durationMs: Date.now() - stepStarted, recoveriesApplied: outcome.recoveriesApplied, detail: outcome.detail });
      const again = await surface.withContext({ intent: 'restarting the capability after a session recovery' }).act({ kind: 'navigate', url: entrypoint });
      if (!again.ok) {
        return fail('surface_error', `navigation back to ${entrypoint} to restart`, again.failure && 'message' in again.failure ? again.failure.message : 'navigation failed', { step, index });
      }
      // Outputs read before the interruption are discarded: they were read from
      // a session that is no longer the one we are in.
      for (const k of Object.keys(outputs)) delete outputs[k];
      index = 0;
      continue;
    }
    if (outcome.kind === 'business_outcome') {
      return {
        status: 'business_outcome',
        capability: `${cap.key}@${cap.version}`,
        outcome: outcome.outcome,
        atStep: step.id,
        steps: traces,
        durationMs: Date.now() - startedAt,
        evidence: evidence(),
      };
    }
    if (outcome.kind === 'escalated') {
      escalationInfo = outcome.intervention;
      if (outcome.terminal) {
        return {
          status: 'escalated',
          capability: `${cap.key}@${cap.version}`,
          intervention: outcome.intervention,
          steps: traces,
          durationMs: Date.now() - startedAt,
          evidence: evidence(),
        };
      }
      traces.push({ stepId: step.id, intent: step.intent, index, status: 'escalated', durationMs: Date.now() - stepStarted, detail: `human decision: ${outcome.intervention.decision}` });
      index += outcome.advance;
      continue;
    }
    return outcome.result; // hard failure
  }

  // -- 5. Success condition -------------------------------------------------
  const success = await waitForAssertion(surface, cap.successCondition, 8_000, { portabilityFloor: cap.policy.portabilityFloor, abortWhen: definitiveAnswer('final') });
  recorder.emit({ type: 'assertion', label: 'successCondition', assertion: cap.successCondition, passed: success.passed, detail: success.detail });
  if (!success.passed) {
    // Even at the very end, a declared business outcome beats a bare failure.
    const triaged = triageOutcomes(success.observation, 'final');
    if (triaged) {
      const data = collectOutcomeData(success.observation, triaged);
      recorder.emit({ type: 'detector_fired', kind: 'business_outcome', id: triaged.code, detail: 'matched at success condition' });
      return {
        status: 'business_outcome',
        capability: `${cap.key}@${cap.version}`,
        outcome: { code: triaged.code, title: triaged.title, severity: triaged.severity, data },
        atStep: 'successCondition',
        steps: traces,
        durationMs: Date.now() - startedAt,
        evidence: evidence(),
      };
    }
    // A declared failure signature outranks a bare checkpoint failure here for
    // the same reason it does mid-flow: a CT-500 reported as "expected text not
    // found" is true, useless, and throws away the core's own reference number.
    const signature = cap.failureSignatures.find(
      (f) => evaluateAssertion(success.observation, f.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
    );
    if (signature) {
      const detail = Object.entries(collectOutcomeData(success.observation, signature))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      recorder.emit({ type: 'detector_fired', kind: 'failure_signature', id: signature.code, detail: signature.title });
      await captureFailureEvidence(surface, recorder, `success-condition-${signature.code.toLowerCase()}`);
      return fail(signature.failureClass, describeAssertion(cap.successCondition), `${signature.title} (${signature.code})${detail ? ` ${detail}` : ''}`, {
        detail: `matched declared failure signature "${signature.code}"`,
      });
    }
    await captureFailureEvidence(surface, recorder, 'success-condition');
    return fail('checkpoint_failed', describeAssertion(cap.successCondition), success.detail, { detail: `waited ${success.waitedMs}ms over ${success.polls} polls` });
  }

  // -- 6. Outputs -----------------------------------------------------------
  const finalObs = success.observation;
  for (const spec of cap.outputs) {
    const r = extractOutput(finalObs, spec, cap.policy.portabilityFloor);
    if (!r.ok) {
      await captureFailureEvidence(surface, recorder, 'extraction');
      return fail('extraction_failed', `output "${spec.name}" (${spec.type}) from ${describeTarget(spec.extract.target)}`, r.error);
    }
    if (r.degraded) degradedResolutions++;
    outputs[spec.name] = r.value;
    recorder.emit({
      type: 'extraction',
      output: spec.name,
      rawLength: r.raw.length,
      value: maskBySensitivity(r.value, spec.sensitivity),
      sensitivity: spec.sensitivity,
    });
  }

  if (escalationInfo) {
    return {
      status: 'escalated',
      capability: `${cap.key}@${cap.version}`,
      intervention: escalationInfo,
      steps: traces,
      durationMs: Date.now() - startedAt,
      evidence: evidence(),
      outputs,
    };
  }

  return {
    status: 'success',
    capability: `${cap.key}@${cap.version}`,
    outputs,
    steps: traces,
    durationMs: Date.now() - startedAt,
    evidence: evidence(),
    degradedResolutions,
  };

  // =========================================================================

  type StepOutcome =
    | { kind: 'advance'; status: 'ok' | 'skipped'; strategyIndex?: number; strategyKind?: string; degraded?: boolean; recoveriesApplied?: string[]; detail?: string }
    | { kind: 'retry'; recoveriesApplied: string[]; detail: string }
    | { kind: 'restart'; recoveriesApplied: string[]; detail: string }
    | { kind: 'business_outcome'; outcome: { code: string; title: string; severity: string; data: Record<string, unknown> } }
    | { kind: 'escalated'; intervention: { id: string; reason: string; decision: string; note?: string; humanActions: number }; terminal: boolean; advance: number }
    | { kind: 'fail'; result: ReplayOutcome };

  async function runStep(step: Step, i: number): Promise<StepOutcome> {
    const guarded = surface.withContext({ intent: step.intent, declaredRisk: step.risk });

    // 4a. Gate.
    if (step.waitFor) {
      const gate = await waitForAssertion(surface, step.waitFor, step.timeoutMs, { portabilityFloor: cap.policy.portabilityFloor, abortWhen: definitiveAnswer(step.id) });
      recorder.emit({ type: 'assertion', label: `${step.id}.waitFor`, assertion: step.waitFor, passed: gate.passed, detail: gate.detail });
      if (!gate.passed) {
        if (step.optional) return { kind: 'advance', status: 'skipped', detail: 'optional step: gate never held' };
        return triage(step, i, gate.observation, `gate ${describeAssertion(step.waitFor)}`, gate.detail, 'timeout');
      }
    }

    // 4b. Human-in-the-loop step declared by the capability itself.
    if (step.action.kind === 'escalate') {
      const obs = await surface.observe();
      const res = await escalate('declared_step', step.action.reason, step, i, obs);
      if (res.decision === 'abort' || res.decision === 'reject') {
        return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
      }
      return { kind: 'escalated', intervention: res, terminal: false, advance: res.decision === 'retry_step' ? 0 : 1 };
    }

    // 4c. Extraction-only step: read declared outputs mid-flow.
    if (step.action.kind === 'extract') {
      const obs = await surface.observe();
      for (const name of step.action.outputs) {
        const spec = cap.outputs.find((o) => o.name === name);
        if (!spec) return { kind: 'fail', result: fail('capability_invalid', `output "${name}" to be declared`, 'it is referenced by an extract step but not declared in outputs', { step, index: i }) };
        const r = extractOutput(obs, spec, cap.policy.portabilityFloor);
        if (!r.ok) return triage(step, i, obs, `output "${name}"`, r.error, 'extraction_failed');
        outputs[spec.name] = r.value;
        recorder.emit({ type: 'extraction', output: spec.name, rawLength: r.raw.length, value: maskBySensitivity(r.value, spec.sensitivity), sensitivity: spec.sensitivity });
      }
      return { kind: 'advance', status: 'ok' };
    }

    // 4d. wait_for is a pure assertion step.
    if (step.action.kind === 'wait_for') {
      const w = await waitForAssertion(surface, step.action.assertion, step.timeoutMs, { portabilityFloor: cap.policy.portabilityFloor, abortWhen: definitiveAnswer(step.id) });
      recorder.emit({ type: 'assertion', label: `${step.id}.wait_for`, assertion: step.action.assertion, passed: w.passed, detail: w.detail });
      if (w.passed) return { kind: 'advance', status: 'ok' };
      if (step.optional) return { kind: 'advance', status: 'skipped', detail: 'optional wait never satisfied' };
      return triage(step, i, w.observation, describeAssertion(step.action.assertion), w.detail, 'timeout');
    }

    // 4e. Real actions.
    let action: Action;
    try {
      action = toAction(step, scope);
    } catch (e) {
      return { kind: 'fail', result: fail('capability_invalid', 'a resolvable action template', e instanceof Error ? e.message : String(e), { step, index: i }) };
    }

    // An optional step whose target is not on screen is skipped, not failed.
    const actionTarget = targetOf(action);
    if (step.optional && actionTarget) {
      const probe = await surface.observe();
      const present = evaluateAssertion(probe, { kind: 'element_present', target: actionTarget }, { portabilityFloor: cap.policy.portabilityFloor });
      if (!present.passed) return { kind: 'advance', status: 'skipped', detail: `optional: ${present.detail}` };
    }

    let result = await guarded.act(action);

    // Policy asked for a human. That is an escalation, not a failure.
    if (!result.ok && result.failure?.reason === 'policy_approval_required') {
      const obs = await surface.observe().catch(() => undefined);
      const res = await escalate('approval_required', result.failure.message, step, i, obs, action);
      if (res.decision === 'approve') {
        guarded.grantApproval({ fingerprint: actionFingerprint(action, step.intent), interventionId: res.id, by: res.by });
        result = await guarded.act(action);
      } else if (res.decision === 'skip_step') {
        return { kind: 'advance', status: 'skipped', detail: `human skipped: ${res.note ?? ''}` };
      } else if (res.decision === 'resume') {
        // The human performed the action themselves during the handoff.
        return { kind: 'escalated', intervention: res, terminal: false, advance: 1 };
      } else {
        return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
      }
    }

    if (!result.ok) {
      const f = result.failure;
      const obs = await surface.observe().catch(() => undefined);
      if (f?.reason === 'policy_denied') {
        await captureFailureEvidence(surface, recorder, `${step.id}-policy`);
        return { kind: 'fail', result: fail('policy_denied', `an action permitted by policy rule set`, f.message, { step, index: i, detail: f.rule }) };
      }
      if (f?.reason === 'control_denied') {
        return { kind: 'fail', result: fail('surface_error', 'automation to hold the control lease', f.message, { step, index: i }) };
      }
      const cls: FailureClass =
        f && 'reason' in f && f.reason === 'ambiguous' ? 'ambiguous_target' : f && 'reason' in f && f.reason === 'no_match' ? 'target_not_found' : 'surface_error';
      if (!obs) {
        await captureFailureEvidence(surface, recorder, `${step.id}-noobs`);
        return { kind: 'fail', result: fail(cls, describeStepTarget(step), f && 'message' in f ? f.message : 'action failed', { step, index: i }) };
      }
      return triage(step, i, obs, describeStepTarget(step), f && 'message' in f ? f.message : 'action failed', cls);
    }

    // 4f. Checkpoint.
    if (step.expect) {
      const check = await waitForAssertion(surface, step.expect, step.timeoutMs, { portabilityFloor: cap.policy.portabilityFloor, abortWhen: definitiveAnswer(step.id) });
      recorder.emit({ type: 'assertion', label: `${step.id}.expect`, assertion: step.expect, passed: check.passed, detail: check.detail });
      if (!check.passed) {
        return triage(step, i, check.observation, describeAssertion(step.expect), check.detail, 'checkpoint_failed');
      }
    }

    return {
      kind: 'advance',
      status: 'ok',
      strategyIndex: result.resolved?.strategyIndex,
      strategyKind: result.resolved?.strategyKind,
      degraded: result.resolved?.degraded,
    };
  }

  /** The precedence ladder documented at the top of this file. */
  async function triage(
    step: Step,
    i: number,
    obs: Observation,
    expected: string,
    observed: string,
    defaultClass: FailureClass,
  ): Promise<StepOutcome> {
    // (1) A modal dialog blocks everything.
    if (obs.blockingDialog) {
      const declared = cap.recoveries.find(
        (r) => appliesAt(r, step.id) && evaluateAssertion(obs, r.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
      );
      if (!declared) {
        await captureFailureEvidence(surface, recorder, `${step.id}-dialog`);
        return {
          kind: 'fail',
          result: fail('dialog_unhandled', expected, `an undeclared ${obs.blockingDialog.kind} dialog is blocking the surface: "${obs.blockingDialog.message}"`, { step, index: i }),
        };
      }
      // Nothing below this rung can read a screen the modal is covering, so the
      // declared recovery runs here rather than after four more detectors have
      // matched on whatever is visible around the dialog.
      recorder.emit({ type: 'detector_fired', kind: 'recovery', id: declared.id, detail: `dialog: ${declared.title}` });
      return applyRecovery(declared, step, i, expected, observed);
    }

    // (2) Session/auth first: a login page does not contain your member.
    const authRecovery = cap.recoveries.find(
      (r) => r.remedy.kind === 'run_capability' && appliesAt(r, step.id) && evaluateAssertion(obs, r.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
    );
    if (authRecovery) {
      recorder.emit({ type: 'detector_fired', kind: 'session_invalid', id: authRecovery.id, detail: authRecovery.title });
      return applyRecovery(authRecovery, step, i, expected, observed);
    }

    // (3) A screen we can positively identify as broken. Outranks a business
    // outcome: an error page is not a result, so a detector that matches on one
    // is matching noise.
    const signature = cap.failureSignatures.find(
      (f) => evaluateAssertion(obs, f.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
    );
    if (signature) {
      const detail = Object.entries(collectOutcomeData(obs, signature))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      recorder.emit({ type: 'detector_fired', kind: 'failure_signature', id: signature.code, detail: signature.title });
      await captureFailureEvidence(surface, recorder, `${step.id}-${signature.code.toLowerCase()}`);
      return {
        kind: 'fail',
        result: fail(signature.failureClass, expected, `${signature.title} (${signature.code})${detail ? ` ${detail}` : ''}`, {
          step,
          index: i,
          detail: `matched declared failure signature "${signature.code}"`,
        }),
      };
    }

    // (4) A declared business outcome is a legitimate answer. Terminal.
    const outcome = triageOutcomes(obs, step.id);
    if (outcome) {
      recorder.emit({ type: 'detector_fired', kind: 'business_outcome', id: outcome.code, detail: outcome.title });
      return { kind: 'business_outcome', outcome: { code: outcome.code, title: outcome.title, severity: outcome.severity, data: collectOutcomeData(obs, outcome) } };
    }

    // (5) Ordinary recoveries.
    const recovery = cap.recoveries.find(
      (r) => r.remedy.kind !== 'run_capability' && appliesAt(r, step.id) && evaluateAssertion(obs, r.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
    );
    if (recovery) {
      recorder.emit({ type: 'detector_fired', kind: 'recovery', id: recovery.id, detail: recovery.title });
      return applyRecovery(recovery, step, i, expected, observed);
    }

    // (6) Nothing matched. Fail with everything a debugger needs.
    await captureFailureEvidence(surface, recorder, `${step.id}-failed`);
    return {
      kind: 'fail',
      result: fail(defaultClass, expected, observed, {
        step,
        index: i,
        detail: `screen was "${obs.title}" at ${obs.location}; no declared outcome or recovery matched`,
      }),
    };
  }

  /**
   * A screen carrying a definitive answer -- a declared business outcome or a
   * known failure signature -- will not become the state we are waiting for.
   * Passed to every polling wait so the engine stops waiting the moment the
   * application has actually answered.
   */
  function definitiveAnswer(stepId: string) {
    return (obs: Observation): string | undefined => {
      const sig = cap.failureSignatures.find((f) => evaluateAssertion(obs, f.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed);
      if (sig) return `the screen matches failure signature ${sig.code}`;
      const out = triageOutcomes(obs, stepId);
      if (out) return `the screen matches business outcome ${out.code}`;
      return undefined;
    };
  }

  function triageOutcomes(obs: Observation, stepId: string) {
    return cap.outcomes.find(
      (o) =>
        (o.afterSteps.length === 0 || o.afterSteps.includes(stepId)) &&
        evaluateAssertion(obs, o.detect, { portabilityFloor: cap.policy.portabilityFloor }).passed,
    );
  }

  function collectOutcomeData(obs: Observation, outcome: { data: Capability['outputs'] }): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const spec of outcome.data) {
      const r = extractOutput(obs, spec, cap.policy.portabilityFloor);
      data[spec.name] = r.ok ? r.value : null;
    }
    return data;
  }

  function appliesAt(r: Recovery, stepId: string): boolean {
    return r.atSteps.length === 0 || r.atSteps.includes(stepId);
  }

  async function applyRecovery(r: Recovery, step: Step, i: number, expected: string, observed: string): Promise<StepOutcome> {
    const used = recoveryBudget.get(r.id) ?? 0;
    if (used >= r.maxAttempts) {
      recorder.emit({ type: 'recovery_attempt', recoveryId: r.id, attempt: used, maxAttempts: r.maxAttempts, result: 'unresolved', detail: 'budget exhausted' });
      // A recovery that keeps firing is a condition we understand but cannot
      // fix. That is exactly when a human is worth interrupting.
      const obs = await surface.observe().catch(() => undefined);
      const res = await escalate('recovery_exhausted', `recovery "${r.title}" fired ${used} times without clearing the condition`, step, i, obs);
      if (res.decision === 'resume') return { kind: 'escalated', intervention: res, terminal: false, advance: 1 };
      if (res.decision === 'retry_step') return { kind: 'retry', recoveriesApplied: [r.id], detail: 'human asked to retry' };
      if (res.decision === 'skip_step') return { kind: 'advance', status: 'skipped', detail: 'human skipped the step' };
      return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
    }
    recoveryBudget.set(r.id, used + 1);
    recoveriesTried.push(r.id);

    let ok = true;
    let detail = '';
    // Bound so the discriminated union stays narrowed across the awaits below.
    const remedy = r.remedy;
    switch (remedy.kind) {
      case 'wait':
        await new Promise((res) => setTimeout(res, remedy.ms));
        detail = `waited ${remedy.ms}ms`;
        break;
      case 'actions': {
        for (const sub of remedy.steps) {
          const subOutcome = await runRecoveryStep(sub);
          if (!subOutcome.ok) { ok = false; detail = subOutcome.detail; break; }
        }
        if (ok) detail = `applied ${remedy.steps.length} remedy step(s)`;
        break;
      }
      case 'run_capability': {
        if (!opts.subReplay) { ok = false; detail = 'no sub-replay available for run_capability remedy'; break; }
        const sub = await opts.subReplay(remedy.key, remedy.version, inputValues);
        ok = sub.status === 'success';
        detail = `ran ${remedy.key}: ${sub.status}`;
        break;
      }
      case 'escalate': {
        const obs = await surface.observe().catch(() => undefined);
        const res = await escalate('replay_unrecoverable', remedy.reason, step, i, obs);
        if (res.decision === 'resume') return { kind: 'escalated', intervention: res, terminal: false, advance: 1 };
        if (res.decision === 'retry_step') return { kind: 'retry', recoveriesApplied: [r.id], detail: 'human asked to retry' };
        if (res.decision === 'skip_step') return { kind: 'advance', status: 'skipped', detail: 'human skipped the step' };
        return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
      }
    }

    recorder.emit({ type: 'recovery_attempt', recoveryId: r.id, attempt: used + 1, maxAttempts: r.maxAttempts, result: ok ? 'resolved' : 'error', detail });

    if (!ok) {
      await captureFailureEvidence(surface, recorder, `${step.id}-recovery-${r.id}`);
      return { kind: 'fail', result: fail('recovery_exhausted', expected, `${observed}; recovery "${r.id}" could not be applied: ${detail}`, { step, index: i }) };
    }

    // Some remedies complete the interrupted step as a side effect: dismissing
    // an interstitial that covered a page we had already reached. Re-checking
    // the step's own checkpoint first costs one observation and avoids clicking
    // a control that is gone.
    if (step.expect) {
      const settled = await waitForAssertion(surface, step.expect, 2_500, { portabilityFloor: cap.policy.portabilityFloor });
      if (settled.passed) {
        recorder.emit({ type: 'assertion', label: `${step.id}.expect (after ${r.id})`, assertion: step.expect, passed: true, detail: settled.detail });
        return { kind: 'advance', status: 'ok', recoveriesApplied: [r.id], detail: `${detail}; the step's checkpoint held afterwards, so it did not need re-running` };
      }
    }

    switch (r.resume) {
      case 'retry_step':
        return { kind: 'retry', recoveriesApplied: [r.id], detail };

      case 'restart_capability': {
        if (!cap.policy.idempotent) {
          // Refusing to restart a write flow is the whole point. Re-running a
          // sub-account creation from step one would open a second account.
          const obs = await surface.observe().catch(() => undefined);
          const res = await escalate(
            'replay_unrecoverable',
            `recovery "${r.title}" needs the flow to restart from the beginning, but this capability is not idempotent, so restarting could repeat a write. A human must decide.`,
            step,
            i,
            obs,
          );
          if (res.decision === 'retry_step') return { kind: 'retry', recoveriesApplied: [r.id], detail: 'human asked to retry the step' };
          if (res.decision === 'skip_step') return { kind: 'advance', status: 'skipped', detail: 'human skipped the step' };
          if (res.decision === 'resume') return { kind: 'escalated', intervention: res, terminal: false, advance: 1 };
          return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
        }
        if (restarts >= MAX_RESTARTS) {
          await captureFailureEvidence(surface, recorder, `${step.id}-restart-exhausted`);
          return {
            kind: 'fail',
            result: fail('recovery_exhausted', expected, `${observed}; restarted the capability ${restarts} time(s) and still could not get past this step`, { step, index: i }),
          };
        }
        restarts += 1;
        recorder.emit({ type: 'note', message: `restarting the capability after recovery "${r.id}"`, data: { restart: restarts, fromStep: step.id } });
        return { kind: 'restart', recoveriesApplied: [r.id], detail: `${detail}; restarting from the entry point` };
      }

      case 'escalate': {
        const obs = await surface.observe().catch(() => undefined);
        const res = await escalate('recovery_exhausted', `recovery "${r.title}" applied, but this recovery is configured to hand back to a human`, step, i, obs);
        if (res.decision === 'retry_step') return { kind: 'retry', recoveriesApplied: [r.id], detail };
        if (res.decision === 'skip_step') return { kind: 'advance', status: 'skipped', detail: 'human skipped the step' };
        if (res.decision === 'resume') return { kind: 'escalated', intervention: res, terminal: false, advance: 1 };
        return { kind: 'escalated', intervention: res, terminal: true, advance: 0 };
      }
    }
  }

  async function runRecoveryStep(sub: Step): Promise<{ ok: boolean; detail: string }> {
    if (sub.action.kind === 'wait_for') {
      const w = await waitForAssertion(surface, sub.action.assertion, sub.timeoutMs, { portabilityFloor: cap.policy.portabilityFloor });
      return { ok: w.passed, detail: w.detail };
    }
    if (sub.action.kind === 'escalate' || sub.action.kind === 'extract') {
      return { ok: false, detail: `remedy steps may not use "${sub.action.kind}"` };
    }
    let action: Action;
    try {
      action = toAction(sub, scope);
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const r = await surface.withContext({ intent: `recovery: ${sub.intent}`, declaredRisk: sub.risk }).act(action);
    if (!r.ok) return { ok: false, detail: r.failure && 'message' in r.failure ? r.failure.message : 'remedy action failed' };
    if (sub.expect) {
      const c = await waitForAssertion(surface, sub.expect, sub.timeoutMs, { portabilityFloor: cap.policy.portabilityFloor });
      return { ok: c.passed, detail: c.detail };
    }
    return { ok: true, detail: `${sub.action.kind} ok` };
  }

  async function escalate(
    reason: InterventionReason,
    why: string,
    step: Step | undefined,
    i: number | undefined,
    obs: Observation | undefined,
    pendingAction?: Action,
  ) {
    const parkedFrom = Date.now();
    const res = await broker.raise({
      reason,
      why,
      mode: 'replay',
      capability: { key: cap.key, version: cap.version },
      stepId: step?.id,
      stepIntent: step?.intent,
      stepIndex: i,
      stepTotal: cap.steps.length,
      pendingAction,
      observation: obs,
    });
    parkedMs += Date.now() - parkedFrom;
    return { id: res.interventionId, reason, decision: res.decision, note: res.note, humanActions: res.humanActions, by: res.by };
  }
}

function describeStepTarget(step: Step): string {
  const t = 'target' in step.action ? step.action.target : undefined;
  return t ? describeTarget(t) : `action ${step.action.kind}`;
}

/**
 * Render `{{inputs.*}}` inside a descriptor's string matchers -- the compiler
 * puts them there so one capability can address one record per invocation.
 */
export function renderDescriptor(target: TargetDescriptor, scope: TemplateScope): TargetDescriptor {
  const matcher = <T extends { value: string } | undefined>(m: T): T => {
    if (!m) return m;
    const v = renderTemplate(m.value, scope);
    return (v === m.value ? m : { ...m, value: v }) as T;
  };
  return {
    ...target,
    name: matcher(target.name),
    strategies: target.strategies.map((st) => {
      if (st.kind === 'relative') return { ...st, anchor: renderDescriptor(st.anchor, scope) };
      if (st.kind === 'text') return { ...st, text: matcher(st.text) };
      if (st.kind === 'test_id') return { ...st, value: renderTemplate(st.value, scope) };
      return st;
    }),
  };
}

/** Turn a templated step action into a concrete surface action. */
export function toAction(step: Step, scope: TemplateScope): Action {
  const a = step.action;
  switch (a.kind) {
    case 'navigate': return { kind: 'navigate', url: renderTemplate(a.urlTemplate, scope) };
    case 'click': return { kind: 'click', target: renderDescriptor(a.target, scope) };
    case 'fill': return { kind: 'fill', target: renderDescriptor(a.target, scope), value: renderTemplate(a.valueTemplate, scope) };
    case 'select': return { kind: 'select', target: renderDescriptor(a.target, scope), value: renderTemplate(a.valueTemplate, scope) };
    case 'check': return { kind: 'check', target: renderDescriptor(a.target, scope), checked: a.checked };
    case 'press': return a.target ? { kind: 'press', keys: a.keys, target: renderDescriptor(a.target, scope) } : { kind: 'press', keys: a.keys };
    case 'answer_dialog': return { kind: 'answer_dialog', accept: a.accept, text: a.text };
    default: throw new Error(`step "${step.id}" action "${a.kind}" is not a surface action`);
  }
}

/**
 * A screenshot and a full multi-frame HTML snapshot, both redacted, at the
 * moment things went wrong. Frame-by-frame matters: on a frameset the top
 * document's HTML says nothing about the screen the operator saw.
 */
export async function captureFailureEvidence(surface: GuardedSurface, recorder: Recorder, label: string): Promise<void> {
  const shot = await surface.screenshot().catch(() => undefined);
  if (shot) recorder.saveBlob(`${label}.png`, 'screenshot', shot);
  const snap = await surface.snapshot().catch(() => undefined);
  if (snap) recorder.saveBlob(`${label}.html`, 'snapshot', snap);
}
