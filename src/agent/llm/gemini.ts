/**
 * Google Gemini planner -- the third implementation of the `Planner` seam.
 *
 * One live provider plus a scripted stand-in makes the clean-boundary claim a
 * claim; three live providers makes it a property. It also lets the loop be
 * exercised by a real model on a free tier rather than not at all.
 *
 * The prompt and the tool contract are imported from ./anthropic.ts rather than
 * restated: independently maintained prompts would drift, and discovery quality
 * would then depend on which vendor happened to be configured. Only the wire
 * format differs below.
 *
 * No SDK, deliberately: one `fetch` keeps the whole request visible, which
 * matters because the interesting work here is a schema translation.
 */

import type { Planner, PlannerRequest, PlannerResponse, PlannerToolCall } from './types.ts';
import { DISCOVERY_SYSTEM_PROMPT, DISCOVERY_TOOLS, renderUserTurn } from './contract.ts';
import { notePlannerCall } from '../../util/plannerCalls.ts';

/**
 * An alias, not a version. `gemini-2.5-flash` was already retired for new keys
 * ("no longer available to new users"), and a pinned version means a reviewer's
 * run fails for a reason unrelated to the code. Pin one through --model or
 * PANTOGRAPH_GEMINI_MODEL when reproducibility matters more than not rotting.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// ---------------------------------------------------------------------------
// JSON Schema -> Gemini's schema dialect
// ---------------------------------------------------------------------------

/**
 * Gemini accepts an OpenAPI-flavoured subset, not JSON Schema, and rejects
 * unknown keys rather than ignoring them: `pattern`, `examples` and friends are
 * stripped and `type` is upper-cased. Getting it wrong 400s every request, hence
 * a pure function with its own tests rather than inline in the call.
 */
const GEMINI_TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/** Keys Gemini understands. Everything else is dropped. */
const KEPT = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'nullable']);

export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(src)) {
    if (!KEPT.has(k)) continue;
    if (k === 'type') {
      const t = GEMINI_TYPES[String(v).toLowerCase()];
      if (t) out['type'] = t;
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        const converted = toGeminiSchema(sub);
        if (converted) props[name] = converted;
      }
      out['properties'] = props;
      continue;
    }
    if (k === 'items') {
      const converted = toGeminiSchema(v);
      if (converted) out['items'] = converted;
      continue;
    }
    out[k] = v;
  }

  // Gemini requires a type; an untyped schema is silently useless.
  if (!out['type']) out['type'] = out['properties'] ? 'OBJECT' : 'STRING';
  return out;
}

export function toGeminiFunctionDeclarations(
  tools: ReadonlyArray<{ name: string; description?: string | undefined; input_schema: unknown }>,
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const parameters = toGeminiSchema(t.input_schema);
    return {
      name: t.name,
      description: t.description ?? '',
      // A function with no parameters must omit the key entirely rather than
      // send an empty object, which Gemini rejects.
      ...(parameters && Object.keys((parameters['properties'] as object) ?? {}).length ? { parameters } : {}),
    };
  });
}

// ---------------------------------------------------------------------------

type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
};

