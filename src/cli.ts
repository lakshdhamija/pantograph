#!/usr/bin/env node
/**
 * Pantograph CLI.
 *
 *   pantograph app                     run the CORETELLER fixture
 *   pantograph discover ...            LLM-driven discovery -> capability artifact
 *   pantograph replay <key> ...        deterministic replay, no model in the loop
 *   pantograph catalog                 the agent-facing capability catalog
 *   pantograph approve <key>           move a capability from draft to approved
 *
 * `node src/cli.ts <command> --help` prints the flags for each.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './util/main.ts';
import { startLegacyBank } from '../fixtures/legacy-bank/server.ts';
import { createSession } from './runtime.ts';
import { discover, type RunParameter } from './agent/loop.ts';
import { AnthropicPlanner } from './agent/llm/anthropic.ts';
import { GeminiPlanner } from './agent/llm/gemini.ts';
import { OPENAI_COMPATIBLE_PROVIDERS, OpenAiCompatiblePlanner, type OpenAiCompatibleProvider } from './agent/llm/openaiCompatible.ts';
import { ScriptedPlanner, SCRIPTED_RULE_SETS } from './agent/llm/mock.ts';
import { compile } from './artifact/compile.ts';
import { PROFILES, profileFor } from './artifact/profiles.ts';
import { CapabilityStore, lintSpecialisation, materialize } from './artifact/store.ts';
import { replayCapability } from './replay/engine.ts';
import { formatStabilityReport, measureStability } from './replay/stability.ts';
import { createAutoOperator } from './escalation/autoOperator.ts';
import { catalogEntry, toolDefinitionFor } from './capabilities/catalog.ts';
import { modelSuppliedArgs, selectCapability } from './capabilities/ask.ts';
import { startCatalogServer } from './capabilities/server.ts';
import type { OperatorMode } from './escalation/broker.ts';
import type { Capability, Sensitivity } from './artifact/schema.ts';
import type { ReplayResult } from './replay/outcomes.ts';

// Node loads .env natively, so ANTHROPIC_API_KEY and friends work without a
// dependency and without the caller remembering --env-file.
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    console.warn('warning: .env exists but could not be parsed; continuing with the ambient environment');
  }
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

type Args = { _: string[]; flags: Map<string, string[]> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eqAt = a.indexOf('=');
    const key = eqAt > 0 ? a.slice(2, eqAt) : a.slice(2);
    let value = eqAt > 0 ? a.slice(eqAt + 1) : undefined;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = 'true';
      }
    }
    const list = out.flags.get(key) ?? [];
    list.push(value);
    out.flags.set(key, list);
  }
  return out;
}

const one = (a: Args, k: string, d?: string): string | undefined => a.flags.get(k)?.[0] ?? d;
const many = (a: Args, k: string): string[] => a.flags.get(k) ?? [];
const bool = (a: Args, k: string): boolean => {
  const v = a.flags.get(k)?.[0];
  return v !== undefined && v !== 'false';
};

function kvPairs(values: string[]): Array<[string, string]> {
  return values.map((v) => {
    const at = v.indexOf('=');
    if (at < 0) throw new Error(`expected name=value, got ${JSON.stringify(v)}`);
    return [v.slice(0, at), v.slice(at + 1)] as [string, string];
  });
}

const DEFAULT_BASE = 'http://127.0.0.1:8731';

const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  memberId: 'The member number to look up, as printed on the member record.',
  operatorId: 'Operator sign-on id for the core banking session.',
  operatorPassword: 'Operator sign-on password. Never persisted or logged.',
  productCode: 'Share product code for the new sub-account, e.g. S06.',
  openingDeposit: 'Opening deposit amount in USD.',
  branchCode: 'Branch code, required by institutions configured to demand one.',
};

// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args._[0];

  switch (command) {
    case 'app': return cmdApp(args);
    case 'discover': return cmdDiscover(args);
    case 'replay': return cmdReplay(args);
    case 'catalog': return cmdCatalog(args);
    case 'stability': return cmdStability(args);
    case 'ask': return cmdAsk(args);
    case 'approve': return cmdApprove(args);
    case undefined:
    case 'help':
      printHelp();
      return 0;
    default:
      console.error(`unknown command "${command}"\n`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`pantograph -- record a UI flow once with a model, replay it deterministically forever

  node src/cli.ts app [--port 8731]
      Run the CORETELLER fixture (the stand-in legacy core banking app).

  node src/cli.ts discover --goal "..." --key member.read-savings-balance --title "..."
                           [--param name=value]... [--secret-env name=ENV_VAR]... [--desc name=text]...
                           [--mock-llm | --planner anthropic|gemini|groq|github|
                                          openrouter|together|mistral|ollama]
                           [--model NAME]
                           [--rules read-savings-balance|open-sub-account]
                           [--tenant first-riverside-cu] [--base-url URL] [--headed]
                           [--operator abort|auto|console] [--max-steps 25]
                           [--operator-id NAME] [--operator-port 8732]
      Drive the app with a planner until the goal is met, then compile the run
      into a capability artifact under ./artifacts.
      --operator console prints a URL carrying a per-run bearer token; the
      console refuses every request without it. --operator-id names whoever is
      at that console, and is stamped on their actions in the evidence.

  node src/cli.ts replay <key>[@version] [--input name=value]... [--input-env name=ENV_VAR]...
                         [--operator abort|auto|console] [--arm mode[:after[:count]]]
                         [--operator-id NAME] [--operator-port 8732]
                         [--base-url URL] [--headed] [--record-stability]
      Replay a capability with no model in the loop. --video DIR records the
      browser session to a webm; --slow-mo MS makes it watchable.
      --arm mode[:after[:count]] injects a fault into the fixture, optionally
      skipping "after" screens first so it lands mid-flow. Modes:
      session_expiry, app_error, interstitial, validation, slow.

  node src/cli.ts catalog [--json] [--tools] [--serve] [--port 8733]
      Show saved capabilities as an agent-invocable catalog.

  node src/cli.ts ask "look up member 100987's savings balance" [--input-env name=VAR]...
      Hand the catalog to a model as tools, let it pick the capability that
      answers your sentence, then replay that capability deterministically.
      Needs ANTHROPIC_API_KEY -- this is the one command where the model is
      doing the part only a model can do. Credentials are supplied by the
      runtime after selection and are never shown to the model.

  node src/cli.ts stability <key>[@version] [--input name=value]... [--runs 5]
      Replay one capability N times against fresh sessions and report whether
      the answer varied (flaky) and whether locators moved down their ladder
      (degrading) -- the drift signal, before anything actually breaks.

  node src/cli.ts approve <key>[@version] --by "name" [--note "..."]
      Move a capability from draft to approved so it can be invoked unattended.

  Common flags: --artifacts DIR (default ./artifacts), --runs-dir DIR
  (default ./runs), --run-id NAME to name a run's evidence directory.

  Credentials: prefer --secret-env / --input-env, which read the value from an
  environment variable. A secret passed as --secret name=value lands in your
  shell history and in ps output.
`);
}

// ---------------------------------------------------------------------------

async function cmdApp(args: Args): Promise<number> {
  const port = Number(one(args, 'port', '8731'));
  const { url } = await startLegacyBank(port);
  console.log(`CORETELLER fixture listening on ${url}`);
  console.log(`  tenant A (First Riverside CU): ${url}/login`);
  console.log(`  tenant B (Granite State Bank): ${url}/t/granite/login`);
  console.log(`  fault injection:               POST ${url}/_chaos  mode=session_expiry|app_error|interstitial|validation|slow`);
  console.log('\nCtrl-C to stop.');
  await new Promise(() => undefined);
  return 0;
}

// ---------------------------------------------------------------------------

async function cmdDiscover(args: Args): Promise<number> {
  const goal = one(args, 'goal');
  const key = one(args, 'key');
  const title = one(args, 'title');
  if (!goal || !key || !title) {
    console.error('discover requires --goal, --key and --title');
    return 2;
  }

  const baseUrl = one(args, 'base-url', DEFAULT_BASE)!;
  const tenantId = one(args, 'tenant', 'first-riverside-cu')!;
  const entrypoint = one(args, 'entrypoint', `${baseUrl}${tenantPrefix(tenantId)}/login`)!;
  const descriptions = new Map(kvPairs(many(args, 'desc')));

  const parameters: RunParameter[] = [
    ...kvPairs(many(args, 'param')).map(([name, value]) => param(name, value, 'public', descriptions)),
    ...kvPairs(many(args, 'secret')).map(([name, value]) => param(name, value, 'secret', descriptions)),
    ...readEnvPairs(many(args, 'secret-env')).map(([name, value]) => param(name, value, 'secret', descriptions)),
  ];
  if (many(args, 'secret').length) {
    console.warn('warning: --secret puts the value in your shell history and in ps output. Prefer --secret-env NAME=ENV_VAR.');
  }

  const useMock = bool(args, 'mock-llm') || process.env['PANTOGRAPH_MOCK_LLM'] === '1';
  const ruleSet = one(args, 'rules', 'read-savings-balance')!;
  // Which provider, if any. Three implementations of one interface; the loop,
  // the compiler and the evidence pipeline cannot tell them apart.
  const which = useMock ? 'scripted' : (one(args, 'planner', 'anthropic') ?? 'anthropic');
  let planner;
  if (which === 'scripted') {
    const rules = SCRIPTED_RULE_SETS[ruleSet];
    if (!rules) {
      console.error(`no scripted rule set "${ruleSet}"; available: ${Object.keys(SCRIPTED_RULE_SETS).join(', ')}`);
      return 2;
    }
    planner = new ScriptedPlanner(rules, `scripted:${ruleSet}`);
    console.log(`planner: SCRIPTED (${ruleSet}) -- no model is being called. See src/agent/llm/mock.ts.`);
  } else {
    try {
      planner =
        which === 'gemini'
          ? new GeminiPlanner({ model: one(args, 'model') })
          : which === 'anthropic'
            ? new AnthropicPlanner({ model: one(args, 'model') })
            : which in OPENAI_COMPATIBLE_PROVIDERS
              ? new OpenAiCompatiblePlanner({ provider: which as OpenAiCompatibleProvider, model: one(args, 'model') })
              : undefined;
      if (!planner) {
        console.error(
          `unknown planner "${which}"; expected anthropic, gemini, ${Object.keys(OPENAI_COMPATIBLE_PROVIDERS).join(', ')}, or --mock-llm`,
        );
        return 2;
      }
    } catch (e) {
      console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    console.log(`planner: ${planner.provider} ${planner.model}`);
  }

  const operatorMode = (one(args, 'operator', 'abort') ?? 'abort') as OperatorMode;
  const session = await createSession({
    mode: 'discovery',
    runId: one(args, 'run-id'),
    runsDir: one(args, 'runs-dir'),
    policyFile: existingPolicyFile(),
    headless: !bool(args, 'headed'),
    operatorMode,
    // Explicit opt-in: the scripted operator may rubber-stamp only because a
    // person typed --operator auto, accepting that this run is a demo or a test.
    autoOperator: createAutoOperator({ approveIrreversible: operatorMode === 'auto' }),
    operatorPort: Number(one(args, 'operator-port', '8732')),
    operatorId: one(args, 'operator-id') || undefined,
    artifactsDir: one(args, 'artifacts', 'artifacts'),
  });
  if (session.operatorConsoleUrl) {
    console.log(`operator console: ${session.operatorConsoleUrl}`);
    console.log('  the token in that URL is this run\'s; the console refuses every request without it');
  }
  console.log(`run evidence:  ${session.dir}\n`);

  const discoveryProfile = profileFor(one(args, 'profile', 'coreteller')!);
  if (!discoveryProfile) {
    console.error(`unknown app profile "${one(args, 'profile')}"; known: ${Object.keys(PROFILES).join(', ')}`);
    await session.close();
    return 2;
  }
  // Same vocabulary the compiler and the replay engine will use, so discovery
  // does not escalate on a verb this product uses benignly.
  session.surface.setRiskPatterns(discoveryProfile.riskPatterns);

  try {
    const result = await discover({
      goal,
      entrypoint,
      parameters,
      surface: session.surface,
      recorder: session.recorder,
      broker: session.broker,
      planner,
      maxSteps: Number(one(args, 'max-steps', '25')),
    });

    // The full transcript is evidence, not contract. It is written next to the
    // event log so a reviewer can see what the model actually said.
    writeFileSync(join(session.dir, 'transcript.json'), JSON.stringify(session.recorder.redactor.deep(result.transcript), null, 2) + '\n');

    console.log(`\ndiscovery: ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s over ${result.steps.length} step(s)`);
    if (result.status !== 'succeeded') {
      session.recorder.finish(result.status);
      console.error(`\nNo artifact written: discovery ended as "${result.status}".`);
      console.error(`Evidence: ${session.dir}`);
      return 1;
    }

    const compiled = compile({
      discovery: result,
      key,
      version: one(args, 'version', '1.0.0'),
      title,
      description: one(args, 'description'),
      tenantId,
      profile: discoveryProfile,
      policy: session.policy,
      baseUrl,
      recordedBy: process.env['USER'] ?? 'unknown',
      runId: session.runId,
      fixtureNote: discoveryProfile.recordingNote,
    });

    for (const p of compiled.problems) {
      console.log(`  ${p.severity === 'error' ? 'ERROR  ' : 'warning'} ${p.message}`);
    }
    if (!compiled.ok) {
      session.recorder.finish('compile_failed');
      console.error('\nRefusing to write a defective artifact.');
      return 1;
    }

    const path = session.store.save(compiled.capability);
    session.recorder.saveBlob('capability.json', 'other', JSON.stringify(compiled.capability, null, 2));
    session.recorder.finish('success', { capability: `${compiled.capability.key}@${compiled.capability.version}`, artifact: path });

    console.log(`\nwrote ${path}`);
    printCapabilitySummary(compiled.capability);
    console.log(`\nevidence: ${session.dir}`);
    console.log(`replay it:  node src/cli.ts replay ${compiled.capability.key} ${compiled.capability.inputs.map((i) => `--input ${i.name}=${i.example ?? '<value>'}`).join(' ')}`);
    return 0;
  } finally {
    await session.close();
  }
}

function param(name: string, value: string, sensitivity: Sensitivity, descriptions: Map<string, string>): RunParameter {
  return {
    name,
    value,
    sensitivity,
    description: descriptions.get(name) ?? DEFAULT_DESCRIPTIONS[name] ?? `Run parameter "${name}".`,
  };
}

/**
 * `--secret-env operatorPassword=CORETELLER_PASSWORD` reads the value from the
 * environment. A secret passed as `--secret name=value` is visible in shell
 * history and to anyone who can run `ps`, which is not a threat model a bank
 * would accept, so the env form is the documented one.
 */
