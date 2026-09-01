/**
 * Guardrails.
 *
 * What matters most here is WHERE this runs: inside a `GuardedSurface` that
 * wraps the real surface, so every actor -- the LLM during discovery, the replay
 * engine, and the human operator during a handoff -- goes through the same gate.
 * There is no code path to the browser that skips it. A guardrail the agent loop
 * enforces on itself is not a guardrail.
 *
 * Irreversible actions default to `require_approval` rather than `block` or
 * `allow`: blocking makes write capabilities impossible to build, and allowing
 * lets a model post to a system of record on its own judgement.
 */

import { readFileSync } from 'node:fs';
import type { Action, ActionKind, TargetDescriptor } from '../surface/types.ts';
import { describeTarget, targetOf } from '../surface/types.ts';
import type { Risk } from '../artifact/schema.ts';

export type PolicyDecision = {
  readonly decision: 'allow' | 'deny' | 'require_approval';
  readonly risk: Risk;
  readonly rule: string;
  readonly reason: string;
};

/** Extra signals available at classification time but not carried by the action. */
export type RiskContext = {
  /** Message of a modal that is currently blocking the surface, if any. */
  readonly dialogMessage?: string;
  /**
   * Per-product pattern overrides from the app profile.
   *
   * The verb lists cannot be global, and a second application is what proves
   * it: "Remove" is destructive on a core banking screen and completely
   * reversible on a shopping cart, where it takes an item back out of a basket.
   * A global list forced one of those two to be wrong -- and it chose to demand
   * a human approval for emptying a cart, which is how an approval gate becomes
   * noise and then gets switched off.
   */
  readonly patterns?: RiskPatternOverrides;
};

export type RiskPatternOverrides = {
  readonly irreversible?: readonly string[];
  readonly elevated?: readonly string[];
  /** Removed from the inherited lists. For verbs this product uses benignly. */
  readonly notIrreversible?: readonly string[];
};

export type OriginRule = {
  readonly origin: string;
  /** Regexes matched against pathname + search. Empty `allow` means all paths. */
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
};

export type PolicyConfig = {
  readonly version: string;
  readonly origins: readonly OriginRule[];
  readonly allowedActions: readonly ActionKind[];
  /** Accessible-name / intent patterns that mark an action as irreversible. */
  readonly irreversiblePatterns: readonly string[];
  readonly elevatedPatterns: readonly string[];
  /** Patterns that are refused outright, whatever the approval state. */
  readonly forbiddenPatterns: readonly string[];
  readonly onIrreversible: 'deny' | 'require_approval' | 'allow';
  readonly onElevated: 'deny' | 'require_approval' | 'allow';
  readonly limits: {
    readonly maxStepsPerRun: number;
    readonly maxRunDurationMs: number;
    readonly maxActionsPerStep: number;
  };
};

export const DEFAULT_POLICY: PolicyConfig = {
  version: '1',
  origins: [{ origin: 'http://127.0.0.1:8731', allow: ['^/(login|logout|desk|nav|content)', '^/t/[a-z-]+/(login|logout|desk|nav|content)'] }],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'check', 'press', 'scroll', 'answer_dialog', 'wait'],
  // Verbs that move money, change entitlements, or touch a system of record.
  // Taken from the actual control labels in credit-union back-office software,
  // not from a generic "dangerous words" list.
  irreversiblePatterns: [
    // submission of a maintenance or transaction request. NOT bare "submit":
    // every form submits, including a search, and promoting all of them to
    // irreversible means signing on requires a human. Noisy gates get switched off.
    'submit request', 'submit transfer', 'submit payment', 'submit maintenance',
    'confirm and post', 'finalize', 'finalise',
    // posting and adjustment
    'post transaction', 'post payment', 'post entry', 'post batch', 'post adjustment',
    'adjust balance', 'debit account', 'credit account', 'force post',
    // money movement
    'wire', 'send money', 'transfer funds', 'xfer', 'disburse', 'withdrawal', 'withdraw',
    'cash out', 'ach', 'originate', 'remit', 'issue check', 'issue draft',
    // holds, stops and status changes
    'stop payment', 'stop pay', 'place hold', 'release hold', 'freeze', 'unfreeze',
    'mark dormant', 'escheat', 'restrict account',
    // lifecycle and destructive
    'close account', 'delete', 'remove', 'purge', 'void', 'reverse',
    'charge off', 'write off', 'chargeback',
    // cards and credentials
    'issue card', 'reissue', 'hot card', 'block card', 'lock card', 'unblock card',
    // authorisation
    'approve', 'authorize', 'authorise', 'override',
  ],
  elevatedPatterns: ['submit', 'save', 'confirm', 'continue', 'update', 'create', 'open sub-account', 'new sub-account'],
  forbiddenPatterns: ['change password', 'reset password', 'add user', 'grant role', 'security administration', 'export all'],
  onIrreversible: 'require_approval',
  onElevated: 'allow',
  limits: { maxStepsPerRun: 40, maxRunDurationMs: 180_000, maxActionsPerStep: 6 },
};

