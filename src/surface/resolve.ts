/**
 * Locator resolution.
 *
 * Pure: `(Observation, TargetDescriptor) -> ResolvedTarget | ResolveFailure`.
 * No Playwright, no DOM, no I/O -- which means the entire targeting strategy is
 * unit-testable against synthetic observations, and identical code will serve a
 * desktop accessibility surface that produces the same `UiNode` shape.
 *
 * The model is a LADDER, not a single selector. A descriptor lists strategies
 * from most portable to least. Resolution walks the ladder and stops at the
 * first rung that identifies exactly one node. Two consequences matter:
 *
 *   - Determinism. "Exactly one" is the bar. A strategy that matches three
 *     nodes does not get to pick one; it falls through.
 *   - Drift detection. Which rung won is returned. Winning on rung 0 every time
 *     is health; falling to rung 2 is the earliest possible warning that the UI
 *     moved, and it is counted in the artifact's stability record long before
 *     the capability actually breaks.
 */

import type {
  ContainerPath,
  LocatorStrategy,
  Observation,
  Portability,
  ResolveFailure,
  ResolvedTarget,
  TargetDescriptor,
  UiNode,
  UiRole,
} from './types.ts';
import { describeTarget, matches, meetsPortabilityFloor } from './types.ts';

/** Roles that may satisfy a request for another role. Kept deliberately tight. */
const ROLE_EQUIVALENTS: Partial<Record<UiRole, readonly UiRole[]>> = {
  textbox: ['textbox', 'searchbox'],
  searchbox: ['searchbox', 'textbox'],
  combobox: ['combobox', 'listbox'],
  listbox: ['listbox', 'combobox'],
  cell: ['cell', 'columnheader', 'rowheader'],
  columnheader: ['columnheader', 'cell'],
  text: ['text', 'cell', 'heading'],
  button: ['button'],
  link: ['link'],
};

export function roleMatches(want: UiRole, got: UiRole): boolean {
  if (want === got) return true;
  return (ROLE_EQUIVALENTS[want] ?? [want]).includes(got);
}

function samePath(a: ContainerPath, b: ContainerPath): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

const cx = (n: UiNode) => (n.bbox ? n.bbox.x + n.bbox.width / 2 : NaN);
const cy = (n: UiNode) => (n.bbox ? n.bbox.y + n.bbox.height / 2 : NaN);

function vOverlap(a: UiNode, b: UiNode): boolean {
  if (!a.bbox || !b.bbox) return false;
  const top = Math.max(a.bbox.y, b.bbox.y);
  const bottom = Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height);
  const overlap = bottom - top;
  return overlap > 0 && overlap >= 0.4 * Math.min(a.bbox.height, b.bbox.height);
}

function hOverlap(a: UiNode, b: UiNode): boolean {
  if (!a.bbox || !b.bbox) return false;
  const left = Math.max(a.bbox.x, b.bbox.x);
  const right = Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width);
  const overlap = right - left;
  return overlap > 0 && overlap >= 0.4 * Math.min(a.bbox.width, b.bbox.width);
}

function contains(outer: UiNode, inner: UiNode): boolean {
  if (!outer.bbox || !inner.bbox) return false;
  const o = outer.bbox;
  const i = inner.bbox;
  return i.x >= o.x - 1 && i.y >= o.y - 1 && i.x + i.width <= o.x + o.width + 1 && i.y + i.height <= o.y + o.height + 1;
}

function distance(a: UiNode, b: UiNode): number {
  if (!a.bbox || !b.bbox) return Number.POSITIVE_INFINITY;
  return Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
}

/**
 * Candidates before any strategy runs: role, container, and visibility.
 * Exported so `describeNode` computes an ordinal index in the SAME space the
 * resolver will apply it to -- see the note on the `ordinal` rung below.
 */
