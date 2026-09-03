/**
 * Synthetic observations for the pure-logic tests.
 *
 * The resolver, the descriptor synthesiser, the assertion evaluator and the
 * extractor are all pure functions over an `Observation`, so none of them need a
 * browser to test. That is a property of the seam, not an accident: the same
 * tests would cover a desktop accessibility surface unchanged.
 */

import type { Observation, UiNode, UiRole } from '../src/surface/types.ts';

export type NodeSpec = {
  role: UiRole;
  name?: string;
  text?: string;
  value?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  frame?: string[];
  css?: string;
  testId?: string;
  tag?: string;
  visible?: boolean;
  enabled?: boolean;
};

let counter = 0;

export function node(spec: NodeSpec): UiNode {
  const frame = spec.frame ?? ['content'];
  return {
    handle: `${frame.join('/')}#n${++counter}`,
    role: spec.role,
    name: spec.name ?? '',
    text: spec.text,
    value: spec.value,
    enabled: spec.enabled ?? true,
    visible: spec.visible ?? true,
    containerPath: frame,
    bbox: { x: spec.x ?? 0, y: spec.y ?? 0, width: spec.w ?? 100, height: spec.h ?? 20 },
    native: { cssPath: spec.css ?? `synthetic-${counter}`, testId: spec.testId, tag: spec.tag ?? 'div' },
  };
}

export function observation(nodes: UiNode[], opts: { location?: string; title?: string; dialog?: Observation['blockingDialog'] } = {}): Observation {
  return {
    at: new Date().toISOString(),
    location: opts.location ?? 'http://127.0.0.1:8731/content?screen=mbrsearch',
    title: opts.title ?? 'Member Inquiry',
    root: { handle: 'root', role: 'document', name: '', enabled: true, visible: true, containerPath: [], children: nodes },
    nodes,
    text: nodes.map((n) => `${n.name} ${n.text ?? ''}`).join(' '),
    blockingDialog: opts.dialog,
  };
}

/**
 * The hostile screen this whole system exists for: a layout table where the
 * input has no accessible name and the only thing identifying it is the label
 * cell beside it.
 */
export function inquiryScreen(): Observation {
  return observation([
    node({ role: 'cell', name: 'Member Number', text: 'Member Number', x: 10, y: 60, w: 130, h: 22, tag: 'td' }),
    node({ role: 'textbox', name: '', x: 150, y: 62, w: 95, h: 18, tag: 'input', css: 'form > table > tr:nth-of-type(1) > td:nth-of-type(2) > input' }),
    node({ role: 'cell', name: 'Surname', text: 'Surname', x: 10, y: 84, w: 130, h: 22, tag: 'td' }),
    node({ role: 'textbox', name: '', x: 150, y: 86, w: 150, h: 18, tag: 'input', css: 'form > table > tr:nth-of-type(2) > td:nth-of-type(2) > input' }),
    node({ role: 'button', name: 'Go', x: 16, y: 108, w: 38, h: 18, tag: 'input' }),
    node({ role: 'button', name: 'Clear', x: 58, y: 108, w: 44, h: 18, tag: 'input' }),
    node({ role: 'link', name: 'Member Inquiry', frame: ['nav'], x: 4, y: 40, w: 120, h: 16, tag: 'a' }),
  ]);
}

/** The accounts table: reading the savings balance means reading a cell by position. */
export function memberDetailScreen(): Observation {
  return observation(
    [
      node({ role: 'cell', name: 'Name', text: 'Name', x: 10, y: 40, w: 110, h: 20, tag: 'td' }),
      node({ role: 'cell', name: 'DELACROIX, RENE M', text: 'DELACROIX, RENE M', x: 125, y: 40, w: 200, h: 20, tag: 'td' }),
      node({ role: 'columnheader', name: 'Account', text: 'Account', x: 10, y: 110, w: 150, h: 20, tag: 'td' }),
      node({ role: 'columnheader', name: 'Product', text: 'Product', x: 165, y: 110, w: 260, h: 20, tag: 'td' }),
      node({ role: 'columnheader', name: 'Current Balance', text: 'Current Balance', x: 430, y: 110, w: 200, h: 20, tag: 'td' }),
      node({ role: 'cell', name: '100234-01', text: '100234-01', x: 10, y: 132, w: 150, h: 20, tag: 'td' }),
      node({ role: 'cell', name: 'SHARE DRAFT (CHECKING)', text: 'SHARE DRAFT (CHECKING)', x: 165, y: 132, w: 260, h: 20, tag: 'td' }),
      node({ role: 'cell', name: '2,841.19', text: '2,841.19', x: 430, y: 132, w: 200, h: 20, tag: 'td' }),
      node({ role: 'cell', name: '100234-02', text: '100234-02', x: 10, y: 154, w: 150, h: 20, tag: 'td' }),
      node({ role: 'cell', name: 'REGULAR SHARE (SAVINGS)', text: 'REGULAR SHARE (SAVINGS)', x: 165, y: 154, w: 260, h: 20, tag: 'td' }),
      node({ role: 'cell', name: '18,234.55', text: '18,234.55', x: 430, y: 154, w: 200, h: 20, tag: 'td' }),
    ],
    { location: 'http://127.0.0.1:8731/content?screen=mbrdetail&id=100234', title: 'Member Detail' },
  );
}
