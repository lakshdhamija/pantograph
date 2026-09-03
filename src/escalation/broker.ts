/**
 * Escalation and control transfer.
 *
 * The lifecycle, end to end:
 *
 *   1. Something blocks. The engine calls `raise()` with the run's context.
 *   2. The broker PARKS the automation -- the lease moves to `nobody`, so the
 *      engine's surface starts failing closed instead of racing the human.
 *   3. The request appears in the operator console with a screenshot, the step
 *      that stopped, why it stopped, and the decisions available.
 *   4. An operator claims it. The lease moves to `operator:<id>`. They now drive
 *      the SAME BrowserContext, through their own guarded surface, and every
 *      action they take is recorded as `human_action` in the same evidence
 *      stream.
 *   5. They resolve it with a decision. The lease returns to automation and the
 *      promise returned by `raise()` settles, so the engine continues from
 *      exactly where it parked.
 *
 * The seam that makes this work is that "the session" is a `Surface` instance
 * shared by reference, and "who may act" is a separate, explicit lease. Nothing
 * about the automation is torn down and rebuilt; there is no fresh session.
 */

import { randomUUID } from 'node:crypto';
import type { Action, Observation, Surface } from '../surface/types.ts';
import { GuardedSurface } from '../surface/guarded.ts';
import type { Recorder, RecordedEvent } from '../evidence/recorder.ts';
import { ControlLease } from './controlLease.ts';
import { PolicyEngine } from '../policy/policy.ts';

export type InterventionReason =
  /** Discovery ran out of ideas or hit its step budget without reaching the goal. */
  | 'stuck_discovery'
  /** Replay hit a state it has no declared recovery for. */
  | 'replay_unrecoverable'
  /** A declared recovery ran out of attempts. */
  | 'recovery_exhausted'
  /** Policy requires a human decision before an irreversible action. */
  | 'approval_required'
  /** The capability itself declares a human step at this point. */
  | 'declared_step'
  /** Raised by a person, not by the system. */
  | 'manual';

export type ResumeDecision =
  /** Human fixed the state; continue with the next step. */
  | 'resume'
  /** Re-run the step that was parked. */
  | 'retry_step'
  /** Treat the parked step as done and move on. */
  | 'skip_step'
  /** Human authorised the irreversible action; automation performs it. */
  | 'approve'
  /** Human refused; end the run as a rejected outcome, not a failure. */
  | 'reject'
  /** Stop the run. */
  | 'abort';

export type InterventionContext = {
  readonly location: string;
  readonly title: string;
  readonly observationSummary: string;
  readonly recentEvents: readonly RecordedEvent[];
  readonly screenshotPath?: string;
  readonly snapshotPath?: string;
};

export type Intervention = {
  readonly id: string;
  readonly runId: string;
  readonly raisedAt: string;
  readonly reason: InterventionReason;
  readonly why: string;
  readonly mode: 'discovery' | 'replay';
  readonly goal?: string;
  readonly capability?: { key: string; version: string };
  readonly stepId?: string;
  readonly stepIntent?: string;
  readonly stepIndex?: number;
  readonly stepTotal?: number;
  readonly pendingAction?: Action;
  readonly options: readonly ResumeDecision[];
  readonly context: InterventionContext;
  status: 'open' | 'claimed' | 'resolved';
  claimedBy?: string;
  claimedAt?: string;
  resolvedAt?: string;
  resolution?: Resolution;
  humanActions: number;
};

export type Resolution = {
  /**
   * The intervention this resolves. Carried explicitly because the callers used
   * to infer it as "the most recently raised one", which ties on a
   * same-millisecond timestamp and, failing that, invented a random id matching
   * no intervention at all -- in the field that records which approval
   * authorised which write.
   */
  readonly interventionId: string;
  readonly decision: ResumeDecision;
  readonly note?: string;
  readonly by: string;
  readonly humanActions: number;
};

export type RaiseInput = {
  readonly reason: InterventionReason;
  readonly why: string;
  readonly mode: 'discovery' | 'replay';
  readonly goal?: string;
  readonly capability?: { key: string; version: string };
  readonly stepId?: string;
  readonly stepIntent?: string;
  readonly stepIndex?: number;
  readonly stepTotal?: number;
  readonly pendingAction?: Action;
  readonly options?: readonly ResumeDecision[];
  readonly observation?: Observation;
};

/**
 * How an unattended process behaves when it needs a human.
 *   console  park and wait for a real operator (default for interactive runs)
 *   auto     a scripted operator, used by the demo and by CI so the handoff is
 *            exercised end to end without a person present
 *   abort    do not wait; fail the run immediately with an escalation status.
 *            This is the correct production default for a batch caller that has
 *            nobody to ask.
 */
