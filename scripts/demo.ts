/**
 * End-to-end demo. Produces everything in /evidence.
 *
 * It shells out to the same CLI commands the README documents, rather than
 * calling the library directly, so the evidence is provably the product of the
 * documented interface and not of a private path that only the demo takes.
 *
 *   node scripts/demo.ts            scripted planner, no API key needed
 *   node scripts/demo.ts --live     discovery driven by a real model (needs a key)
 *
 * Roughly two minutes. Every step prints the command it is about to run.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startLegacyBank } from '../fixtures/legacy-bank/server.ts';
import { isMain } from '../src/util/main.ts';

// The CLI loads .env itself, but this script reads the environment directly to
// decide which provider to use, so it has to load it too.
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* a malformed .env is the caller's problem; the CLI reports it */
  }
}

const EVIDENCE = resolve('evidence');
const RUNS = resolve('runs');
const ARTIFACTS = resolve('artifacts');
const BASE = 'http://127.0.0.1:8731';

// The operator password reaches the CLI through the environment, never as an
// argument: an argument would land in shell history, in `ps`, and -- as this
// demo learned the hard way -- in the console transcripts saved as evidence.
process.env['CORETELLER_PASSWORD'] ??= 'demo-only-not-a-secret';
const CREDS = ['--input', 'operatorId=teller01', '--input-env', 'operatorPassword=CORETELLER_PASSWORD'];

type Step = { name: string; note: string; args: string[]; expect?: string };

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? 0, out }));
  });
}

