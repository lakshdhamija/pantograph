/**
 * The chokepoint.
 *
 * Every actor -- the LLM planner during discovery, the deterministic replay
 * engine, and the human operator during a handoff -- reaches the browser
 * through one of these. There is no other reference to the raw Surface outside
 * the process that constructs it.
 *
 * Three things happen here and only here:
 *   1. control lease check   (is this actor allowed to act at all?)
 *   2. policy check          (is this action allowed, and how risky is it?)
 *   3. evidence              (attempt and result, redacted, attributed to the actor)
 *
 * Putting policy in the agent's prompt instead would make it a suggestion. A
 * model cannot talk its way past this, and neither can a bug in the replay
 * engine, and neither can the operator console.
 */

import { targetOf } from './types.ts';
import type {
  Action,
  ActionResult,
  Observation,
  Portability,
  ResolveFailure,
  ResolvedTarget,
  Surface,
  SurfaceKind,
  TargetDescriptor,
} from './types.ts';
import type { PolicyEngine, RiskPatternOverrides } from '../policy/policy.ts';
import type { Recorder } from '../evidence/recorder.ts';
import type { ControlLease, LeaseHolder } from '../escalation/controlLease.ts';
import type { Risk } from '../artifact/schema.ts';
import type { Redactor } from '../evidence/redact.ts';

/**
 * Nodes whose pixels must be covered before an image of the screen exists.
 *
 * Content-driven rather than schema-driven on purpose: it needs no artifact, so
 * it works identically during discovery, during replay, and while a human is
 * driving. A tax ID rendered on a screen nobody declared an output for is
 * covered on the same terms as a declared one.
 */
export function sensitiveHandles(obs: Observation, redactor: Redactor): string[] {
  const out: string[] = [];
  for (const n of obs.nodes) {
    if (redactor.wouldRedact(n.value ?? '') || redactor.wouldRedact(n.name ?? '')) out.push(n.handle);
  }
  return out;
}

export type GuardContext = {
  /** Recorded step or planner intent, used for risk classification. */
  intent?: string;
  declaredRisk?: Risk;
  /** Message of a modal blocking the surface; the strongest risk signal there is. */
  dialogMessage?: string;
};

export type GuardedSurfaceOptions = {
  readonly inner: Surface;
  readonly policy: PolicyEngine;
  readonly recorder: Recorder;
  readonly lease: ControlLease;
  readonly as: LeaseHolder;
};

/**
 * A one-shot authorisation for a single action that policy would otherwise send
 * to a human. Issued only by the engine, only after an operator answered
 * `approve` to an intervention, and consumed on first use.
 *
 * One-shot is the whole point: a blanket "approvals on" flag would mean one
 * human decision silently authorises every later irreversible action in the run.
 */
export type ApprovalGrant = { readonly fingerprint: string; readonly interventionId: string; readonly by: string };

export function actionFingerprint(action: Action, intent = ''): string {
  const t = targetOf(action);
  const target = t ? `${t.role}:${t.name?.value ?? ''}` : '';
  const value = action.kind === 'fill' || action.kind === 'select' ? (action.kind === 'fill' && action.secret ? '<secret>' : action.value) : '';
  return `${action.kind}|${target}|${value}|${intent}`;
}

export class GuardedSurface implements Surface {
  readonly kind: SurfaceKind;
  readonly sessionId: string;
  readonly as: LeaseHolder;

  private readonly inner: Surface;
  private readonly policy: PolicyEngine;
  private readonly recorder: Recorder;
  private readonly lease: ControlLease;
  private ctx: GuardContext = {};
  private readonly grants = new Map<string, ApprovalGrant>();
  private scope: { allowedOrigins?: readonly string[]; allowedActions?: readonly string[] } = {};
  private riskPatterns: RiskPatternOverrides | undefined;

  constructor(opts: GuardedSurfaceOptions) {
    this.inner = opts.inner;
    this.policy = opts.policy;
    this.recorder = opts.recorder;
    this.lease = opts.lease;
    this.as = opts.as;
    this.kind = opts.inner.kind;
    this.sessionId = opts.inner.sessionId;
  }

  setPortabilityFloor(floor: Portability): void {
    this.inner.setPortabilityFloor?.(floor);
  }

  /** Attach the current step's intent so policy can classify risk in context. */
  withContext(ctx: GuardContext): this {
    this.ctx = ctx;
    return this;
  }

  /**
   * Narrow this surface to a capability's own declared allowlist for the
   * duration of a run. Intersected with the deployment policy; never widening.
   */
  setCapabilityScope(scope: { allowedOrigins?: readonly string[]; allowedActions?: readonly string[] }): void {
    this.scope = scope;
  }

  /** Risk vocabulary for the product being driven. See AppProfile.riskPatterns. */
  setRiskPatterns(patterns: RiskPatternOverrides | undefined): void {
    this.riskPatterns = patterns;
  }

  /** Record a human's approval for exactly one upcoming action. */
  grantApproval(grant: ApprovalGrant): void {
    this.grants.set(grant.fingerprint, grant);
  }

