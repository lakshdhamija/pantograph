/**
 * Descriptor synthesis: turn "the model pointed at this node" into a durable,
 * portable, self-verified locator ladder.
 *
 * The model never writes a selector; it points at a node by handle, and this
 * module derives how to find that node again. So artifact quality stops
 * depending on prompt luck, and every descriptor can be resolved back against
 * the observation it came from and required to return the same node, uniquely.
 * A descriptor that does not round-trip is never written to an artifact.
 */

import type { LocatorStrategy, Observation, TargetDescriptor, UiNode } from '../surface/types.ts';
import { STRATEGY_PORTABILITY, eq, isResolveFailure, type Portability } from '../surface/types.ts';
import { baseCandidates, resolveTarget } from '../surface/resolve.ts';

export type DescribeResult = {
  readonly descriptor: TargetDescriptor;
  /**
   * The weakest portability class among the rungs actually emitted. Not a
   * boolean: a `test_id` win is portable to every *web* surface but not beyond,
   * and reporting it as "portable" makes the compiler stamp `any_surface`, after
   * which replay refuses the very rung the recorder chose.
   */
  readonly portability: Portability;
  /** Convenience: true when the ladder is not portable to every surface. */
  readonly usedNonPortable: boolean;
  readonly notes: readonly string[];
};

const PORTABILITY_ORDER: Portability[] = ['pixel', 'this_dom', 'any_web', 'any_surface'];

/** The weakest class among the rungs in a ladder. */
function ladderPortability(strategies: readonly LocatorStrategy[]): Portability {
  let weakest: Portability = 'any_surface';
  for (const s of strategies) {
    const cls = STRATEGY_PORTABILITY[s.kind];
    if (PORTABILITY_ORDER.indexOf(cls) < PORTABILITY_ORDER.indexOf(weakest)) weakest = cls;
  }
  return weakest;
}

export type DescribeOptions = {
  /**
   * Set for extraction targets. The thing you are reading is by definition the
   * thing that changes, so its own text must never become its identity.
   */
  readonly volatileName?: boolean;
  /**
   * Concrete values supplied as run parameters for this recording.
   *
   * Keying a locator on a parameter's value is not a defect: the compiler
   * substitutes `{{inputs.x}}` in its place, so the locator varies with the
   * input. "The button beside the card titled {{inputs.productName}}" is right.
   * What is still refused is data that is not a parameter -- a balance, another
   * member's name -- and a test id that embeds a parameter in slug form, which
   * cannot be templated.
   */
  readonly volatileValues?: readonly string[];
};

/**
 * Data-shaped names are not identities.
 *
 * The savings balance renders as "18,234.55", so a naive recorder produces
 * `cell with name "18,234.55"` -- which resolves perfectly on the machine that
 * recorded it and returns "no such element" the first time it replays for a
 * different member. If two members share a balance it returns the wrong cell
 * rather than failing.
 *
 * So a data-shaped name disqualifies the `role_name` rung, and the ladder is
 * forced onto a relational anchor ("the cell to the right of the one reading
 * REGULAR SHARE (SAVINGS)"), which describes structure rather than contents.
 */
const DATA_SHAPED = [
  /^[$€£]?[\d,]+\.?\d*%?$/,            // 18,234.55 / 1000 / 12.5%
  /^\d{4}-\d{2}-\d{2}$/,               // 2016-03-11
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,      // 03/11/2016
  /^[A-Z]{0,3}[-\s]?\d[\d-]{3,}$/,     // 100234-02, 555-010-0234
  /^[A-Z]{1,6}[-_](?=[A-Z0-9]*\d)[A-Z0-9]{3,}$/, // CT-9F3A21C4, SEC-4031, VAL-3004
];

/**
 * Common slug forms of a value, so the volatility check catches a parameter
 * that has been reshaped rather than quoted verbatim: a storefront's
 * `data-test="add-to-cart-sauce-labs-backpack"` is keyed on record data just as
 * surely as the raw product name.
 */
function valueVariants(value: string): string[] {
  const v = value.trim();
  if (v.length < 3) return [];
  const lower = v.toLowerCase();
  return [...new Set([v, lower, lower.replace(/[^a-z0-9]+/g, '-'), lower.replace(/[^a-z0-9]+/g, '_'), lower.replace(/[^a-z0-9]+/g, '')])];
}

