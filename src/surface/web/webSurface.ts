/**
 * Playwright implementation of the Surface contract.
 *
 * Everything web-specific lives here and in ./perceive.ts. The layers above see
 * only `Observation` / `TargetDescriptor` / `Action`, which is what makes the
 * "swap in a desktop surface" story in REPORT.md credible rather than aspirational.
 */

import { chromium, type Browser, type BrowserContext, type Dialog, type Frame, type Page } from 'playwright';
import type {
  Action,
  ActionResult,
  Observation,
  Portability,
  ResolveFailure,
  ResolvedTarget,
  Surface,
  TargetDescriptor,
} from '../types.ts';
import { isResolveFailure } from '../types.ts';
import { resolveTarget } from '../resolve.ts';
import { perceive } from './perceive.ts';

export type WebSurfaceOptions = {
  readonly headless?: boolean;
  readonly baseUrl?: string;
  readonly defaultTimeoutMs?: number;
  readonly viewport?: { width: number; height: number };
  /** Slow motion, for the human-watchable demo recording. */
  readonly slowMoMs?: number;
  /**
   * Record the session to video in this directory. Playwright writes the file
   * on context close, so `videoPath()` is only meaningful after `close()`.
   * Used for the demo recording; off by default, because a video of every
   * production run is a data-retention problem, not a feature.
   */
  readonly recordVideoDir?: string;
};

type PendingDialog = { dialog: Dialog; kind: 'confirm' | 'alert' | 'prompt' | 'beforeunload'; message: string };

export class WebSurface implements Surface {
  readonly kind = 'legacy_web' as const;
  readonly sessionId: string;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly defaultTimeoutMs: number;

  /** Set per capability by the engine; bounds which locator rungs may act. */
  portabilityFloor: Portability = 'pixel';

  private screenshotMask?: (obs: Observation) => readonly string[];

  private pendingDialog: PendingDialog | undefined;
  /** A click that is blocked behind an open dialog. Settled once it is answered. */
  private blockedAction: Promise<unknown> | undefined;
  /** Timestamp of the most recent navigation in any frame. Drives settling. */
  private lastNavigationAt = 0;
  /** Last known page identity, for describing a screen we cannot evaluate. */
  private lastSeen = { location: 'about:blank', title: '' };

  private constructor(browser: Browser, context: BrowserContext, page: Page, opts: WebSurfaceOptions) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.sessionId = `web-${Date.now().toString(36)}`;

    // Dialogs are captured, not auto-dismissed. An unexpected confirm() is a
    // first-class observable state -- Playwright's default of silently
    // dismissing it would turn "the app asked for confirmation" into
    // "the submit mysteriously did nothing", which is precisely the class of
    // runtime surprise this system is supposed to detect.
    this.page.on('dialog', (dialog) => {
      this.pendingDialog = {
        dialog,
        kind: dialog.type() as PendingDialog['kind'],
        message: dialog.message(),
      };
    });

