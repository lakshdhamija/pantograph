/**
 * THE SEAM.
 *
 * Everything above this file -- artifacts, replay, the agent loop, escalation --
 * is written against these types and never touches Playwright, a DOM, or CSS.
 * The vocabulary is the *accessibility* vocabulary, because that is the one
 * description of a UI that exists on every surface we care about:
 *
 *   web (modern)      ARIA roles from the browser a11y tree
 *   web (legacy)      same tree; roles inferred from tag semantics, and many
 *                     controls have an empty accessible name -- which is why
 *                     relational targeting below is mandatory, not a nicety
 *   desktop (macOS)   AXRole / AXTitle
 *   desktop (Windows) UIA ControlType / Name
 *   terminal/Citrix   OCR + coordinates, via the `region` strategy only
 *
 * So an artifact describes intent ("the textbox in the row labelled Member
 * Number") rather than implementation ("input[name=f_mbr]").
 */

/** Normalised control roles. Intersection of ARIA, macOS AX, and Windows UIA. */
export type UiRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'checkbox'
  | 'radio'
  | 'tab'
  | 'menuitem'
  | 'cell'
  | 'columnheader'
  | 'rowheader'
  | 'row'
  | 'table'
  | 'heading'
  | 'text'
  | 'image'
  | 'dialog'
  | 'alert'
  | 'form'
  | 'group'
  | 'document'
  | 'unknown';

export type BBox = { x: number; y: number; width: number; height: number };

/** How a string in a descriptor is compared against a live accessible name. */
export type StringMatcher =
  | { op: 'equals'; value: string; caseSensitive?: boolean }
  | { op: 'contains'; value: string; caseSensitive?: boolean }
  | { op: 'startsWith'; value: string; caseSensitive?: boolean }
  | { op: 'regex'; value: string; flags?: string };

/**
 * A container path. On the web this is the frame chain (frameset/iframe names);
 * on desktop it is the window/pane chain. Empty means "the root document".
 */
export type ContainerPath = readonly string[];

/** One node of a normalised UI snapshot. Surface-independent. */
export type UiNode = {
  /** Stable only within a single Observation. Never persisted into artifacts. */
  readonly handle: string;
  readonly role: UiRole;
  readonly name: string;
  readonly value?: string;
  readonly text?: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly focused?: boolean;
  readonly containerPath: ContainerPath;
  readonly bbox?: BBox;
  /**
   * Surface-native identifiers, kept only for the *current* observation so the
   * agent can act, and for recording `observedAt` evidence. The replay engine
   * is allowed to use these only through an explicitly non-portable strategy.
   */
  readonly native?: { readonly cssPath?: string; readonly testId?: string; readonly tag?: string };
  readonly children?: readonly UiNode[];
};

export type Observation = {
  readonly at: string;
  /** URL for web surfaces; window title / app identity for desktop. */
  readonly location: string;
  readonly title: string;
  readonly root: UiNode;
  /** Flattened, in document order. Convenience for matchers. */
  readonly nodes: readonly UiNode[];
  /** Text of the whole surface, normalised. Used by text-based detectors. */
  readonly text: string;
  /** Modal/dialog currently blocking interaction, if any. */
  readonly blockingDialog?: { readonly kind: 'confirm' | 'alert' | 'prompt' | 'beforeunload'; readonly message: string };
};

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * One way to find a control. Artifacts store an *ordered list*; resolution stops
 * at the first rung yielding exactly one node, and which rung won is recorded,
 * because falling through is the earliest signal of drift. `portability` is what
 * lets the engine refuse a rung below the artifact's declared floor. The rung
 * order and why it is that order are in src/artifact/describe.ts.
 */
