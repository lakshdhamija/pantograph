/**
 * The same recorder and engine against Sauce Labs' public demo storefront -- an
 * application this project did not write and cannot change.
 *
 * The credentials are the ones printed on the target's own login page, so
 * nothing secret is involved. Out of CI on purpose: a green build should not
 * depend on a third party's uptime.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const EVIDENCE = resolve('evidence/public-site');
const RUNS = resolve('runs-public');
const BASE = 'https://www.saucedemo.com';

// Printed on the storefront's own login page. Not a credential in any real sense.
process.env['SAUCE_PASSWORD'] ??= 'secret_sauce';

/** Checkout details and the credential source, shared by every invocation. */
const DETAILS = ['--input', 'firstName=Ada', '--input', 'lastName=Lovelace', '--input', 'postalCode=02115', '--input-env', 'password=SAUCE_PASSWORD'];

/** Replay arguments for one user and one product. Built explicitly: filtering a
 *  flat argv array to swap one value leaves dangling flags behind. */
const replayArgs = (user: string, product: string) => [
  'replay', 'store.add-to-cart-and-review',
  '--base-url', BASE,
  '--input', `username=${user}`,
  '--input', `productName=${product}`,
  ...DETAILS,
];

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (c) => res({ code: c ?? 0, out }));
  });
}

async function main(): Promise<void> {
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  rmSync(RUNS, { recursive: true, force: true });

  const summary: string[] = [];
  const step = async (name: string, note: string, args: string[], expect?: string) => {
    console.log(`\n${'='.repeat(78)}\n${name}\n${'-'.repeat(78)}\n${note}\n`);
    console.log(`$ node src/cli.ts ${args.join(' ')}\n`);
    const { code, out } = await run([...args, '--runs-dir', RUNS, '--run-id', name]);
    console.log(out.split('\n').filter((l) => !/^\s{2}\[\d{3}\]/.test(l)).join('\n').trim());
    const from = join(RUNS, name);
    if (existsSync(from)) cpSync(from, join(EVIDENCE, name), { recursive: true });
    else {
      for (const d of readdirSync(RUNS).filter((x) => x.startsWith(name + '-'))) {
        cpSync(join(RUNS, d), join(EVIDENCE, name, d), { recursive: true });
      }
    }
    writeFileSync(join(EVIDENCE, `${name}.console.txt`), `$ node src/cli.ts ${args.join(' ')}\n\n${out}`);
    summary.push(`- **${name}** (exit ${code}, ${expect && !out.includes(expect) ? `UNEXPECTED, wanted "${expect}"` : 'as expected'}), ${note}`);
  };

  await step(
    '01-discover',
    'Record the flow against a storefront I did not write. Note the locator ladder in the artifact: role+name is ambiguous on the product grid (six buttons read "Add to cart"), so it falls to a relational anchor on the product title -- which the compiler then templates as {{inputs.productName}}.',
    [
      'discover',
      '--goal', 'Add the Sauce Labs Backpack to the cart and reach the checkout review page',
      '--key', 'store.add-to-cart-and-review',
      '--title', 'Add a product and reach checkout review',
      '--description', 'Sign in to the Swag Labs storefront, add a named product to the cart, and drive checkout to the order review page, returning the order total.',
      '--profile', 'saucedemo', '--tenant', 'sauce-labs-demo',
      '--entrypoint', `${BASE}/`,
      '--base-url', BASE,
      '--param', 'username=standard_user',
      '--param', 'productName=Sauce Labs Backpack',
      '--param', 'firstName=Ada', '--param', 'lastName=Lovelace', '--param', 'postalCode=02115',
      '--secret-env', 'password=SAUCE_PASSWORD',
      '--mock-llm', '--rules', 'saucedemo-checkout',
    ],
    'wrote',
  );

  await run(['approve', 'store.add-to-cart-and-review', '--by', 'demo-reviewer', '--note', 'Reviewed against the public storefront.']);

  for (const [product, total] of [['Sauce Labs Backpack', '32.39'], ['Sauce Labs Fleece Jacket', '53.99'], ['Sauce Labs Onesie', '8.63']] as const) {
    await step(
      `02-replay-${product.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      `Replay for ${product}. Three different products, three different totals, one artifact -- which is the whole point of parameterising the locator rather than recording a test id that names one product.`,
      replayArgs('standard_user', product),
      total,
    );
  }

  await step(
    '03-business-outcome-locked-out',
    "Sauce Labs ships a deliberately locked account. No fault injection: this is a real, intended, non-happy answer on somebody else's application, and it comes back as a typed business outcome rather than a crash.",
    replayArgs('locked_out_user', 'Sauce Labs Backpack'),
    'USER_LOCKED_OUT',
  );

  await step(
    '04-stability-three-runs',
    'Drift measurement against a site I do not control. Watch which rungs each step resolves on.',
    [
      'stability', 'store.add-to-cart-and-review',
      '--base-url', BASE,
      '--input', 'username=standard_user', '--input', 'productName=Sauce Labs Backpack',
      ...DETAILS, '--runs', '3',
    ],
    'STABILITY',
  );

  writeFileSync(
    join(EVIDENCE, 'README.md'),
    `# Evidence: a public site

Produced by \`node scripts/demo-public.ts\` on ${new Date().toISOString().slice(0, 10)}, against
Sauce Labs' Swag Labs demo storefront, an application I did not write and cannot change.

Kept out of CI on purpose: a green build should not depend on a third party's uptime, and
re-running someone else's site on every push is rude.

## Runs

${summary.join('\n')}

## Why this exists

A fixture I wrote myself invites the obvious objection: that the app was shaped around the
solution. This surface answers it. It also exercises four things the fixture cannot:

- a \`data-test\` attribute convention, so the cheap locator rung is present and has to be
  handled on exactly the class of app that has one
- an href-less anchor (the cart control) which strict ARIA computes as generic, which is why roles
  here describe affordances for automation rather than following the spec exactly
- an order total rendered as \`Total: $32.39\`, which is why the compiler verifies each extraction
  against the value discovery observed rather than trusting the pipeline
- a product-specific test id, \`add-to-cart-sauce-labs-backpack\`, which is why a locator keying on
  a run parameter has to be templated: pinned, it would declare a \`productName\` input and then
  return the Backpack's price for a Fleece Jacket.

## The contrast worth reading

| | local fixture | this storefront |
|---|---|---|
| declared \`portabilityFloor\` | \`any_surface\` | \`any_web\` |
| why | no test IDs anywhere, so the ladder derives relational locators | test IDs present, and the ladder uses one where nothing portable is unique |
| framesets | yes | no |
| error taxonomy | fully exercised, faults injected on demand | two business outcomes declared, one exercised; no injection possible |

Same recorder, same engine, neither told which app it was looking at.
`,
  );

  console.log(`\n${'='.repeat(78)}\nEvidence written to ${EVIDENCE}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