export function baseCandidates(obs: Observation, t: TargetDescriptor): UiNode[] {
  return obs.nodes.filter(
    (n) => n.visible && roleMatches(t.role, n.role) && (t.container === undefined || samePath(t.container, n.containerPath)),
  );
}

type Attempt = { kind: LocatorStrategy['kind']; matches: number; note?: string; set: UiNode[] };

export type ResolveOptions = {
  readonly portabilityFloor?: Portability;
  /**
   * When a `relative` strategy finds several candidates, accept the nearest if
   * it is clearly nearest. See the comment at the call site for the rationale.
   */
  readonly relativeAmbiguityRatio?: number;
};

export function resolveTarget(
  obs: Observation,
  target: TargetDescriptor,
  opts: ResolveOptions = {},
): ResolvedTarget | ResolveFailure {
  const floor = opts.portabilityFloor ?? 'pixel';
  const base = baseCandidates(obs, target);
  const attempts: Attempt[] = [];
  let previousSet: UiNode[] = base;
  /** Did any rung before this one actually narrow anything? */
  let priorRungMatched = false;
  let anyRungRan = false;
  let allSkippedByFloor = target.strategies.length > 0;

  for (let i = 0; i < target.strategies.length; i++) {
    const strategy = target.strategies[i]!;
    if (!meetsPortabilityFloor(strategy.kind, floor)) {
      attempts.push({ kind: strategy.kind, matches: 0, note: `skipped: below portability floor "${floor}"`, set: [] });
      continue;
    }
    allSkippedByFloor = false;

    const applied = applyStrategy(obs, target, strategy, base, previousSet, { ...opts, priorRungMatched, anyRungRan });
    if (strategy.kind !== 'ordinal') {
      anyRungRan = true;
      if (applied.set.length > 0) priorRungMatched = true;
    }
    attempts.push({ kind: strategy.kind, matches: applied.set.length, note: applied.note, set: applied.set });

    if (applied.set.length === 1) {
      return {
        node: applied.set[0]!,
        strategyIndex: i,
        strategyKind: strategy.kind,
        degraded: i > 0,
        candidatesConsidered: base.length,
      };
    }
    if (applied.set.length > 1) previousSet = applied.set;
  }

  // NOTE: no last-resort pass intersecting every rung that matched something,
  // tempting as that is on the theory that two independently ambiguous
  // constraints often pin down one node between them. The rungs are documented
  // and recorded as ALTERNATIVES, and treating them as a conjunction quietly
  // changes what the artifact means. It would also override the
  // deliberate "these two candidates are too close to separate" guard in the
  // `relative` rung, and made `describeNode`'s round-trip verification pass for
  // ladders in which no single rung was ever unique. Failing here, so the
  // recorder rejects such a ladder at record time, is the honest behaviour.

  const anyMatched = attempts.some((a) => a.matches > 0);
  return {
    reason: allSkippedByFloor ? 'portability_floor' : anyMatched ? 'ambiguous' : 'no_match',
    triedStrategies: attempts.map(({ kind, matches: m, note }) => ({ kind, matches: m, note })),
    message:
      `could not uniquely resolve ${describeTarget(target)}: ` +
      (base.length === 0
        ? `no visible ${target.role} in ${target.container?.length ? `container [${target.container.join('>')}]` : 'the observation'}`
        : attempts.map((a) => `${a.kind}=${a.matches}`).join(', ')),
  };
}

