/**
 * macOS accessibility surface -- the second implementation of the seam.
 *
 * Not a finished desktop driver. It exists because "these abstractions would
 * extend to a desktop app" is worth nothing in prose, so the parts that carry
 * the argument are real, tested code:
 *
 *   - `axNodeToUiNode` / `axTreeToObservation` are pure functions from a macOS
 *     AX tree to the exact `Observation` the existing resolver consumes,
 *     unit-tested against a captured AX dump in tests/desktop.test.ts -- so the
 *     mapping is verifiable without a Mac, without permissions, and in CI.
 *   - `MacAxSurface` implements `Surface` in full. If the interface were secretly
 *     web-shaped, this file would not compile.
 *
 * `act()` is not implemented: injecting synthetic events needs a native binding
 * or CGEvent through a helper binary, which is a toolchain problem rather than a
 * design one. It throws rather than pretending.
 *
 * Nothing above the seam changes. `resolve.ts` has no DOM concept and its
 * relations are geometric, and a desktop form has geometry: "the textbox to the
 * right of the cell reading Member Number" is as true of an AppKit form as of a
 * table layout. The one rung that cannot port is `native_path`, which is why it
 * is a separate rung with a portability class the engine enforces.
 *
 * The mapping:
 *
 *   AX attribute            UiNode field     note
 *   ----------------------  ---------------  --------------------------------
 *   AXRole                  role             via AX_ROLE_MAP below
 *   AXTitle                 name             preferred
 *   AXDescription           name             fallback when AXTitle is empty
 *   AXValue                 value            text fields, sliders, checkboxes
 *   AXEnabled               enabled          direct
 *   AXFocused               focused          direct
 *   AXPosition + AXSize     bbox             screen coords, origin top-left
 *   window / pane chain     containerPath    the frame chain's analogue
 *   AXIdentifier            native.testId    set by developers, rare but free
 *
 * `containerPath` is the interesting one: on the web it is the frameset chain,
 * and here it is the window and pane chain. Both answer the same question --
 * "which independently-scoped region of the screen is this control in" -- which
 * is why the resolver refuses cross-container relations without caring which
 * surface produced them.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Action,
  ActionResult,
  Observation,
  Portability,
  ResolveFailure,
  ResolvedTarget,
  Surface,
  TargetDescriptor,
  UiNode,
  UiRole,
} from '../types.ts';
import { normaliseText } from '../types.ts';
import { resolveTarget } from '../resolve.ts';

const run = promisify(execFile);

/** A node as macOS reports it. Shape of what `captureAxTree` returns. */
export type AxNode = {
  readonly AXRole: string;
  readonly AXSubrole?: string;
  readonly AXTitle?: string;
  readonly AXDescription?: string;
  readonly AXValue?: string | number | boolean;
  readonly AXEnabled?: boolean;
  readonly AXFocused?: boolean;
  readonly AXIdentifier?: string;
  readonly AXPosition?: { x: number; y: number };
  readonly AXSize?: { width: number; height: number };
  readonly children?: readonly AxNode[];
};

/**
 * AXRole -> our normalised role. The same target vocabulary the web surface maps
 * onto, which is what lets one artifact address both. Where macOS is more
 * specific than we are, the distinction is dropped: a locator depending on it
 * would not port.
 */
export const AX_ROLE_MAP: Readonly<Record<string, UiRole>> = {
  AXButton: 'button',
  AXPopUpButton: 'combobox',
  AXMenuButton: 'button',
  AXRadioButton: 'radio',
  AXCheckBox: 'checkbox',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSecureTextField: 'textbox',
  AXSearchField: 'searchbox',
  AXComboBox: 'combobox',
  AXList: 'listbox',
  AXMenuItem: 'menuitem',
  AXTabGroup: 'tab',
  AXRadioGroup: 'group',
  AXStaticText: 'text',
  AXHeading: 'heading',
  AXLink: 'link',
  AXImage: 'image',
  AXTable: 'table',
  AXOutline: 'table',
  AXRow: 'row',
  AXCell: 'cell',
  AXColumn: 'columnheader',
  AXGroup: 'group',
  AXSheet: 'dialog',
  AXWindow: 'document',
  AXApplication: 'document',
  AXSplitGroup: 'group',
  AXScrollArea: 'group',
  AXToolbar: 'group',
};

