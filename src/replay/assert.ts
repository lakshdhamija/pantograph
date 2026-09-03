/**
 * Assertion evaluation.
 *
 * One evaluator serves four jobs, which is the point: checkpoints after a step,
 * gates before a step, business-outcome detectors, and recovery detectors are
 * all the same predicate language. That keeps the error taxonomy declarative --
 * "no such member" is detected by exactly the same machinery that verifies the
 * happy path, so the two cannot drift apart.
 *
 * Nothing here calls a model. That is what "deterministic replay" means.
 */

import type { Observation, Portability, ResolveFailure, Surface, TargetDescriptor } from '../surface/types.ts';
import { describeMatcher, describeTarget, isResolveFailure, matches } from '../surface/types.ts';
import { resolveTarget } from '../surface/resolve.ts';
import type { Assertion } from '../artifact/schema.ts';

export type AssertionResult = { readonly passed: boolean; readonly detail: string };

export type EvalOptions = { readonly portabilityFloor?: Portability };

export function evaluateAssertion(obs: Observation, a: Assertion, opts: EvalOptions = {}): AssertionResult {
  switch (a.kind) {
    case 'location_matches': {
      const passed = new RegExp(a.pattern).test(obs.location);
      return { passed, detail: `location ${JSON.stringify(obs.location)} ${passed ? 'matches' : 'does not match'} /${a.pattern}/` };
    }

    case 'text_present':
    case 'text_absent': {
      const want = a.kind === 'text_present';
      if (a.container?.length) {
        const inScope = obs.nodes.filter((n) => n.containerPath.join('/') === a.container!.join('/'));
        // "Not present in a container I cannot see" is not absence, it is
        // ignorance. A frame that is mid-navigation, or one truncated out of
        // the observation, would otherwise satisfy every `text_absent` in the
        // capability -- and absence assertions are the cheapest to pass, so the
        // engine would take that as proof the screen had cleared.
        if (inScope.length === 0) {
          return {
            passed: false,
            detail: `cannot evaluate: container [${a.container.join('/')}] has no nodes in this observation, so neither presence nor absence of ${describeMatcher(a.text)} can be established`,
          };
        }
        const found = matches(a.text, inScope.map((n) => `${n.name} ${n.text ?? ''}`).join(' '));
        return { passed: found === want, detail: `text ${describeMatcher(a.text)} ${found ? 'found' : 'not found'} in [${a.container.join('/')}]` };
      }
      const found = matches(a.text, obs.text);
      return { passed: found === want, detail: `text ${describeMatcher(a.text)} ${found ? 'found' : 'not found'}` };
    }

    case 'element_present':
    case 'element_absent':
    case 'element_enabled': {
      const r = resolveTarget(obs, a.target, { portabilityFloor: opts.portabilityFloor });
      const present = !isResolveFailure(r);
      if (a.kind === 'element_absent') {
        if (present) return { passed: false, detail: `${describeTarget(a.target)} is present but should be absent` };
        // Only `no_match` is evidence of absence. `ambiguous` means the control
        // is on screen more than once; `portability_floor` means we were not
        // allowed to look. Reporting either as "absent as expected" turns an
        // inability to answer into a passing checkpoint.
        const reason = (r as ResolveFailure).reason;
        if (reason !== 'no_match') {
          return {
            passed: false,
            detail: `cannot assert absence of ${describeTarget(a.target)}: resolution returned "${reason}" (${(r as ResolveFailure).message})`,
          };
        }
        return { passed: true, detail: `${describeTarget(a.target)} is absent as expected` };
      }
      if (!present) {
        return { passed: false, detail: `${describeTarget(a.target)}: ${(r as { message: string }).message}` };
      }
      if (a.kind === 'element_enabled') {
        const enabled = r.node.enabled;
        return { passed: enabled, detail: `${describeTarget(a.target)} is ${enabled ? 'enabled' : 'disabled'}` };
      }
      return { passed: true, detail: `${describeTarget(a.target)} present via ${r.strategyKind}${r.degraded ? ' (degraded)' : ''}` };
    }

    case 'value_matches': {
      const r = resolveTarget(obs, a.target, { portabilityFloor: opts.portabilityFloor });
      if (isResolveFailure(r)) return { passed: false, detail: `${describeTarget(a.target)}: ${r.message}` };
      const actual = r.node.value ?? r.node.text ?? r.node.name;
      const passed = matches(a.value, actual);
      return { passed, detail: `${describeTarget(a.target)} value ${JSON.stringify(actual)} vs ${describeMatcher(a.value)}` };
    }

    case 'dialog_present': {
      const d = obs.blockingDialog;
      if (!d) return { passed: false, detail: 'no dialog is open' };
      const passed = matches(a.message, d.message);
      return { passed, detail: `${d.kind} dialog: ${JSON.stringify(d.message)}` };
    }

    case 'all': {
      const results = a.of.map((x) => evaluateAssertion(obs, x, opts));
      const failed = results.filter((r) => !r.passed);
      return { passed: failed.length === 0, detail: failed.length ? `all: ${failed.map((f) => f.detail).join('; ')}` : `all ${results.length} held` };
    }

    case 'any': {
      const results = a.of.map((x) => evaluateAssertion(obs, x, opts));
      const ok = results.find((r) => r.passed);
      return { passed: Boolean(ok), detail: ok ? `any: ${ok.detail}` : `any: none of ${results.length} held (${results.map((r) => r.detail).join('; ')})` };
    }

    case 'not': {
      const r = evaluateAssertion(obs, a.of, opts);
      return { passed: !r.passed, detail: `not(${r.detail})` };
    }
  }
}