function targetText(t: TargetDescriptor | undefined): string {
  if (!t) return '';
  const bits = [t.name?.value ?? '', t.observedAt?.name ?? '', t.observedAt?.text ?? '', t.rationale ?? ''];
  return bits.join(' ').toLowerCase();
}

/** Inherited list, plus this product's additions, minus its exemptions. */
function applyOverrides(base: readonly string[], add?: readonly string[], remove?: readonly string[]): readonly string[] {
  const dropped = new Set((remove ?? []).map((p) => p.toLowerCase()));
  return [...base.filter((p) => !dropped.has(p.toLowerCase())), ...(add ?? [])];
}

/**
 * A legacy app that performs writes over GET is not hypothetical, so the URL is
 * part of the risk haystack for a navigation.
 */
function urlText(action: Action): string {
  if (action.kind !== 'navigate') return '';
  try {
    const u = new URL(action.url);
    return `${u.pathname} ${u.search}`.replace(/[?&=+_/-]/g, ' ');
  } catch {
    return action.url;
  }
}

/**
 * Match a risk phrase on word boundaries, not as a raw substring: `includes`
 * classified "Avoid duplicate" as irreversible, because "Avoid" contains "void".
 * A false positive sets `requiresHumanApproval` and clears `idempotent`, denying
 * a read-only capability the session-expiry recovery it is entitled to.
 */
function anyPattern(patterns: readonly string[], haystack: string): string | undefined {
  return patterns.find((p) => {
    const needle = p.toLowerCase();
    // Escape regex metacharacters, then allow any run of non-alphanumerics
    // where the pattern has a space or hyphen, so "charge-off", "charge off"
    // and "chargeoff" all match one entry.
    const body = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[^a-z0-9]*');
    return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, 'i').test(haystack);
  });
}

export class PolicyEngine {
  private readonly config: PolicyConfig;

  constructor(config: PolicyConfig = DEFAULT_POLICY) {
    this.config = config;
  }

  static fromFile(path: string): PolicyEngine {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PolicyConfig>;
    return new PolicyEngine({ ...DEFAULT_POLICY, ...raw, limits: { ...DEFAULT_POLICY.limits, ...raw.limits } });
  }

  get limits() {
    return this.config.limits;
  }

  /**
   * The configuration this engine was built from, so a caller can derive a
   * different *stance* without discarding the deployment's allowlists. Used by
   * the escalation broker: an operator may perform an irreversible action, but
   * the origins, routes and forbidden patterns this deployment declared still
   * apply to them.
   */
  derive(overrides: Partial<PolicyConfig>): PolicyEngine {
    return new PolicyEngine({ ...this.config, ...overrides });
  }

