/**
 * A plain-language request, answered by invoking a recorded capability.
 *
 * Which model does what is the point: the model here reads the catalog, picks a
 * capability and supplies the business arguments, and never sees the app. No
 * model drives the UI. So the non-deterministic part happens once at record time
 * and once per request at selection time, and the part that touches the bank is
 * neither.
 *
 * Two things the model is not trusted with. Credentials: secret inputs are
 * filled from the environment after it has chosen, never offered to it and never
 * accepted from it. Approval: selection is not authorisation, so an irreversible
 * capability still parks for a human and the stance here is pinned to `abort`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Capability } from '../artifact/schema.ts';
import { toolDefinitionFor, toolNameFor } from './catalog.ts';
import { DEFAULT_MODEL } from '../agent/llm/anthropic.ts';

export type AskSelection = {
  readonly capability: Capability;
  readonly args: Record<string, unknown>;
  readonly reasoning?: string;
  readonly usage?: { inputTokens?: number; outputTokens?: number };
};

export type AskOutcome =
  | { readonly kind: 'selected'; readonly selection: AskSelection }
  | { readonly kind: 'declined'; readonly reasoning: string; readonly offered: readonly string[] };

const SYSTEM = `You are the agent-facing half of a back-office automation system for banks and credit unions.

You cannot see or touch the applications yourself. What you have instead is a catalog of CAPABILITIES: flows that were each discovered once against a real application and recorded as a deterministic, replayable artifact. Each is exposed to you as a tool with a typed input schema.

Your job for each request: pick the ONE capability that answers it and supply its business arguments. Then stop. The system replays it with no model in the loop and returns you a typed result.

Rules:
- Call exactly one tool, or none.
- Supply only arguments you were actually given or can read directly from the request. Never invent a member number, an amount or a product code.
- Never supply credentials. Sign-on parameters are filled by the runtime from its own configuration; if a schema shows one, omit it.
- If no capability fits, say so plainly and name what you would need. A wrong capability invoked against a bank's core is worse than an unanswered question.
- A capability marked as requiring human approval will pause for an operator. That is expected. Do not try to route around it or pick a different capability to avoid it.`;

export type AskOptions = {
  readonly request: string;
  readonly capabilities: readonly Capability[];
  readonly apiKey?: string;
  readonly model?: string;
  /** Inputs the runtime supplies itself, e.g. credentials. Never shown to the model. */
  readonly runtimeInputs?: Record<string, unknown>;
};

export async function selectCapability(opts: AskOptions): Promise<AskOutcome> {
  const invocable = opts.capabilities.filter((c) => c.approval.state === 'approved');
  if (!invocable.length) {
    return { kind: 'declined', reasoning: 'No approved capabilities in the catalog. A reviewer must approve one before it can be invoked.', offered: [] };
  }

  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. `ask` is the one command that genuinely needs a model: it is the model choosing which capability answers your sentence.');
  }

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? process.env['PANTOGRAPH_MODEL'] ?? DEFAULT_MODEL;

  // Credentials are stripped from what the model is shown, so it cannot supply
  // one even by accident, and the schema it sees matches what it may pass.
  const runtimeSupplied = new Set(Object.keys(opts.runtimeInputs ?? {}));
  const tools = invocable.map((c) => {
    const def = toolDefinitionFor(c) as { name: string; description: string; input_schema: { properties: Record<string, unknown>; required: string[] } };
    const secretNames = c.inputs.filter((i) => i.sensitivity === 'secret' || runtimeSupplied.has(i.name)).map((i) => i.name);
    for (const n of secretNames) delete def.input_schema.properties[n];
    def.input_schema.required = def.input_schema.required.filter((r) => !secretNames.includes(r));
    return def as unknown as Anthropic.Tool;
  });

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    tools,
    messages: [{ role: 'user', content: opts.request }],
  });

  let reasoning = '';
  for (const block of message.content) if (block.type === 'text') reasoning += block.text;

  const call = message.content.find((b) => b.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    return { kind: 'declined', reasoning: reasoning.trim() || 'the model chose not to call any capability', offered: invocable.map(toolNameFor) };
  }

  const chosen = invocable.find((c) => toolNameFor(c) === call.name);
  if (!chosen) {
    return { kind: 'declined', reasoning: `the model called "${call.name}", which is not in the catalog`, offered: invocable.map(toolNameFor) };
  }

  return {
    kind: 'selected',
    selection: {
      capability: chosen,
      // The runtime's own inputs are merged in AFTER selection, so a credential
      // is never something the model passed.
      args: { ...(call.input as Record<string, unknown>), ...(opts.runtimeInputs ?? {}) },
      reasoning: reasoning.trim() || undefined,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    },
  };
}

/** What the model was allowed to pass, for printing without leaking secrets. */
export function modelSuppliedArgs(selection: AskSelection): Record<string, unknown> {
  const secret = new Set(selection.capability.inputs.filter((i) => i.sensitivity !== 'public').map((i) => i.name));
  return Object.fromEntries(Object.entries(selection.args).filter(([k]) => !secret.has(k)));
}