export type LocatorStrategy =
  /** role + accessible name. Works everywhere. Always tried first. */
  | { readonly kind: 'role_name' }
  /** Visible text of the node itself. */
  | { readonly kind: 'text'; readonly text: StringMatcher }
  /**
   * Positional, relative to an anchor node. This is the workhorse for
   * table-laid-out legacy screens where the control has no accessible name:
   * "the textbox in the same row as the cell reading 'Member Number'".
   */
  | {
      readonly kind: 'relative';
      readonly anchor: TargetDescriptor;
      readonly direction: 'same_row' | 'same_column' | 'right_of' | 'left_of' | 'below' | 'above' | 'within';
      readonly maxDistancePx?: number;
    }
  /** Ordinal within the matched set of a weaker constraint. Fragile; last-ish. */
  | { readonly kind: 'ordinal'; readonly index: number }
  /** Developer-supplied test id. Cheap and stable when present; rare in legacy. */
  | { readonly kind: 'test_id'; readonly value: string }
  /** Surface-native path (CSS/XPath). Web only. Explicitly non-portable. */
  | { readonly kind: 'native_path'; readonly path: string }
  /**
   * Geometry. Only meaningful when the surface exposes nothing else
   * (Citrix, canvas apps, screenshot-only control). Never used alone -- must be
   * combined with a role or text constraint.
   */
  | { readonly kind: 'region'; readonly bbox: BBox; readonly tolerancePx?: number };

export type Portability = 'any_surface' | 'any_web' | 'this_dom' | 'pixel';

export const STRATEGY_PORTABILITY: Record<LocatorStrategy['kind'], Portability> = {
  role_name: 'any_surface',
  text: 'any_surface',
  relative: 'any_surface',
  ordinal: 'any_surface',
  test_id: 'any_web',
  native_path: 'this_dom',
  region: 'pixel',
};

const PORTABILITY_RANK: Record<Portability, number> = { any_surface: 3, any_web: 2, this_dom: 1, pixel: 0 };

export function meetsPortabilityFloor(kind: LocatorStrategy['kind'], floor: Portability): boolean {
  return PORTABILITY_RANK[STRATEGY_PORTABILITY[kind]] >= PORTABILITY_RANK[floor];
}

/**
 * A persisted, surface-independent description of one control.
 *
 * `role` and `name` are the semantic core. `strategies` is the ordered fallback
 * ladder. `observedAt` is a snapshot of what the control looked like when it was
 * recorded -- never used to *find* the control, only to explain a mismatch when
 * resolution fails or degrades.
 */
export type TargetDescriptor = {
  readonly role: UiRole;
  readonly name?: StringMatcher;
  readonly container?: ContainerPath;
  readonly strategies: readonly LocatorStrategy[];
  readonly observedAt?: {
    readonly name?: string;
    readonly text?: string;
    readonly tag?: string;
    readonly nativePath?: string;
    readonly bbox?: BBox;
  };
  /** Free-text note from the recording model about why this target was chosen. */
  readonly rationale?: string;
};

export type ResolvedTarget = {
  readonly node: UiNode;
  /** Which strategy in the ladder actually matched (0 = the preferred one). */
  readonly strategyIndex: number;
  readonly strategyKind: LocatorStrategy['kind'];
  /** True when resolution had to fall past the first strategy. A drift signal. */
  readonly degraded: boolean;
  readonly candidatesConsidered: number;
};

export type ResolveFailure = {
  readonly reason: 'no_match' | 'ambiguous' | 'portability_floor' | 'container_missing';
  readonly triedStrategies: ReadonlyArray<{ kind: LocatorStrategy['kind']; matches: number; note?: string }>;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly target: TargetDescriptor }
  | { readonly kind: 'fill'; readonly target: TargetDescriptor; readonly value: string; readonly secret?: boolean }
  | { readonly kind: 'select'; readonly target: TargetDescriptor; readonly value: string }
  | { readonly kind: 'check'; readonly target: TargetDescriptor; readonly checked: boolean }
  | { readonly kind: 'press'; readonly keys: string; readonly target?: TargetDescriptor }
  | { readonly kind: 'scroll'; readonly direction: 'up' | 'down'; readonly amount?: number }
  | { readonly kind: 'answer_dialog'; readonly accept: boolean; readonly text?: string }
  | { readonly kind: 'wait'; readonly ms: number };

export type ActionKind = Action['kind'];

/**
 * Why an action did not happen. The distinctions matter to the caller:
 * `policy_approval_required` is not an error at all -- it is the guard asking
 * for a human, and the engine turns it into an escalation rather than a failure.
 */