export type WaitResult = AssertionResult & {
  readonly observation: Observation;
  readonly waitedMs: number;
  readonly polls: number;
  /** True when polling stopped early because a definitive answer appeared. */
  readonly abortedEarly: boolean;
};

/**
 * Poll until the assertion holds or the budget runs out.
 *
 * This -- not a sleep, and not the surface's settle() heuristic -- is how the
 * replay engine knows a step worked. It also means a slow backend is absorbed
 * by the step's own timeout rather than producing a spurious "element not
 * found", which is the difference between a transient condition and a failure.
 */
export async function waitForAssertion(
  surface: Pick<Surface, 'observe'>,
  assertion: Assertion,
  timeoutMs: number,
  opts: EvalOptions & {
    pollMs?: number;
    /**
     * Stop waiting early because the screen already carries a definitive answer.
     *
     * Without this, a capability that hits "NO MATCHING RECORDS FOUND" sits
     * through its entire 12-second checkpoint budget before triage gets a look
     * at a screen that was never going to change. Patience is for states that
     * might still resolve; a business outcome or an error page is not one.
     */
    abortWhen?: (obs: Observation) => string | undefined;
  } = {},
): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let polls = 0;
  let last: AssertionResult = { passed: false, detail: 'never evaluated' };
  let abortedEarly = false;
  let obs = await surface.observe();

  for (;;) {
    polls++;
    last = evaluateAssertion(obs, assertion, opts);
    if (last.passed) break;
    const abort = opts.abortWhen?.(obs);
    if (abort) {
      abortedEarly = true;
      last = { passed: false, detail: `${last.detail}; stopped waiting: ${abort}` };
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
    obs = await surface.observe();
  }

  return { ...last, observation: obs, waitedMs: Date.now() - started, polls, abortedEarly };
}

/** Compact, reviewable rendering of an assertion, for logs and error messages. */
export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'location_matches': return `location ~ /${a.pattern}/`;
    case 'text_present': return `text present ${describeMatcher(a.text)}${a.container?.length ? ` in [${a.container.join('/')}]` : ''}`;
    case 'text_absent': return `text absent ${describeMatcher(a.text)}`;
    case 'element_present': return `element present ${describeTarget(a.target)}`;
    case 'element_absent': return `element absent ${describeTarget(a.target)}`;
    case 'element_enabled': return `element enabled ${describeTarget(a.target)}`;
    case 'value_matches': return `${describeTarget(a.target)} value ${describeMatcher(a.value)}`;
    case 'dialog_present': return `dialog present ${a.message ? describeMatcher(a.message) : ''}`;
    case 'all': return `all(${a.of.map(describeAssertion).join(', ')})`;
    case 'any': return `any(${a.of.map(describeAssertion).join(', ')})`;
    case 'not': return `not(${describeAssertion(a.of)})`;
  }
}
