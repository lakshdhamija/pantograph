/**
 * The live-model path, verified without a live model.
 *
 * `discover --mock-llm` exercises everything in the discovery loop except the
 * decision itself, which leaves one thing untested: whether the code that talks
 * to Anthropic is correct. That is not a small surface, a wrong tool schema, a
 * mis-parsed `tool_use` block or a credential leaking into the prompt would all
 * only show up on a run that costs money and needs a key nobody has in CI.
 *
 * So this points the real `AnthropicPlanner` at a local HTTP server that speaks
 * the Messages API, and asserts on the request it actually sends. Everything is
 * the production path apart from what is listening on the socket.
 *
 * WHAT THIS PROVES: the request is well-formed, the tool schemas are valid, a
 * `tool_use` response is parsed into the planner's own types, usage is recorded,
 * and no secret reaches the wire.
 *
 * WHAT IT CANNOT PROVE: that a model's judgement is any good, that it finds a
 * nameless field in a frameset, parameterises rather than hardcodes, and calls
 * `finish` at the right moment. That needs a real key and a real run, and no
 * amount of stubbing substitutes for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicPlanner } from '../src/agent/llm/anthropic.ts';
import { GeminiPlanner } from '../src/agent/llm/gemini.ts';
import { DISCOVERY_SYSTEM_PROMPT, renderUserTurn } from '../src/agent/llm/contract.ts';
import { OPENAI_COMPATIBLE_PROVIDERS, OpenAiCompatiblePlanner } from '../src/agent/llm/openaiCompatible.ts';
import { selectCapability } from '../src/capabilities/ask.ts';
import { parseCapability, type Capability } from '../src/artifact/schema.ts';
import { eq, has } from '../src/surface/types.ts';
import type { PlannerRequest } from '../src/agent/llm/types.ts';

type Captured = { path: string; headers: Record<string, unknown>; body: any };

/** A server that speaks just enough of the Messages API, and records the request. */
async function withStub(
  reply: (body: any) => unknown,
  body: (baseUrl: string, captured: () => Captured | undefined) => Promise<void>,
): Promise<void> {
  let captured: Captured | undefined;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    captured = { path: req.url ?? '', headers: req.headers as Record<string, unknown>, body: parsed };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply(parsed)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, () => captured);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function messageWith(content: unknown[]): unknown {
  return {
    id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content, stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 1234, output_tokens: 56 },
  };
}

const SCREEN = `URL: http://127.0.0.1:8731/desk
TITLE: CORETELLER Desktop

--- frame: content ---
  cell "Member Number" ref=content#n6
  textbox (NO ACCESSIBLE NAME) ref=content#n9
  button "Go" ref=content#n12`;

function plannerRequest(over: Partial<PlannerRequest> = {}): PlannerRequest {
  return {
    goal: 'Look up member 100234 and read their savings balance',
    stepBudget: { used: 0, max: 25 },
    screen: SCREEN,
    location: 'http://127.0.0.1:8731/desk',
    history: [],
    parameters: [
      { name: 'memberId', value: '100234', description: 'the member number', sensitive: false },
      // The credential: the loop blanks a secret's value before it gets here,
      // and the planner must not put the name anywhere near a value either.
      { name: 'operatorPassword', value: '', description: 'sign-on password', sensitive: true },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------

test('the planner sends a well-formed Messages API request', async () => {
  await withStub(
    () => messageWith([{ type: 'tool_use', id: 'tu_1', name: 'act', input: { intent: 'type the member number', kind: 'fill', ref: 'content#n9', value: '100234', parameter: 'memberId' } }]),
    async (baseUrl, captured) => {
      const planner = new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl });
      await planner.plan(plannerRequest());

      const req = captured()!;
      assert.equal(req.path, '/v1/messages');
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.body.model, 'claude-sonnet-5');
      assert.ok(req.body.max_tokens > 0);
      assert.ok(typeof req.body.system === 'string' && req.body.system.length > 500, 'the system prompt should actually be sent');
      assert.equal(req.body.messages.length, 1);
      assert.equal(req.body.messages[0].role, 'user');
    },
  );
});

