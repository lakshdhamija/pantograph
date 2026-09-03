/**
 * Targeting: the locator ladder and the descriptor synthesiser.
 *
 * These are the tests that matter most, because a targeting bug does not throw
 * -- it quietly acts on the wrong control. Two of the cases here (the
 * data-shaped name, and the column-header anchor that resolves to the first row)
 * are bugs this system actually had, caught by exactly these assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/surface/resolve.ts';
import { describeNode, looksLikeData } from '../src/artifact/describe.ts';
import { eq, has, isResolveFailure, type TargetDescriptor } from '../src/surface/types.ts';
import { inquiryScreen, memberDetailScreen, node, observation } from './helpers.ts';

test('resolves a named control on the first rung of the ladder', () => {
  const obs = inquiryScreen();
  const r = resolveTarget(obs, { role: 'button', name: eq('Go'), container: ['content'], strategies: [{ kind: 'role_name' }] });
  assert.ok(!isResolveFailure(r));
  assert.equal(r.node.name, 'Go');
  assert.equal(r.strategyIndex, 0);
  assert.equal(r.degraded, false);
});

test('finds a control with no accessible name via its label cell', () => {
  const obs = inquiryScreen();
  const target: TargetDescriptor = {
    role: 'textbox',
    container: ['content'],
    strategies: [
      {
        kind: 'relative',
        anchor: { role: 'cell', name: eq('Member Number'), container: ['content'], strategies: [{ kind: 'role_name' }] },
        direction: 'right_of',
        maxDistancePx: 200,
      },
    ],
  };
  const r = resolveTarget(obs, target);
  assert.ok(!isResolveFailure(r), 'the nameless member-number input should resolve relative to its label');
  assert.equal(r.node.bbox?.x, 150);
});

test('a container mismatch is not a match: the nav frame is not the content frame', () => {
  const obs = inquiryScreen();
  const r = resolveTarget(obs, { role: 'link', name: eq('Member Inquiry'), container: ['content'], strategies: [{ kind: 'role_name' }] });
  assert.ok(isResolveFailure(r));
  assert.equal(r.reason, 'no_match');
});

test('an ambiguous match falls through rather than guessing', () => {
  const obs = observation([
    node({ role: 'button', name: 'Submit', x: 0, y: 0 }),
    node({ role: 'button', name: 'Submit', x: 0, y: 40 }),
  ]);
  const r = resolveTarget(obs, { role: 'button', name: eq('Submit'), container: ['content'], strategies: [{ kind: 'role_name' }] });
  assert.ok(isResolveFailure(r));
  assert.equal(r.reason, 'ambiguous');
});

test('an ordinal disambiguates what a weaker constraint could not', () => {
  const obs = observation([
    node({ role: 'button', name: 'Submit', x: 0, y: 0 }),
    node({ role: 'button', name: 'Submit', x: 0, y: 40 }),
  ]);
  const r = resolveTarget(obs, {
    role: 'button',
    name: eq('Submit'),
    container: ['content'],
    strategies: [{ kind: 'role_name' }, { kind: 'ordinal', index: 1 }],
  });
  assert.ok(!isResolveFailure(r));
  assert.equal(r.node.bbox?.y, 40);
  assert.equal(r.degraded, true, 'winning on a later rung is a drift signal and must be reported');
});

test('the portability floor refuses a DOM path even when it would work', () => {
  const obs = inquiryScreen();
  const cssPath = obs.nodes.find((n) => n.role === 'textbox')!.native!.cssPath!;
  const target: TargetDescriptor = { role: 'textbox', container: ['content'], strategies: [{ kind: 'native_path', path: cssPath }] };

  const permissive = resolveTarget(obs, target, { portabilityFloor: 'pixel' });
  assert.ok(!isResolveFailure(permissive), 'with no floor, a DOM path resolves');

  const strict = resolveTarget(obs, target, { portabilityFloor: 'any_surface' });
  assert.ok(isResolveFailure(strict), 'a capability declaring surface portability must not silently use a DOM path');
  assert.match(strict.triedStrategies[0]!.note ?? '', /portability floor/);
});

test('describeNode refuses to key a locator on the value it is reading', () => {
  const obs = memberDetailScreen();
  const balance = obs.nodes.find((n) => n.text === '18,234.55')!;

  const described = describeNode(obs, balance, 'the savings balance', { volatileName: true, volatileValues: ['100234'] });

  assert.equal(described.descriptor.name, undefined, 'a volatile name must be dropped from the descriptor entirely');
  assert.ok(
    described.descriptor.strategies.every((s) => s.kind !== 'role_name'),
    'role_name would make this locator work only for members whose balance is exactly 18,234.55',
  );
  const relative = described.descriptor.strategies.find((s) => s.kind === 'relative');
  assert.ok(relative, 'it should fall back to a structural, relational locator');
  assert.equal(relative.anchor.name?.value, 'REGULAR SHARE (SAVINGS)');
  assert.equal(relative.direction, 'right_of');
});

test('the anchor it picks is verified, not merely nearest', () => {
  // "Current Balance" is the column header directly above the balance cell, so a
  // naive nearest-label pick lands on it -- and "the cell below Current Balance"
  // resolves to the FIRST row for every member. Round-trip verification is what
  // rejects it.
  const obs = memberDetailScreen();
  const balance = obs.nodes.find((n) => n.text === '18,234.55')!;
  const described = describeNode(obs, balance, 'balance', { volatileName: true });

  const r = resolveTarget(obs, described.descriptor);
  assert.ok(!isResolveFailure(r));
  assert.equal(r.node.handle, balance.handle, 'the synthesised descriptor must resolve back to the node it described');
  assert.notEqual(r.node.text, '2,841.19', 'it must not resolve to the checking balance in the first row');
});

test('a descriptor that keys on a run parameter is rejected', () => {
  const obs = memberDetailScreen();
  const accountCell = obs.nodes.find((n) => n.text === '100234-02')!;
  const described = describeNode(obs, accountCell, 'the account number', { volatileValues: ['100234'] });
  assert.equal(described.descriptor.name, undefined);
  assert.ok(described.notes.some((n) => n.includes('100234')), 'it should say why it refused');
});

test('a nameless control gets a portable descriptor, not a DOM path', () => {
  const obs = inquiryScreen();
  const input = obs.nodes.find((n) => n.role === 'textbox' && n.bbox?.y === 62)!;
  const described = describeNode(obs, input, 'the member number field');
  assert.equal(described.usedNonPortable, false);
  assert.equal(described.descriptor.strategies[0]!.kind, 'relative');
});

test('looksLikeData recognises record values but not screen labels', () => {
  for (const v of ['18,234.55', '2016-03-11', '100234-02', '$1,000', '03/11/2016', 'CT-9F3A21C4']) {
    assert.equal(looksLikeData(v), true, `${v} should be treated as data`);
  }
  for (const v of ['Member Number', 'Sign On', 'REGULAR SHARE (SAVINGS)', 'Continue']) {
    assert.equal(looksLikeData(v), false, `${v} should be usable as an identity`);
  }
});

test('text matchers normalise whitespace so a re-flowed label still matches', () => {
  const obs = observation([node({ role: 'cell', name: 'Current   Balance', text: 'Current   Balance' })]);
  const r = resolveTarget(obs, { role: 'cell', name: has('Current Balance'), container: ['content'], strategies: [{ kind: 'role_name' }] });
  assert.ok(!isResolveFailure(r));
});
