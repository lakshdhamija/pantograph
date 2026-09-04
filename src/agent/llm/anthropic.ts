/**
 * Anthropic planner.
 *
 * Prompting choices worth defending:
 *
 *  - Tools, not free text. The model's only outputs are typed tool calls, so
 *    there is no parsing step that can misread an action, and an invalid call is
 *    rejected structurally rather than interpreted charitably.
 *  - The model points at nodes by handle; it never writes a selector. See
 *    src/artifact/describe.ts.
 *  - It is told explicitly that it is recording a reusable capability, not just
 *    completing a task once. That is what makes it declare parameters and
 *    outputs rather than typing literals and reading values out loud.
 *  - It is shown the SAME normalised accessibility view the deterministic
 *    resolver uses. A model that plans against a richer view than the replay
 *    engine can see will confidently record steps that cannot be replayed.
 *  - Screens are redacted before they are sent. Regulated data does not leave
 *    the process to reach a model any more than it reaches a log file.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Planner, PlannerRequest, PlannerResponse, PlannerToolCall } from './types.ts';
import { DISCOVERY_SYSTEM_PROMPT, DISCOVERY_TOOLS, renderUserTurn } from './contract.ts';
import { notePlannerCall } from '../../util/plannerCalls.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5';


export class AnthropicPlanner implements Planner {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: { apiKey?: string; model?: string; maxTokens?: number; baseUrl?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Either export it (or put it in .env), or run discovery with --mock-llm to use the scripted planner.',
      );
    }
    // `baseUrl` exists so tests/planner-wire.test.ts can point the real client
    // at a local server that speaks the Messages API. Without it, the code that
    // talks to Anthropic is only ever verified by a run that costs money and
    // needs a key CI does not have.
    this.client = new Anthropic({ apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    this.model = opts.model ?? process.env['PANTOGRAPH_MODEL'] ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? 1500;
  }

  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    const params = req.parameters.length
      ? req.parameters
          .map((p) => `  ${p.name} = ${p.sensitive ? '<supplied at run time; you are not shown its value>' : JSON.stringify(p.value)}  -- ${p.description}`)
          .join('\n')
      : '  (none)';

    const user = [
      `GOAL: ${req.goal}`,
      '',
      `RUN PARAMETERS (use act.parameter to reference these instead of typing literals):`,
      params,
      '',
      `STEP ${req.stepBudget.used + 1} of at most ${req.stepBudget.max}.`,
      req.history.length ? `\nWHAT YOU HAVE DONE SO FAR:\n${req.history.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}` : '',
      req.lastError ? `\nTHE LAST ACTION FAILED: ${req.lastError}` : '',
      '',
      'CURRENT SCREEN:',
      req.screen,
    ].join('\n');

    notePlannerCall();
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: DISCOVERY_SYSTEM_PROMPT,
      tools: DISCOVERY_TOOLS,
      messages: [{ role: 'user', content: user }],
    });

    const calls: PlannerToolCall[] = [];
    let reasoning = '';
    for (const block of message.content) {
      if (block.type === 'text') reasoning += block.text;
      if (block.type === 'tool_use') {
        calls.push({ name: block.name, input: block.input } as PlannerToolCall);
      }
    }

    return {
      reasoning: reasoning.trim() || undefined,
      calls,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}
