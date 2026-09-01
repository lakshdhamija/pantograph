/**
 * Evidence.
 *
 * One append-only JSONL stream per run plus a small blob store for screenshots
 * and raw surface snapshots. Every event carries `actor`, which is what makes
 * the human handoff auditable: after a control transfer the stream keeps going
 * in the same file, with `actor: "operator:<id>"` on the steps the person took.
 *
 * Everything written here passes through the Redactor first. There is no
 * "write raw" escape hatch, because the one that exists is the one that gets
 * used at 2am.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from './redact.ts';
import { targetOf, type Action, type Observation, type ResolveFailure, type ResolvedTarget } from '../surface/types.ts';
import type { PolicyDecision } from '../policy/policy.ts';

export type Actor = 'automation' | 'planner' | 'system' | `operator:${string}`;

export type EvidenceEvent =
  | { type: 'run_started'; mode: 'discovery' | 'replay'; goal?: string; capability?: string; inputs?: Record<string, unknown> }
  | { type: 'run_finished'; status: string; durationMs: number; summary?: unknown }
  | { type: 'observation'; location: string; title: string; nodeCount: number; digest: string; blockingDialog?: unknown }
  | { type: 'planner_request'; model: string; promptChars: number; toolCount: number }
  | { type: 'planner_response'; model: string; text?: string; toolCalls: Array<{ name: string; input: unknown }>; usage?: unknown }
  | { type: 'policy_decision'; decision: PolicyDecision; action: Action }
  | { type: 'step_started'; stepId: string; intent: string; index: number; total: number }
  | { type: 'action_attempt'; action: Action; intent?: string }
  | { type: 'action_result'; ok: boolean; durationMs: number; resolved?: ResolvedTarget; failure?: ResolveFailure | { reason: string; message: string } }
  | { type: 'assertion'; label: string; assertion: unknown; passed: boolean; detail?: string }
  | { type: 'detector_fired'; kind: 'business_outcome' | 'recovery' | 'session_invalid'; id: string; detail?: string }
  | { type: 'recovery_attempt'; recoveryId: string; attempt: number; maxAttempts: number; result: 'resolved' | 'unresolved' | 'error'; detail?: string }
  | { type: 'extraction'; output: string; rawLength: number; value: unknown; sensitivity: string }
  | { type: 'escalation_raised'; interventionId: string; reason: string; stepId?: string }
  | { type: 'control_transferred'; from: Actor; to: Actor; interventionId?: string; note?: string }
  | { type: 'human_action'; interventionId: string; action: Action; note?: string }
  | { type: 'escalation_resolved'; interventionId: string; decision: string; note?: string; humanActions: number }
  | { type: 'blob'; name: string; kind: 'screenshot' | 'snapshot' | 'transcript' | 'other'; path: string; bytes: number }
  | { type: 'note'; message: string; data?: unknown };

export type RecordedEvent = EvidenceEvent & {
  seq: number;
  at: string;
  runId: string;
  actor: Actor;
  elapsedMs: number;
};

export type RecorderOptions = {
  readonly runId: string;
  readonly dir: string;
  readonly redactor?: Redactor;
  readonly echo?: boolean;
};

export class Recorder {
  readonly runId: string;
  readonly dir: string;
  readonly redactor: Redactor;
  private readonly startedAt = Date.now();
  private readonly eventsPath: string;
  private readonly blobDir: string;
  private readonly echo: boolean;
  private seq = 0;
  private actor: Actor = 'automation';
  private blobCount = 0;
  private readonly tail: RecordedEvent[] = [];

  constructor(opts: RecorderOptions) {
    this.runId = opts.runId;
    this.dir = opts.dir;
    this.redactor = opts.redactor ?? new Redactor();
    this.echo = opts.echo ?? false;
    this.blobDir = join(this.dir, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });
    this.eventsPath = join(this.dir, 'events.jsonl');
    writeFileSync(this.eventsPath, '');
  }

  /** Control transfer is modelled here too, so the log is self-describing. */
  setActor(actor: Actor, note?: string): void {
    if (actor === this.actor) return;
    const from = this.actor;
    this.actor = 'system';
    this.emit({ type: 'control_transferred', from, to: actor, note });
    this.actor = actor;
  }

  get currentActor(): Actor {
    return this.actor;
  }

  emit(event: EvidenceEvent): RecordedEvent {
    const record: RecordedEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      runId: this.runId,
      actor: this.actor,
      elapsedMs: Date.now() - this.startedAt,
      ...(this.redactor.deep(event) as EvidenceEvent),
    };
    appendFileSync(this.eventsPath, JSON.stringify(record) + '\n');
    this.tail.push(record);
    if (this.tail.length > 50) this.tail.shift();
    if (this.echo) {
      // eslint-disable-next-line no-console
      console.log(`  [${String(record.seq).padStart(3, '0')}] ${record.actor} ${summarise(record)}`);
    }
    return record;
  }

  /** Compact tail for handing context to a human operator or to a report. */
  recentEvents(n = 12): readonly RecordedEvent[] {
    return this.tail.slice(-n);
  }

  saveBlob(name: string, kind: 'screenshot' | 'snapshot' | 'transcript' | 'other', data: Buffer | string): string {
    const idx = String(++this.blobCount).padStart(3, '0');
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = `${idx}-${safe}`;
    const full = join(this.blobDir, file);
    const payload = typeof data === 'string' ? Buffer.from(this.redactor.text(data), 'utf8') : data;
    writeFileSync(full, payload);
    this.emit({ type: 'blob', name: file, kind, path: join('blobs', file), bytes: payload.byteLength });
    return full;
  }

  recordObservation(obs: Observation): void {
    this.emit({
      type: 'observation',
      location: obs.location,
      title: obs.title,
      nodeCount: obs.nodes.length,
      digest: digestOf(obs),
      blockingDialog: obs.blockingDialog,
    });
  }

  finish(status: string, summary?: unknown): void {
    this.emit({ type: 'run_finished', status, durationMs: Date.now() - this.startedAt, summary });
    writeFileSync(
      join(this.dir, 'manifest.json'),
      JSON.stringify(
        {
          runId: this.runId,
          status,
          startedAt: new Date(this.startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - this.startedAt,
          events: this.seq,
          blobs: this.blobCount,
          redactions: this.redactor.report(),
        },
        null,
        2,
      ) + '\n',
    );
  }
}

