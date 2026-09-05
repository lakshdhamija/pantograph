/**
 * The seam, tested rather than asserted.
 *
 * These tests exist to make one specific claim checkable: that an artifact
 * recorded against a web surface addresses a desktop surface without change.
 * They run a macOS AX tree through the mapping, then resolve the SAME
 * `TargetDescriptor` shape the web recorder emits against it, using the same
 * pure resolver, with no Playwright anywhere in the import graph.
 *
 * No Mac and no permissions needed: the AX tree here is a fixture shaped like
 * what System Events reports for a native form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AX_ROLE_MAP,
  axName,
  axTreeToObservation,
  normaliseAxRoleName,
  parseSystemEventsDump,
  type AxNode,
} from '../src/surface/desktop/macAxSurface.ts';
import { resolveTarget } from '../src/surface/resolve.ts';
import { describeNode } from '../src/artifact/describe.ts';
import { eq, isResolveFailure } from '../src/surface/types.ts';

/**
 * A native member-inquiry window: a label, an unnamed text field beside it, and
 * two buttons. Deliberately the same *shape* as the fixture's hostile web
 * screen, an unnamed input identified only by the label to its left, because
 * that is the case the whole targeting design exists for.
 */
function inquiryWindow(): AxNode {
  const at = (x: number, y: number, w = 120, h = 22) => ({ AXPosition: { x, y }, AXSize: { width: w, height: h } });
  return {
    AXRole: 'AXApplication',
    AXTitle: 'CoreTeller',
    children: [
      {
        AXRole: 'AXWindow',
        AXTitle: 'Member Inquiry',
        ...at(0, 0, 800, 600),
        children: [
          { AXRole: 'AXStaticText', AXValue: 'Member Number', ...at(20, 100, 130, 20) },
          // No AXTitle and no AXDescription: nameless, exactly like <input name="f_mbr">.
          { AXRole: 'AXTextField', AXValue: '', ...at(160, 100, 100, 20) },
          { AXRole: 'AXStaticText', AXValue: 'Surname', ...at(20, 130, 130, 20) },
          { AXRole: 'AXTextField', AXValue: '', ...at(160, 130, 160, 20) },
          { AXRole: 'AXButton', AXTitle: 'Go', ...at(20, 170, 60, 24) },
          { AXRole: 'AXButton', AXTitle: 'Clear', ...at(90, 170, 60, 24) },
        ],
      },
    ],
  };
}