function embedsVolatileValue(subject: string, volatileValues: readonly string[]): string | undefined {
  const hay = subject.toLowerCase();
  for (const raw of volatileValues) {
    for (const variant of valueVariants(raw)) {
      if (variant.length >= 3 && hay.includes(variant.toLowerCase())) return raw;
    }
  }
  return undefined;
}

export function looksLikeData(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  return DATA_SHAPED.some((re) => re.test(s));
}

const MAX_ANCHOR_DISTANCE = 420;

/** Text-bearing nodes usable as anchors for relational targeting. */
function anchorCandidates(obs: Observation, node: UiNode): UiNode[] {
  if (!node.bbox) return [];
  return obs.nodes.filter(
    (n) =>
      n.handle !== node.handle &&
      n.visible &&
      n.bbox !== undefined &&
      n.containerPath.join('/') === node.containerPath.join('/') &&
      ['cell', 'columnheader', 'rowheader', 'text', 'heading'].includes(n.role) &&
      (n.name || n.text || '').trim().length >= 2 &&
      (n.name || n.text || '').trim().length <= 60 &&
      // Avoid anchoring to a node that merely contains the target: a wrapping
      // <td> would make the descriptor circular and geometrically useless.
      !containsBox(n, node),
  );
}

function containsBox(outer: UiNode, inner: UiNode): boolean {
  if (!outer.bbox || !inner.bbox) return false;
  const o = outer.bbox;
  const i = inner.bbox;
  return i.x >= o.x - 1 && i.y >= o.y - 1 && i.x + i.width <= o.x + o.width + 1 && i.y + i.height <= o.y + o.height + 1;
}

function labelText(n: UiNode): string {
  return (n.name || n.text || '').trim();
}

function isUnique(obs: Observation, descriptor: TargetDescriptor, node: UiNode): boolean {
  const r = resolveTarget(obs, descriptor);
  return !isResolveFailure(r) && r.node.handle === node.handle;
}

/**
 * Build the ladder.
 *
 * Rung order is by expected robustness on the recorded surface, not strictly by
 * portability. Those disagree in one place: `test_id` is web-only, so less
 * portable than the relational rung below it, but placed above it because an
 * identifier a developer declared for automation beats one inferred from
 * geometry. A grid with six identical "Add to cart" buttons is the case. The
 * cost is recorded rather than hidden: the capability's `portabilityFloor`
 * drops to `any_web`.
 *
 *   role + accessible name        any surface, survives a re-skin
 *   test id                       web-only, exact where geometry is a guess
 *   relative to a labelled anchor the workhorse for table-laid-out screens
 *   own text                      links and buttons identified by their label
 *   ordinal                       a disambiguator, never a primary
 *   native path (CSS)             last resort, explicitly this-DOM-only
 */