/**
 * A cheap structural fingerprint of a screen. Two observations with the same
 * digest are the same screen; a changed digest after an action is the simplest
 * possible "something happened" signal, and a *stable* digest across a
 * navigation is how the replay engine notices a click silently did nothing.
 */
export function digestOf(obs: Observation): string {
  const shape = obs.nodes
    .filter((n) => n.visible)
    .map((n) => `${n.containerPath.join('/')}|${n.role}|${n.name.slice(0, 40)}`)
    .join('\n');
  let h = 5381;
  for (let i = 0; i < shape.length; i++) h = ((h << 5) + h + shape.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function summarise(e: RecordedEvent): string {
  switch (e.type) {
    case 'action_attempt': {
      const t = targetOf(e.action);
      return `act ${e.action.kind}${t ? ` ${t.role}` : ''}`;
    }
    case 'action_result': return `  -> ${e.ok ? 'ok' : 'FAILED'} ${e.durationMs}ms${e.resolved?.degraded ? ' (degraded locator)' : ''}`;
    case 'observation': return `see ${e.title} [${e.nodeCount} nodes] ${e.digest}`;
    case 'step_started': return `step ${e.index + 1}/${e.total} ${e.stepId}: ${e.intent}`;
    case 'assertion': return `assert ${e.label}: ${e.passed ? 'pass' : 'FAIL'}${e.detail ? ` (${e.detail})` : ''}`;
    case 'detector_fired': return `detector ${e.kind} ${e.id}`;
    case 'policy_decision': return `policy ${e.decision.decision} (${e.decision.rule})`;
    case 'escalation_raised': return `ESCALATE ${e.interventionId}: ${e.reason}`;
    case 'control_transferred': return `control ${e.from} -> ${e.to}`;
    case 'human_action': return `human ${e.action.kind}`;
    case 'extraction': return `extract ${e.output} = ${JSON.stringify(e.value)}`;
    case 'recovery_attempt': return `recovery ${e.recoveryId} #${e.attempt} -> ${e.result}`;
    default: return e.type;
  }
}
