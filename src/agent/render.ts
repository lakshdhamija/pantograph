/**
 * Rendering an observation for a model.
 *
 * A raw legacy screen is thousands of DOM nodes; a model given all of them
 * wastes its attention on layout tables. This renders the same normalised
 * `UiNode` list the resolver uses -- roles, accessible names, frame, and a
 * handle -- as compact indented text.
 *
 * Two properties are load-bearing:
 *   - The model sees EXACTLY what the resolver sees. If a control has no
 *     accessible name here, it has none there either, so the model cannot
 *     invent an identity the replay engine will not be able to reproduce.
 *   - Every actionable node carries its handle, which is the only way the model
 *     is allowed to refer to a control.
 */

import type { Observation, UiNode } from '../surface/types.ts';

/** Roles you can `act` on. These get `ref=`. */
const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem']);

/**
 * Roles you can READ a value from. These get `read=` instead of `ref=`.
 *
 * The marker has to distinguish them. A `cell` carrying the same `ref=` as a
 * real control lets a model scanning for a label aim a `fill` at the label cell
 * rather than at the input beside it, which surfaces three calls later as an
 * opaque driver error. And `text` and `heading` need a marker of their own: on
 * a modern app, where values live in spans rather than table cells, a model
 * with no handle for them cannot point at the value it was asked to return.
 * That policy was shaped by one fixture that happens to use table layout.
 *
 * Distinct markers make the affordance explicit: act on `ref=`, read from
 * `read=`.
 */
const READABLE = new Set(['cell', 'columnheader', 'rowheader', 'text', 'heading']);

export type RenderOptions = { readonly maxNodes?: number; readonly maxChars?: number };

export function renderObservation(obs: Observation, opts: RenderOptions = {}): string {
  const maxNodes = opts.maxNodes ?? 160;
  const lines: string[] = [];

  if (obs.blockingDialog) {
    lines.push(
      `!! A ${obs.blockingDialog.kind.toUpperCase()} DIALOG IS OPEN AND BLOCKING THE PAGE: "${obs.blockingDialog.message}"`,
      `!! Nothing else can be read or clicked until you answer it (act kind=answer_dialog, accept=true|false).`,
      '',
    );
  }

  lines.push(`URL: ${obs.location}`, `TITLE: ${obs.title}`, '');

  const byContainer = new Map<string, UiNode[]>();
  for (const n of obs.nodes.slice(0, maxNodes)) {
    if (!n.visible) continue;
    const key = n.containerPath.join('/') || '(main document)';
    const list = byContainer.get(key) ?? [];
    list.push(n);
    byContainer.set(key, list);
  }

  for (const [container, nodes] of byContainer) {
    lines.push(`--- frame: ${container} ---`);
    for (const n of nodes) {
      const label = n.name || n.text || '';
      const isActionable = ACTIONABLE.has(n.role);
      const isReadable = READABLE.has(n.role) && Boolean(n.name || n.text);
      const ref = isActionable
        ? ` ref=${shortHandle(n.handle)}`
        : isReadable
          ? ` read=${shortHandle(n.handle)}`
          : '';
      const value = n.value ? ` value=${JSON.stringify(truncate(n.value, 40))}` : '';
      const state = n.enabled ? '' : ' [disabled]';
      const named = label ? ` "${truncate(label, 70)}"` : isActionable ? ' (NO ACCESSIBLE NAME)' : '';
      lines.push(`  ${n.role}${named}${value}${state}${ref}`);
    }
    lines.push('');
  }

  let text = lines.join('\n');
  const maxChars = opts.maxChars ?? 14_000;
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n... [screen truncated]';
  return text;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

/** Handles are `frame/path#nN`; the frame is already shown as a section header. */
export function shortHandle(handle: string): string {
  return handle;
}

export function findByHandle(obs: Observation, ref: string): UiNode | undefined {
  return obs.nodes.find((n) => n.handle === ref) ?? obs.nodes.find((n) => n.handle.endsWith(`#${ref}`));
}
