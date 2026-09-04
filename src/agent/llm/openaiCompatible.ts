/**
 * OpenAI-compatible planner -- one implementation, most of the market.
 *
 * Groq, GitHub Models, Together, OpenRouter, Mistral and a local Ollama all
 * speak `POST /chat/completions` with OpenAI's tool-calling shape, so this takes
 * a base URL and a model name rather than being written once per vendor.
 *
 * Two things differ from the other planners and are worth knowing before
 * trusting a cheap model here:
 *
 *   - Tool arguments arrive as a JSON *string*, and a weaker model will
 *     occasionally emit malformed JSON. A bad call is dropped with a note rather
 *     than thrown, so the loop feeds the model a correction and carries on.
 *   - Smaller open models are markedly worse at this task: they pick label cells
 *     over inputs, forget the `parameter` field, and call `finish` early. The
 *     system survives all three -- the affordance check, the unused-input error
 *     and the premature-finish guard respectively -- but expect more turns.
 */

import type { Planner, PlannerRequest, PlannerResponse, PlannerToolCall } from './types.ts';
import { DISCOVERY_SYSTEM_PROMPT, DISCOVERY_TOOLS, renderUserTurn } from './contract.ts';
import { notePlannerCall } from '../../util/plannerCalls.ts';

/** Presets, so a caller supplies a key and nothing else. */
export const OPENAI_COMPATIBLE_PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Groq retires model names periodically, same as everyone -- the first two
    // defaults tried here were already gone. There is no "latest" alias on this
    // provider, so this WILL age; the error message tells you to list
    // /v1/models and set PANTOGRAPH_OPENAI_MODEL.
    defaultModel: 'openai/gpt-oss-120b',
    envKeys: ['GROQ_API_KEY'],
    signup: 'https://console.groq.com/keys',
    // The free tier meters TOKENS per minute (8000 on this model), and a screen
    // dump makes each turn ~2400 tokens, so roughly three turns a minute fit.
    // Pacing to match beats bouncing off the limit and retrying.
    minIntervalMs: 12_000,
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.inference.ai.azure.com',
    defaultModel: 'gpt-4o-mini',
    envKeys: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    signup: 'https://github.com/marketplace/models',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    envKeys: ['OPENROUTER_API_KEY'],
    signup: 'https://openrouter.ai/keys',
  },
  together: {
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    envKeys: ['TOGETHER_API_KEY'],
    signup: 'https://api.together.ai/settings/api-keys',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    envKeys: ['MISTRAL_API_KEY'],
    signup: 'https://console.mistral.ai/api-keys',
  },
  ollama: {
    label: 'local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.3',
    envKeys: [],
    signup: 'https://ollama.com',
  },
} as const;

export type OpenAiCompatibleProvider = keyof typeof OPENAI_COMPATIBLE_PROVIDERS;

/** OpenAI's `tools` array, projected from the one shared tool contract. */
export function toOpenAiTools(
  tools: ReadonlyArray<{ name: string; description?: string | undefined; input_schema: unknown }>,
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      // Plain JSON Schema, unlike Gemini's dialect. No translation needed.
      parameters: t.input_schema,
    },
  }));
}

type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
};

export type OpenAiCompatibleOptions = {
  readonly provider?: OpenAiCompatibleProvider;
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly minIntervalMs?: number;
};

export class OpenAiCompatiblePlanner implements Planner {
  readonly provider: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  /** Calls the model emitted that could not be parsed. Surfaced as reasoning. */
  private lastMalformed: string[] = [];