export function describeNode(obs: Observation, node: UiNode, rationale?: string, opts: DescribeOptions = {}): DescribeResult {
  const notes: string[] = [];
  const container = node.containerPath.length ? [...node.containerPath] : undefined;
  const rawName = node.name.trim();
  const strategies: LocatorStrategy[] = [];

  const matchedParameter = opts.volatileValues?.find((v) => v && v.length >= 3 && rawName.includes(v));
  const volatile = Boolean(opts.volatileName) || looksLikeData(rawName);
  if (volatile && rawName) {
    notes.push(`name "${rawName}" is data-shaped; refusing to key the locator on record data`);
  }
  if (matchedParameter && !volatile) {
    // Kept, and flagged so a reviewer can see the locator is parameterised.
    notes.push(`name "${rawName}" carries the run parameter value "${matchedParameter}"; the compiler will template it`);
  }
  // A volatile name is dropped from the descriptor entirely, not merely skipped
  // as a strategy, so a reviewer is never shown a matcher the engine ignores.
  const name = volatile ? '' : rawName;

  const base = (extra: LocatorStrategy[]): TargetDescriptor => ({
    role: node.role,
    name: name ? eq(name) : undefined,
    container,
    strategies: extra,
    observedAt: {
      name: node.name || undefined,
      text: node.text || undefined,
      tag: node.native?.tag,
      nativePath: node.native?.cssPath,
      bbox: node.bbox,
    },
    rationale,
  });

  // Rung 1: role + accessible name.
  if (name) {
    strategies.push({ kind: 'role_name' });
    if (isUnique(obs, base(strategies), node)) {
      return { descriptor: base(strategies), ...portabilityOf(strategies), notes: ['identified by role and accessible name'] };
    }
    notes.push(`role+name "${name}" is not unique among ${node.role} nodes here`);
  } else {
    notes.push('control has no accessible name; relational targeting is required');
  }

  // Rung 2: developer-provided test id, if the app happens to have one AND it is
  // not itself keyed on record data.
  const testIdEmbeds = node.native?.testId ? embedsVolatileValue(node.native.testId, opts.volatileValues ?? []) : undefined;
  if (testIdEmbeds) {
    notes.push(`test id "${node.native!.testId}" embeds the run value "${testIdEmbeds}"; refusing it, or the capability would ignore that parameter`);
  }
  if (node.native?.testId && !testIdEmbeds) {
    strategies.push({ kind: 'test_id', value: node.native.testId });
    if (isUnique(obs, base(strategies), node)) {
      return { descriptor: base(strategies), ...portabilityOf(strategies), notes: [...notes, 'identified by test id'] };
    }
  }

  // Rung 3: relative to the nearest labelled anchor. This is what makes a
  // nameless <input name="f_mbr"> in a layout table addressable at all.
  const anchorPick = pickAnchor(obs, node, opts.volatileValues ?? []);
  if (anchorPick) {
    strategies.push(anchorPick.strategy);
    const anchorParameter = (opts.volatileValues ?? []).find((v) => v && v.length >= 3 && anchorPick.label.includes(v));
    notes.push(
      `anchored ${anchorPick.strategy.direction.replace('_', ' ')} "${anchorPick.label}"` +
        (anchorParameter ? ` -- which carries the run parameter value "${anchorParameter}", so the compiler will template it and the anchor varies with the input` : ''),
    );
    if (isUnique(obs, base(strategies), node)) {
      return { descriptor: base(strategies), ...portabilityOf(strategies), notes };
    }
  }

  // Rung 4: the node's own visible text. Same volatility rule applies.
  const own = volatile ? '' : (node.text ?? '').trim();
  if (own && own !== name) {
    strategies.push({ kind: 'text', text: eq(own) });
    if (isUnique(obs, base(strategies), node)) {
      return { descriptor: base(strategies), ...portabilityOf(strategies), notes: [...notes, 'identified by its own text'] };
    }
  }

  // Rung 5: ordinal, as a disambiguator over whatever narrowed things furthest.
  // The index MUST be computed over the same candidate set the resolver will
  // index into. Filtering on strict role equality here while the resolver
  // widens by role equivalence means a page that later gains a `searchbox`
  // above three `textbox`es shifts every recorded index by one, silently.
  const peers = baseCandidates(obs, { role: node.role, container, strategies: [] });
  const idx = peers.findIndex((n) => n.handle === node.handle);
  if (idx >= 0) {
    strategies.push({ kind: 'ordinal', index: idx });
    if (isUnique(obs, base(strategies), node)) {
      notes.push(`disambiguated by position (${idx + 1} of ${peers.length} ${node.role} controls in this container)`);
      return { descriptor: base(strategies), ...portabilityOf(strategies), notes };
    }
    strategies.pop();
  }

  // Rung 6: give up on portability and pin the DOM path. Recorded explicitly so
  // a reviewer can see this capability will not survive a surface change, and so
  // `policy.portabilityFloor` can refuse it at replay time.
  if (node.native?.cssPath) {
    strategies.push({ kind: 'native_path', path: node.native.cssPath });
    const descriptor = base(strategies);
    if (isUnique(obs, descriptor, node)) {
      return {
        descriptor,
        ...portabilityOf(strategies),
        notes: [...notes, 'FELL BACK to a DOM path: nothing portable identified this control uniquely'],
      };
    }
  }

  // Nothing worked. Return the best ladder we have and let the caller decide;
  // the compiler treats this as a recording defect rather than writing it out.
  return {
    descriptor: base(strategies.length ? strategies : [{ kind: 'role_name' }]),
    ...portabilityOf(strategies),
    notes: [...notes, 'NO strategy uniquely identified this control'],
  };
}