function readEnvPairs(values: string[]): Array<[string, string]> {
  return kvPairs(values).map(([name, envVar]) => {
    const v = process.env[envVar];
    if (v === undefined) throw new Error(`${name} was mapped to environment variable ${envVar}, which is not set`);
    return [name, v] as [string, string];
  });
}

function tenantPrefix(tenantId: string): string {
  return tenantId === 'granite-state-bank' ? '/t/granite' : '';
}

// ---------------------------------------------------------------------------

async function cmdReplay(args: Args): Promise<number> {
  const ref = args._[1];
  if (!ref) {
    console.error('replay requires a capability key, e.g. `replay member.read-savings-balance`');
    return 2;
  }
  const [key, version] = ref.split('@');
  const baseUrl = one(args, 'base-url', DEFAULT_BASE)!;
  const store = new CapabilityStore(resolve(one(args, 'artifacts', 'artifacts')!));

  let capability: Capability;
  try {
    capability = store.materialize(key!, version);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const inputs: Record<string, unknown> = {
    ...Object.fromEntries(kvPairs(many(args, 'input'))),
    ...Object.fromEntries(readEnvPairs(many(args, 'input-env'))),
  };

  // --arm mode[:after[:count]] -- "after" skips that many screens first, so the
  // fault lands mid-flow rather than on the very first request, which is where
  // the interesting behaviour is.
  for (const arm of many(args, 'arm')) {
    const [mode, after, count] = arm.split(':');
    const res = await fetch(`${baseUrl}/_chaos`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode: mode!, count: count ?? '1', after: after ?? '0' }),
    }).catch(() => undefined);
    console.log(`armed fault "${mode}" on the fixture after ${after ?? '0'} screen(s): ${res?.ok ? 'ok' : 'FAILED (is the app running?)'}`);
  }

  const operatorMode = (one(args, 'operator', 'abort') ?? 'abort') as OperatorMode;
  const session = await createSession({
    mode: 'replay',
    runId: one(args, 'run-id'),
    runsDir: one(args, 'runs-dir'),
    policyFile: existingPolicyFile(),
    headless: !bool(args, 'headed'),
    operatorMode,
    autoOperator: createAutoOperator({ approveIrreversible: operatorMode === 'auto' }),
    operatorPort: Number(one(args, 'operator-port', '8732')),
    operatorId: one(args, 'operator-id') || undefined,
    artifactsDir: one(args, 'artifacts', 'artifacts'),
    recordVideoDir: one(args, 'video'),
    slowMoMs: one(args, 'slow-mo') ? Number(one(args, 'slow-mo')) : undefined,
  });
  if (session.operatorConsoleUrl) {
    console.log(`operator console: ${session.operatorConsoleUrl}`);
    console.log('  the token in that URL is this run\'s; the console refuses every request without it');
  }
  console.log(`replaying ${capability.key}@${capability.version} (${capability.approval.state}, risk=${capability.policy.riskTier})`);
  console.log(`run evidence: ${session.dir}\n`);

  if (capability.approval.state !== 'approved' && !bool(args, 'allow-draft')) {
    console.log('note: this capability is still in draft. The CLI runs it anyway for development;');
    console.log('      the agent-facing catalog refuses to advertise it as invocable until approved.\n');
  }

  try {
    const env = { baseUrl };

    // A recovery may re-run another capability -- typically sign-on -- against
    // the SAME live session. Inputs are filtered to what the sub-capability
    // declares, because passing the parent's whole bag would be rejected by its
    // input contract (and rightly so).
    // Defence in depth against recursion. The compiler already refuses to give a
    // capability a recovery that re-runs itself, but a hand-edited artifact
    // could still create a cycle, and a runaway loop against a bank's core is
    // not a failure mode worth trusting one guard with.
    const running = new Set<string>([`${capability.key}`]);
    const subReplay = async (subKey: string, subVersion: string | undefined, parentInputs: Record<string, unknown>): Promise<ReplayResult> => {
      if (running.has(subKey)) {
        throw new Error(`refusing to re-enter capability "${subKey}": recovery chain is cyclic (${[...running].join(' -> ')})`);
      }
      const sub = store.materialize(subKey, subVersion);
      const filtered = Object.fromEntries(sub.inputs.map((i) => [i.name, parentInputs[i.name]]).filter(([, v]) => v !== undefined));
      const missing = sub.inputs.filter((i) => i.required && filtered[i.name] === undefined).map((i) => i.name);
      if (missing.length) {
        throw new Error(`cannot run sub-capability "${subKey}": the caller did not supply ${missing.join(', ')}, which it requires`);
      }
      session.recorder.emit({ type: 'note', message: `running sub-capability ${subKey} on the same live session` });
      running.add(subKey);
      try {
        return await replayCapability({
          capability: sub,
          inputs: filtered,
          surface: session.surface,
          recorder: session.recorder,
          broker: session.broker,
          env,
          subReplay,
        });
      } finally {
        running.delete(subKey);
      }
    };

    const result = await replayCapability({
      capability,
      inputs,
      surface: session.surface,
      recorder: session.recorder,
      broker: session.broker,
      env,
      subReplay,
    });

    session.recorder.finish(result.status, summaryOf(result));
    const videoDir = one(args, 'video');
    writeFileSync(join(session.dir, 'result.json'), JSON.stringify(session.recorder.redactor.deep(result), null, 2) + '\n');

    printReplayResult(result);

    if (bool(args, 'record-stability')) {
      const updated = recordStability(capability, result);
      store.save(updated);
      console.log(`\nstability updated: ${updated.stability.successes}/${updated.stability.replays} successful, ${updated.stability.degradedResolutions} degraded resolution(s)`);
    }

    console.log(`\nevidence: ${session.dir}`);
    if (videoDir) {
      // Playwright flushes the video on context close, so the path is only
      // real after teardown.
      await session.close();
      const path = await session.raw.videoPath();
      console.log(path ? `video:    ${path}` : 'video:    (not written)');
    }
    return result.status === 'failed' ? 1 : 0;
  } finally {
    await session.close();
  }
}