  /** Origin/route allowlist. Also used to vet an artifact before replay. */
  checkUrl(rawUrl: string): PolicyDecision {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { decision: 'deny', risk: 'safe', rule: 'origin.malformed', reason: `not a URL: ${rawUrl}` };
    }
    const rule = this.config.origins.find((o) => o.origin === u.origin);
    if (!rule) {
      return {
        decision: 'deny',
        risk: 'safe',
        rule: 'origin.allowlist',
        reason: `origin ${u.origin} is not in the allowlist (${this.config.origins.map((o) => o.origin).join(', ') || 'empty'})`,
      };
    }
    const path = u.pathname + u.search;
    const denied = rule.deny?.find((p) => new RegExp(p).test(path));
    if (denied) {
      return { decision: 'deny', risk: 'safe', rule: 'route.deny', reason: `path ${path} matches deny rule /${denied}/` };
    }
    if (rule.allow?.length && !rule.allow.some((p) => new RegExp(p).test(path))) {
      return { decision: 'deny', risk: 'safe', rule: 'route.allow', reason: `path ${path} matches no allow rule for ${u.origin}` };
    }
    return { decision: 'allow', risk: 'safe', rule: 'origin.allowlist', reason: 'origin and route permitted' };
  }

  /**
   * Classify without deciding. Used by the compiler to stamp `risk` onto every
   * recorded step, so the artifact carries its own risk profile for review.
   */
  classify(action: Action, intent = '', context: RiskContext = {}): Risk {
    const irreversible = applyOverrides(this.config.irreversiblePatterns, context.patterns?.irreversible, context.patterns?.notIrreversible);
    const elevated = applyOverrides(this.config.elevatedPatterns, context.patterns?.elevated, undefined);
    // The dialog's own message is the strongest signal available when one is
    // open -- "This will permanently delete..." says far more than whatever
    // intent the caller wrote -- so it goes into the haystack too.
    const hay = [intent, targetText(targetOf(action)), context.dialogMessage ?? '', urlText(action)]
      .join(' ')
      .toLowerCase();

    // Checked FIRST, for every action kind. Short-circuiting targetless actions
    // to `safe` would leave a wire transfer submitted by pressing Enter
    // unclassified: no target, therefore safe.
    if (anyPattern(irreversible, hay)) return 'irreversible';

    if (action.kind === 'answer_dialog') {
      // Dismissing is always safe; accepting commits whatever the app asked
      // about, so it inherits at least `elevated`.
      return action.accept ? 'elevated' : 'safe';
    }
    if (anyPattern(elevated, hay)) return 'elevated';
    return 'safe';
  }

  check(action: Action, ctx: { intent?: string; declaredRisk?: Risk; dialogMessage?: string; patterns?: RiskPatternOverrides } = {}): PolicyDecision {
    if (!this.config.allowedActions.includes(action.kind)) {
      return { decision: 'deny', risk: 'safe', rule: 'action.allowlist', reason: `action "${action.kind}" is not permitted` };
    }

    if (action.kind === 'navigate') {
      const d = this.checkUrl(action.url);
      if (d.decision !== 'allow') return d;
    }

    const target = targetOf(action);
    const hay = `${ctx.intent ?? ''} ${targetText(target)} ${ctx.dialogMessage ?? ''}`.toLowerCase();
    const forbidden = anyPattern(this.config.forbiddenPatterns, hay);
    if (forbidden) {
      return {
        decision: 'deny',
        risk: 'irreversible',
        rule: 'action.forbidden',
        reason: `matches forbidden pattern "${forbidden}" -- this class of action is never automated`,
      };
    }

    // The artifact's recorded risk is a floor, not a ceiling: live
    // classification can escalate it but never quietly downgrade it.
    const live = this.classify(action, ctx.intent, { dialogMessage: ctx.dialogMessage, patterns: ctx.patterns });
    const risk = maxRisk(live, ctx.declaredRisk ?? 'safe');

    if (risk === 'irreversible') {
      const stance = this.config.onIrreversible;
      return {
        decision: stance === 'allow' ? 'allow' : stance,
        risk,
        rule: 'risk.irreversible',
        reason: `writes to a system of record${target ? ` via ${describeTarget(target)}` : ''}; policy stance is "${stance}"`,
      };
    }
    if (risk === 'elevated' && this.config.onElevated !== 'allow') {
      return { decision: this.config.onElevated, risk, rule: 'risk.elevated', reason: `state-changing action; policy stance is "${this.config.onElevated}"` };
    }
    return { decision: 'allow', risk, rule: 'default', reason: 'no rule matched; treated as safe' };
  }

  /** Vet a whole artifact before it is allowed to run unattended. */
  vetCapability(entrypoint: string, actions: ReadonlyArray<{ action: Action; intent: string; risk: Risk }>): PolicyDecision[] {
    const problems: PolicyDecision[] = [];
    const originCheck = this.checkUrl(entrypoint);
    if (originCheck.decision !== 'allow') problems.push(originCheck);
    for (const a of actions) {
      const d = this.check(a.action, { intent: a.intent, declaredRisk: a.risk });
      if (d.decision !== 'allow') problems.push(d);
    }
    return problems;
  }
}

const RISK_ORDER: Record<Risk, number> = { safe: 0, elevated: 1, irreversible: 2 };
function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