export function axRole(node: AxNode): UiRole {
  return AX_ROLE_MAP[node.AXRole] ?? 'unknown';
}

/**
 * The accessible name, in the priority a screen reader uses on macOS: AXTitle,
 * then AXDescription, then -- for static text and buttons whose label IS their
 * value -- AXValue.
 */
export function axName(node: AxNode): string {
  const title = normaliseText(node.AXTitle ?? '');
  if (title) return title;
  const desc = normaliseText(node.AXDescription ?? '');
  if (desc) return desc;
  if (node.AXRole === 'AXStaticText' && typeof node.AXValue === 'string') return normaliseText(node.AXValue);
  return '';
}

/** Roles that scope their descendants, and therefore extend `containerPath`. */
const CONTAINER_ROLES = new Set(['AXWindow', 'AXSheet', 'AXDrawer']);

export function axNodeToUiNode(node: AxNode, containerPath: readonly string[], handle: string): UiNode {
  const pos = node.AXPosition;
  const size = node.AXSize;
  return {
    handle,
    role: axRole(node),
    name: axName(node),
    value: typeof node.AXValue === 'string' ? node.AXValue : node.AXValue !== undefined ? String(node.AXValue) : undefined,
    text: node.AXRole === 'AXStaticText' && typeof node.AXValue === 'string' ? normaliseText(node.AXValue) : undefined,
    enabled: node.AXEnabled !== false,
    // AX exposes no direct "visible"; a zero-area element is the usable proxy,
    // matching how the web surface decides the same thing.
    visible: !size || size.width > 0 || size.height > 0,
    focused: node.AXFocused === true,
    containerPath: [...containerPath],
    bbox: pos && size ? { x: pos.x, y: pos.y, width: size.width, height: size.height } : undefined,
    native: { testId: node.AXIdentifier, tag: node.AXRole },
  };
}

/** Flatten an AX tree into the same `Observation` the web surface produces. */
export function axTreeToObservation(root: AxNode, opts: { appName: string; maxNodes?: number } = { appName: 'unknown' }): Observation {
  const max = opts.maxNodes ?? 600;
  const nodes: UiNode[] = [];
  let counter = 0;

  const walk = (node: AxNode, containerPath: readonly string[]): void => {
    if (nodes.length >= max) return;
    const path = CONTAINER_ROLES.has(node.AXRole) ? [...containerPath, axName(node) || node.AXRole] : containerPath;
    const ui = axNodeToUiNode(node, path, `${path.join('/')}#a${++counter}`);
    // Purely structural containers are dropped from the flat list for the same
    // reason the web collector drops layout divs: they are never the target and
    // they crowd out the ones that are.
    if (ui.role !== 'group' || ui.name) nodes.push(ui);
    for (const child of node.children ?? []) walk(child, path);
  };
  walk(root, []);

  const dialog = nodes.find((n) => n.role === 'dialog');
  return {
    at: new Date().toISOString(),
    location: `app://${opts.appName}`,
    title: axName(root) || opts.appName,
    root: { handle: 'root', role: 'document', name: opts.appName, enabled: true, visible: true, containerPath: [] },
    nodes,
    text: normaliseText(nodes.map((n) => `${n.name} ${n.text ?? ''}`).join(' ')),
    blockingDialog: dialog ? { kind: 'confirm', message: dialog.name } : undefined,
  };
}

// ---------------------------------------------------------------------------

export class DesktopSurfaceUnavailableError extends Error {}

export type MacAxSurfaceOptions = {
  /** The application to drive, as System Events names it. */
  readonly appName: string;
};

export class MacAxSurface implements Surface {
  readonly kind = 'desktop_mac' as const;
  readonly sessionId: string;

  private readonly appName: string;
  private floor: Portability = 'any_surface';

  constructor(opts: MacAxSurfaceOptions) {
    this.appName = opts.appName;
    this.sessionId = `mac-${opts.appName}-${Date.now().toString(36)}`;
  }

  setPortabilityFloor(floor: Portability): void {
    this.floor = floor;
  }

  async observe(): Promise<Observation> {
    const tree = await captureAxTree(this.appName);
    return axTreeToObservation(tree, { appName: this.appName });
  }

  async act(_action: Action): Promise<ActionResult> {
    throw new DesktopSurfaceUnavailableError(
      'MacAxSurface can perceive but not act. Injecting synthetic events needs CGEvent through a native ' +
        'binding or a helper binary, which is a packaging problem rather than a design one. Perception, ' +
        'targeting and the artifact contract are all exercised by this surface today; see the header comment.',
    );
  }

