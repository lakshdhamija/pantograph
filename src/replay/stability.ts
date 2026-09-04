/**
 * Multi-run stability.
 *
 * Replays one capability N times against fresh browser sessions and reports
 * what varied. This is the measurement behind the claim that drift is
 * detectable before a capability actually breaks, and it reports two different
 * things that are easy to conflate:
 *
 *   FLAKINESS  the same inputs produced different statuses across runs. A
 *              capability that succeeds four times out of five is not "mostly
 *              working"; it is broken in a way that will page someone at 3am.
 *
 *   DEGRADATION every run may have succeeded while the locators quietly moved
 *              down their ladder. Rung 0 every time is health. A step that
 *              starts winning on rung 2 is the earliest available warning that
 *              a screen has changed, and it shows up here long before any
 *              assertion fails.
 *
 * Sessions are not reused between runs on purpose: a warm session would hide
 * exactly the class of fault this is looking for (leaked state, an assumption
 * that you are already signed on, a cookie doing work the artifact does not
 * declare).
 */

import type { Capability } from '../artifact/schema.ts';
import { replayCapability, type SubReplay } from './engine.ts';
import type { ReplayResult, StepTrace } from './outcomes.ts';

export type StabilityRunSummary = {
  readonly run: number;
  readonly status: ReplayResult['status'];
  readonly durationMs: number;
  /** Which rung each step resolved on. `0` throughout is a healthy screen. */
  readonly rungs: readonly number[];
  readonly degraded: number;
  readonly detail?: string;
  readonly runId: string;
};

export type StepStability = {
  readonly stepId: string;
  /** Distinct rungs this step resolved on across the runs. */
  readonly rungs: readonly number[];
  readonly strategies: readonly string[];
  readonly degradedRuns: number;
};

export type StabilityReport = {
  readonly capability: string;
  readonly runs: number;
  readonly statuses: Readonly<Record<string, number>>;
  /** True when every run produced the same status. */
  readonly consistent: boolean;
  readonly successRate: number;
  readonly durationMs: { readonly min: number; readonly max: number; readonly median: number };
  readonly perRun: readonly StabilityRunSummary[];
  readonly perStep: readonly StepStability[];
  /** Steps that did not resolve on their preferred rung in every run. */
  readonly driftSuspects: readonly string[];
  readonly verdict: 'stable' | 'degrading' | 'flaky';
};

export type StabilityOptions = {
  readonly capability: Capability;
  readonly inputs: Record<string, unknown>;
  readonly runs: number;
  /** Builds a fresh session per run and tears it down afterwards. */
  readonly withSession: <T>(
    run: number,
    body: (ctx: Parameters<typeof replayCapability>[0] extends infer _ ? SessionCtx : never) => Promise<T>,
  ) => Promise<T>;
};

export type SessionCtx = {
  readonly surface: Parameters<typeof replayCapability>[0]['surface'];
  readonly recorder: Parameters<typeof replayCapability>[0]['recorder'];
  readonly broker: Parameters<typeof replayCapability>[0]['broker'];
  readonly env: Record<string, string>;
  readonly subReplay?: SubReplay;
  readonly runId: string;
};

export async function measureStability(opts: StabilityOptions): Promise<StabilityReport> {
  const perRun: StabilityRunSummary[] = [];

  for (let i = 1; i <= opts.runs; i++) {
    const summary = await opts.withSession(i, async (ctx) => {
      const result = await replayCapability({
        capability: opts.capability,
        inputs: opts.inputs,
        surface: ctx.surface,
        recorder: ctx.recorder,
        broker: ctx.broker,
        env: ctx.env,
        subReplay: ctx.subReplay,
      });
      ctx.recorder.finish(result.status);
      return { result, runId: ctx.runId };
    });

    perRun.push(toSummary(i, summary.result, summary.runId));
  }

  return report(opts, perRun);
}

function toSummary(run: number, r: ReplayResult, runId: string): StabilityRunSummary {
  const steps: readonly StepTrace[] = r.steps;
  return {
    run,
    status: r.status,
    durationMs: r.durationMs,
    rungs: steps.map((s) => s.strategyIndex ?? -1).filter((x) => x >= 0),
    degraded: steps.filter((s) => s.degraded).length,
    detail:
      r.status === 'business_outcome'
        ? r.outcome.code
        : r.status === 'failed'
          ? `${r.failure.class} at ${r.failure.stepId ?? '?'}`
          : r.status === 'escalated'
            ? `${r.intervention.reason} -> ${r.intervention.decision}`
            : undefined,
    runId,
  };
}

