/**
 * The discovery contract: one system prompt, one tool schema, one user turn.
 *
 * Every planner imports these rather than restating them. Independently
 * maintained prompts would drift, and a discovery run's quality would then
 * depend on which vendor happened to be configured -- exactly the hidden
 * coupling the planner seam exists to prevent. What differs between the
 * implementations in this directory is wire format and nothing else.
 */

import type { PlannerRequest } from './types.ts';

/**
 * A tool as every provider in this directory understands it. Deliberately the
 * shape Anthropic uses, because it is the plainest of the three: OpenAI wraps it
 * in `{type:'function',function:{...}}` and Gemini renames `input_schema` to
 * `parameters` and translates the schema dialect. Both conversions live with
 * their planner.
 */
export type DiscoveryTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

/**
 * Prompting choices worth defending:
 *
 *  - Tools, not free text. The model's only outputs are typed tool calls, so
 *    there is no parsing step that can misread an action.
 *  - The model points at nodes by handle; it never writes a selector. See
 *    src/artifact/describe.ts.
 *  - It is told explicitly that it is recording a reusable capability, which is
 *    what makes it declare parameters and outputs rather than typing literals.
 *  - It is shown the SAME normalised accessibility view the deterministic
 *    resolver uses. A model planning against a richer view than the engine can
 *    see will confidently record steps that cannot be replayed.
 *  - Screens are redacted before they are sent. Regulated data does not leave
 *    the process to reach a model any more than it reaches a log file.
 */
export const DISCOVERY_SYSTEM_PROMPT = `You are the discovery half of a computer-use automation system for back-office banking applications.

You are driving a real application through a normalised accessibility view: roles, accessible names, and frames. This is deliberately the same view the deterministic replay engine will have later. If you cannot identify a control here, the replay engine will not be able to either.

YOUR REAL JOB
You are not just completing a task once. You are RECORDING A REUSABLE CAPABILITY that will be replayed thousands of times, with different inputs, with no model in the loop. Everything you do is being compiled into a typed artifact. So:

- When you type a value that came from the run parameters, say so via the "parameter" field. Otherwise the value gets baked in as a literal and the capability only ever works for one record.
- When you see a piece of data the caller will want back, call declare_output. Do not just read it out in prose.
- When you notice a legitimate non-happy answer the app can give (a "no matching records" screen, a permission refusal), call declare_outcome. These become typed results, not errors.
- Call finish only when the goal is actually visible on screen, and give successText that would still be true on a future replay with different inputs.

HOW TO ACT
- Two markers appear in the screen dump, and they mean different things:
    ref=   a control you can act on  -- use these for "act"
    read=  a value you can read      -- use these for "declare_output"
  Pointing an "act" at a read= handle will fail: a label is not an input, and the
  cell beside a label is not the label.
- Refer to controls only by those handles. Never guess an id, a CSS selector, or a coordinate.
- Many legacy controls have NO ACCESSIBLE NAME. That is normal and not a problem: pick them by their ref and the system will work out how to describe them relative to nearby labels.
- Frames matter. A control in the "nav" frame is a different control from one in "content".
- If a dialog is open, nothing else can be interacted with until you answer it.
- One or two tool calls per turn. Observe the result before deciding the next thing.
- If you are blocked, stuck in a loop, or the screen is not what you expected twice in a row, call give_up with a specific reason. A clean escalation is a better outcome than flailing; a human will take over the live session.

Never attempt to sign in with credentials you were not given, never navigate outside the application you were pointed at, and never try to work around a refusal from the guardrails.`;

/**
 * The tool contract, in Anthropic's shape but deliberately neutral in content:
 * a name, a description, and a plain JSON Schema. `GeminiPlanner` projects the
 * same array into Google's schema dialect, so the two providers cannot drift
 * apart in what the model is allowed to do.
 */
export const DISCOVERY_TOOLS: DiscoveryTool[] = [
  {
    name: 'act',
    description: 'Perform one interaction with the application.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Why you are doing this, in one short sentence. Recorded as the step description in the artifact.' },
        kind: { type: 'string', enum: ['click', 'fill', 'select', 'press', 'navigate', 'answer_dialog', 'wait'] },
        ref: { type: 'string', description: 'Handle of the target control, exactly as shown after ref= in the screen dump. Required for click/fill/select.' },
        value: { type: 'string', description: 'Text to type, or the option to select.' },
        parameter: { type: 'string', description: 'If this value came from a run parameter, its name. Makes the recorded step parameterised instead of a hardcoded literal.' },
        url: { type: 'string', description: 'For kind=navigate only.' },
        keys: { type: 'string', description: 'For kind=press, e.g. "Enter".' },
        accept: { type: 'boolean', description: 'For kind=answer_dialog: true to confirm, false to cancel.' },
        ms: { type: 'number', description: 'For kind=wait.' },
      },
      required: ['intent', 'kind'],
    },
  },
  {
    name: 'declare_output',
    description: 'Declare a piece of data on the current screen that the capability should return to its caller. Use this instead of reporting the value in prose.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'camelCase identifier, e.g. savingsBalance.' },
        type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'money', 'date', 'enum'] },
        description: { type: 'string' },
        ref: { type: 'string', description: 'Handle of the element holding the value.' },
        property: { type: 'string', enum: ['text', 'value', 'name', 'location'] },
        sensitivity: { type: 'string', enum: ['public', 'pii', 'secret'], description: 'Mark anything personally identifying as pii so it is masked in logs.' },
      },
      required: ['name', 'type', 'description', 'ref'],
    },
  },
  {
    name: 'declare_outcome',
    description: 'Declare a legitimate non-happy result this flow can produce, e.g. "no matching records" or a permission refusal. These become typed business outcomes, not failures.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.' },
        title: { type: 'string' },
        description: { type: 'string' },
        detectText: { type: 'string', description: 'Distinctive text that appears on screen when this outcome happens.' },
        severity: { type: 'string', enum: ['info', 'warning'] },
      },
      required: ['code', 'title', 'detectText'],
    },
  },
  {
    name: 'finish',
    description: 'The goal has been reached and is visible on the current screen.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        successText: { type: 'string', description: 'Text on this screen that proves the goal was reached, and that would still be present on a future replay with different inputs. Avoid record-specific values.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'give_up',
    description: 'You cannot safely proceed. A human operator will be given control of the live session.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

/**
 * The user turn. Every provider assembles it into a different envelope, but the
 * text is what determines discovery quality, so there is one of it.
 */
export function renderUserTurn(req: PlannerRequest): string {
  const params = req.parameters.length
    ? req.parameters
        .map(
          (p) =>
            `  ${p.name} = ${p.sensitive ? '<supplied at run time; you are not shown its value>' : JSON.stringify(p.value)}  -- ${p.description}`,
        )
        .join('\n')
    : '  (none)';

  return [
    `GOAL: ${req.goal}`,
    '',
    'RUN PARAMETERS (use act.parameter to reference these instead of typing literals):',
    params,
    '',
    `STEP ${req.stepBudget.used + 1} of at most ${req.stepBudget.max}.`,
    req.history.length ? `\nWHAT YOU HAVE DONE SO FAR:\n${req.history.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}` : '',
    req.lastError ? `\nTHE LAST ACTION FAILED: ${req.lastError}` : '',
    '',
    'CURRENT SCREEN:',
    req.screen,
  ].join('\n');
}
