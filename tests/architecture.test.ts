/**
 * Two claims this system makes loudest, asserted rather than stated.
 *
 * Both are about absence, which is the kind of property that decays silently: it
 * holds until someone adds one convenient import or one convenient sleep, and
 * nothing fails. A grep in a README is not a guard; these are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('replay and the surface layer never reach a model provider', () => {
  const offenders: string[] = [];
  for (const file of [...sources('src/replay'), ...sources('src/surface')]) {
    const text = readFileSync(file, 'utf8');
    for (const banned of ['agent/llm', '@anthropic-ai', 'generativelanguage', 'chat/completions']) {
      if (text.includes(banned)) offenders.push(`${file} references ${banned}`);
    }
  }
  assert.deepEqual(offenders, [], 'deterministic replay must not be able to consult a model');
});

test('the only clocks under src/replay are the poll loop and the declared wait remedy', () => {
  // Not "no sleeps anywhere": a gate that polls has to wait between polls, and a
  // capability may declare `wait` as a recovery remedy. Both are legitimate and
  // both are bounded. What must not appear is a third one -- an unconditional
  // sleep standing in for a condition nobody wrote down.
  const counts: Record<string, number> = {};
  for (const file of sources('src/replay')) {
    const n = readFileSync(file, 'utf8').split('setTimeout').length - 1;
    if (n > 0) counts[file] = n;
  }

  assert.deepEqual(
    counts,
    { 'src/replay/assert.ts': 1, 'src/replay/engine.ts': 1 },
    'a new timer appeared under src/replay -- if it is a poll or a declared remedy, add it here',
  );
});
