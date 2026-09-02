/**
 * The discovery loop: observe -> decide -> act, until the goal is met or a
 * stopping condition fires. The only place a model influences anything.
 *
 * Its output is a transcript -- intents, concrete actions, and the descriptor
 * the system synthesised for each target -- which the compiler turns into an
 * artifact. The transcript is deliberately not the artifact: the raw model
 * exchange is evidence, and the capability contract is a separate reviewable
 * thing that outlives whichever model produced it.
 *
 * Stopping conditions, all of them explicit:
 *   - the model calls finish and the success text is actually on screen
 *   - the model calls give_up               -> escalate to a human
 *   - the step budget is exhausted          -> escalate to a human
 *   - the wall-clock budget is exhausted    -> escalate to a human
 *   - the same action fails twice           -> escalate to a human
 *   - three turns pass without progress     -> escalate to a human
 *   - policy needs an approval              -> escalate to a human
 *
 * Every one of those routes through the same broker as replay does, so "the
 * agent is stuck during discovery" and "replay hit something it cannot handle"
 * are the same code path and produce the same operator experience.
 */

import type { Observation, Action, TargetDescriptor, UiNode } from '../surface/types.ts';
import type { GuardedSurface } from '../surface/guarded.ts';
import { actionFingerprint } from '../surface/guarded.ts';
import type { Recorder } from '../evidence/recorder.ts';
import type { EscalationBroker } from '../escalation/broker.ts';
import type { Planner, PlannerRequest, PlannerToolCall } from './llm/types.ts';
import { findByHandle, renderObservation } from './render.ts';
import { describeNode, looksLikeData, type DescribeResult } from '../artifact/describe.ts';
import { captureFailureEvidence } from '../replay/engine.ts';
import type { Sensitivity, ValueType } from '../artifact/schema.ts';

export type RunParameter = {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly sensitivity: Sensitivity;
};

export type RecordedStep = {
  readonly intent: string;
  readonly action: Action;
  readonly target?: TargetDescriptor;
  readonly describe?: DescribeResult;
  /** Name of the run parameter this step's value came from, if any. */
  readonly parameter?: string;
  readonly locationBefore: string;
  readonly locationAfter: string;
  readonly titleAfter: string;
  /** Message of a modal the action raised, if any. Becomes the checkpoint. */
  readonly dialogAfter?: string;
  /**
   * Short, non-data text that appeared as a result of this action. The compiler
   * turns these into the step's checkpoint: the cheapest honest proof that the
   * click did what its intent said it would.
   */
  readonly newTexts: readonly string[];
};

export type DeclaredOutput = {
  readonly name: string;
  readonly type: ValueType;
  readonly description: string;
  readonly sensitivity: Sensitivity;
  readonly target: TargetDescriptor;
  readonly property: 'text' | 'value' | 'name' | 'location';
  readonly rawSample: string;
  readonly describe: DescribeResult;
};

export type DeclaredOutcome = {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly detectText: string;
  readonly severity: 'info' | 'warning';
  readonly seenAtStep: number;
};

export type DiscoveryStatus = 'succeeded' | 'gave_up' | 'budget_exhausted' | 'aborted' | 'failed';

export type DiscoveryResult = {
  readonly status: DiscoveryStatus;
  readonly goal: string;
  readonly entrypoint: string;
  readonly steps: readonly RecordedStep[];
  readonly outputs: readonly DeclaredOutput[];
  readonly outcomes: readonly DeclaredOutcome[];
  readonly parameters: readonly RunParameter[];
  readonly successText?: string;
  readonly summary?: string;
  readonly finalLocation: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly interventions: readonly string[];
  readonly durationMs: number;
  readonly planner: { provider: string; model: string };
};

export type TranscriptEntry = {
  readonly turn: number;
  readonly screenDigest: string;
  readonly reasoning?: string;
  readonly calls: readonly PlannerToolCall[];
  readonly usage?: unknown;
};

export type DiscoveryOptions = {
  readonly goal: string;
  readonly entrypoint: string;
  readonly parameters: readonly RunParameter[];
  readonly surface: GuardedSurface;
  readonly recorder: Recorder;
  readonly broker: EscalationBroker;
  readonly planner: Planner;
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
};

