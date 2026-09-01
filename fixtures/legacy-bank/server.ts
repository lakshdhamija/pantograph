/**
 * CORETELLER 7.2 -- fixture "legacy core banking" web app.
 *
 * Why a local fixture instead of a public demo site: the interesting problems in
 * this domain are the *exceptional* states (session expiry, permission denial,
 * validation rejection, surprise dialogs, app 500s). No public site lets you arm
 * those on demand, and every public site has a cleaner DOM than the real target.
 *
 * Failures are armed out-of-band via POST /_chaos so that the recorded artifact
 * and the replayed request stream stay byte-identical -- only the app misbehaves.
 * That is how you would fault-inject against a real integration test bed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { OPERATOR_CREDENTIALS, PRODUCT_CODES, findMember, tenantFor, type TenantConfig } from './data.ts';
import { isMain } from '../../src/util/main.ts';
import * as V from './html.ts';

type ChaosMode = 'session_expiry' | 'app_error' | 'interstitial' | 'slow' | 'validation';
type ChaosArm = {
  mode: ChaosMode;
  remaining: number;
  delayMs?: number;
  /** Skip this many eligible requests before firing. Lets a fault land mid-flow. */
  after: number;
};

type Session = { id: string; user: string; valid: boolean; createdAt: number };

const sessions = new Map<string, Session>();
const chaos: ChaosArm[] = [];
const requestLog: Array<{ at: string; method: string; url: string }> = [];

function takeChaos(mode: ChaosMode): ChaosArm | undefined {
  const i = chaos.findIndex((c) => c.mode === mode && c.remaining > 0);
  if (i < 0) return undefined;
  const arm = chaos[i]!;
  if (arm.after > 0) {
    arm.after -= 1;
    return undefined;
  }
  arm.remaining -= 1;
  if (arm.remaining <= 0) chaos.splice(i, 1);
  return arm;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionOf(req: IncomingMessage): Session | undefined {
  const id = cookies(req)['CTSESSION'];
  if (!id) return undefined;
  const s = sessions.get(id);
  return s?.valid ? s : undefined;
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const out: Record<string, string> = {};
  // The app's own forms are urlencoded; the /_chaos control channel is just as
  // likely to be poked with curl -d '{"mode":...}', so accept both.
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw || '{}') as Record<string, unknown>)) out[k] = String(v);
      return out;
    } catch {
      /* fall through and try urlencoded */
    }
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic so evidence files are reproducible across runs. */
function confirmationRef(parts: string[]): string {
  return 'CT-' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8).toUpperCase();
}

