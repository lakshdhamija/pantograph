/**
 * Perception for web surfaces.
 *
 * This builds the normalised `Observation` the rest of the system reasons over.
 * It deliberately does NOT use Playwright's aria snapshot, for three reasons:
 *
 *   1. We need geometry. The `relative` locator strategy ("the textbox in the
 *      same row as the cell reading 'Member Number'") is the only thing that
 *      works on table-laid-out legacy screens where controls have no accessible
 *      name, and it needs bounding boxes.
 *   2. We need the frame chain per node. Real framesets nest, and a target
 *      recorded in the `content` frame must not resolve against `nav`.
 *   3. We need to control the node budget. A raw tree of a legacy page is
 *      thousands of nodes; the model gets a filtered view, and the filter has to
 *      be ours.
 *
 * Role and name computation follows the same rules a screen reader applies, in
 * simplified form -- which is exactly the point: the artifact then describes the
 * UI the way an OS accessibility API would describe it, so the same descriptor
 * shape ports to a desktop surface.
 */

import type { Frame, Page } from 'playwright';
import type { Observation, UiNode, UiRole } from '../types.ts';
import { normaliseText } from '../types.ts';

type RawNode = {
  h: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  bbox?: { x: number; y: number; width: number; height: number };
  css: string;
  tag: string;
  testId?: string;
  depth: number;
};

/**
 * Runs inside the page. Must be fully self-contained -- no imports, no closures
 * over module scope.
 */
/* c8 ignore start -- executed in the browser, not in node */
function collect(): { nodes: RawNode[]; title: string; url: string; text: string } {
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const STRUCTURAL = new Set(['TD', 'TH', 'TR', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'LI', 'FORM']);
  const out: RawNode[] = [];
  let counter = 0;

  const norm = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      let seg = cur.tagName.toLowerCase();
      const id = cur.getAttribute('id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift(`${seg}#${id}`);
        break;
      }
      const nm = cur.getAttribute('name');
      if (nm) seg += `[name="${nm}"]`;
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    // DELIBERATE DIVERGENCE FROM ARIA. An <a> with no href computes as generic,
    // and a screen reader would skip it. We call it a link anyway: roles here
    // describe AFFORDANCES for automation, and an anchor is an affordance
    // whether or not the author wired it up properly. A real storefront's cart
    // control is exactly this -- a React handler, no href, no accessible
    // name -- and perceiving it as static text leaves it with no handle, so the
    // planner cannot point at it at all.
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden') return 'hidden';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'OPTION') return 'option';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (tag === 'TR') return 'row';
    if (tag === 'TABLE') return 'table';
    if (tag === 'FORM') return 'form';
    if (tag === 'IMG') return 'image';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'LABEL') return 'text';
    return 'text';
  }

  /** Simplified accname computation, in spec priority order. */
  function nameOf(el: Element): string {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => norm(el.ownerDocument.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ');
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return norm(el.getAttribute('value')) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const id = el.getAttribute('id');
      if (id) {
        const lbl = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return norm(lbl.textContent);
      }
      const wrap = el.closest('label');
      if (wrap) return norm(wrap.textContent);
      const ph = norm(el.getAttribute('placeholder'));
      if (ph) return ph;
      // Deliberately NOT falling back to name= here: the attribute is developer
      // shorthand (f_mbr), not something a human or a screen reader would see.
      // Leaving the name empty is honest and forces relational targeting.
      return '';
    }
    if (tag === 'IMG') return norm(el.getAttribute('alt'));
    const title = norm(el.getAttribute('title'));
    if (title) return title;
    // For containers, the accessible name is their own text, but only when it
    // is small enough to be a label rather than a paragraph.
    const own = norm(el.textContent);
    return own.length <= 120 ? own : '';
  }

  function ownText(el: Element): string {
    let s = '';
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3) s += c.nodeValue ?? '';
    }
    return norm(s);
  }

  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function walk(el: Element, depth: number): void {
    if (out.length > 900) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'NOSCRIPT') return;
    const role = roleOf(el);
    const interactive = INTERACTIVE.has(tag);
    const structural = STRUCTURAL.has(tag);
    const own = ownText(el);
    const worthKeeping = role !== 'hidden' && (interactive || structural || (own.length > 0 && el.children.length === 0));

    if (worthKeeping) {
      const r = el.getBoundingClientRect();
      // Tag the element so the surface can act on exactly the node it perceived.
      // Generating a CSS selector and hoping it round-trips is a bug factory;
      // a per-observation ref attribute is exact. It is ephemeral (cleared by
      // any navigation) and never reaches an artifact.
      el.setAttribute('data-pantograph-ref', `n${counter + 1}`);
      const isFormControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      out.push({
        h: `n${++counter}`,
        role,
        name: nameOf(el),
        value: isFormControl ? String((el as HTMLInputElement).value ?? '') : undefined,
        text: own || (el.children.length === 0 ? norm(el.textContent) : undefined),
        enabled: !(el as HTMLInputElement).disabled,
        visible: visible(el),
        focused: el === el.ownerDocument.activeElement,
        bbox: r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined,
        css: cssPath(el),
        tag: tag.toLowerCase(),
        // The conventions actually in the wild, in rough order of prevalence.
        // `data-test` was missing and is what Sauce Labs' own demo app uses, so
        // the cheap rung was invisible on exactly the class of app that has it.
        testId:
          el.getAttribute('data-testid') ??
          el.getAttribute('data-test-id') ??
          el.getAttribute('data-test') ??
          el.getAttribute('data-cy') ??
          el.getAttribute('data-qa') ??
          undefined,
        depth,
      });
    }
    for (const c of Array.from(el.children)) walk(c, depth + 1);
  }

  if (document.body) walk(document.body, 0);
  return {
    nodes: out,
    title: document.title,
    url: location.href,
    text: norm(document.body?.innerText ?? document.body?.textContent ?? ''),
  };
}
/* c8 ignore stop */