/** Both portability fields, derived from the ladder rather than asserted. */
function portabilityOf(strategies: readonly LocatorStrategy[]): { portability: Portability; usedNonPortable: boolean } {
  const portability = ladderPortability(strategies);
  return { portability, usedNonPortable: portability !== 'any_surface' };
}

function pickAnchor(
  obs: Observation,
  node: UiNode,
  volatileValues: readonly string[] = [],
): { strategy: Extract<LocatorStrategy, { kind: 'relative' }>; label: string } | undefined {
  if (!node.bbox) return undefined;
  const candidates = anchorCandidates(obs, node);
  if (!candidates.length) return undefined;

  const ncx = node.bbox.x + node.bbox.width / 2;
  const ncy = node.bbox.y + node.bbox.height / 2;

  const scored = candidates
    .map((a) => {
      const acx = a.bbox!.x + a.bbox!.width / 2;
      const acy = a.bbox!.y + a.bbox!.height / 2;
      const dist = Math.hypot(ncx - acx, ncy - acy);
      const sameRow = Math.abs(ncy - acy) <= Math.max(node.bbox!.height, a.bbox!.height) * 0.6;
      // Prefer a DIRECTIONAL relation over a bare same_row one. "The cell to the
      // right of X" excludes the cell to the left of X; "in the same row as X"
      // does not, and in a four-column table that ambiguity is the difference
      // between reading the balance and reading the account number.
      const direction: 'right_of' | 'left_of' | 'below' = sameRow ? (acx < ncx ? 'right_of' : 'left_of') : 'below';
      // A label to the left on the same row is the dominant convention in form
      // and detail layouts, so it is preferred decisively rather than
      // marginally: without that, a value cell 19px above wins on raw distance
      // over the label 175px to the left, and the locator ends up depending on
      // record data twice over.
      const bonus = sameRow && acx < ncx ? -260 : sameRow ? -60 : 0;
      return { a, dist, score: dist + bonus, direction };
    })
    .filter((s) => s.dist <= MAX_ANCHOR_DISTANCE)
    .sort((x, y) => x.score - y.score);

  for (const s of scored.slice(0, 10)) {
    const label = labelText(s.a);
    // Data-shaped labels are refused; a label carrying a run parameter is kept,
    // because it is templated and the anchor then varies with the input, which
    // is how one capability addresses whichever record the caller asked for.
    if (looksLikeData(label)) continue;

    const anchor: TargetDescriptor = {
      role: s.a.role,
      name: eq(label),
      container: node.containerPath.length ? [...node.containerPath] : undefined,
      strategies: [{ kind: 'role_name' }],
    };
    // The anchor itself must be unambiguous, or the relation is meaningless.
    const anchorResolved = resolveTarget(obs, anchor);
    if (isResolveFailure(anchorResolved) || anchorResolved.node.handle !== s.a.handle) continue;

    // VERIFY, do not assume. The nearest label is often a column header, and
    // "the cell below the Current Balance header" resolves to the FIRST row for
    // every member -- correct-looking on the recording, wrong on replay. The
    // only way to catch that is to resolve the relation we are about to record
    // and check it comes back to the node we started from.
    const slack = s.direction === 'below' ? 1.8 : 1.35;
    for (const attempt of [s.direction, 'same_row' as const]) {
      if (attempt === 'same_row' && s.direction === 'below') continue;
      const strategy: Extract<LocatorStrategy, { kind: 'relative' }> = {
        kind: 'relative',
        anchor,
        direction: attempt,
        maxDistancePx: Math.ceil(s.dist * slack),
      };
      const probe: TargetDescriptor = {
        role: node.role,
        container: node.containerPath.length ? [...node.containerPath] : undefined,
        strategies: [strategy],
      };
      const r = resolveTarget(obs, probe);
      if (!isResolveFailure(r) && r.node.handle === node.handle) return { strategy, label };
    }
  }
  return undefined;
}