export async function discover(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const { surface, recorder, broker, planner } = opts;
  const maxSteps = opts.maxSteps ?? 25;
  /** Raised when a human explicitly chooses to continue past the budget. */
  let stepCeiling = maxSteps;
  const maxDurationMs = opts.maxDurationMs ?? 180_000;
  const startedAt = Date.now();

  const steps: RecordedStep[] = [];
  const outputs: DeclaredOutput[] = [];
  const outcomes: DeclaredOutcome[] = [];
  const transcript: TranscriptEntry[] = [];
  const history: string[] = [];
  const interventions: string[] = [];
  /** Wall-clock spent parked awaiting a human; excluded from the run budget. */
  let parkedMs = 0;

  // Secrets are registered with the redactor before anything is written, and
  // are never included in what the planner is shown.
  for (const p of opts.parameters) {
    if (p.sensitivity !== 'public') recorder.redactor.addLiteral(p.value);
  }

  recorder.emit({
    type: 'run_started',
    mode: 'discovery',
    goal: opts.goal,
    inputs: Object.fromEntries(opts.parameters.map((p) => [p.name, p.sensitivity === 'public' ? p.value : '[REDACTED]'])),
  });

  const done = (status: DiscoveryStatus, extra: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
    status,
    goal: opts.goal,
    entrypoint: opts.entrypoint,
    steps,
    outputs,
    outcomes,
    parameters: opts.parameters,
    finalLocation: extra.finalLocation ?? '',
    transcript,
    interventions,
    durationMs: Date.now() - startedAt,
    planner: { provider: planner.provider, model: planner.model },
    ...extra,
  });

  const nav = await surface.withContext({ intent: 'open the application entry point' }).act({ kind: 'navigate', url: opts.entrypoint });
  if (!nav.ok) {
    recorder.emit({ type: 'note', message: 'could not open the entry point', data: nav.failure });
    return done('failed', { finalLocation: opts.entrypoint });
  }

  let lastError: string | undefined;
  let consecutiveFailures = 0;
  let turn = 0;
  /**
   * Turns that completed without advancing anything. `consecutiveFailures` only
   * counts actions that failed; a model can also spin on calls that all succeed
   * and change nothing, and burn the whole budget doing it. Progress is a
   * recorded step, a new output or a new outcome.
   */
  let stalledTurns = 0;
  const MAX_STALLED_TURNS = 3;

  for (;;) {
    if (steps.length >= stepCeiling) {
      const res = await escalate('stuck_discovery', `step budget of ${stepCeiling} exhausted without reaching the goal`);
      if (res === 'abort') return done('budget_exhausted', { finalLocation: (await safeObserve())?.location });
      // A human chose to continue, so extend the ceiling. Without this the same
      // escalation re-fires every turn, and their decision is honoured once and
      // then re-litigated forever.
      stepCeiling = steps.length + Math.max(5, Math.ceil(maxSteps / 2));
      recorder.emit({ type: 'note', message: `step budget extended to ${stepCeiling} after a human chose "${res}"` });
      lastError = `a human operator took over and chose "${res}"; re-read the screen before continuing`;
    }
    if (Date.now() - startedAt - parkedMs > maxDurationMs) {
      await escalate('stuck_discovery', `budget of ${maxDurationMs}ms of agent time exhausted`);
      return done('budget_exhausted', { finalLocation: (await safeObserve())?.location });
    }

    const obs = await surface.observe();
    recorder.recordObservation(obs);

    // The model sees a redacted screen. Regulated data does not leave the
    // process to reach a model any more than it reaches a log file.
    const screen = recorder.redactor.text(renderObservation(obs));

    const req: PlannerRequest = {
      goal: opts.goal,
      stepBudget: { used: steps.length, max: maxSteps },
      screen,
      location: obs.location,
      history: history.slice(-12),
      parameters: opts.parameters.map((p) => ({
        name: p.name,
        value: p.sensitivity === 'secret' ? '' : p.value,
        description: p.description,
        sensitive: p.sensitivity !== 'public',
      })),
      lastError,
    };

    recorder.emit({ type: 'planner_request', model: planner.model, promptChars: screen.length, toolCount: 5 });
    let response;
    try {
      response = await planner.plan(req);
    } catch (e) {
      recorder.emit({ type: 'note', message: 'planner call failed', data: { error: e instanceof Error ? e.message : String(e) } });
      await captureFailureEvidence(surface, recorder, 'planner-error');
      return done('failed', { finalLocation: obs.location });
    }
    recorder.emit({
      type: 'planner_response',
      model: planner.model,
      text: response.reasoning,
      toolCalls: response.calls.map((c) => ({ name: c.name, input: c.input })),
      usage: response.usage,
    });
    transcript.push({ turn: ++turn, screenDigest: obs.location, reasoning: response.reasoning, calls: response.calls, usage: response.usage });

    if (!response.calls.length) {
      lastError = 'you returned no tool call; every turn must make exactly one or two tool calls';
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        const res = await escalate('stuck_discovery', 'the planner returned no actionable tool call three turns running');
        if (res === 'abort') return done('gave_up', { finalLocation: obs.location });
        consecutiveFailures = 0;
      }
      continue;
    }

    lastError = undefined;
    const progressBefore = steps.length + outputs.length + outcomes.length;
    let finished: { summary: string; successText?: string } | undefined;
    let gaveUp: string | undefined;
    let currentObs = obs;

    for (const call of response.calls) {
      if (call.name === 'give_up') {
        gaveUp = call.input.reason;
        break;
      }

      if (call.name === 'finish') {
        finished = { summary: call.input.summary, successText: call.input.successText };
        break;
      }

      if (call.name === 'declare_outcome') {
        const i = call.input;
        if (outcomes.some((o) => o.code === i.code)) {
          lastError = `business outcome "${i.code}" is already declared. Move on, or call finish if the goal is met.`;
          continue;
        }
        outcomes.push({
          code: i.code,
          title: i.title,
          description: i.description ?? '',
          detectText: i.detectText,
          severity: i.severity ?? 'info',
          seenAtStep: steps.length,
        });
        history.push(`declared business outcome ${i.code} ("${i.detectText}")`);
        recorder.emit({ type: 'note', message: `declared business outcome ${i.code}`, data: i });
        continue;
      }

      if (call.name === 'declare_output') {
        const i = call.input;
        // Re-declaring is the commonest way a live model stalls: declare_output
        // changes nothing on screen, so a model that does not notice it
        // succeeded will do it again until a budget kills the run. Observed
        // eight times in a row on one live run.
        if (outputs.some((o) => o.name === i.name)) {
          lastError =
            `output "${i.name}" is already declared and recorded -- do not declare it again. ` +
            'If you have everything the goal asked for, call finish now.';
          history.push(`output ${i.name} was already declared; the repeat was ignored`);
          continue;
        }
        const node = findByHandle(currentObs, i.ref);
        if (!node) {
          lastError = `declare_output referenced ref=${i.ref}, which is not on the current screen`;
          consecutiveFailures++;
          continue;
        }
        // volatileName: an output is by definition the thing that changes, so
        // its own text must never become its locator. See describe.ts.
        const described = describeNode(currentObs, node, i.description, {
          volatileName: true,
          volatileValues: opts.parameters.map((p) => p.value),
        });
        outputs.push({
          name: i.name,
          type: i.type,
          description: i.description,
          sensitivity: i.sensitivity ?? 'public',
          target: described.descriptor,
          property: i.property ?? 'text',
          rawSample: node.text ?? node.name,
          describe: described,
        });
        history.push(`declared output ${i.name} (${i.type})`);
        recorder.emit({ type: 'note', message: `declared output ${i.name}`, data: { type: i.type, notes: described.notes } });
        continue;
      }

      // -- act ---------------------------------------------------------------
      const i = call.input;
      const built = buildAction(currentObs, call, opts.parameters);
      if ('error' in built) {
        lastError = built.error;
        consecutiveFailures++;
        history.push(`FAILED: ${i.intent} -- ${built.error}`);
        break;
      }

      const locationBefore = currentObs.location;
      let result = await surface.withContext({ intent: i.intent }).act(built.action);

      if (!result.ok && result.failure?.reason === 'policy_approval_required') {
        const res = await escalate('approval_required', result.failure.message, built.action, i.intent);
        if (res === 'approve') {
          surface.grantApproval({ fingerprint: actionFingerprint(built.action, i.intent), interventionId: interventions.at(-1) ?? 'unknown', by: 'operator' });
          result = await surface.withContext({ intent: i.intent }).act(built.action);
        } else if (res === 'resume') {
          history.push(`a human performed "${i.intent}" manually during a handoff`);
          currentObs = await surface.observe();
          continue;
        } else {
          return done('aborted', { finalLocation: currentObs.location });
        }
      }

      if (!result.ok) {
        const msg = result.failure && 'message' in result.failure ? result.failure.message : 'action failed';
        lastError = `${i.kind} failed: ${msg}`;
        consecutiveFailures++;
        history.push(`FAILED: ${i.intent} -- ${msg}`);
        if (consecutiveFailures >= 2) {
          const res = await escalate('stuck_discovery', `two consecutive action failures; the last was: ${msg}`);
          if (res === 'abort') return done('gave_up', { finalLocation: currentObs.location });
          consecutiveFailures = 0;
        }
        break;
      }

      consecutiveFailures = 0;
      const before = currentObs;
      const after = await surface.observe();

      steps.push({
        intent: i.intent,
        action: built.action,
        target: built.target,
        describe: built.described,
        parameter: i.parameter,
        locationBefore,
        locationAfter: after.location,
        titleAfter: after.title,
        dialogAfter: after.blockingDialog?.message,
        newTexts: newTextsBetween(before, after, opts.parameters.map((p) => p.value)),
      });
      history.push(`${i.intent} (${i.kind})`);
      currentObs = after;
    }

    if (gaveUp) {
      const res = await escalate('stuck_discovery', gaveUp);
      if (res === 'abort') {
        await captureFailureEvidence(surface, recorder, 'discovery-gave-up');
        return done('gave_up', { finalLocation: currentObs.location });
      }
      lastError = `a human operator took over and chose "${res}"; re-read the screen before continuing`;
      continue;
    }

    // Did this turn move anything at all?
    if (!finished && !gaveUp) {
      const progressed = steps.length + outputs.length + outcomes.length;
      if (progressed === progressBefore) {
        stalledTurns += 1;
        recorder.emit({ type: 'note', message: `turn ${turn} advanced nothing (${stalledTurns}/${MAX_STALLED_TURNS})` });
        if (stalledTurns >= MAX_STALLED_TURNS) {
          const res = await escalate(
            'stuck_discovery',
            `${MAX_STALLED_TURNS} consecutive turns completed without recording a step, an output or an outcome`,
          );
          if (res === 'abort') {
            await captureFailureEvidence(surface, recorder, 'discovery-stalled');
            return done('gave_up', { finalLocation: currentObs.location });
          }
          stalledTurns = 0;
        }
      } else {
        stalledTurns = 0;
      }
    }

    if (finished) {
      const final = await surface.observe();
      // Trust but verify: the goal has to be visible, not merely asserted.
      if (finished.successText && !final.text.toLowerCase().includes(finished.successText.toLowerCase())) {
        lastError = `you called finish with successText ${JSON.stringify(finished.successText)}, but that text is not on the current screen`;
        recorder.emit({ type: 'note', message: 'rejected a premature finish', data: { successText: finished.successText } });
        continue;
      }
      recorder.emit({ type: 'note', message: 'goal reached', data: finished });
      return done('succeeded', { summary: finished.summary, successText: finished.successText, finalLocation: final.location });
    }
  }

  // -------------------------------------------------------------------------

  async function safeObserve(): Promise<Observation | undefined> {
    return surface.observe().catch(() => undefined);
  }

  async function escalate(
    reason: 'stuck_discovery' | 'approval_required',
    why: string,
    pendingAction?: Action,
    intent?: string,
  ): Promise<'abort' | 'resume' | 'approve' | 'retry_step' | 'skip_step' | 'reject'> {
    const obs = await safeObserve();
    const parkedFrom = Date.now();
    const res = await broker.raise({
      reason,
      why,
      mode: 'discovery',
      goal: opts.goal,
      stepIntent: intent,
      stepIndex: steps.length,
      stepTotal: maxSteps,
      pendingAction,
      observation: obs,
    });
    // Time a human spent deciding is not time the agent spent flailing.
    parkedMs += Date.now() - parkedFrom;
    interventions.push(res.interventionId);
    if (res.decision === 'abort' || res.decision === 'reject') return 'abort';
    return res.decision;
  }
}