function stripPrefix(pathname: string, t: TenantConfig): string {
  return t.prefix && pathname.startsWith(t.prefix) ? pathname.slice(t.prefix.length) || '/' : pathname;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  requestLog.push({ at: new Date().toISOString(), method: req.method ?? 'GET', url: req.url ?? '/' });
  if (requestLog.length > 500) requestLog.shift();

  // ---- out-of-band control channel (not part of the app under automation) ----
  if (url.pathname === '/_health') return json(res, 200, { ok: true });
  if (url.pathname === '/_chaos') {
    if (req.method === 'POST') {
      const raw = await readBody(req);
      const mode = String(raw['mode'] ?? '') as ChaosMode;
      if (!['session_expiry', 'app_error', 'interstitial', 'slow', 'validation'].includes(mode)) {
        return json(res, 400, { error: 'unknown mode', mode });
      }
      chaos.push({
        mode,
        remaining: Number(raw['count'] ?? 1),
        after: Number(raw['after'] ?? 0),
        delayMs: raw['delayMs'] ? Number(raw['delayMs']) : undefined,
      });
      return json(res, 200, { armed: chaos });
    }
    if (req.method === 'DELETE') {
      chaos.length = 0;
      return json(res, 200, { armed: chaos });
    }
    return json(res, 200, { armed: chaos, requests: requestLog.length });
  }
  if (url.pathname === '/_requests') return json(res, 200, requestLog.slice(-100));

  const t = tenantFor(url.pathname);
  const p = stripPrefix(url.pathname, t);

  if (p === '/' ) return redirect(res, `${t.prefix}/login`);

  if (p === '/login') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body['f_user'] === OPERATOR_CREDENTIALS.user && body['f_pass'] === OPERATOR_CREDENTIALS.pass) {
        const id = randomUUID();
        sessions.set(id, { id, user: body['f_user']!, valid: true, createdAt: Date.now() });
        return redirect(res, `${t.prefix}/desk`, {
          'set-cookie': `CTSESSION=${id}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }
      return send(res, 200, V.loginPage(t, 'SEC-1001: Invalid operator ID or password.'));
    }
    return send(res, 200, V.loginPage(t, url.searchParams.get('m') ?? undefined));
  }

  if (p === '/logout') {
    const s = sessionOf(req);
    if (s) s.valid = false;
    return redirect(res, `${t.prefix}/login?m=${encodeURIComponent('You have been signed off.')}`);
  }

  if (p === '/desk') {
    if (!sessionOf(req)) return redirect(res, `${t.prefix}/login`);
    return send(res, 200, V.desk(t));
  }

  if (p === '/nav') {
    if (!sessionOf(req)) return send(res, 200, V.loginPage(t, 'Your session has expired. Please sign on again.'));
    return send(res, 200, V.navFrame(t));
  }

  if (p === '/content') return content(req, res, t, url);

  return send(res, 404, V.appError(t, 'CT-404-' + randomUUID().slice(0, 8)));
}

async function content(req: IncomingMessage, res: ServerResponse, t: TenantConfig, url: URL): Promise<void> {
  // Chaos is evaluated at the content-frame boundary, before auth, so an armed
  // session_expiry can invalidate a live session mid-flow.
  if (takeChaos('session_expiry')) {
    const s = sessionOf(req);
    if (s) s.valid = false;
  }
  const slow = takeChaos('slow');
  if (slow) await sleep(slow.delayMs ?? 4000);
  if (takeChaos('app_error')) {
    return send(res, 500, V.appError(t, 'CT-ERR-' + createHash('sha1').update(url.search).digest('hex').slice(0, 6).toUpperCase()));
  }

  const session = sessionOf(req);
  if (!session) {
    // Renders *inside the content frame* -- the app does not redirect the top
    // frame, which is exactly why session expiry is easy to mistake for a
    // missing element rather than an auth problem.
    return send(res, 200, V.loginPage(t, 'Your session has expired. Please sign on again.'));
  }

  const screen = url.searchParams.get('screen') ?? 'home';

  if (req.method === 'GET' && takeChaos('interstitial')) {
    return send(res, 200, V.maintenanceNotice(t, url.search));
  }

  if (screen === 'home' || screen === 'reports') return send(res, 200, V.homeScreen(t));

  if (screen === 'mbrsearch') {
    if (req.method !== 'POST') return send(res, 200, V.searchScreen(t));
    const body = await readBody(req);
    const q = (body['f_mbr'] ?? '').trim();
    if (!q) return send(res, 200, V.searchScreen(t, { error: 'VAL-2001: Member Number is required.' }));
    if (!/^\d+$/.test(q)) {
      return send(res, 200, V.searchScreen(t, { error: 'VAL-2002: Member Number must be numeric.' }));
    }
    const m = findMember(q);
    if (!m) return send(res, 200, V.noRecords(t, q));
    if (m.behaviour === 'slow') await sleep(3500);
    if (m.behaviour === 'restricted') return send(res, 200, V.permissionDenied(t));
    return send(res, 200, V.searchResults(t, m));
  }

  if (screen === 'mbrdetail') {
    const m = findMember(url.searchParams.get('id') ?? '');
    if (!m) return send(res, 200, V.noRecords(t, url.searchParams.get('id') ?? ''));
    if (m.behaviour === 'restricted') return send(res, 200, V.permissionDenied(t));
    return send(res, 200, V.memberDetail(t, m));
  }

  if (screen === 'subacct') {
    const m = findMember(url.searchParams.get('id') ?? '');
    if (!m) return send(res, 200, V.noRecords(t, url.searchParams.get('id') ?? ''));
    if (m.behaviour === 'restricted') return send(res, 200, V.permissionDenied(t));
    if (req.method !== 'POST') return send(res, 200, V.subAccountForm(t, m));

    const body = await readBody(req);
    const errors: string[] = [];
    const prod = body['f_prod'] ?? '';
    const amt = (body['f_amt'] ?? '').trim();
    if (!prod) errors.push('VAL-3001: Product Code must be selected.');
    if (!amt) errors.push('VAL-3002: Opening Deposit is required.');
    else if (!/^\d+(\.\d{1,2})?$/.test(amt)) errors.push('VAL-3003: Opening Deposit must be a positive amount.');
    else if (Number(amt) < 25) errors.push('VAL-3004: Opening Deposit must be at least 25.00 for this product.');
    if (t.requiresBranchCode && !(body['f_branch'] ?? '').trim()) {
      errors.push('VAL-3010: Branch Code is required.');
    }
    if (takeChaos('validation')) errors.push('VAL-3099: Product not available for this member class.');
    if (errors.length) return send(res, 200, V.subAccountForm(t, m, { errors, values: body }));

    const label = PRODUCT_CODES.find((x) => x.code === prod)?.label ?? prod;
    const ref = confirmationRef([t.id, m.id, prod, amt]);
    const seq = String(m.accounts.length + 1).padStart(2, '0');
    return send(res, 200, V.subAccountConfirmed(t, m, ref, `${m.id}-${seq}`, label));
  }

  return send(res, 200, V.homeScreen(t));
}

export function startLegacyBank(port = 8731): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[legacy-bank] handler error', e);
      if (!res.headersSent) json(res, 500, { error: String(e) });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

if (isMain(import.meta.url)) {
  const port = Number(process.env['LEGACY_BANK_PORT'] ?? 8731);
  void startLegacyBank(port).then(({ url }) => {
    // eslint-disable-next-line no-console
    console.log(`[legacy-bank] CORETELLER fixture listening on ${url}`);
    // eslint-disable-next-line no-console
    console.log(`[legacy-bank] tenant A: ${url}/login    tenant B: ${url}/t/granite/login`);
  });
}