test('every tool it offers is a valid JSON Schema object with required fields', async () => {
  await withStub(
    () => messageWith([{ type: 'text', text: 'thinking' }]),
    async (baseUrl, captured) => {
      await new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl }).plan(plannerRequest());
      const tools = captured()!.body.tools as Array<{ name: string; description: string; input_schema: any }>;

      assert.deepEqual(tools.map((t) => t.name).sort(), ['act', 'declare_outcome', 'declare_output', 'finish', 'give_up']);
      for (const t of tools) {
        assert.ok(t.description.length > 10, `${t.name} needs a description the model can act on`);
        assert.equal(t.input_schema.type, 'object');
        assert.ok(t.input_schema.properties && Object.keys(t.input_schema.properties).length, `${t.name} has no properties`);
        assert.ok(Array.isArray(t.input_schema.required), `${t.name} declares no required fields`);
        for (const r of t.input_schema.required) {
          assert.ok(r in t.input_schema.properties, `${t.name} requires "${r}" but does not define it`);
        }
      }
    },
  );
});

test('a secret parameter value never reaches the wire', async () => {
  await withStub(
    () => messageWith([{ type: 'text', text: 'ok' }]),
    async (baseUrl, captured) => {
      const planner = new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl });
      // Simulate a caller that failed to blank the value, which is the case that
      // actually matters: the planner must not relay it even if handed it.
      await planner.plan(
        plannerRequest({
          parameters: [
            { name: 'memberId', value: '100234', description: 'the member number', sensitive: false },
            { name: 'operatorPassword', value: 'hunter2-real-credential', description: 'sign-on password', sensitive: true },
          ],
        }),
      );
      const wire = JSON.stringify(captured()!.body);
      assert.ok(!wire.includes('hunter2-real-credential'), 'a sensitive parameter value must never be sent to the model');
      assert.ok(wire.includes('operatorPassword'), 'its name is fine to send; the model needs to know the parameter exists');
      assert.ok(wire.includes('100234'), 'a public parameter value is sent, so the model can use it');
    },
  );
});

test('a tool_use response is parsed into the planner types, with usage', async () => {
  await withStub(
    () =>
      messageWith([
        { type: 'text', text: 'The member number field has no name; using its ref.' },
        { type: 'tool_use', id: 'tu_1', name: 'act', input: { intent: 'type the member number', kind: 'fill', ref: 'content#n9', value: '100234', parameter: 'memberId' } },
        { type: 'tool_use', id: 'tu_2', name: 'act', input: { intent: 'run the inquiry', kind: 'click', ref: 'content#n12' } },
      ]),
    async (baseUrl) => {
      const res = await new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl }).plan(plannerRequest());
      assert.equal(res.calls.length, 2);
      assert.equal(res.calls[0]!.name, 'act');
      assert.match(res.reasoning ?? '', /no name/);
      assert.equal(res.usage?.inputTokens, 1234);
      assert.equal(res.usage?.outputTokens, 56);
    },
  );
});

test('a response with no tool call yields no calls rather than throwing', async () => {
  await withStub(
    () => messageWith([{ type: 'text', text: 'I am not sure what to do here.' }]),
    async (baseUrl) => {
      const res = await new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl }).plan(plannerRequest());
      assert.equal(res.calls.length, 0, 'the loop handles this by feeding back a correction, so it must not throw');
    },
  );
});

test('the screen the model is shown is the same one the resolver sees', async () => {
  await withStub(
    () => messageWith([{ type: 'text', text: 'ok' }]),
    async (baseUrl, captured) => {
      await new AnthropicPlanner({ apiKey: 'sk-ant-stub-not-real', baseUrl }).plan(plannerRequest());
      const user = captured()!.body.messages[0].content as string;
      // The point of the design: a control with no accessible name is presented
      // as having none, so the model cannot invent an identity replay could not
      // reproduce.
      assert.ok(user.includes('NO ACCESSIBLE NAME'));
      assert.ok(user.includes('content#n9'), 'handles must be shown; they are the only way it may refer to a control');
      assert.ok(user.includes('GOAL:'));
      assert.ok(user.includes('RUN PARAMETERS'));
    },
  );
});

// ---------------------------------------------------------------------------
// `ask`: the agent-facing selection path
// ---------------------------------------------------------------------------

function readCapability(): Capability {
  return parseCapability({
    schemaVersion: '1.0.0', id: 'c1', key: 'member.read-savings-balance', version: '1.0.0',
    title: 'Read a savings balance', description: 'Look up a member and return their savings balance.',
    app: { profile: 'coreteller', surface: 'legacy_web', entrypointTemplate: '{{env.baseUrl}}/login' },
    tenant: { id: 'a', overrides: [] },
    inputs: [
      { name: 'memberId', type: 'string', description: 'member number', required: true, sensitivity: 'public' },
      { name: 'operatorPassword', type: 'string', description: 'sign-on password', required: true, sensitivity: 'secret' },
    ],
    outputs: [],
    preconditions: [],
    steps: [{ id: 's1', intent: 'go', action: { kind: 'click', target: { role: 'button', name: eq('Go'), strategies: [{ kind: 'role_name' }] } }, timeoutMs: 1000, risk: 'safe', optional: false }],
    successCondition: { kind: 'text_present', text: has('ok') },
    outcomes: [], recoveries: [], failureSignatures: [],
    policy: { allowedOrigins: [], allowedActions: [], riskTier: 'safe', requiresHumanApproval: false, maxDurationMs: 1000, portabilityFloor: 'any_surface', idempotent: true },
    provenance: { recordedAt: 'n', recordedBy: 't', discoveryRunId: 'r', goal: 'g', planner: { provider: 'p', model: 'm' }, transcriptDigest: 'd' },
    approval: { state: 'approved' },
    stability: {},
  });
}