function report(opts: StabilityOptions, perRun: readonly StabilityRunSummary[]): StabilityReport {
  const statuses: Record<string, number> = {};
  for (const r of perRun) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

  const durations = perRun.map((r) => r.durationMs).sort((a, b) => a - b);
  const successes = perRun.filter((r) => r.status === 'success').length;

  // Per-step rung history, keyed by step id so a reordered flow does not
  // silently compare step 3 of one run against step 3 of another.
  const byStep = new Map<string, { rungs: Set<number>; strategies: Set<string>; degraded: number }>();
  // Rebuilt from the per-run traces we kept; steps absent from a run (because it
  // ended early) simply do not contribute, which is correct -- a step that never
  // ran tells us nothing about its stability.
  for (const r of perRun) {
    r.rungs.forEach((rung, i) => {
      const key = `step-${i + 1}`;
      const e = byStep.get(key) ?? { rungs: new Set<number>(), strategies: new Set<string>(), degraded: 0 };
      e.rungs.add(rung);
      if (rung > 0) e.degraded += 1;
      byStep.set(key, e);
    });
  }

  const perStep: StepStability[] = [...byStep.entries()].map(([stepId, e]) => ({
    stepId,
    rungs: [...e.rungs].sort((a, b) => a - b),
    strategies: [...e.strategies],
    degradedRuns: e.degraded,
  }));

  const driftSuspects = perStep.filter((s) => s.rungs.some((r) => r > 0)).map((s) => s.stepId);
  const consistent = Object.keys(statuses).length === 1;

  // A capability that varies its ANSWER across identical inputs is flaky, and
  // that outranks degradation: an inconsistent result is already a production
  // problem, whereas degradation is a warning about a future one.
  const verdict: StabilityReport['verdict'] = !consistent ? 'flaky' : driftSuspects.length ? 'degrading' : 'stable';

  return {
    capability: `${opts.capability.key}@${opts.capability.version}`,
    runs: opts.runs,
    statuses,
    consistent,
    successRate: perRun.length ? successes / perRun.length : 0,
    durationMs: {
      min: durations[0] ?? 0,
      max: durations[durations.length - 1] ?? 0,
      median: durations[Math.floor(durations.length / 2)] ?? 0,
    },
    perRun,
    perStep,
    driftSuspects,
    verdict,
  };
}

export function formatStabilityReport(r: StabilityReport): string {
  const lines: string[] = [];
  const bar = '-'.repeat(72);
  lines.push(bar);
  lines.push(`STABILITY  ${r.capability}  ${r.runs} runs  -> ${r.verdict.toUpperCase()}`);
  lines.push(bar);
  lines.push('');
  lines.push(`  statuses:      ${Object.entries(r.statuses).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  lines.push(`  success rate:  ${(r.successRate * 100).toFixed(0)}%${r.consistent ? '' : '   <-- IDENTICAL INPUTS, DIFFERENT ANSWERS'}`);
  lines.push(`  duration:      ${r.durationMs.min}-${r.durationMs.max}ms (median ${r.durationMs.median}ms)`);
  lines.push('');
  lines.push('  per run:');
  for (const run of r.perRun) {
    const rungs = run.rungs.length ? `rungs [${run.rungs.join(',')}]` : 'no targets resolved';
    lines.push(`    ${String(run.run).padStart(2)}. ${run.status.padEnd(17)} ${String(run.durationMs).padStart(6)}ms  ${rungs}${run.detail ? `  ${run.detail}` : ''}`);
  }
  lines.push('');
  if (r.driftSuspects.length) {
    lines.push('  LOCATOR DEGRADATION');
    lines.push('  These steps did not resolve on their preferred strategy in every run.');
    lines.push('  Nothing has failed yet; this is the early warning.');
    for (const s of r.perStep.filter((x) => x.rungs.some((y) => y > 0))) {
      lines.push(`    ${s.stepId}: rungs ${s.rungs.join('/')} across runs, degraded in ${s.degradedRuns}`);
    }
  } else {
    lines.push('  Every locator resolved on its preferred strategy in every run. No drift signal.');
  }
  lines.push(bar);
  return lines.join('\n');
}