export type ActionFailure =
  | ResolveFailure
  | { readonly reason: 'action_error'; readonly message: string }
  | { readonly reason: 'policy_denied'; readonly message: string; readonly rule: string; readonly risk: string }
  | { readonly reason: 'policy_approval_required'; readonly message: string; readonly rule: string; readonly risk: string }
  | { readonly reason: 'control_denied'; readonly message: string; readonly holder: string };

export type ActionResult = {
  readonly ok: boolean;
  readonly resolved?: ResolvedTarget;
  readonly failure?: ActionFailure;
  readonly durationMs: number;
};

// ---------------------------------------------------------------------------
// The surface contract
// ---------------------------------------------------------------------------

export type SurfaceKind = 'web' | 'legacy_web' | 'desktop_mac' | 'desktop_win' | 'mock';

export interface Surface {
  readonly kind: SurfaceKind;
  /** Human-facing identity of what is being driven (URL, app bundle id, ...). */
  readonly sessionId: string;

  observe(): Promise<Observation>;
  act(action: Action): Promise<ActionResult>;

  /**
   * Bound the locator rungs this surface may use to ACT, for the duration of a
   * capability. Assertions take the floor per call; actions cannot, because the
   * action carries no capability context, so it is set once here instead.
   */
  setPortabilityFloor?(floor: Portability): void;

  /**
   * Install the predicate that decides which nodes must be covered in every
   * screenshot this surface takes, whoever asks for it.
   *
   * It lives here, below the seam, rather than in `GuardedSurface`, because the
   * escalation broker is handed the raw surface on purpose: it mints a separate
   * guarded surface per operator. Masking in the wrapper therefore missed the
   * one screenshot that matters most, the one a human is shown at a handoff.
   * A surface that cannot mask must refuse rather than return an unmasked
   * image: an evidence path that silently degrades to "no masking" is worse
   * than one that never had it, because this one is trusted.
   */
  setScreenshotMask?(select: (obs: Observation) => readonly string[]): void;

  /** Raw evidence. Optional, because some surfaces cannot produce a screenshot. */
  screenshot(): Promise<Buffer | undefined>;
  /** Serialised raw state for post-mortem (HTML for web, AX dump for desktop). */
  snapshot(): Promise<string | undefined>;

  close(): Promise<void>;
}

export function isResolveFailure(x: ResolvedTarget | ResolveFailure): x is ResolveFailure {
  return 'reason' in x;
}

/**
 * `'target' in action` is not enough: `press` declares an OPTIONAL target, so
 * the key exists while the value is undefined. Every caller that wants the
 * target goes through here.
 */
export function targetOf(action: Action): TargetDescriptor | undefined {
  return 'target' in action ? action.target : undefined;
}

// ---------------------------------------------------------------------------
// Matcher helpers (used by both the resolver and the assertion evaluator)
// ---------------------------------------------------------------------------

export function normaliseText(s: string): string {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

export function matches(m: StringMatcher | undefined, subject: string | undefined): boolean {
  if (!m) return true;
  const s = normaliseText(subject ?? '');
  if (m.op === 'regex') return new RegExp(m.value, m.flags ?? 'i').test(s);
  const cs = m.caseSensitive === true;
  const a = cs ? s : s.toLowerCase();
  const b = cs ? m.value : m.value.toLowerCase();
  const target = normaliseText(b);
  if (m.op === 'equals') return a === target;
  if (m.op === 'startsWith') return a.startsWith(target);
  return a.includes(target);
}

export const eq = (value: string): StringMatcher => ({ op: 'equals', value });
export const has = (value: string): StringMatcher => ({ op: 'contains', value });
export const re = (value: string, flags = 'i'): StringMatcher => ({ op: 'regex', value, flags });

export function describeMatcher(m: StringMatcher | undefined): string {
  if (!m) return '*';
  return m.op === 'regex' ? `/${m.value}/${m.flags ?? 'i'}` : `${m.op}(${JSON.stringify(m.value)})`;
}

export function describeTarget(t: TargetDescriptor): string {
  const container = t.container?.length ? `[${t.container.join('>')}] ` : '';
  return `${container}${t.role} ${describeMatcher(t.name)}`;
}
