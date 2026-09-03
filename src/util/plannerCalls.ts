/**
 * A process-wide count of requests actually sent to a model provider.
 *
 * "Replay consults no model" is the central claim of this system, and it is a
 * structural property -- nothing under src/replay/ imports a planner, which
 * tests/architecture.test.ts asserts. This counter makes it a *measured* one
 * too: every replay result carries the number of provider calls made while it
 * ran, so each committed evidence file attests to it on its own.
 *
 * Incremented by the real planners at the point of the request, not by the loop
 * that asked for one, so a retried or paced request counts as the call it is.
 */
let calls = 0;

/** Called by each planner immediately before a request leaves the process. */
export function notePlannerCall(): void {
  calls += 1;
}

export function plannerCalls(): number {
  return calls;
}