function summaryOf(r: ReplayResult): unknown {
  switch (r.status) {
    case 'success': return { outputs: r.outputs, degradedResolutions: r.degradedResolutions };
    case 'business_outcome': return { outcome: r.outcome, atStep: r.atStep };
    case 'escalated': return { intervention: r.intervention };
    case 'failed': return { failure: r.failure };
  }
}

function printReplayResult(r: ReplayResult): void {
  const line = '-'.repeat(72);
  console.log(`\n${line}`);
  switch (r.status) {
    case 'success':
      console.log(`SUCCESS  ${r.capability}  (${r.durationMs}ms)`);
      console.log('\noutputs:');
      for (const [k, v] of Object.entries(r.outputs)) console.log(`  ${k} = ${JSON.stringify(v)}  [${typeof v}]`);
      if (r.degradedResolutions) {
        console.log(`\n  ${r.degradedResolutions} locator(s) resolved on a fallback strategy. Not a failure, but the`);
        console.log('  earliest signal that this screen has drifted. Worth reviewing.');
      }
      break;
    case 'business_outcome':
      console.log(`BUSINESS OUTCOME  ${r.capability}  (${r.durationMs}ms)`);
      console.log(`\n  ${r.outcome.code} [${r.outcome.severity}]  ${r.outcome.title}`);
      console.log(`  detected at step: ${r.atStep}`);
      if (Object.keys(r.outcome.data).length) console.log(`  data: ${JSON.stringify(r.outcome.data)}`);
      console.log('\n  This is a legitimate answer from the application, not an error. The caller');
      console.log('  should act on the code; retrying will not change it.');
      break;
    case 'escalated':
      console.log(`ESCALATED  ${r.capability}  (${r.durationMs}ms)`);
      console.log(`\n  intervention:   ${r.intervention.id}`);
      console.log(`  reason:         ${r.intervention.reason}`);
      console.log(`  human decision: ${r.intervention.decision}`);
      if (r.intervention.note) console.log(`  note:           ${r.intervention.note}`);
      console.log(`  actions taken by the human: ${r.intervention.humanActions}`);
      if (r.outputs) {
        console.log('\noutputs (the run completed after the handoff):');
        for (const [k, v] of Object.entries(r.outputs)) console.log(`  ${k} = ${JSON.stringify(v)}`);
      }
      break;
    case 'failed':
      console.log(`FAILED  ${r.capability}  (${r.durationMs}ms)`);
      console.log(`\n  class:     ${r.failure.class}${r.failure.retryable ? ' (retryable)' : ' (not retryable)'}`);
      if (r.failure.stepId) console.log(`  step:      ${r.failure.stepId}  "${r.failure.stepIntent}"`);
      console.log(`  expected:  ${r.failure.expected}`);
      console.log(`  observed:  ${r.failure.observed}`);
      if (r.failure.detail) console.log(`  detail:    ${r.failure.detail}`);
      if (r.failure.recoveriesTried.length) console.log(`  recoveries tried: ${r.failure.recoveriesTried.join(', ')}`);
      break;
  }
  console.log(line);
  console.log('\nstep trace:');
  for (const s of r.steps) {
    const strat = s.strategyKind ? ` via ${s.strategyKind}${s.degraded ? ' (DEGRADED)' : ''}` : '';
    console.log(`  ${String(s.index + 1).padStart(2)}. ${s.status.padEnd(9)} ${s.stepId}${strat}  ${s.detail ?? ''}`);
  }
}