export type OperatorMode = 'console' | 'auto' | 'abort';

export type AutoOperator = (
  intervention: Intervention,
  session: { surface: GuardedSurface; observe: () => Promise<Observation> },
) => Promise<{ decision: ResumeDecision; note?: string }>;

export type BrokerOptions = {
  readonly surface: Surface;
  readonly lease: ControlLease;
  readonly recorder: Recorder;
  readonly policy: PolicyEngine;
  readonly mode: OperatorMode;
  readonly autoOperator?: AutoOperator;
  /** Hard cap on how long a run will sit parked waiting for a person. */
  readonly waitTimeoutMs?: number;
};

/**
 * Operators get their own policy STANCE, derived from the deployment's policy
 * rather than replacing it. `require_approval` exists to ask a human; once a
 * human is acting, asking again is circular, so an operator may perform
 * irreversible actions. Everything else the deployment declared -- its origin
 * and route allowlists, its forbidden patterns -- still applies, because those
 * are actions we will not take at all, whoever is driving. Building a fresh
 * engine from the defaults instead would silently drop every deployment-specific
 * rule on the one path where a human is authorising a write.
 */
function operatorPolicy(base: PolicyEngine): PolicyEngine {
  return base.derive({ onIrreversible: 'allow', onElevated: 'allow' });
}

export class EscalationBroker {
  private readonly opts: BrokerOptions;
  private readonly interventions = new Map<string, Intervention>();
  private readonly waiters = new Map<string, (r: Resolution) => void>();
  private readonly operatorSurfaces = new Map<string, GuardedSurface>();

  constructor(opts: BrokerOptions) {
    this.opts = opts;
  }