  constructor(opts: OpenAiCompatibleOptions = {}) {
    const name = opts.provider ?? 'groq';
    const preset = OPENAI_COMPATIBLE_PROVIDERS[name];
    if (!preset) throw new Error(`unknown provider "${name}"; known: ${Object.keys(OPENAI_COMPATIBLE_PROVIDERS).join(', ')}`);

    const fromEnv = preset.envKeys.map((k) => process.env[k]).find(Boolean);
    const apiKey = opts.apiKey ?? fromEnv ?? '';
    // Ollama needs no key; everyone else does.
    if (!apiKey && name !== 'ollama') {
      throw new Error(
        `No API key for ${preset.label}. Set ${preset.envKeys.join(' or ')} in .env, free key at ${preset.signup}, ` +
          'or run discovery with --mock-llm to use the scripted planner.',
      );
    }

    this.provider = name;
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? process.env['PANTOGRAPH_OPENAI_BASE_URL'] ?? preset.baseUrl;
    this.model = opts.model ?? process.env['PANTOGRAPH_OPENAI_MODEL'] ?? preset.defaultModel;
    this.maxTokens = opts.maxTokens ?? 1500;
    // Pacing is cheap insurance and costs nothing when the limit is generous.
    this.minIntervalMs =
      opts.minIntervalMs ??
      Number(process.env['PANTOGRAPH_OPENAI_MIN_INTERVAL_MS'] ?? ('minIntervalMs' in preset ? preset.minIntervalMs : 250));
  }

  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    this.lastMalformed = [];

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      messages: [
        // The same prompt the other planners use, imported not restated, so no
        // provider can drift into different discovery quality.
        { role: 'system', content: DISCOVERY_SYSTEM_PROMPT },
        { role: 'user', content: renderUserTurn(req) },
      ],
      tools: toOpenAiTools(DISCOVERY_TOOLS),
      tool_choice: 'auto',
    };

    const json = await this.post(body);
    const message = json.choices?.[0]?.message;

    const calls: PlannerToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      const name = call.function?.name;
      const raw = call.function?.arguments ?? '{}';
      if (!name) continue;
      try {
        // Arguments are a JSON STRING here, not an object, and a weaker model
        // does sometimes emit invalid JSON. Dropping the call and telling the
        // model beats throwing away the whole run.
        calls.push({ name, input: JSON.parse(raw) } as PlannerToolCall);
      } catch {
        this.lastMalformed.push(`${name}(${raw.slice(0, 120)})`);
      }
    }

    const reasoning = [
      message?.content?.trim() ?? '',
      this.lastMalformed.length
        ? `[${this.lastMalformed.length} tool call(s) had unparseable arguments and were dropped: ${this.lastMalformed.join('; ')}]`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      reasoning: reasoning || undefined,
      calls,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }

  /** Same retry discipline as the Gemini planner, for the same reasons. */
  private async post(body: unknown, attempts = 6): Promise<ChatResponse> {
    let lastMessage = 'unknown error';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const sinceLast = Date.now() - this.lastRequestAt;
      if (this.lastRequestAt && sinceLast < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - sinceLast));
      }
      this.lastRequestAt = Date.now();

      notePlannerCall();
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as ChatResponse;
      if (res.ok && !json.error) return json;

      lastMessage = json.error?.message ?? `HTTP ${res.status}`;

      // TWO DIFFERENT THINGS WEAR THE SAME 429, and they want opposite handling.
      //
      // A TOKEN BUCKET refills continuously. Groq's free tier limits tokens per
      // minute -- 8000 TPM, against a ~2400-token prompt, so about three turns a
      // minute -- and says "try again in 45ms". Waiting briefly and retrying is
      // exactly right there, and each attempt costs nothing that is not coming
      // back.
      //
      // A SPENT ALLOWANCE does not refill soon, and every attempt consumes one
      // of the requests being counted, so retrying keeps it spent. A ~20/day
      // free-tier limit is that shape.
      //
      // The stated wait separates them: a short one is a bucket, a long one (or
      // none) is an allowance.
      const stated = Number(/(?:retry|try) again in ([\d.]+)\s*(m?s)/i.exec(lastMessage)?.[1] ?? NaN);
      const statedUnit = /(?:retry|try) again in [\d.]+\s*(m?s)/i.exec(lastMessage)?.[1];
      const statedMs = Number.isFinite(stated) ? (statedUnit === 'ms' ? stated : stated * 1000) : NaN;
      const retryAfter = Number(res.headers.get('retry-after'));
      const bucket = Number.isFinite(statedMs) && statedMs <= 30_000;
      const transient = (res.status === 429 && bucket) || res.status >= 500;

      if (res.status === 429 && !bucket) {
        throw new Error(
          `${this.provider} allowance looks spent rather than momentarily throttled: ${lastMessage}\n` +
            'Not retrying: each attempt spends one of the requests being counted.',
        );
      }
      if (!transient || attempt === attempts) break;

      // Floor the wait: a bucket that reports "45ms" still needs real time to
      // refill enough headroom for a 2400-token prompt, and retrying instantly
      // just burns an attempt.
      const waitMs = Number.isFinite(statedMs)
        ? Math.max(statedMs + 250, 4_000)
        : Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : Math.min(2 ** attempt * 1000, 8_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const hint = /model|not found|does not exist|decommissioned/i.test(lastMessage)
      ? ` -- "${this.model}" may be retired or may not support tool calling on this provider. Set PANTOGRAPH_OPENAI_MODEL or pass --model.`
      : '';
    throw new Error(`${this.provider} request failed after ${attempts} attempt(s): ${lastMessage}${hint}`);
  }
}