test('ask never offers a credential to the model, and merges it in after selection', async () => {
  await withStub(
    (body) => {
      // Assert from inside the stub: whatever schema arrives must not mention it.
      const tools = body.tools as Array<{ input_schema: { properties: Record<string, unknown>; required: string[] } }>;
      for (const t of tools) {
        assert.ok(!('operatorPassword' in t.input_schema.properties), 'a secret must be stripped from the tool schema');
        assert.ok(!t.input_schema.required.includes('operatorPassword'));
      }
      return messageWith([{ type: 'tool_use', id: 'tu_1', name: 'member_read_savings_balance', input: { memberId: '100987' } }]);
    },
    async (baseUrl) => {
      const previous = process.env['ANTHROPIC_BASE_URL'];
      process.env['ANTHROPIC_BASE_URL'] = baseUrl;
      try {
        const outcome = await selectCapability({
          request: 'what is the savings balance for member 100987?',
          capabilities: [readCapability()],
          apiKey: 'sk-ant-stub-not-real',
          runtimeInputs: { operatorPassword: 'supplied-by-the-runtime' },
        });
        assert.equal(outcome.kind, 'selected');
        assert.ok(outcome.kind === 'selected');
        assert.equal(outcome.selection.capability.key, 'member.read-savings-balance');
        assert.equal(outcome.selection.args['memberId'], '100987');
        // Selection came from the model; the credential came from the runtime.
        assert.equal(outcome.selection.args['operatorPassword'], 'supplied-by-the-runtime');
      } finally {
        if (previous === undefined) delete process.env['ANTHROPIC_BASE_URL'];
        else process.env['ANTHROPIC_BASE_URL'] = previous;
      }
    },
  );
});

test('ask declines rather than guessing when the model calls nothing', async () => {
  await withStub(
    () => messageWith([{ type: 'text', text: 'No capability covers wire transfers. I would need one that does.' }]),
    async (baseUrl) => {
      const previous = process.env['ANTHROPIC_BASE_URL'];
      process.env['ANTHROPIC_BASE_URL'] = baseUrl;
      try {
        const outcome = await selectCapability({
          request: 'wire $40,000 to account 12345',
          capabilities: [readCapability()],
          apiKey: 'sk-ant-stub-not-real',
        });
        assert.equal(outcome.kind, 'declined');
        assert.ok(outcome.kind === 'declined');
        assert.match(outcome.reasoning, /wire transfers/);
        assert.deepEqual(outcome.offered, ['member_read_savings_balance']);
      } finally {
        if (previous === undefined) delete process.env['ANTHROPIC_BASE_URL'];
        else process.env['ANTHROPIC_BASE_URL'] = previous;
      }
    },
  );
});

test('ask refuses a catalog with nothing approved', async () => {
  const draft = parseCapability({ ...readCapability(), approval: { state: 'draft' } });
  const outcome = await selectCapability({ request: 'anything', capabilities: [draft], apiKey: 'sk-ant-stub-not-real' });
  assert.equal(outcome.kind, 'declined');
  assert.ok(outcome.kind === 'declined');
  assert.match(outcome.reasoning, /No approved capabilities/);
});

// ---------------------------------------------------------------------------
// The Gemini planner: same seam, different wire format
// ---------------------------------------------------------------------------