  list(): Intervention[] {
    return [...this.interventions.values()].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  get(id: string): Intervention | undefined {
    return this.interventions.get(id);
  }

  get openCount(): number {
    return [...this.interventions.values()].filter((i) => i.status !== 'resolved').length;
  }

  /**
   * Park the run and ask for a human. Resolves when one answers (or when the
   * configured mode decides for us).
   */
  async raise(input: RaiseInput): Promise<Resolution> {
    const { recorder, lease } = this.opts;
    const id = `iv_${randomUUID().slice(0, 8)}`;

    // Capture evidence BEFORE parking, while the surface is still ours.
    const shot = await this.opts.surface.screenshot().catch(() => undefined);
    const snap = await this.opts.surface.snapshot().catch(() => undefined);
    const screenshotPath = shot ? recorder.saveBlob(`${id}-escalation.png`, 'screenshot', shot) : undefined;
    const snapshotPath = snap ? recorder.saveBlob(`${id}-escalation.html`, 'snapshot', snap) : undefined;

    const intervention: Intervention = {
      id,
      runId: recorder.runId,
      raisedAt: new Date().toISOString(),
      reason: input.reason,
      why: input.why,
      mode: input.mode,
      goal: input.goal,
      capability: input.capability,
      stepId: input.stepId,
      stepIntent: input.stepIntent,
      stepIndex: input.stepIndex,
      stepTotal: input.stepTotal,
      pendingAction: input.pendingAction,
      options: input.options ?? defaultOptions(input.reason),
      context: {
        location: input.observation?.location ?? '(unknown)',
        title: input.observation?.title ?? '',
        observationSummary: input.observation ? summariseObservation(input.observation) : '(no observation captured)',
        recentEvents: recorder.recentEvents(15),
        screenshotPath,
        snapshotPath,
      },
      status: 'open',
      humanActions: 0,
    };
    this.interventions.set(id, intervention);

    recorder.emit({ type: 'escalation_raised', interventionId: id, reason: `${input.reason}: ${input.why}`, stepId: input.stepId });

    // Park: nobody drives until a human claims it. Automation's guarded surface
    // now fails closed rather than racing whoever picks this up.
    recorder.setActor('system', 'parked pending human intervention');
    lease.transfer('nobody', `escalation ${id}`);

    const resolution = await this.awaitResolution(intervention);

    lease.transfer('automation', `escalation ${id} resolved: ${resolution.decision}`);
    recorder.setActor('automation', 'control returned to automation');
    recorder.emit({
      type: 'escalation_resolved',
      interventionId: id,
      decision: resolution.decision,
      note: resolution.note,
      humanActions: resolution.humanActions,
    });
    return resolution;
  }

  private async awaitResolution(intervention: Intervention): Promise<Resolution> {
    if (this.opts.mode === 'abort') {
      const r: Resolution = { interventionId: intervention.id, decision: 'abort', by: 'system:unattended', humanActions: 0, note: 'operator mode is "abort": no human is available for this run' };
      this.finish(intervention, r);
      return r;
    }

    if (this.opts.mode === 'auto') {
      const auto = this.opts.autoOperator;
      if (!auto) throw new Error('operator mode "auto" requires an autoOperator');
      const operatorId = 'auto';
      this.claim(intervention.id, operatorId);
      const surface = this.surfaceFor(intervention.id, operatorId);
      const outcome = await auto(intervention, { surface, observe: () => surface.observe() });
      const r: Resolution = { interventionId: intervention.id, decision: outcome.decision, note: outcome.note, by: `operator:${operatorId}`, humanActions: intervention.humanActions };
      this.finish(intervention, r);
      return r;
    }

    const timeoutMs = this.opts.waitTimeoutMs ?? 15 * 60_000;
    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(intervention.id);
        const r: Resolution = { interventionId: intervention.id, decision: 'abort', by: 'system:timeout', humanActions: intervention.humanActions, note: `no operator responded within ${Math.round(timeoutMs / 1000)}s` };
        this.finish(intervention, r);
        resolve(r);
      }, timeoutMs);
      this.waiters.set(intervention.id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  // -- operator-facing API (used by the console server and the auto operator) --

  claim(id: string, operatorId: string): Intervention {
    const iv = this.require(id);
    if (iv.status === 'resolved') throw new Error(`intervention ${id} is already resolved`);
    iv.status = 'claimed';
    iv.claimedBy = operatorId;
    iv.claimedAt = new Date().toISOString();
    this.opts.lease.transfer(`operator:${operatorId}`, `claimed ${id}`);
    this.opts.recorder.setActor(`operator:${operatorId}`, `claimed intervention ${id}`);
    return iv;
  }

  /** The operator's handle on the live session. Same Surface, different guard. */
  surfaceFor(id: string, operatorId: string): GuardedSurface {
    const key = `${id}:${operatorId}`;
    let s = this.operatorSurfaces.get(key);
    if (!s) {
      s = new GuardedSurface({
        inner: this.opts.surface,
        policy: operatorPolicy(this.opts.policy),
        recorder: this.opts.recorder,
        lease: this.opts.lease,
        as: `operator:${operatorId}`,
      });
      this.operatorSurfaces.set(key, s);
    }
    return s;
  }

  async operatorAct(id: string, operatorId: string, action: Action, note?: string) {
    const iv = this.require(id);
    if (iv.claimedBy !== operatorId) throw new Error(`intervention ${id} is claimed by ${iv.claimedBy ?? 'nobody'}`);
    const surface = this.surfaceFor(id, operatorId);
    const result = await surface.withContext({ intent: note ?? 'manual operator action' }).act(action);
    iv.humanActions += 1;
    this.opts.recorder.emit({ type: 'human_action', interventionId: id, action, note });
    return result;
  }

  resolve(id: string, decision: ResumeDecision, by: string, note?: string): Resolution {
    const iv = this.require(id);
    const r: Resolution = { interventionId: id, decision, note, by, humanActions: iv.humanActions };
    this.finish(iv, r);
    this.waiters.get(id)?.(r);
    this.waiters.delete(id);
    return r;
  }

  private finish(iv: Intervention, r: Resolution): void {
    iv.status = 'resolved';
    iv.resolvedAt = new Date().toISOString();
    iv.resolution = r;
  }

  private require(id: string): Intervention {
    const iv = this.interventions.get(id);
    if (!iv) throw new Error(`no such intervention: ${id}`);
    return iv;
  }
}

function defaultOptions(reason: InterventionReason): readonly ResumeDecision[] {
  switch (reason) {
    case 'approval_required':
      return ['approve', 'reject', 'abort'];
    case 'declared_step':
      return ['resume', 'abort'];
    default:
      return ['resume', 'retry_step', 'skip_step', 'abort'];
  }
}

/** A compact, human-readable view of the screen, for the intervention card. */
export function summariseObservation(obs: Observation, limit = 40): string {
  const lines = obs.nodes
    .filter((n) => n.visible && (n.role !== 'text' || (n.text ?? '').length > 0))
    .slice(0, limit)
    .map((n) => {
      const where = n.containerPath.length ? `[${n.containerPath.join('/')}] ` : '';
      const label = n.name || n.text || '';
      const value = n.value ? ` value=${JSON.stringify(n.value)}` : '';
      return `${where}${n.role}${label ? ` "${truncate(label, 60)}"` : ''}${value}`;
    });
  const extra = obs.blockingDialog ? [`!! blocking ${obs.blockingDialog.kind} dialog: "${obs.blockingDialog.message}"`] : [];
  return [...extra, ...lines].join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