/**
 * Text that appeared as a result of an action and is safe to assert on later.
 *
 * "Any text that is new" produces checkpoints like
 * `text_present("NameDELACROIX, RENE MStatusACTIVE")`, which passes on the
 * recording and fails on every other member. Three filters stop that:
 *
 *   1. Nothing from inside a table cell: in a table-laid-out legacy app, text in
 *      a cell is record data and text outside one is screen chrome. A heuristic,
 *      applied at record time only -- the checkpoint it produces is plain data a
 *      reviewer can see and change.
 *   2. Nothing data-shaped, and nothing containing a run parameter.
 *   3. Screen titles trimmed at their separator, so "Member Detail - 100234"
 *      becomes "Member Detail". The tail is record-specific; the head is the
 *      screen identity.
 */
function newTextsBetween(before: Observation, after: Observation, volatileValues: readonly string[]): string[] {
  const seen = new Set(before.nodes.map((n) => screenTitle(n.name || n.text || '')).filter(Boolean));
  const out: string[] = [];
  for (const n of after.nodes) {
    if (n.role === 'cell' || n.role === 'row' || n.role === 'columnheader' || n.role === 'rowheader') continue;
    if (/\b(td|th)\b/.test(n.native?.cssPath ?? '')) continue;
    const t = screenTitle(n.name || n.text || '');
    if (!t || seen.has(t)) continue;
    if (t.length < 6 || t.length > 60) continue;
    if (looksLikeData(t)) continue;
    if (volatileValues.some((v) => v && v.length >= 3 && t.includes(v))) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

/** "Member Detail - 100234" -> "Member Detail". Keeps the identity, drops the record. */
function screenTitle(raw: string): string {
  const t = raw.trim();
  const cut = t.split(/\s+[\u2014\u2013-]\s+/)[0]!.trim();
  return cut.length >= 6 ? cut : t;
}

type BuiltAction =
  | { action: Action; target?: TargetDescriptor; described?: DescribeResult }
  | { error: string };

function buildAction(obs: Observation, call: Extract<PlannerToolCall, { name: 'act' }>, params: readonly RunParameter[]): BuiltAction {
  const i = call.input;

  if (i.kind === 'navigate') {
    if (!i.url) return { error: 'navigate requires a url' };
    return { action: { kind: 'navigate', url: i.url } };
  }
  if (i.kind === 'answer_dialog') return { action: { kind: 'answer_dialog', accept: i.accept ?? true } };
  if (i.kind === 'wait') return { action: { kind: 'wait', ms: Math.min(i.ms ?? 500, 5_000) } };
  if (i.kind === 'press' && !i.ref) return { action: { kind: 'press', keys: i.keys ?? 'Enter' } };

  if (!i.ref) return { error: `${i.kind} requires a ref from the current screen` };
  const node: UiNode | undefined = findByHandle(obs, i.ref);
  if (!node) return { error: `ref=${i.ref} is not on the current screen; re-read the screen dump and use a ref shown there` };

  // The parameter's value is authoritative over whatever the model retyped: a
  // model that transcribes "100234" as "100243" would otherwise bake the typo
  // into the recording as a literal.
  const ACTIONABLE_ROLES = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem'];
  if (['click', 'fill', 'select', 'press'].includes(i.kind) && !ACTIONABLE_ROLES.includes(node.role)) {
    return {
      error:
        `ref=${i.ref} is a "${node.role}"${node.name ? ` ("${node.name}")` : ''}, which is not something you can ${i.kind}. ` +
        `Handles marked read= are values, not controls; look for a ref= handle instead -- often the one immediately after this line.`,
    };
  }
  if ((i.kind === 'fill' || i.kind === 'select') && !['textbox', 'searchbox', 'combobox', 'listbox'].includes(node.role)) {
    return { error: `ref=${i.ref} is a "${node.role}", so it cannot accept typed input. Find the field itself.` };
  }

  const declared = i.parameter ? params.find((p) => p.name === i.parameter) : undefined;
  const value = declared ? declared.value : (i.value ?? '');

  const described = describeNode(obs, node, i.intent, {
    volatileValues: params.map((p) => p.value),
  });
  const target = described.descriptor;

  switch (i.kind) {
    case 'click': return { action: { kind: 'click', target }, target, described };
    case 'fill': return { action: { kind: 'fill', target, value, secret: declared?.sensitivity === 'secret' }, target, described };
    case 'select': return { action: { kind: 'select', target, value }, target, described };
    case 'press': return { action: { kind: 'press', keys: i.keys ?? 'Enter', target }, target, described };
    default: return { error: `unsupported action kind "${i.kind}"` };
  }
}