const ROLE_ALIASES: Record<string, UiRole> = {
  link: 'link', button: 'button', textbox: 'textbox', searchbox: 'searchbox',
  combobox: 'combobox', listbox: 'listbox', option: 'option', checkbox: 'checkbox',
  radio: 'radio', cell: 'cell', columnheader: 'columnheader', rowheader: 'rowheader',
  row: 'row', table: 'table', heading: 'heading', text: 'text', image: 'image',
  dialog: 'dialog', alert: 'alert', form: 'form', group: 'group', tab: 'tab',
  menuitem: 'menuitem', document: 'document',
};

function toRole(raw: string): UiRole {
  return ROLE_ALIASES[raw] ?? 'unknown';
}

/**
 * Frame identity. Prefer the frame's `name` attribute (framesets always set it,
 * and it is what a human would call the pane); fall back to the URL's screen
 * parameter, then to an index. Never the frame's numeric id, which is unstable.
 */
function framePath(frame: Frame, page: Page): string[] {
  const path: string[] = [];
  let cur: Frame | null = frame;
  while (cur && cur !== page.mainFrame()) {
    const name = cur.name();
    path.unshift(name || shortUrl(cur.url()));
    cur = cur.parentFrame();
  }
  return path;
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return (url.pathname + url.search).slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}

export type PerceiveOptions = {
  /** Cap on nodes returned. Keeps prompts and evidence bounded. */
  readonly maxNodes?: number;
};

export async function perceive(
  page: Page,
  blockingDialog: Observation['blockingDialog'],
  opts: PerceiveOptions = {},
): Promise<Observation> {
  const maxNodes = opts.maxNodes ?? 400;
  const nodes: UiNode[] = [];
  const texts: string[] = [];

  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    let raw: Awaited<ReturnType<typeof collect>>;
    try {
      raw = await frame.evaluate(collect);
    } catch {
      // A frame can navigate out from under us mid-snapshot. Skip it rather than
      // failing the whole observation -- a partial view is still actionable.
      continue;
    }
    const path = framePath(frame, page);
    texts.push(raw.text);
    for (const n of raw.nodes) {
      nodes.push({
        handle: `${path.join('/')}#${n.h}`,
        role: toRole(n.role),
        name: normaliseText(n.name),
        value: n.value,
        text: n.text ? normaliseText(n.text) : undefined,
        enabled: n.enabled,
        visible: n.visible,
        focused: n.focused,
        containerPath: path,
        bbox: n.bbox,
        native: { cssPath: n.css, testId: n.testId, tag: n.tag },
      });
    }
  }

  const kept = nodes.slice(0, maxNodes);
  return {
    at: new Date().toISOString(),
    location: page.url(),
    title: await page.title().catch(() => ''),
    root: { handle: 'root', role: 'document', name: '', enabled: true, visible: true, containerPath: [], children: kept },
    nodes: kept,
    text: normaliseText(texts.join('\n')),
    blockingDialog,
  };
}