function geminiReply(parts: unknown[]): unknown {
  return {
    candidates: [{ content: { parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 999, candidatesTokenCount: 42 },
  };
}

test('the Gemini planner sends the same prompt and tool contract, in Google shape', async () => {
  await withStub(
    () => geminiReply([{ text: 'ok' }]),
    async (baseUrl, captured) => {
      const planner = new GeminiPlanner({ apiKey: 'stub-not-real', baseUrl, model: 'gemini-test' });
      await planner.plan(plannerRequest());

      const req = captured()!;
      assert.match(req.path, /\/gemini-test:generateContent$/);
      assert.equal(req.headers['x-goog-api-key'], 'stub-not-real');

      // The prompt is IMPORTED from the Anthropic planner, not restated, so the
      // two providers cannot drift into different discovery quality.
      assert.equal(req.body.systemInstruction.parts[0].text, DISCOVERY_SYSTEM_PROMPT);

      const decls = req.body.tools[0].functionDeclarations as Array<{ name: string }>;
      assert.deepEqual(decls.map((d) => d.name).sort(), ['act', 'declare_outcome', 'declare_output', 'finish', 'give_up']);
    },
  );
});

test('schemas are translated into Gemini\'s dialect, not passed through', async () => {
  await withStub(
    () => geminiReply([{ text: 'ok' }]),
    async (baseUrl, captured) => {
      await new GeminiPlanner({ apiKey: 'stub-not-real', baseUrl }).plan(plannerRequest());
      const wire = JSON.stringify(captured()!.body.tools);

      // Gemini rejects unknown keys rather than ignoring them, and wants types
      // upper-cased. Either one is a 400 on every single request.
      assert.ok(!/"type":"(string|object|number|boolean|array|integer)"/.test(wire), 'types must be upper-cased');
      assert.ok(/"type":"OBJECT"/.test(wire));
      for (const banned of ['pattern', 'examples', 'additionalProperties', 'minimum', 'writeOnly']) {
        assert.ok(!wire.includes(`"${banned}"`), `${banned} is not in Gemini's schema dialect and must be stripped`);
      }
    },
  );
});

test('a Gemini functionCall is parsed into the same PlannerToolCall shape', async () => {
  await withStub(
    () =>
      geminiReply([
        { text: 'The member field has no name; using its handle.' },
        { functionCall: { name: 'act', args: { intent: 'type the member number', kind: 'fill', ref: 'content#n9', value: '100234', parameter: 'memberId' } } },
      ]),
    async (baseUrl) => {
      const res = await new GeminiPlanner({ apiKey: 'stub-not-real', baseUrl }).plan(plannerRequest());
      assert.equal(res.calls.length, 1);
      assert.equal(res.calls[0]!.name, 'act');
      assert.equal((res.calls[0]!.input as { ref?: string }).ref, 'content#n9');
      assert.match(res.reasoning ?? '', /no name/);
      assert.equal(res.usage?.inputTokens, 999);
      assert.equal(res.usage?.outputTokens, 42);
    },
  );
});

test('a secret parameter value never reaches Gemini either', async () => {
  await withStub(
    () => geminiReply([{ text: 'ok' }]),
    async (baseUrl, captured) => {
      await new GeminiPlanner({ apiKey: 'stub-not-real', baseUrl }).plan(
        plannerRequest({
          parameters: [
            { name: 'memberId', value: '100234', description: 'the member number', sensitive: false },
            { name: 'operatorPassword', value: 'hunter2-real-credential', description: 'sign-on password', sensitive: true },
          ],
        }),
      );
      const wire = JSON.stringify(captured()!.body);
      assert.ok(!wire.includes('hunter2-real-credential'), 'the guarantee must hold per-provider, not just for one');
      assert.ok(wire.includes('operatorPassword'));
    },
  );
});

test('a wrong model name produces an error that says what to do', async () => {
  await withStub(
    () => ({ error: { code: 404, message: 'models/gemini-nope is not found for API version v1beta', status: 'NOT_FOUND' } }),
    async (baseUrl) => {
      await assert.rejects(
        () => new GeminiPlanner({ apiKey: 'stub-not-real', baseUrl, model: 'gemini-nope' }).plan(plannerRequest()),
        /AI Studio|PANTOGRAPH_GEMINI_MODEL/,
      );
    },
  );
});

test('the user turn is identical across providers', () => {
  // Divergence here would silently make one provider better at discovery than
  // the other, which would make the seam a fiction.
  const req = plannerRequest();
  const rendered = renderUserTurn(req);
  assert.ok(rendered.includes('GOAL:'));
  assert.ok(rendered.includes('RUN PARAMETERS'));
  assert.ok(rendered.includes('NO ACCESSIBLE NAME'));
  assert.ok(rendered.includes('content#n9'));
  assert.ok(!rendered.includes('hunter2'), 'sensitive values are blanked here too');
});

// ---------------------------------------------------------------------------
// The OpenAI-compatible planner: one implementation, many providers
// ---------------------------------------------------------------------------

function chatReply(opts: { content?: string | null; toolCalls?: Array<{ name: string; args: string }> } = {}): unknown {
  return {
    choices: [{
      message: {
        content: opts.content ?? null,
        ...(opts.toolCalls ? { tool_calls: opts.toolCalls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 777, completion_tokens: 33 },
  };
}

test('the OpenAI-compatible planner posts chat/completions with the shared contract', async () => {
  await withStub(
    () => chatReply({ content: 'ok' }),
    async (baseUrl, captured) => {
      const planner = new OpenAiCompatiblePlanner({ provider: 'groq', apiKey: 'stub', baseUrl, model: 'llama-test', minIntervalMs: 0 });
      await planner.plan(plannerRequest());

      const req = captured()!;
      assert.equal(req.path, '/chat/completions');
      assert.equal(req.headers['authorization'], 'Bearer stub');
      assert.equal(req.body.model, 'llama-test');
      // The prompt is imported, not restated, so providers cannot drift.
      assert.equal(req.body.messages[0].role, 'system');
      assert.equal(req.body.messages[0].content, DISCOVERY_SYSTEM_PROMPT);
      const names = (req.body.tools as Array<{ type: string; function: { name: string } }>).map((t) => t.function.name);
      assert.deepEqual(names.sort(), ['act', 'declare_outcome', 'declare_output', 'finish', 'give_up']);
      assert.ok((req.body.tools as Array<{ type: string }>).every((t) => t.type === 'function'));
    },
  );
});

test('tool arguments arrive as a JSON string and are parsed', async () => {
  await withStub(
    () => chatReply({ toolCalls: [{ name: 'act', args: JSON.stringify({ intent: 'type the member number', kind: 'fill', ref: 'content#n9', value: '100234', parameter: 'memberId' }) }] }),
    async (baseUrl) => {
      const res = await new OpenAiCompatiblePlanner({ provider: 'groq', apiKey: 'stub', baseUrl, minIntervalMs: 0 }).plan(plannerRequest());
      assert.equal(res.calls.length, 1);
      assert.equal((res.calls[0]!.input as { ref?: string }).ref, 'content#n9');
      assert.equal(res.usage?.inputTokens, 777);
    },
  );
});

test('a malformed tool call is dropped with a note, not thrown', async () => {
  // A weaker open model does emit invalid JSON. Throwing away the whole run for
  // one bad call is worse than telling the model and carrying on -- the loop
  // feeds `reasoning` back as context on the next turn.
  await withStub(
    () => chatReply({
      content: 'attempting',
      toolCalls: [
        { name: 'act', args: '{"intent":"click go","kind":"click","ref":' },
        { name: 'act', args: JSON.stringify({ intent: 'click go', kind: 'click', ref: 'content#n12' }) },
      ],
    }),
    async (baseUrl) => {
      const res = await new OpenAiCompatiblePlanner({ provider: 'groq', apiKey: 'stub', baseUrl, minIntervalMs: 0 }).plan(plannerRequest());
      assert.equal(res.calls.length, 1, 'the valid call survives');
      assert.match(res.reasoning ?? '', /unparseable/);
    },
  );
});

test('a secret parameter value never reaches an OpenAI-compatible provider either', async () => {
  await withStub(
    () => chatReply({ content: 'ok' }),
    async (baseUrl, captured) => {
      await new OpenAiCompatiblePlanner({ provider: 'groq', apiKey: 'stub', baseUrl, minIntervalMs: 0 }).plan(
        plannerRequest({
          parameters: [
            { name: 'memberId', value: '100234', description: 'the member number', sensitive: false },
            { name: 'operatorPassword', value: 'hunter2-real-credential', description: 'sign-on password', sensitive: true },
          ],
        }),
      );
      const wire = JSON.stringify(captured()!.body);
      assert.ok(!wire.includes('hunter2-real-credential'), 'the guarantee must hold for every provider');
      assert.ok(wire.includes('operatorPassword'));
    },
  );
});

test('every provider preset names an env var and a signup URL', () => {
  for (const [name, p] of Object.entries(OPENAI_COMPATIBLE_PROVIDERS)) {
    assert.ok(p.baseUrl.startsWith('http'), `${name} needs a base URL`);
    assert.ok(p.defaultModel.length > 0, `${name} needs a default model`);
    assert.ok(p.signup.startsWith('http'), `${name} needs a signup URL for the error message`);
    // Ollama is the one that legitimately needs no key.
    assert.ok(p.envKeys.length > 0 || name === 'ollama', `${name} needs an env var`);
  }
});

test('a missing key names the provider and where to get one', () => {
  assert.throws(
    () => new OpenAiCompatiblePlanner({ provider: 'groq', apiKey: '' }),
    /GROQ_API_KEY.*console\.groq\.com/s,
  );
});
