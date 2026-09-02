/**
 * The planner boundary.
 *
 * Everything the model can do is expressed as one of these tool calls, and the
 * agent loop is the only thing that translates them into surface actions. The
 * interface is small on purpose: it is the seam the brief asks for ("mock the
 * boundary cleanly"), and it is what lets the scripted planner in ./mock.ts
 * exercise the entire discovery path with no network and no key.
 *
 * Note what is NOT here: the model cannot supply a selector, a URL outside the
 * allowlist, or a raw DOM query. It points at nodes it was shown, by handle.
 * See src/artifact/describe.ts for why that division of labour matters.
 */

export type PlannerToolCall =
  | { readonly name: 'act'; readonly input: ActInput }
  | { readonly name: 'declare_output'; readonly input: DeclareOutputInput }
  | { readonly name: 'declare_outcome'; readonly input: DeclareOutcomeInput }
  | { readonly name: 'finish'; readonly input: FinishInput }
  | { readonly name: 'give_up'; readonly input: { readonly reason: string } };

export type ActInput = {
  /** Why, in the model's words. Recorded as the step's `intent`. */
  readonly intent: string;
  readonly kind: 'click' | 'fill' | 'select' | 'press' | 'navigate' | 'answer_dialog' | 'wait';
  /** A node handle from the observation the model was shown. */
  readonly ref?: string;
  readonly value?: string;
  /** For navigate. Must satisfy the allowlist; the guard checks, not the model. */
  readonly url?: string;
  readonly keys?: string;
  readonly accept?: boolean;
  readonly ms?: number;
  /**
   * Set when the value came from a run parameter, so the compiler can
   * parameterise the step instead of baking in a literal.
   */
  readonly parameter?: string;
};

export type DeclareOutputInput = {
  readonly name: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'money' | 'date' | 'enum';
  readonly description: string;
  readonly ref: string;
  readonly property?: 'text' | 'value' | 'name' | 'location';
  readonly sensitivity?: 'public' | 'pii' | 'secret';
};

export type DeclareOutcomeInput = {
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  /** Text that identifies this outcome on screen. Compiled into a detector. */
  readonly detectText: string;
  readonly severity?: 'info' | 'warning';
};

export type FinishInput = {
  readonly summary: string;
  /** Text that proves the goal was reached. Compiled into the success condition. */
  readonly successText?: string;
};

export type PlannerRequest = {
  readonly goal: string;
  readonly stepBudget: { readonly used: number; readonly max: number };
  /** Rendered observation of the current screen. */
  readonly screen: string;
  readonly location: string;
  /** Terse history so the model can see what it already tried. */
  readonly history: readonly string[];
  /** Parameters the caller supplied for this discovery run. */
  readonly parameters: ReadonlyArray<{ name: string; value: string; description: string; sensitive: boolean }>;
  /** Set when the last action failed, so the model can adapt. */
  readonly lastError?: string;
};

export type PlannerResponse = {
  readonly reasoning?: string;
  readonly calls: readonly PlannerToolCall[];
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
};

export interface Planner {
  readonly provider: string;
  readonly model: string;
  plan(req: PlannerRequest): Promise<PlannerResponse>;
}
