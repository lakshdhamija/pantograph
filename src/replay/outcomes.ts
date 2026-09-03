/**
 * The replay result contract.
 *
 * Conflating an expected business outcome with a failure is the classic error
 * here, so the return type makes them different shapes rather than different
 * values of a `success` boolean. A caller that
 * pattern-matches on `status` cannot accidentally treat "no such member" as an
 * outage, and cannot silently swallow a real breakage as "no result".
 *
 * Four statuses, and each one answers a different question for the caller:
 *
 *   success           the flow completed; here are your typed outputs
 *   business_outcome  the app gave a legitimate non-happy answer; here is its
 *                     code and any data attached to it. Retrying will not help.
 *   escalated         a human was needed. Includes what they decided.
 *   failed            something is wrong with the automation, the app, or the
 *                     environment. Includes enough to debug without a repro.
 */

import type { BusinessOutcome, Capability, Risk } from '../artifact/schema.ts';

export type FailureClass =
  /** Caller passed inputs that violate the declared parameter contract. */
  | 'input_invalid'
  /** The artifact itself is unusable here (portability floor, bad reference). */
  | 'capability_invalid'
  /** A target could not be found at all. */
  | 'target_not_found'
  /** A target matched several nodes and no strategy could separate them. */
  | 'ambiguous_target'
  /** The step's post-condition never held. The action did not do what it claimed. */
  | 'checkpoint_failed'
  /** A gate or checkpoint ran out of time. Distinct from checkpoint_failed:
   *  this is "still waiting", not "wrong state". */
  | 'timeout'
  /** The guardrail refused. Never retried. */
  | 'policy_denied'
  /** Auth was lost and could not be re-established within budget. */
  | 'session_expired'
  /** The app returned its own error page. */
  | 'app_error'
  /** A modal appeared that nothing declared and nothing could clear. */
  | 'dialog_unhandled'
  /** A declared recovery matched but ran out of attempts. */
  | 'recovery_exhausted'
  /** The browser/OS layer failed. Infrastructure, not the app. */
  | 'surface_error'
  /** A declared output could not be read or coerced to its declared type. */
  | 'extraction_failed'
  /** The whole run exceeded its budget. */
  | 'run_timeout';

/** Whether a caller should ever try the same invocation again. */
export const RETRYABLE: Readonly<Record<FailureClass, boolean>> = {
  input_invalid: false,
  capability_invalid: false,
  target_not_found: false,
  ambiguous_target: false,
  checkpoint_failed: false,
  timeout: true,
  policy_denied: false,
  session_expired: true,
  app_error: true,
  dialog_unhandled: false,
  recovery_exhausted: true,
  surface_error: true,
  extraction_failed: false,
  run_timeout: true,
};

export type StepTrace = {
  readonly stepId: string;
  readonly intent: string;
  readonly index: number;
  readonly status: 'ok' | 'skipped' | 'recovered' | 'failed' | 'escalated';
  readonly durationMs: number;
  /** Which rung of the locator ladder won. 0 is healthy; higher is drift. */
  readonly strategyIndex?: number;
  readonly strategyKind?: string;
  readonly degraded?: boolean;
  readonly recoveriesApplied?: readonly string[];
  readonly detail?: string;
};

export type EvidenceRef = {
  readonly runId: string;
  readonly dir: string;
  readonly eventsFile: string;
  readonly blobs: readonly string[];
};

export type ReplayFailure = {
  readonly class: FailureClass;
  readonly retryable: boolean;
  readonly stepId?: string;
  readonly stepIntent?: string;
  readonly stepIndex?: number;
  /** What the engine required at this point, in plain language. */
  readonly expected: string;
  /** What it actually saw. */
  readonly observed: string;
  readonly detail?: string;
  readonly recoveriesTried: readonly string[];
};

/** The engine's own result, before the provider-call count is attached. */
export type ReplayOutcome =
  | {
      readonly status: 'success';
      readonly capability: string;
      readonly outputs: Record<string, unknown>;
      readonly steps: readonly StepTrace[];
      readonly durationMs: number;
      readonly evidence: EvidenceRef;
      readonly degradedResolutions: number;
    }
  | {
      readonly status: 'business_outcome';
      readonly capability: string;
      readonly outcome: { readonly code: string; readonly title: string; readonly severity: string; readonly data: Record<string, unknown> };
      readonly atStep: string;
      readonly steps: readonly StepTrace[];
      readonly durationMs: number;
      readonly evidence: EvidenceRef;
    }
  | {
      readonly status: 'escalated';
      readonly capability: string;
      readonly intervention: { readonly id: string; readonly reason: string; readonly decision: string; readonly note?: string; readonly humanActions: number };
      readonly steps: readonly StepTrace[];
      readonly durationMs: number;
      readonly evidence: EvidenceRef;
      /** Present when the human authorised the run to finish after taking over. */
      readonly outputs?: Record<string, unknown>;
    }
  | {
      readonly status: 'failed';
      readonly capability: string;
      readonly failure: ReplayFailure;
      readonly steps: readonly StepTrace[];
      readonly durationMs: number;
      readonly evidence: EvidenceRef;
    };

/**
 * What a caller receives. `plannerCalls` is the number of model provider
 * requests made while this replay ran; on this path it is always 0, and every
 * committed evidence file records it. See src/util/plannerCalls.ts.
 */
export type ReplayResult = ReplayOutcome & { readonly plannerCalls: number };

/** Highest risk declared anywhere in the capability. Used for approval gating. */
export function capabilityRisk(c: Capability): Risk {
  let worst: Risk = 'safe';
  const order: Record<Risk, number> = { safe: 0, elevated: 1, irreversible: 2 };
  for (const s of c.steps) if (order[s.risk] > order[worst]) worst = s.risk;
  return worst;
}