  private screenshotMask?: (obs: Observation) => readonly string[];

  setScreenshotMask(select: (obs: Observation) => readonly string[]): void {
    this.screenshotMask = select;
  }

  async screenshot(): Promise<Buffer | undefined> {
    // `screencapture` cannot mask a region, and compositing afterwards would
    // mean the unmasked pixels existed first. So when anything on screen needs
    // covering, this refuses: a caller that asked for redaction must not be
    // handed an image that merely looks redacted.
    if (this.screenshotMask) {
      const needed = this.screenshotMask(await this.observe());
      if (needed.length) {
        throw new Error(
          `MacAxSurface cannot mask ${needed.length} sensitive region(s) during capture, and will not return an ` +
            'unmasked screenshot in their place. A production desktop surface would capture through a compositor ' +
            'that supports exclusion rectangles.',
        );
      }
    }
    try {
      const out = `/tmp/pantograph-${Date.now()}.png`;
      // -x suppresses the capture sound; -o omits the window shadow.
      await run('/usr/sbin/screencapture', ['-x', '-o', out]);
      const { readFile, unlink } = await import('node:fs/promises');
      const buf = await readFile(out);
      await unlink(out).catch(() => undefined);
      return buf;
    } catch {
      return undefined;
    }
  }

  async snapshot(): Promise<string | undefined> {
    try {
      return JSON.stringify(await captureAxTree(this.appName), null, 2);
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    /* nothing to tear down: we attach to a running app rather than launching one */
  }
}

/**
 * Read the AX tree via System Events. `osascript` needs no native build step and
 * is on every Mac; it is also slow and shallow, so a production surface would
 * use a native AX binding. Requires Accessibility permission, and says so rather
 * than returning an empty tree that the resolver would read as a blank screen.
 */
export async function captureAxTree(appName: string): Promise<AxNode> {
  if (process.platform !== 'darwin') {
    throw new DesktopSurfaceUnavailableError(`MacAxSurface needs macOS; this process is on ${process.platform}.`);
  }
  const script = `
    tell application "System Events"
      if not (exists process "${appName}") then error "no running process named ${appName}"
      tell process "${appName}"
        set out to ""
        repeat with w in windows
          set out to out & "WINDOW\t" & (name of w as text) & "\n"
          repeat with e in (entire contents of w)
            try
              set r to (role of e as text)
              set t to ""
              try
                set t to (title of e as text)
              end try
              set out to out & r & "\t" & t & "\n"
            end try
          end repeat
        end repeat
        return out
      end tell
    end tell`;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', script], { maxBuffer: 8 * 1024 * 1024 });
    return parseSystemEventsDump(stdout, appName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not allowed assistive access|osascript is not allowed/i.test(msg)) {
      throw new DesktopSurfaceUnavailableError(
        `Accessibility permission is required to read the AX tree of "${appName}". ` +
          'Grant it under System Settings > Privacy & Security > Accessibility for the process running this. ' +
          'Refusing to return an empty tree, which the resolver would read as a screen with nothing on it.',
      );
    }
    throw new DesktopSurfaceUnavailableError(`could not read the AX tree of "${appName}": ${msg}`);
  }
}

/** Parse the flat tab-separated dump above back into a shallow AxNode tree. */
export function parseSystemEventsDump(stdout: string, appName: string): AxNode {
  const windows: AxNode[] = [];
  let current: { name: string; children: AxNode[] } | undefined;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [a, b] = line.split('\t');
    if (a === 'WINDOW') {
      if (current) windows.push({ AXRole: 'AXWindow', AXTitle: current.name, children: current.children });
      current = { name: b ?? '', children: [] };
      continue;
    }
    if (!current || !a) continue;
    current.children.push({ AXRole: normaliseAxRoleName(a), AXTitle: b ?? '' });
  }
  if (current) windows.push({ AXRole: 'AXWindow', AXTitle: current.name, children: current.children });

  return { AXRole: 'AXApplication', AXTitle: appName, children: windows };
}

/** System Events reports "button"; the AX API reports "AXButton". Normalise. */
export function normaliseAxRoleName(role: string): string {
  if (role.startsWith('AX')) return role;
  const camel = role
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return `AX${camel}`;
}