    this.page.on('framenavigated', () => {
      this.lastNavigationAt = Date.now();
    });
  }

  static async launch(opts: WebSurfaceOptions = {}): Promise<WebSurface> {
    let browser: Browser;
    try {
      browser = await chromium.launch({
        // `channel: 'chromium'` runs the full Chromium build in new-headless
        // mode rather than the separate chrome-headless-shell download. One
        // binary covers both headless runs and the headed operator handoff,
        // which halves what a reviewer has to download.
        channel: 'chromium',
        headless: opts.headless ?? true,
        slowMo: opts.slowMoMs,
      });
    } catch (e) {
      // `npm install` does not fetch browsers: playwright ships no install
      // hook, and npm 11 would not run one anyway. Say so, rather than letting
      // a first-run reviewer read a path that does not exist and guess.
      const msg = e instanceof Error ? e.message : String(e);
      if (/Executable doesn't exist|please run the following command/i.test(msg)) {
        throw new Error(`No Chromium build was found. Run:\n\n  npx playwright install chromium\n\nOriginal error: ${msg.split('\n')[0]}`);
      }
      throw e;
    }
    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const context = await browser.newContext({
      viewport,
      // Certificate errors are not ignored: a surface that silently accepts a
      // bad certificate is one that can be pointed at an impostor.
      ignoreHTTPSErrors: false,
      ...(opts.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.defaultTimeoutMs ?? 10_000);
    return new WebSurface(browser, context, page, opts);
  }

  setPortabilityFloor(floor: Portability): void {
    this.portabilityFloor = floor;
  }

  

  /** Path of the recorded video, available only once the context has closed. */
  async videoPath(): Promise<string | undefined> {
    try {
      return (await this.page.video()?.path()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async observe(): Promise<Observation> {
    // A pending JS dialog pauses the renderer. Any frame.evaluate() -- which is
    // how perception works -- would block until the dialog is answered, and the
    // dialog can only be answered by code that is waiting on this observation.
    // That deadlock is the bug that makes `confirm()` on submit so nasty. So a
    // blocked surface reports exactly one thing: that it is blocked, and by what.
    if (this.pendingDialog) {
      return {
        at: new Date().toISOString(),
        location: this.lastSeen.location,
        title: this.lastSeen.title,
        root: { handle: 'root', role: 'dialog', name: this.pendingDialog.message, enabled: true, visible: true, containerPath: [] },
        nodes: [],
        text: this.pendingDialog.message,
        blockingDialog: { kind: this.pendingDialog.kind, message: this.pendingDialog.message },
      };
    }
    await this.settle();
    const obs = await perceive(this.page, undefined);
    this.lastSeen = { location: obs.location, title: obs.title };
    return obs;
  }

  async act(action: Action): Promise<ActionResult> {
    const started = Date.now();
    const done = (ok: boolean, extra: Partial<ActionResult> = {}): ActionResult => ({
      ok,
      durationMs: Date.now() - started,
      ...extra,
    });

    try {
      if (action.kind === 'wait') {
        await this.page.waitForTimeout(action.ms);
        return done(true);
      }

      if (action.kind === 'answer_dialog') {
        const pending = this.pendingDialog;
        if (!pending) {
          return done(false, { failure: { reason: 'action_error', message: 'no dialog is open' } });
        }
        this.pendingDialog = undefined;
        if (action.accept) await pending.dialog.accept(action.text);
        else await pending.dialog.dismiss();
        // The action the dialog was blocking can now complete.
        if (this.blockedAction) {
          await this.blockedAction.catch(() => undefined);
          this.blockedAction = undefined;
        }
        await this.settle();
        return done(true);
      }

      if (this.pendingDialog) {
        return done(false, {
          failure: {
            reason: 'action_error',
            message: `a ${this.pendingDialog.kind} dialog is blocking the surface: "${this.pendingDialog.message}"`,
          },
        });
      }

      if (action.kind === 'navigate') {
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.defaultTimeoutMs });
        await this.settle();
        return done(true);
      }

      if (action.kind === 'scroll') {
        const dy = (action.amount ?? 400) * (action.direction === 'up' ? -1 : 1);
        await this.page.mouse.wheel(0, dy);
        return done(true);
      }

      if (action.kind === 'press' && !action.target) {
        await this.page.keyboard.press(action.keys);
        await this.settle();
        return done(true);
      }

      // Everything below needs a resolved target.
      const target = 'target' in action ? action.target : undefined;
      if (!target) return done(false, { failure: { reason: 'action_error', message: `action ${action.kind} requires a target` } });

      const obs = await this.observe();
      // The floor binds the action, not only the assertions and extraction
      // around it. Otherwise a capability declaring surface portability could
      // still fall to a CSS rung to actually act, which is the one thing the
      // floor exists to prevent.
      const resolved = resolveTarget(obs, target, { portabilityFloor: this.portabilityFloor });
      if (isResolveFailure(resolved)) return done(false, { failure: resolved });

      const handle = this.locatorFor(resolved);
      if (!handle) {
        return done(false, {
          failure: { reason: 'action_error', message: `resolved node ${resolved.node.handle} has no live frame` },
        });
      }

      switch (action.kind) {
        case 'click':
          await this.clickPossiblyBlocking(handle);
          break;
        case 'fill':
          await handle.fill(action.value, { timeout: this.defaultTimeoutMs });
          break;
        case 'select':
          await handle.selectOption(action.value, { timeout: this.defaultTimeoutMs });
          break;
        case 'check':
          await handle.setChecked(action.checked, { timeout: this.defaultTimeoutMs });
          break;
        case 'press':
          await handle.press(action.keys, { timeout: this.defaultTimeoutMs });
          break;
      }
      await this.settle();
      return done(true, { resolved });
    } catch (e) {
      return done(false, { failure: { reason: 'action_error', message: errText(e) } });
    }
  }

  /**
   * A click that triggers `onsubmit="return confirm(...)"` never resolves until
   * the dialog is answered. Race the click against the dialog so the engine
   * regains control and can observe the dialog as state.
   */
  private async clickPossiblyBlocking(handle: NonNullable<ReturnType<WebSurface['locatorFor']>>): Promise<void> {
    const click = handle.click({ timeout: this.defaultTimeoutMs });
    // Swallow here so an abandoned click cannot become an unhandled rejection;
    // the real outcome is still awaited below, or after the dialog is answered.
    click.catch(() => undefined);

    const winner = await Promise.race([
      click.then(() => 'click' as const),
      this.waitForDialog(1500).then((seen) => (seen ? ('dialog' as const) : ('no-dialog' as const))),
    ]);

    if (winner === 'dialog') {
      // Leave the click pending. `answer_dialog` will settle it.
      this.blockedAction = click;
      return;
    }
    await click;
  }

  private waitForDialog(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this.pendingDialog) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** Map a perceived node back to a live element via its per-observation ref. */
  private locatorFor(resolved: ResolvedTarget) {
    return this.locatorForHandle(resolved.node.handle);
  }

  private locatorForHandle(handle: string) {
    const [framePart, ref] = handle.split('#');
    const path = framePart ? framePart.split('/').filter(Boolean) : [];
    const frame = this.frameByPath(path);
    if (!frame || !ref) return undefined;
    return frame.locator(`[data-pantograph-ref="${ref}"]`).first();
  }

  private frameByPath(path: readonly string[]): Frame | undefined {
    if (path.length === 0) return this.page.mainFrame();
    let cur: Frame | undefined = this.page.mainFrame();
    for (const seg of path) {
      cur = cur?.childFrames().find((f) => f.name() === seg || f.url().includes(seg));
      if (!cur) return undefined;
    }
    return cur;
  }

  /**
   * Bounded settling.
   *
   * The naive version -- await domcontentloaded -- returns instantly on a
   * frameset, because the *top* document loaded long ago. Submitting a form
   * inside the `content` frame navigates only that frame, and the navigation
   * has not even started by the time the click promise resolves. So we wait for
   * quiescence rather than for an event: no frame navigation for `quietMs`, and
   * every live frame past domcontentloaded.
   *
   * This is a best-effort convenience, deliberately short. It is NOT how the
   * replay engine establishes that a step worked -- that is the job of the
   * step's `expect` assertion, which polls to its own timeout. Settling only
   * keeps the common case fast; correctness never depends on it.
   */
  private async settle(quietMs = 180, capMs = 4_000): Promise<void> {
    const deadline = Date.now() + capMs;
    const navBaseline = this.lastNavigationAt;
    try {
      // Give a navigation a brief window to begin before deciding it will not.
      const startWindow = Date.now() + 250;
      while (Date.now() < startWindow && this.lastNavigationAt === navBaseline) {
        await this.page.waitForTimeout(25);
      }
      while (Date.now() < deadline) {
        if (Date.now() - this.lastNavigationAt >= quietMs) break;
        await this.page.waitForTimeout(40);
      }
      await Promise.all(
        this.page
          .frames()
          .filter((f) => !f.isDetached())
          .map((f) => f.waitForLoadState('domcontentloaded', { timeout: Math.max(250, deadline - Date.now()) }).catch(() => undefined)),
      );
    } catch {
      /* a page that never settles is a condition the engine detects via its own
         assertions, not something to throw from here. */
    }
  }

  /**
   * Masking happens during capture, via Playwright's own `mask`, rather than by
   * editing the page first or the image after. Editing the page destroys the
   * state the screenshot exists to record; editing the image afterwards means
   * the unmasked pixels existed in this process, in a Buffer, for a while.
   */
  setScreenshotMask(select: (obs: Observation) => readonly string[]): void {
    this.screenshotMask = select;
  }

  async screenshot(): Promise<Buffer | undefined> {
    try {
      // Cannot screenshot while a dialog is open -- the renderer is blocked.
      if (this.pendingDialog) return undefined;
      let handles: readonly string[] = [];
      if (this.screenshotMask) {
        try {
          handles = this.screenshotMask(await this.observe());
        } catch {
          // A screenshot we cannot prove is safe is one we do not take.
          return undefined;
        }
      }
      const mask = handles.map((h) => this.locatorForHandle(h)).filter((l) => l !== undefined);
      return await this.page.screenshot({
        fullPage: false,
        timeout: 5_000,
        ...(mask.length ? { mask, maskColor: '#000000' } : {}),
      });
    } catch {
      return undefined;
    }
  }

  async snapshot(): Promise<string | undefined> {
    try {
      const parts: string[] = [`<!-- location: ${this.page.url()} -->`];
      for (const frame of this.page.frames()) {
        if (frame.isDetached()) continue;
        const name = frame.name() || '(main)';
        const html = await frame.content().catch(() => '<!-- unavailable -->');
        parts.push(`\n<!-- ===== frame: ${name} url: ${frame.url()} ===== -->\n${html}`);
      }
      return parts.join('\n');
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.pendingDialog) {
      await this.pendingDialog.dialog.dismiss().catch(() => undefined);
      this.pendingDialog = undefined;
    }
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n').slice(0, 3).join(' ');
  return String(e);
}
