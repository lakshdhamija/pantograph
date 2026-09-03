/**
 * Composition root.
 *
 * One place assembles the object graph, and it is the only place that holds a
 * reference to the raw `WebSurface`. Everything else -- the agent loop, the
 * replay engine, the operator console -- receives a `GuardedSurface`, so the
 * lease check, the policy check and the evidence write are structurally
 * unavoidable rather than a convention people have to remember.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSurface } from './surface/web/webSurface.ts';
import { GuardedSurface, sensitiveHandles } from './surface/guarded.ts';
import { ControlLease } from './escalation/controlLease.ts';
import { EscalationBroker, type AutoOperator, type OperatorMode } from './escalation/broker.ts';
import { startOperatorConsole } from './escalation/operatorServer.ts';
import { Recorder } from './evidence/recorder.ts';
import { Redactor } from './evidence/redact.ts';
import { PolicyEngine } from './policy/policy.ts';
import { CapabilityStore } from './artifact/store.ts';

export type SessionOptions = {
  readonly mode: 'discovery' | 'replay';
  readonly runId?: string;
  readonly runsDir?: string;
  readonly policyFile?: string;
  readonly headless?: boolean;
  readonly slowMoMs?: number;
  readonly operatorMode?: OperatorMode;
  readonly autoOperator?: AutoOperator;
  readonly operatorPort?: number;
  /**
   * Who is at the console. Stamped on every action they take and every decision
   * they record, so the audit trail names a person rather than a role. Defaults
   * to the OS user, which is at least a real identity on this machine.
   */
  readonly operatorId?: string;
  readonly artifactsDir?: string;
  readonly echo?: boolean;
  readonly escalationTimeoutMs?: number;
  /** Record the browser session to video in this directory. */
  readonly recordVideoDir?: string;
};

export type Session = {
  readonly runId: string;
  readonly dir: string;
  readonly surface: GuardedSurface;
  readonly raw: WebSurface;
  readonly recorder: Recorder;
  readonly policy: PolicyEngine;
  readonly lease: ControlLease;
  readonly broker: EscalationBroker;
  readonly store: CapabilityStore;
  readonly operatorConsoleUrl?: string;
  close: () => Promise<void>;
};

export async function createSession(opts: SessionOptions): Promise<Session> {
  const runId = opts.runId ?? `${opts.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const runsDir = resolve(opts.runsDir ?? 'runs');
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });

  const recorder = new Recorder({ runId, dir, redactor: new Redactor(), echo: opts.echo ?? true });
  const policy = opts.policyFile ? PolicyEngine.fromFile(opts.policyFile) : new PolicyEngine();
  const lease = new ControlLease();
  const store = new CapabilityStore(resolve(opts.artifactsDir ?? 'artifacts'));

  const raw = await WebSurface.launch({
    headless: opts.headless ?? true,
    slowMoMs: opts.slowMoMs,
    recordVideoDir: opts.recordVideoDir,
  });

  // Installed on the raw surface, once, before anything can ask it for an
  // image. Every screenshot this process produces goes through it: the engine's
  // failure captures, the broker's pre-handoff capture, and the frames the
  // operator console polls while a human is driving.
  raw.setScreenshotMask?.((obs) => {
    const handles = sensitiveHandles(obs, recorder.redactor);
    if (handles.length) recorder.emit({ type: 'note', message: `screenshot: masked ${handles.length} sensitive region(s)` });
    return handles;
  });

  const broker = new EscalationBroker({
    surface: raw,
    lease,
    recorder,
    policy,
    mode: opts.operatorMode ?? 'abort',
    autoOperator: opts.autoOperator,
    waitTimeoutMs: opts.escalationTimeoutMs,
  });

  const surface = new GuardedSurface({ inner: raw, policy, recorder, lease, as: 'automation' });

  let consoleHandle: { url: string; close: () => Promise<void> } | undefined;
  if ((opts.operatorMode ?? 'abort') === 'console') {
    consoleHandle = await startOperatorConsole({
      broker,
      port: opts.operatorPort ?? 8732,
      operatorId: opts.operatorId ?? process.env['USER'] ?? 'unknown-operator',
    });
  }

  return {
    runId,
    dir,
    surface,
    raw,
    recorder,
    policy,
    lease,
    broker,
    store,
    operatorConsoleUrl: consoleHandle?.url,
    close: async () => {
      await consoleHandle?.close();
      await raw.close();
    },
  };
}