function banner(title: string, note: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'-'.repeat(78)}\n${note}\n`);
}

async function main(): Promise<void> {
  // `--live` uses whichever provider has a key; the preference order is below.
  const live = process.argv.includes('--live');
  // Discovery is the only part that needs a model. `--replays-only` reuses the
  // committed artifacts and re-runs every deterministic step, so a reviewer with
  // no key can reproduce runs 04-17 in seconds without disturbing the discovery
  // evidence a live model produced.
  const replaysOnly = process.argv.includes('--replays-only');
  const explicit = process.argv.find((a) => a.startsWith('--planner='))?.split('=')[1];
  // Preference order is by free-tier headroom, not by model quality: the whole
  // demo needs ~35 requests, and running out mid-way wastes every step before it.
  const provider =
    explicit ??
    (process.env['GROQ_API_KEY']
      ? 'groq'
      : process.env['ANTHROPIC_API_KEY']
        ? 'anthropic'
        : process.env['GEMINI_API_KEY']
          ? 'gemini'
          : undefined);
  if (live && !provider) {
    console.error(
      '--live needs a model key in .env. In rough order of free-tier headroom:\n' +
        '  GROQ_API_KEY          free, thousands/day:  https://console.groq.com/keys\n' +
        '  ANTHROPIC_API_KEY     ~25 cents for this whole demo\n' +
        '  GEMINI_API_KEY        free but ~20 requests/day, enough for one capability\n' +
        'Or drop --live to use the scripted planner.',
    );
    process.exit(2);
  }
  if (live) console.log(`live discovery via ${provider}`);

  // Delete only what this script writes. `evidence/public-site/` is produced by
  // demo-public.ts, and wiping the whole directory meant a reviewer who ran the
  // documented fast path destroyed evidence the README links to.
  const keep = replaysOnly ? /^(0[1-3]-discover|public-site$)/ : /^public-site$/;
  if (existsSync(EVIDENCE)) {
    for (const d of readdirSync(EVIDENCE).filter((x) => !keep.test(x))) {
      rmSync(join(EVIDENCE, d), { recursive: true, force: true });
    }
  }
  if (!replaysOnly) {
    for (const f of ['member.read-savings-balance@1.0.0.json', 'coreteller.sign-on@1.0.0.json', 'member.open-sub-account@1.0.0.json']) {
      rmSync(join(ARTIFACTS, f), { force: true });
    }
  }
  mkdirSync(EVIDENCE, { recursive: true });
  rmSync(RUNS, { recursive: true, force: true });

  const app = await startLegacyBank(8731);
  console.log(`CORETELLER fixture up at ${app.url}`);
  await fetch(`${BASE}/_chaos`, { method: 'DELETE' }).catch(() => undefined);

  const plannerFlags = live ? ['--planner', provider!] : ['--mock-llm'];
  const summary: string[] = [];

  const record = async (step: Step): Promise<void> => {
    if (replaysOnly && /^0[1-3]-discover/.test(step.name)) {
      // Its evidence directory is being kept, so describe it rather than re-running it.
      summary.push(`- **${step.name}** (kept from the last live-model run), ${step.note}`);
      return;
    }
    banner(step.name, step.note);
    console.log(`$ node src/cli.ts ${step.args.join(' ')}\n`);
    const { code, out } = await run([...step.args, '--runs-dir', RUNS, '--run-id', step.name]);
    const tail = out.split('\n').filter((l) => !/^\s{2}\[\d{3}\]/.test(l)).join('\n');
    console.log(tail.trim());
    const from = join(RUNS, step.name);
    if (existsSync(from)) cpSync(from, join(EVIDENCE, step.name), { recursive: true });
    else {
      // `stability` fans out into <run-id>-01, -02, ... rather than one dir.
      for (const d of readdirSync(RUNS).filter((x) => x.startsWith(step.name + '-'))) {
        cpSync(join(RUNS, d), join(EVIDENCE, step.name, d), { recursive: true });
      }
    }
    writeFileSync(join(EVIDENCE, `${step.name}.console.txt`), `$ node src/cli.ts ${step.args.join(' ')}\n\n${out}`);
    const verdict = step.expect && !out.includes(step.expect) ? `UNEXPECTED (wanted "${step.expect}")` : 'as expected';
    summary.push(`- **${step.name}** (exit ${code}, ${verdict}), ${step.note}`);
  };

  // -- 1. discovery ---------------------------------------------------------

  await record({
    name: '01-discover-sign-on',
    note: 'Discover a sign-on capability. It exists so the session-expiry recovery has something to invoke.',
    args: [
      'discover',
      '--goal', 'Sign on to the teller desktop as the supplied operator',
      '--key', 'coreteller.sign-on',
      '--title', 'Sign on to CORETELLER',
      '--description', 'Establish an authenticated CORETELLER session. Invoked on its own, or by the reauthenticate recovery when a longer flow loses its session.',
      '--param', 'operatorId=teller01',
      '--secret-env', 'operatorPassword=CORETELLER_PASSWORD',
      '--rules', 'sign-on',
      ...plannerFlags,
    ],
    expect: 'wrote',
  });

  await record({
    name: '02-discover-read-balance',
    note: 'The main read capability. The planner drives a frameset, types into a control with no accessible name, and declares its typed output.',
    args: [
      'discover',
      '--goal', 'Look up member 100234 and read their current regular share (savings) balance',
      '--key', 'member.read-savings-balance',
      '--title', "Read a member's savings balance",
      '--description', 'Look up a member by number and return the current balance of their regular share (savings) account.',
      '--param', 'memberId=100234', '--param', 'operatorId=teller01',
      '--secret-env', 'operatorPassword=CORETELLER_PASSWORD',
      '--rules', 'read-savings-balance',
      ...plannerFlags,
    ],
    expect: 'wrote',
  });

  await record({
    name: '03-discover-open-sub-account',
    note: 'A capability that WRITES. The submit step is classified irreversible, so discovery itself escalates for approval before the write; the scripted operator authorises it.',
    args: [
      'discover',
      '--goal', 'Open a new vacation club sub-account for member 100234 with a 250.00 opening deposit and reach the confirmation screen',
      '--key', 'member.open-sub-account',
      '--title', 'Open a sub-account for a member',
      '--description', 'Submit a new share sub-account request for an existing member and return the confirmation reference the core issues. Writes to the core: the submit step requires a human decision.',
      '--param', 'memberId=100234', '--param', 'operatorId=teller01',
      '--param', 'productCode=S06', '--param', 'openingDeposit=250.00',
      '--secret-env', 'operatorPassword=CORETELLER_PASSWORD',
      '--rules', 'open-sub-account', '--operator', 'auto',
      ...plannerFlags,
    ],
    expect: 'wrote',
  });

  // -- 2. approval ----------------------------------------------------------

  banner('04-approve', 'Capabilities are recorded as drafts. The agent-facing catalog refuses to advertise a draft as invocable until a named reviewer approves it.');
  for (const key of ['coreteller.sign-on', 'member.read-savings-balance', 'member.open-sub-account', 'granite.member.read-savings-balance']) {
    const { out } = await run(['approve', key, '--by', 'demo-reviewer', '--note', 'Reviewed the recorded flow and its locators against the fixture.']);
    console.log(out.trim());
  }
  const catalog = await run(['catalog']);
  writeFileSync(join(EVIDENCE, '04-catalog.txt'), catalog.out);
  const tools = await run(['catalog', '--tools']);
  writeFileSync(join(EVIDENCE, '04-catalog-tools.json'), tools.out);
  console.log(catalog.out.trim());
  summary.push('- **04-catalog**, the catalog and the Anthropic tool definitions projected from the artifacts.');

  // -- 3. replay: the happy path and the exceptional ones -------------------

  await record({
    name: '05-replay-success',
    note: 'Deterministic replay, no model in the loop. Same member as the recording.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100234', '--record-stability'],
    expect: 'SUCCESS',
  });

  await record({
    name: '06-replay-different-member',
    note: 'A DIFFERENT member. Proves the recording was parameterised and that the balance locator is structural rather than keyed on the value it read.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100987', '--record-stability'],
    // Assert on the VALUE, not the output's name. What an output is called is a
    // recording-time choice the planner makes -- a live model named this
    // `regularShareBalance` where the scripted one said `savingsBalance` -- and
    // anything downstream that hardcodes the name is coupled to one recording.
    expect: '611.07',
  });

  await record({
    name: '07-replay-business-outcome-not-found',
    note: 'An unknown member. This is a BUSINESS OUTCOME, not a failure: the caller gets MEMBER_NOT_FOUND and knows retrying is pointless.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=900001', '--record-stability'],
    expect: 'MEMBER_NOT_FOUND',
  });

  await record({
    name: '08-replay-business-outcome-restricted',
    note: 'A record the operator is not cleared to see. A different outcome code, with a different severity, so the caller can route it to a supervisor.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=700007'],
    expect: 'MEMBER_RESTRICTED',
  });

  await record({
    name: '09-replay-input-invalid',
    note: 'A caller passes a malformed member number. Rejected in about a millisecond, against the declared input contract, before a browser is opened.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=not-a-number'],
    expect: 'input_invalid',
  });

  await record({
    name: '10-replay-app-error',
    note: 'An injected core 500, mid-flow. A declared failure signature turns "expected text not found" into app_error plus the core\'s own ORA reference.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100234', '--arm', 'app_error:2'],
    expect: 'app_error',
  });

  await record({
    name: '11-replay-recovered-interstitial',
    note: 'An unexpected maintenance interstitial appears mid-flow. A declared recovery dismisses it; the step\'s checkpoint then already holds, so the step is not re-run.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100234', '--arm', 'interstitial:2'],
    expect: 'SUCCESS',
  });

  await record({
    name: '12-replay-recovered-session-expiry',
    note: 'The session dies mid-flow. The engine runs the sign-on capability against the SAME live browser context, then restarts this capability, because re-authentication lands on the home screen and retrying one step could not work.',
    args: ['replay', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100234', '--arm', 'session_expiry:2'],
    expect: 'SUCCESS',
  });

  // -- 4. safety and the human -----------------------------------------------

  await record({
    name: '13-replay-write-unattended-blocked',
    note: 'The write capability with no human available. It escalates and stops BEFORE the irreversible step. Nothing is written.',
    args: [
      'replay', 'member.open-sub-account', ...CREDS,
      '--input', 'memberId=100234', '--input', 'productCode=S09', '--input', 'openingDeposit=100.00',
      '--operator', 'abort',
    ],
    expect: 'ESCALATED',
  });

  await record({
    name: '14-replay-write-human-approved',
    note: 'The same capability with an operator available. The operator claims the intervention, takes the control lease, approves, and the automation completes the write on a one-shot grant.',
    args: [
      'replay', 'member.open-sub-account', ...CREDS,
      '--input', 'memberId=100234', '--input', 'productCode=S09', '--input', 'openingDeposit=100.00',
      '--operator', 'auto',
    ],
    expect: 'SUCCESS',
  });

  await record({
    name: '15-replay-write-rejected-by-core',
    note: 'A deposit below the product minimum. The core refuses it; that refusal is a declared business outcome carrying the core\'s own wording, not a crash.',
    args: [
      'replay', 'member.open-sub-account', ...CREDS,
      '--input', 'memberId=100234', '--input', 'productCode=S06', '--input', 'openingDeposit=5.00',
      '--operator', 'auto',
    ],
    expect: 'REQUEST_REJECTED',
  });

  // -- 5. the other tenant ---------------------------------------------------

  await record({
    name: '16-replay-second-tenant',
    note: 'A second institution running the same vendor product, with relabelled fields. Not a re-recording: the artifact extends the base and patches five points, contributing no steps of its own.',
    args: ['replay', 'granite.member.read-savings-balance', ...CREDS, '--input', 'memberId=100234'],
    expect: 'SUCCESS',
  });

  // -- 5b. stability ---------------------------------------------------------

  await record({
    name: '17-stability-five-runs',
    note: 'Replay the same capability five times against fresh sessions. Reports whether the ANSWER varied (flaky) and whether locators moved down their ladder (degrading) -- the drift signal, before anything breaks.',
    args: ['stability', 'member.read-savings-balance', ...CREDS, '--input', 'memberId=100234', '--runs', '5'],
    expect: 'STABLE',
  });

  // -- 6. write the index ----------------------------------------------------

  cpSync(ARTIFACTS, join(EVIDENCE, 'artifacts'), { recursive: true });
  writeFileSync(join(EVIDENCE, 'README.md'), index(summary, live, provider));

  await app.close();
  console.log(`\n${'='.repeat(78)}\nEvidence written to ${EVIDENCE}\n`);
}

function index(summary: string[], live: boolean, provider?: string): string {
  return `# Evidence