function applyStrategy(
  obs: Observation,
  target: TargetDescriptor,
  strategy: LocatorStrategy,
  base: readonly UiNode[],
  previousSet: readonly UiNode[],
  opts: ResolveOptions & { priorRungMatched?: boolean; anyRungRan?: boolean },
): { set: UiNode[]; note?: string } {
  switch (strategy.kind) {
    case 'role_name':
      return { set: base.filter((n) => matches(target.name, n.name)) };

    case 'text':
      return { set: base.filter((n) => matches(strategy.text, n.text ?? n.name)) };

    case 'test_id':
      return { set: base.filter((n) => n.native?.testId === strategy.value) };

    case 'native_path':
      return { set: base.filter((n) => n.native?.cssPath === strategy.path) };

    case 'ordinal': {
      // An ordinal is a DISAMBIGUATOR, never a primary locator. If an earlier
      // rung ran and matched nothing, the constraint this index was meant to
      // narrow has vanished from the screen, and indexing the unfiltered
      // candidate set would return an arbitrary control with an `ok` result.
      // Observed: a descriptor for a button named "Post" resolving to "Cancel"
      // on a screen with no Post button.
      if (opts.anyRungRan && !opts.priorRungMatched) {
        return { set: [], note: 'refused: every earlier rung matched nothing, so there is no set to index into' };
      }
      const source = previousSet.length ? previousSet : base;
      const pick = source[strategy.index];
      return { set: pick ? [pick] : [], note: `index ${strategy.index} of ${source.length}` };
    }

    case 'region': {
      const tol = strategy.tolerancePx ?? 12;
      const b = strategy.bbox;
      return {
        set: base.filter(
          (n) =>
            n.bbox !== undefined &&
            Math.abs(n.bbox.x - b.x) <= tol &&
            Math.abs(n.bbox.y - b.y) <= tol &&
            Math.abs(n.bbox.width - b.width) <= tol * 2 &&
            Math.abs(n.bbox.height - b.height) <= tol * 2,
        ),
      };
    }

    case 'relative': {
      const anchorResult = resolveTarget(obs, strategy.anchor, opts);
      if ('reason' in anchorResult) {
        return { set: [], note: `anchor unresolved: ${anchorResult.message}` };
      }
      const anchor = anchorResult.node;
      // Relations are geometric and therefore surface-independent: the same
      // rule works on a DOM table, a desktop form, and an OCR'd terminal.
      // Cross-container relations are never valid -- a control in the `nav`
      // frame is not "in the same row" as a label in `content`.
      let set = base.filter((n) => n.handle !== anchor.handle && samePath(n.containerPath, anchor.containerPath));
      switch (strategy.direction) {
        case 'same_row': set = set.filter((n) => vOverlap(n, anchor)); break;
        case 'same_column': set = set.filter((n) => hOverlap(n, anchor)); break;
        case 'right_of': set = set.filter((n) => vOverlap(n, anchor) && cx(n) > cx(anchor)); break;
        case 'left_of': set = set.filter((n) => vOverlap(n, anchor) && cx(n) < cx(anchor)); break;
        case 'below': set = set.filter((n) => hOverlap(n, anchor) && cy(n) > cy(anchor)); break;
        case 'above': set = set.filter((n) => hOverlap(n, anchor) && cy(n) < cy(anchor)); break;
        case 'within': set = set.filter((n) => contains(anchor, n)); break;
      }
      if (strategy.maxDistancePx !== undefined) {
        set = set.filter((n) => distance(n, anchor) <= strategy.maxDistancePx!);
      }
      if (set.length <= 1) return { set };

      // Several candidates satisfy the relation. "The textbox in the same row as
      // 'Member Number'" plainly means the nearest one, so accept the nearest --
      // but only when it is unambiguously nearest. If the runner-up is within
      // `ratio` of the same distance, stay ambiguous and let a later strategy
      // decide, rather than silently guessing.
      const ratio = opts.relativeAmbiguityRatio ?? 0.75;
      const sorted = [...set].sort((a, b) => distance(a, anchor) - distance(b, anchor));
      const d0 = distance(sorted[0]!, anchor);
      const d1 = distance(sorted[1]!, anchor);
      if (d0 < d1 * ratio) return { set: [sorted[0]!], note: `nearest of ${set.length} (${d0.toFixed(0)}px vs ${d1.toFixed(0)}px)` };
      return { set: sorted, note: `${set.length} candidates, nearest two too close to separate (${d0.toFixed(0)}px vs ${d1.toFixed(0)}px)` };
    }
  }
}
