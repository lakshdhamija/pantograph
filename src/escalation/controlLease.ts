/**
 * Who is allowed to touch the live session, right now.
 *
 * The handoff requirement in the brief ("let the human operate the same live
 * session, then hand control back") is really a mutual-exclusion problem. Two
 * actors driving one browser context concurrently is not a co-browsing feature,
 * it is a race condition that corrupts a banking transaction.
 *
 * So control is a lease. Exactly one holder at a time, every actor's identity is
 * explicit, and the check lives below every actor rather than inside any of
 * them. Automation does not "politely stop" when a human takes over -- its
 * actions start failing closed with `control_denied`, which the engine treats as
 * a signal to park, not as an app error.
 */

export type LeaseHolder = 'automation' | `operator:${string}` | 'nobody';

export type LeaseState = {
  readonly holder: LeaseHolder;
  readonly since: number;
  readonly reason: string;
  readonly generation: number;
};

export class ControlDeniedError extends Error {
  readonly holder: LeaseHolder;
  constructor(requester: LeaseHolder, holder: LeaseHolder) {
    super(`${requester} attempted to act while control is held by ${holder}`);
    this.name = 'ControlDeniedError';
    this.holder = holder;
  }
}

export type LeaseListener = (state: LeaseState, previous: LeaseState) => void;

export class ControlLease {
  private state: LeaseState = { holder: 'automation', since: Date.now(), reason: 'initial', generation: 0 };
  private readonly listeners = new Set<LeaseListener>();

  get current(): LeaseState {
    return this.state;
  }

  holds(who: LeaseHolder): boolean {
    return this.state.holder === who;
  }

  assert(who: LeaseHolder): void {
    if (this.state.holder !== who) throw new ControlDeniedError(who, this.state.holder);
  }

  /**
   * Transfer is always explicit and always logged by the caller. There is no
   * "steal" primitive: an operator taking over goes through the broker, which
   * parks the automation first so it cannot be mid-action.
   */
  transfer(to: LeaseHolder, reason: string): LeaseState {
    const previous = this.state;
    this.state = { holder: to, since: Date.now(), reason, generation: previous.generation + 1 };
    for (const l of this.listeners) l(this.state, previous);
    return this.state;
  }

  onChange(listener: LeaseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