  /** Observation is read-only, so it is exempt from the policy gate but not
   *  from the lease: a parked automation must not keep polling the screen the
   *  human is working on, or its evidence interleaves confusingly. */
  async observe(): Promise<Observation> {
    this.lease.assert(this.as);
    return this.inner.observe();
  }

  async resolve(target: TargetDescriptor, floor?: Portability): Promise<ResolvedTarget | ResolveFailure> {
    this.lease.assert(this.as);
    return this.inner.resolve(target, floor);
  }

  async act(action: Action): Promise<ActionResult> {
    const started = Date.now();

    if (!this.lease.holds(this.as)) {
      const holder = this.lease.current.holder;
      const result: ActionResult = {
        ok: false,
        durationMs: Date.now() - started,
        failure: {
          reason: 'control_denied',
          message: `${this.as} cannot act: control is held by ${holder}`,
          holder,
        },
      };
      this.recorder.emit({ type: 'action_attempt', action: redactAction(action), intent: this.ctx.intent });
      this.recorder.emit({ type: 'action_result', ok: false, durationMs: result.durationMs, failure: result.failure });
      return result;
    }

    // The capability's own allowlist, applied BEFORE the deployment policy so a
    // narrower artifact is honoured even where the deployment would allow more.
    const narrowed = this.checkCapabilityScope(action);
    if (narrowed) {
      this.recorder.emit({ type: 'policy_decision', decision: narrowed, action: redactAction(action) });
      return { ok: false, durationMs: Date.now() - started, failure: { reason: 'policy_denied', message: narrowed.reason, rule: narrowed.rule, risk: narrowed.risk } };
    }

    const decision = this.policy.check(action, { ...this.ctx, patterns: this.riskPatterns });
    this.recorder.emit({ type: 'policy_decision', decision, action: redactAction(action) });

    if (decision.decision === 'require_approval') {
      const fp = actionFingerprint(action, this.ctx.intent ?? '');
      const grant = this.grants.get(fp);
      if (grant) {
        this.grants.delete(fp);
        this.recorder.emit({
          type: 'note',
          message: `policy approval consumed for ${action.kind}`,
          data: { rule: decision.rule, risk: decision.risk, interventionId: grant.interventionId, by: grant.by },
        });
        return this.perform(action);
      }
    }

    if (decision.decision !== 'allow') {
      return {
        ok: false,
        durationMs: Date.now() - started,
        failure: {
          reason: decision.decision === 'deny' ? 'policy_denied' : 'policy_approval_required',
          message: decision.reason,
          rule: decision.rule,
          risk: decision.risk,
        },
      };
    }

    return this.perform(action);
  }

  /** Returns a denial when the capability's own allowlist forbids the action. */
  private checkCapabilityScope(action: Action): { decision: 'deny'; risk: Risk; rule: string; reason: string } | undefined {
    const actions = this.scope.allowedActions;
    if (actions?.length && !actions.includes(action.kind)) {
      return { decision: 'deny', risk: 'safe', rule: 'capability.allowedActions', reason: `this capability declares it uses only [${actions.join(', ')}]; "${action.kind}" is not among them` };
    }
    const origins = this.scope.allowedOrigins;
    if (origins?.length && action.kind === 'navigate') {
      let origin: string;
      try {
        origin = new URL(action.url).origin;
      } catch {
        return { decision: 'deny', risk: 'safe', rule: 'capability.allowedOrigins', reason: `not a URL: ${action.url}` };
      }
      if (!origins.includes(origin)) {
        return { decision: 'deny', risk: 'safe', rule: 'capability.allowedOrigins', reason: `this capability declares it reaches only [${origins.join(', ')}]; ${origin} is not among them` };
      }
    }
    return undefined;
  }

  private async perform(action: Action): Promise<ActionResult> {
    this.recorder.emit({ type: 'action_attempt', action: redactAction(action), intent: this.ctx.intent });
    const result = await this.inner.act(action);
    this.recorder.emit({
      type: 'action_result',
      ok: result.ok,
      durationMs: result.durationMs,
      resolved: result.resolved,
      failure: result.failure,
    });
    return result;
  }

  /**
   * Evidence capture bypasses the lease: a screenshot of what the human is
   * doing is exactly what we want during a handoff.
   *
   * It does not bypass redaction, but that is not enforced here. The mask is
   * installed on the surface itself (see `Surface.setScreenshotMask`), because
   * the escalation broker is deliberately handed the raw surface and would
   * otherwise route around anything this wrapper did.
   */
  screenshot(): Promise<Buffer | undefined> {
    return this.inner.screenshot();
  }

  snapshot(): Promise<string | undefined> {
    return this.inner.snapshot();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * `fill` carries the only user-supplied value that reaches the surface, and it
 * is the one thing that must never land in the log verbatim when it is a
 * credential. The Redactor also scans it, but stripping it here means a secret
 * never enters the evidence pipeline at all.
 */
function redactAction(action: Action): Action {
  if (action.kind === 'fill' && action.secret) {
    return { ...action, value: '[REDACTED:SECRET]' };
  }
  return action;
}