function recordStability(cap: Capability, r: ReplayResult): Capability {
  const s = cap.stability;
  return {
    ...cap,
    stability: {
      replays: s.replays + 1,
      successes: s.successes + (r.status === 'success' ? 1 : 0),
      businessOutcomes: s.businessOutcomes + (r.status === 'business_outcome' ? 1 : 0),
      failures: s.failures + (r.status === 'failed' ? 1 : 0),
      lastReplayAt: new Date().toISOString(),
      degradedResolutions: s.degradedResolutions + (r.status === 'success' ? r.degradedResolutions : 0),
    },
  };
}

// ---------------------------------------------------------------------------

async function cmdAsk(args: Args): Promise<number> {
  const request = args._.slice(1).join(' ').trim();
  if (!request) {
    console.error('ask needs a request, e.g. ask "look up member 100987\'s savings balance"');
    return 2;
  }
  const baseUrl = one(args, 'base-url', DEFAULT_BASE)!;
  const store = new CapabilityStore(resolve(one(args, 'artifacts', 'artifacts')!));
  const caps = store.list().map((c) => materialize(c, store));

  // Whatever the runtime supplies itself. Credentials belong here, not in the
  // model's hands: it decides WHAT to invoke, never what to authenticate with.
  const runtimeInputs: Record<string, unknown> = {
    ...Object.fromEntries(kvPairs(many(args, 'input'))),
    ...Object.fromEntries(readEnvPairs(many(args, 'input-env'))),
  };

  console.log(`request:  "${request}"`);
  console.log(`catalog:  ${caps.filter((c) => c.approval.state === 'approved').length} approved capability/capabilities offered as tools\n`);

  let outcome;
  try {
    outcome = await selectCapability({ request, capabilities: caps, model: one(args, 'model'), runtimeInputs });
  } catch (e) {
    console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  if (outcome.kind === 'declined') {
    console.log('the agent declined to invoke anything.\n');
    console.log(`  reason:  ${outcome.reasoning}`);
    console.log(`  offered: ${outcome.offered.join(', ') || '(none)'}`);
    console.log('\nThat is the correct answer when nothing fits. A wrong capability is worse than none.');
    return 0;
  }

  const { capability, args: chosenArgs, reasoning, usage } = outcome.selection;
  console.log(`the agent chose:  ${capability.key}@${capability.version}`);
  console.log(`  arguments it supplied: ${JSON.stringify(modelSuppliedArgs(outcome.selection))}`);
  const runtimeNames = Object.keys(runtimeInputs);
  if (runtimeNames.length) console.log(`  supplied by the runtime: ${runtimeNames.join(', ')} (never shown to the model)`);
  if (reasoning) console.log(`  its reasoning: ${reasoning}`);
  if (usage) console.log(`  tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);
  console.log(`\nreplaying it deterministically -- no model from here on.\n`);

  const session = await createSession({
    mode: 'replay',
    runId: one(args, 'run-id'),
    runsDir: one(args, 'runs-dir'),
    policyFile: existingPolicyFile(),
    headless: !bool(args, 'headed'),
    // Selection is not authorisation. The agent that asked for a write does not
    // get to approve it, so this path never carries an auto-operator.
    operatorMode: 'abort',
    artifactsDir: one(args, 'artifacts', 'artifacts'),
    echo: bool(args, 'verbose'),
  });

  try {
    const result = await replayCapability({
      capability,
      inputs: chosenArgs,
      surface: session.surface,
      recorder: session.recorder,
      broker: session.broker,
      env: { baseUrl },
    });
    session.recorder.finish(result.status, summaryOf(result));
    printReplayResult(result);
    console.log(`\nevidence: ${session.dir}`);
    return result.status === 'failed' ? 1 : 0;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------

async function cmdStability(args: Args): Promise<number> {
  const ref = args._[1];
  if (!ref) {
    console.error('stability requires a capability key');
    return 2;
  }
  const [key, version] = ref.split('@');
  const runs = Math.max(2, Math.min(20, Number(one(args, 'runs', '5'))));
  const baseUrl = one(args, 'base-url', DEFAULT_BASE)!;
  const store = new CapabilityStore(resolve(one(args, 'artifacts', 'artifacts')!));

  let capability: Capability;
  try {
    capability = store.materialize(key!, version);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const inputs: Record<string, unknown> = {
    ...Object.fromEntries(kvPairs(many(args, 'input'))),
    ...Object.fromEntries(readEnvPairs(many(args, 'input-env'))),
  };

  console.log(`measuring ${capability.key}@${capability.version} over ${runs} runs, one fresh browser session each\n`);

  const report = await measureStability({
    capability,
    inputs,
    runs,
    withSession: async (run, body) => {
      // A fresh session per run on purpose: reusing a warm one would hide
      // leaked state, which is one of the faults this is looking for.
      const session = await createSession({
        mode: 'replay',
        runId: `${one(args, 'run-id', 'stability')}-${String(run).padStart(2, '0')}`,
        runsDir: one(args, 'runs-dir'),
        policyFile: existingPolicyFile(),
        headless: !bool(args, 'headed'),
        operatorMode: 'abort',
        artifactsDir: one(args, 'artifacts', 'artifacts'),
        echo: false,
      });
      process.stdout.write(`  run ${run}/${runs} ... `);
      try {
        const out = await body({
          surface: session.surface,
          recorder: session.recorder,
          broker: session.broker,
          env: { baseUrl },
          runId: session.runId,
        });
        console.log('done');
        return out;
      } finally {
        await session.close();
      }
    },
  });

  console.log();
  console.log(formatStabilityReport(report));

  if (bool(args, 'record-stability')) {
    const current = store.load(key!, version);
    if (current) {
      const s = current.stability;
      store.save({
        ...current,
        stability: {
          replays: s.replays + report.runs,
          successes: s.successes + (report.perRun.filter((r) => r.status === 'success').length),
          businessOutcomes: s.businessOutcomes + report.perRun.filter((r) => r.status === 'business_outcome').length,
          failures: s.failures + report.perRun.filter((r) => r.status === 'failed').length,
          lastReplayAt: new Date().toISOString(),
          degradedResolutions: s.degradedResolutions + report.perRun.reduce((n, r) => n + r.degraded, 0),
        },
      });
      console.log(`\nrecorded into ${current.key}@${current.version}`);
    }
  }

  // Flaky is a failure of the measurement's purpose; degrading is a warning.
  return report.verdict === 'flaky' ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function cmdCatalog(args: Args): Promise<number> {
  const store = new CapabilityStore(resolve(one(args, 'artifacts', 'artifacts')!));
  const caps = store.list().map((c) => materialize(c, store));

  if (bool(args, 'serve')) {
    const port = Number(one(args, 'port', '8733'));
    const { url } = await startCatalogServer({
      store,
      port,
      baseUrl: one(args, 'base-url', DEFAULT_BASE)!,
      policyFile: existingPolicyFile(),
      operatorMode: bool(args, 'operator-console') ? 'console' : 'abort',
    });
    console.log(`capability catalog listening on ${url}`);
    console.log(`  GET  ${url}/capabilities            catalog with JSON Schema per capability`);
    console.log(`  GET  ${url}/tools                   Anthropic tool definitions, ready to paste`);
    console.log(`  POST ${url}/capabilities/<key>/invoke   {"inputs": {...}}`);
    console.log('\nCtrl-C to stop.');
    await new Promise(() => undefined);
    return 0;
  }

  if (bool(args, 'tools')) {
    // Only approved capabilities are offered to a model, matching what the HTTP
    // catalog advertises. A draft is a recording nobody has reviewed yet.
    const approved = caps.filter((c) => c.approval.state === 'approved');
    const held = caps.length - approved.length;
    if (held) console.error(`(${held} capability/capabilities withheld: not approved)`);
    console.log(JSON.stringify(approved.map(toolDefinitionFor), null, 2));
    return 0;
  }
  if (bool(args, 'json')) {
    console.log(JSON.stringify(caps.map(catalogEntry), null, 2));
    return 0;
  }

  const invalid = store.invalid();
  if (!caps.length && !invalid.length) {
    console.log('No capabilities in ./artifacts yet. Record one with `node src/cli.ts discover ...`.');
    return 0;
  }
  for (const c of caps) {
    const e = catalogEntry(c);
    console.log(`\n${e.key}@${e.version}   [${e.approval}]  risk=${e.riskTier}${e.requiresHumanApproval ? ' (needs human approval)' : ''}`);
    console.log(`  ${e.title}`);
    console.log(`  tenant ${e.tenant} / product ${e.appProfile}${c.tenant.extends ? ` (extends ${c.tenant.extends.key}@${c.tenant.extends.version} with ${c.tenant.overrides.length} override(s))` : ''}`);
    console.log(`  inputs:   ${c.inputs.map((i) => `${i.name}: ${i.type}${i.required ? '' : '?'}${i.sensitivity !== 'public' ? ` [${i.sensitivity}]` : ''}`).join(', ') || '(none)'}`);
    console.log(`  outputs:  ${c.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || '(none)'}`);
    console.log(`  outcomes: ${c.outcomes.map((o) => o.code).join(', ') || '(none)'}`);
    console.log(`  steps:    ${c.steps.length}, recoveries: ${c.recoveries.length}, failure signatures: ${c.failureSignatures.length}`);
    if (c.stability.replays) {
      console.log(`  stability: ${c.stability.successes}/${c.stability.replays} successful, ${c.stability.degradedResolutions} degraded resolution(s)`);
    }
    if (!e.invocable) console.log(`  NOT INVOCABLE: ${e.notInvocableReason}`);
    for (const problem of lintSpecialisation(store.load(c.key, c.version) ?? c, store)) {
      console.log(`  LINT: ${problem}`);
    }
  }
  for (const bad of invalid) {
    console.log(`\n${bad.file}  [INVALID]\n  ${bad.error.split('\n')[0]}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------

async function cmdApprove(args: Args): Promise<number> {
  const ref = args._[1];
  if (!ref) {
    console.error('approve requires a capability key');
    return 2;
  }
  const [key, version] = ref.split('@');
  const store = new CapabilityStore(resolve(one(args, 'artifacts', 'artifacts')!));
  const cap = store.load(key!, version);
  if (!cap) {
    console.error(`no capability "${ref}"`);
    return 2;
  }
  const by = one(args, 'by');
  if (!by) {
    console.error('approve requires --by "name", because an approval with no name attached is not an approval');
    return 2;
  }
  const updated: Capability = {
    ...cap,
    approval: { state: 'approved', approvedBy: by, approvedAt: new Date().toISOString(), note: one(args, 'note') },
  };
  const path = store.save(updated);
  console.log(`approved ${cap.key}@${cap.version} by ${by}`);
  console.log(`  ${path}`);
  if (cap.policy.riskTier === 'irreversible') {
    console.log('  note: this capability still requires a human decision at its irreversible step;');
    console.log('        approval makes it invocable, it does not make it unattended.');
  }
  return 0;
}

// ---------------------------------------------------------------------------

function printCapabilitySummary(c: Capability): void {
  console.log(`\n  ${c.key}@${c.version}  "${c.title}"`);
  console.log(`  inputs:   ${c.inputs.map((i) => `${i.name}: ${i.type}${i.sensitivity !== 'public' ? ` [${i.sensitivity}]` : ''}`).join(', ') || '(none)'}`);
  console.log(`  outputs:  ${c.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || '(none)'}`);
  console.log(`  steps:    ${c.steps.length} (risk tier ${c.policy.riskTier}, portability floor ${c.policy.portabilityFloor})`);
  console.log(`  outcomes: ${c.outcomes.map((o) => o.code).join(', ') || '(none)'}`);
  console.log(`  recoveries: ${c.recoveries.map((r) => r.id).join(', ') || '(none)'}`);
}

function existingPolicyFile(): string | undefined {
  const p = resolve('policy.json');
  return existsSync(p) ? p : undefined;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((e) => {
      console.error('\nfatal:', e instanceof Error ? e.stack : e);
      process.exitCode = 1;
    });
}