test('an AX tree maps onto the same Observation shape the web surface produces', () => {
  const obs = axTreeToObservation(inquiryWindow(), { appName: 'CoreTeller' });

  assert.equal(obs.title, 'CoreTeller');
  assert.match(obs.location, /^app:\/\//);
  // The window becomes the container, which is the frame chain's analogue.
  const field = obs.nodes.find((n) => n.role === 'textbox');
  assert.ok(field);
  assert.deepEqual(field.containerPath, ['Member Inquiry']);
  assert.equal(field.name, '', 'a nameless native field must stay nameless, not be given a fake name');
  assert.ok(field.bbox, 'geometry is required: the relational rungs are geometric');
});

test('a web-recorded descriptor resolves against a desktop observation unchanged', () => {
  // This descriptor is the shape src/artifact/describe.ts emits for the
  // fixture's nameless member-number input. Not adapted for desktop in any way.
  const recordedOnTheWeb = {
    role: 'textbox' as const,
    container: ['Member Inquiry'],
    strategies: [
      {
        kind: 'relative' as const,
        anchor: { role: 'text' as const, name: eq('Member Number'), container: ['Member Inquiry'], strategies: [{ kind: 'role_name' as const }] },
        direction: 'right_of' as const,
        maxDistancePx: 200,
      },
    ],
  };

  const obs = axTreeToObservation(inquiryWindow(), { appName: 'CoreTeller' });
  const r = resolveTarget(obs, recordedOnTheWeb);

  assert.ok(!isResolveFailure(r), 'the same locator ladder must work on a native form');
  assert.equal(r.node.bbox?.x, 160, 'it must find the field beside the label, not the other one');
  assert.equal(r.strategyIndex, 0);
});

test('role+name resolution works on desktop for controls that have names', () => {
  const obs = axTreeToObservation(inquiryWindow(), { appName: 'CoreTeller' });
  const r = resolveTarget(obs, { role: 'button', name: eq('Go'), container: ['Member Inquiry'], strategies: [{ kind: 'role_name' }] });
  assert.ok(!isResolveFailure(r));
  assert.equal(r.node.name, 'Go');
});

test('the recorder synthesises a portable descriptor from a desktop node too', () => {
  // describeNode has no surface dependency either, so a desktop recording would
  // produce descriptors of the same shape a web recording does.
  const obs = axTreeToObservation(inquiryWindow(), { appName: 'CoreTeller' });
  const field = obs.nodes.find((n) => n.role === 'textbox' && n.bbox?.x === 160)!;
  const described = describeNode(obs, field, 'the member number field');

  assert.equal(described.usedNonPortable, false);
  assert.equal(described.descriptor.strategies[0]!.kind, 'relative');
  const rung = described.descriptor.strategies[0]!;
  assert.ok(rung.kind === 'relative' && rung.anchor.name?.value === 'Member Number');
  // And it round-trips, which is the recorder's own acceptance criterion.
  const back = resolveTarget(obs, described.descriptor);
  assert.ok(!isResolveFailure(back));
  assert.equal(back.node.handle, field.handle);
});

test('a cross-window relation is refused, exactly as a cross-frame one is', () => {
  const twoWindows: AxNode = {
    AXRole: 'AXApplication',
    AXTitle: 'CoreTeller',
    children: [
      {
        AXRole: 'AXWindow', AXTitle: 'Main',
        children: [{ AXRole: 'AXStaticText', AXValue: 'Member Number', AXPosition: { x: 0, y: 0 }, AXSize: { width: 100, height: 20 } }],
      },
      {
        AXRole: 'AXWindow', AXTitle: 'Palette',
        children: [{ AXRole: 'AXTextField', AXValue: '', AXPosition: { x: 110, y: 0 }, AXSize: { width: 100, height: 20 } }],
      },
    ],
  };
  const obs = axTreeToObservation(twoWindows, { appName: 'CoreTeller' });
  const r = resolveTarget(obs, {
    role: 'textbox',
    strategies: [{
      kind: 'relative',
      anchor: { role: 'text', name: eq('Member Number'), strategies: [{ kind: 'role_name' }] },
      direction: 'right_of',
    }],
  });
  // Geometrically it is to the right; it is in a different window, so no.
  assert.ok(isResolveFailure(r), 'a control in another window is not "beside" anything in this one');
});

test('AXTitle wins over AXDescription, and static text falls back to AXValue', () => {
  assert.equal(axName({ AXRole: 'AXButton', AXTitle: 'Post', AXDescription: 'post button' }), 'Post');
  assert.equal(axName({ AXRole: 'AXButton', AXDescription: 'post button' }), 'post button');
  assert.equal(axName({ AXRole: 'AXStaticText', AXValue: 'Member Number' }), 'Member Number');
  assert.equal(axName({ AXRole: 'AXTextField', AXValue: 'typed text' }), '', 'a field value is not its name');
});

test('every mapped AX role lands on a role the resolver understands', () => {
  const known = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'tab',
    'menuitem', 'cell', 'columnheader', 'rowheader', 'row', 'table', 'heading', 'text', 'image', 'dialog',
    'alert', 'form', 'group', 'document', 'unknown',
  ]);
  for (const [ax, role] of Object.entries(AX_ROLE_MAP)) {
    assert.ok(known.has(role), `${ax} maps to "${role}", which is not a role in the seam's vocabulary`);
  }
});

test('System Events role names normalise onto AX names', () => {
  assert.equal(normaliseAxRoleName('button'), 'AXButton');
  assert.equal(normaliseAxRoleName('text field'), 'AXTextField');
  assert.equal(normaliseAxRoleName('static text'), 'AXStaticText');
  assert.equal(normaliseAxRoleName('AXButton'), 'AXButton', 'already-normalised names pass through');
});

test('the System Events dump parses into windows and controls', () => {
  const dump = ['WINDOW\tMember Inquiry', 'static text\tMember Number', 'text field\t', 'button\tGo'].join('\n');
  const tree = parseSystemEventsDump(dump, 'CoreTeller');
  assert.equal(tree.AXRole, 'AXApplication');
  assert.equal(tree.children?.length, 1);
  const win = tree.children![0]!;
  assert.equal(win.AXTitle, 'Member Inquiry');
  assert.deepEqual(win.children?.map((c) => c.AXRole), ['AXStaticText', 'AXTextField', 'AXButton']);
});

test('the System Events dump round-trips geometry, which the relational rungs need', () => {
  // Without position and size, "the field to the right of this label" cannot
  // resolve on a desktop, and the portability argument this surface exists to
  // make would be false.
  const dump = [
    'WINDOW\tMember Inquiry',
    'static text\tMember Number\t\t20,100,130,20',
    'text field\t\t100234\t160,100,180,22',
    'button\tSearch\t\t360,100,80,24',
  ].join('\n');

  const tree = parseSystemEventsDump(dump, 'CoreTeller');
  const obs = axTreeToObservation(tree, { appName: 'CoreTeller' });

  const field = obs.nodes.find((n) => n.role === 'textbox');
  assert.ok(field, 'the text field should be perceived');
  assert.deepEqual(field.bbox, { x: 160, y: 100, width: 180, height: 22 });
  assert.equal(field.value, '100234');

  // And the descriptor recorded against the web fixture resolves against it.
  const resolved = resolveTarget(obs, {
    role: 'textbox',
    strategies: [{ kind: 'relative', anchor: { role: 'text', name: eq('Member Number'), strategies: [{ kind: 'role_name' }] }, direction: 'right_of', maxDistancePx: 220 }],
  });
  assert.ok(!isResolveFailure(resolved), `expected a resolution, got ${JSON.stringify(resolved)}`);
  assert.equal(resolved.node.handle, field.handle);
});