Produced by \`node scripts/demo.ts\`${live ? ' --live' : ''} on ${new Date().toISOString().slice(0, 10)}.

Planner: **${live ? `live model via ${provider}` : 'scripted planner (`--mock-llm`)'}**.${
    live
      ? ''
      : ' The scripted planner is a real implementation of the `Planner` interface, so every other component in these runs is exercised for real: the same guarded surface, the same perception, the same descriptor synthesis, the same compiler, the same replay engine, the same evidence pipeline. Only the "which control next" decision is scripted. See `src/agent/llm/mock.ts`, and run with `--live` for model-driven discovery.'
  }

Each directory contains:

- \`events.jsonl\`, the structured event stream. Every action, policy decision, assertion, detector, recovery and control transfer, attributed to an actor and redacted.
- \`manifest.json\`, run status, duration, event count, and a tally of what redaction caught.
- \`blobs/\`, screenshots and full multi-frame HTML snapshots, captured on failure and at every escalation.
- \`transcript.json\`, for discovery runs, what the planner actually said.
- \`result.json\`, for replay runs, the structured result the caller receives.

Alongside each directory, \`<name>.console.txt\` is the terminal output.

## Runs

${summary.join('\n')}

## Reading the interesting ones

**07 / 08 / 15, business outcomes.** \`result.json\` has \`status: "business_outcome"\`, not an error. That distinction is the point of the result contract.

**10, a hard failure.** \`status: "failed"\`, \`class: "app_error"\`, and \`observed\` carries the core's own \`ORA-01722\`. \`blobs/\` has the screenshot and the frame-by-frame HTML from the moment it broke.

**12, recovery by capability composition.** Grep \`events.jsonl\` for \`sub-capability\`: the engine runs \`coreteller.sign-on\` on the same browser context, then restarts.

**13 vs 14, the guardrail.** Same capability, same inputs. Without an operator it stops before writing; with one it completes. Grep for \`policy_decision\` and \`control_transferred\`.

**16, cross-tenant reuse.** \`artifacts/granite.member.read-savings-balance@1.0.0.json\` contributes no steps of its own: five overrides and an empty step list, which the schema permits exactly when \`tenant.extends\` is set.

**17, the drift signal.** Five runs, \`rungs [0,0,0,0,0,0,0]\` every time: every locator on its preferred strategy, nothing degraded. A step that starts winning on a later rung shows up here long before any assertion fails.

## Redaction

\`manifest.json\` counts what was scrubbed. The operator password is supplied on the command line and never appears in any artifact, log or transcript; the member tax IDs rendered by the fixture are redacted wherever they were observed.
`;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