export class GeminiPlanner implements Planner {
  readonly provider = 'google';
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(opts: { apiKey?: string; model?: string; maxTokens?: number; baseUrl?: string; minIntervalMs?: number } = {}) {
    const apiKey = opts.apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey (no card required), ' +
          'put it in .env, or run discovery with --mock-llm to use the scripted planner.',
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? process.env['PANTOGRAPH_GEMINI_MODEL'] ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = opts.baseUrl ?? ENDPOINT;
    this.maxTokens = opts.maxTokens ?? 1500;
    // Pace, do not just retry. The free tier allows 20 requests a minute and a
    // discovery run is ten or more turns, so an unpaced run walks into the limit
    // partway through and throws away every step before it. 20/min is 3s
    // exactly, which leaves no headroom for a retry or a second consumer of the
    // key; 4.5s is ~13/min. Retry is the backstop, not the strategy.
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env['PANTOGRAPH_GEMINI_MIN_INTERVAL_MS'] ?? 4500);
  }

  /**
   * POST with bounded retry on transient provider failures only.
   *
   * A free tier rate-limits and its shared models get busy. A discovery run is
   * ten or more turns, so one hiccup in the middle otherwise kills the whole
   * recording. A bad model name, a bad key or a malformed schema fails
   * identically forever, and retrying those turns a clear error into a slow one.
   */
  private async post(body: unknown, attempts = 5): Promise<GeminiResponse> {
    let lastMessage = 'unknown error';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const sinceLast = Date.now() - this.lastRequestAt;
      if (this.lastRequestAt && sinceLast < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - sinceLast));
      }
      this.lastRequestAt = Date.now();

      notePlannerCall();
      const res = await fetch(`${this.baseUrl}/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponse;

      if (res.ok && !json.error) return json;

      lastMessage = json.error?.message ?? `HTTP ${res.status}`;
      // Retrying a spent budget is self-defeating: every attempt consumes one
      // request of the rolling window, so retrying an exhausted window keeps it
      // exhausted. Google's "retry in Ns" hint does not distinguish a spent
      // budget from a momentary one, so it cannot be the signal either.
      //
      // So a 429 gets ONE retry, after the full stated window plus a margin, and
      // only when that window is short enough to be a rolling limit rather than
      // a daily one. The rest of throttling is handled by not getting
      // throttled -- see minIntervalMs.
      const stated429 = res.status === 429 ? Number(/retry in ([\d.]+)\s*s/i.exec(lastMessage)?.[1] ?? NaN) : NaN;
      const rollingWindow = Number.isFinite(stated429) && stated429 <= 90;
      const transient =
        (res.status === 429 && rollingWindow && attempt === 1) ||
        res.status >= 500 ||
        /high demand|overloaded|UNAVAILABLE/i.test(lastMessage);

      if (res.status === 429 && !transient) {
        throw new Error(
          `Gemini is rate-limited and one wait did not clear it: ${lastMessage}\n` +
            'Not retrying further: each attempt spends one of the requests the limit is counting. ' +
            'Either wait for the window, raise PANTOGRAPH_GEMINI_MIN_INTERVAL_MS to pace slower, or run one capability at a time.',
        );
      }

      if (!transient || attempt === attempts) break;

      // Honour Retry-After when offered; otherwise back off exponentially with
      // jitter, so a burst of parallel runs does not retry in lockstep.
      const retryAfter = Number(res.headers.get('retry-after'));
      // Google states the wait in the ERROR TEXT ("Please retry in 47.9s"), not
      // in a Retry-After header. Capping backoff at 15s then never clears a
      // 48-second window. Honour whichever hint is offered.
      const stated = /retry in ([\d.]+)\s*s/i.exec(lastMessage)?.[1];
      const waitMs =
        stated !== undefined
          ? Math.min(Number(stated) * 1000 + 5_000, 90_000)
          : Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 75_000)
            : Math.min(2 ** attempt * 1000, 15_000) + Math.floor(Math.random() * 750);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // A wrong model name is the likeliest failure and the least obvious from
    // Google's wording, so say what to do about it.
    const hint = /not found|not supported|NOT_FOUND|no longer available/i.test(lastMessage)
      ? ` -- "${this.model}" may not exist, may be retired, or may not support function calling. ` +
        'List what your key can use with GET https://generativelanguage.googleapis.com/v1beta/models, ' +
        'then set PANTOGRAPH_GEMINI_MODEL or pass --model.'
      : '';
    throw new Error(`Gemini request failed after ${attempts} attempt(s): ${lastMessage}${hint}`);
  }

  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    const body = {
      // Same prompt the Anthropic planner uses, imported rather than restated.
      systemInstruction: { parts: [{ text: DISCOVERY_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: renderUserTurn(req) }] }],
      tools: [{ functionDeclarations: toGeminiFunctionDeclarations(DISCOVERY_TOOLS) }],
      generationConfig: { maxOutputTokens: this.maxTokens, temperature: 0 },
    };

    const json = await this.post(body);

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const calls: PlannerToolCall[] = [];
    let reasoning = '';
    for (const part of parts) {
      if (part.text) reasoning += part.text;
      if (part.functionCall) {
        calls.push({ name: part.functionCall.name, input: part.functionCall.args ?? {} } as PlannerToolCall);
      }
    }

    return {
      reasoning: reasoning.trim() || undefined,
      calls,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
