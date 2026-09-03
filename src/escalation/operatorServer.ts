/**
 * Minimal operator console.
 *
 * Scope note from the brief: a full real-time co-browsing console is explicitly
 * out of scope. What is IN scope is that the handoff mechanism and the
 * control-transfer model are real. So this is deliberately plain -- server-
 * rendered HTML, a polled screenshot, and forms -- but it is not a mock: the
 * operator's clicks go through `broker.operatorAct`, into a `GuardedSurface`
 * bound to their identity, into the same live BrowserContext the automation was
 * using. Nothing is replayed or simulated on their behalf.
 *
 * What a production version would replace: the polled PNG becomes a CDP screen-
 * cast or a WebRTC stream with real input forwarding, and the "act by role and
 * name" form becomes direct pointer/keyboard events. Neither changes the
 * control-transfer model, which is the part worth getting right now.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { EscalationBroker, Intervention, ResumeDecision } from './broker.ts';
import type { Action, UiRole } from '../surface/types.ts';
import { eq } from '../surface/types.ts';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type OperatorServerOptions = {
  readonly broker: EscalationBroker;
  readonly port?: number;
  /**
   * Identity stamped on every action taken through this console, and on the
   * evidence those actions produce. Required: "who approved this write" is the
   * first question anyone asks of an audit trail, and `console` is not an answer.
   */
  readonly operatorId: string;
  /**
   * Bearer token, generated when omitted. Loopback binding is not
   * authentication; it is an assumption about who else is on the machine, and on
   * a shared or containerised host that assumption is false. Without this,
   * anything able to reach the port could claim an intervention and approve an
   * irreversible write under somebody else's name.
   */
  readonly token?: string;
};

/** Constant-time compare, so a wrong token cannot be discovered a byte at a time. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function startOperatorConsole(
  opts: OperatorServerOptions,
): Promise<{ url: string; token: string; server: Server; close: () => Promise<void> }> {
  const { broker } = opts;
  const operatorId = opts.operatorId;
  const port = opts.port ?? 8732;
  const token = opts.token ?? randomBytes(24).toString('base64url');

  const server = createServer((req, res) => {
    void route(req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`operator console error: ${String(e)}`);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    // Checked before routing, so a route added later cannot be added unguarded.
    // Header for a script, ?t= for a person, who arrives by copying the line the
    // process printed.
    const header = req.headers['authorization'];
    const supplied = (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('t')) ?? '';
    if (!tokenMatches(supplied, token)) {
      res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return void res.end('401: this console requires the token printed by the process that started it.\n');
    }

    if (url.pathname === '/') return html(res, indexPage(broker.list(), token, operatorId));
    if (url.pathname === '/api/interventions') return json(res, broker.list());

    if (parts[0] === 'i' && parts[1]) {
      const id = parts[1];
      const iv = broker.get(id);
      if (!iv) return notFound(res, `no intervention ${id}`);
      const action = parts[2];

      if (!action && req.method === 'GET') return html(res, detailPage(iv, operatorId, token));

      if (action === 'screen.png') {
        const surface = broker.surfaceFor(id, operatorId);
        const png = await surface.screenshot();
        if (!png) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          return void res.end('screenshot unavailable (a modal dialog may be blocking the renderer)');
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return void res.end(png);
      }

      if (action === 'claim' && req.method === 'POST') {
        broker.claim(id, operatorId);
        return redirect(res, `/i/${id}?t=${encodeURIComponent(token)}`);
      }

      if (action === 'act' && req.method === 'POST') {
        const body = await formBody(req);
        const built = buildAction(body);
        if (!built) return redirect(res, `/i/${id}?t=${encodeURIComponent(token)}&err=${encodeURIComponent('could not build an action from that form')}`);
        const result = await broker.operatorAct(id, operatorId, built, body['note']);
        const msg = result.ok ? 'action applied' : `action failed: ${describeFailure(result.failure)}`;
        return redirect(res, `/i/${id}?t=${encodeURIComponent(token)}&msg=${encodeURIComponent(msg)}`);
      }

      if (action === 'resolve' && req.method === 'POST') {
        const body = await formBody(req);
        const decision = (body['decision'] ?? 'resume') as ResumeDecision;
        broker.resolve(id, decision, `operator:${operatorId}`, body['note']);
        return redirect(res, `/?t=${encodeURIComponent(token)}`);
      }
    }

    return notFound(res, 'not found');
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    // The token rides in the URL because copying the printed line is how a
    // person gets in. It lives for one run, in one process, and is never
    // written to evidence.
    url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------

function buildAction(body: Record<string, string>): Action | undefined {
  const kind = body['kind'];
  const role = (body['role'] ?? 'button') as UiRole;
  const name = body['name'] ?? '';
  const container = (body['container'] ?? '').split('/').filter(Boolean);
  const target = { role, name: name ? eq(name) : undefined, container: container.length ? container : undefined, strategies: [{ kind: 'role_name' as const }, { kind: 'text' as const, text: eq(name) }] };

  switch (kind) {
    case 'click': return { kind: 'click', target };
    case 'fill': return { kind: 'fill', target: { ...target, role: 'textbox' }, value: body['value'] ?? '' };
    case 'select': return { kind: 'select', target: { ...target, role: 'combobox' }, value: body['value'] ?? '' };
    case 'navigate': return body['value'] ? { kind: 'navigate', url: body['value'] } : undefined;
    case 'press': return { kind: 'press', keys: body['value'] || 'Enter' };
    case 'accept_dialog': return { kind: 'answer_dialog', accept: true };
    case 'dismiss_dialog': return { kind: 'answer_dialog', accept: false };
    default: return undefined;
  }
}

function describeFailure(f: unknown): string {
  if (!f || typeof f !== 'object') return 'unknown';
  const o = f as { message?: string; reason?: string };
  return `${o.reason ?? 'error'}: ${o.message ?? ''}`;
}

async function formBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) out[k] = v;
  return out;
}

const html = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res: ServerResponse, data: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
};
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(302, { location: to });
  res.end();
};
const notFound = (res: ServerResponse, msg: string) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(msg);
};

const STYLE = `
body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;background:#0f1117;color:#d8dee9}
a{color:#88c0d0}
.wrap{max-width:1180px;margin:0 auto;padding:18px}
h1{font-size:16px;margin:0 0 14px}
h2{font-size:13px;margin:18px 0 6px;color:#8fbcbb;text-transform:uppercase;letter-spacing:.08em}
.card{background:#161922;border:1px solid #2a2f3d;border-radius:6px;padding:12px;margin-bottom:12px}
.badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;border:1px solid}
.open{color:#ebcb8b;border-color:#ebcb8b}.claimed{color:#88c0d0;border-color:#88c0d0}.resolved{color:#a3be8c;border-color:#a3be8c}
pre{background:#0b0d13;border:1px solid #232838;padding:9px;border-radius:4px;overflow:auto;max-height:320px;margin:6px 0;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;border-bottom:1px solid #232838;text-align:left;vertical-align:top}
input,select,textarea{background:#0b0d13;border:1px solid #2a2f3d;color:#d8dee9;padding:4px 6px;border-radius:3px;font:inherit}
button{background:#2e3440;border:1px solid #4c566a;color:#eceff4;padding:5px 12px;border-radius:3px;cursor:pointer;font:inherit}
button.primary{background:#3b4a5a;border-color:#5e81ac}
button.danger{border-color:#bf616a;color:#bf616a}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.msg{background:#2e3440;border-left:3px solid #ebcb8b;padding:7px 10px;margin-bottom:12px}
img.screen{max-width:100%;border:1px solid #2a2f3d;border-radius:4px;background:#fff}
.dim{color:#6c7689}
`;

function shell(title: string, body: string, refresh = 0): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

/** `t` is threaded through every link and form so a page stays usable once open. */
function indexPage(list: readonly Intervention[], t: string, operatorId: string): string {
  const q = `?t=${encodeURIComponent(t)}`;
  const open = list.filter((i) => i.status !== 'resolved');
  const done = list.filter((i) => i.status === 'resolved');
  const row = (i: Intervention) =>
    `<tr><td><a href="/i/${esc(i.id)}${q}">${esc(i.id)}</a></td>
     <td><span class="badge ${i.status}">${esc(i.status)}</span></td>
     <td>${esc(i.reason)}</td>
     <td>${esc(i.capability?.key ?? i.goal ?? '')}</td>
     <td>${esc(i.stepId ?? '')}</td>
     <td class="dim">${esc(i.raisedAt)}</td></tr>`;
  return shell(
    'Operator console',
    `<h1>Pantograph · operator console</h1>
${open.length === 0 ? '<div class="card dim">No open intervention requests. This page refreshes every 3s.</div>' : ''}
${open.length ? `<h2>Open</h2><div class="card"><table><tr><th>id</th><th>status</th><th>reason</th><th>capability / goal</th><th>step</th><th>raised</th></tr>${open.map(row).join('')}</table></div>` : ''}
${done.length ? `<h2>Resolved</h2><div class="card"><table><tr><th>id</th><th>status</th><th>reason</th><th>capability / goal</th><th>step</th><th>raised</th></tr>${done.map(row).join('')}</table></div>` : ''}`,
    3,
  );
}

function detailPage(i: Intervention, operatorId: string, t: string): string {
  const q = `?t=${encodeURIComponent(t)}`;
  const claimed = i.claimedBy === operatorId && i.status === 'claimed';
  const resolved = i.status === 'resolved';
  const events = i.context.recentEvents
    .map((e) => `${String(e.seq).padStart(3, '0')} ${e.at.slice(11, 23)} ${e.actor.padEnd(16)} ${e.type} ${compact(e)}`)
    .join('\n');

  const actForm = `
<h2>Drive the live session</h2>
<div class="card">
<form method="POST" action="/i/${esc(i.id)}/act${q}">
<table>
<tr><td>action</td><td><select name="kind">
  <option value="click">click</option><option value="fill">fill</option>
  <option value="select">select</option><option value="press">press key</option>
  <option value="navigate">navigate</option>
  <option value="accept_dialog">accept dialog</option><option value="dismiss_dialog">dismiss dialog</option>
</select></td></tr>
<tr><td>role</td><td><select name="role">
  <option>button</option><option>link</option><option>textbox</option><option>combobox</option><option>cell</option><option>checkbox</option>
</select></td></tr>
<tr><td>accessible name</td><td><input name="name" size="40" placeholder="e.g. Sign On"></td></tr>
<tr><td>frame / container</td><td><input name="container" size="24" placeholder="content" value="content"></td></tr>
<tr><td>value / url / keys</td><td><input name="value" size="40"></td></tr>
<tr><td>note</td><td><input name="note" size="40" placeholder="what you are doing and why"></td></tr>
<tr><td></td><td><button class="primary" type="submit">Apply to live session</button></td></tr>
</table>
</form>
<div class="dim">Every action here runs against the same browser context the automation was using,
through a guarded surface bound to <code>operator:${esc(operatorId)}</code>, and is written to the run's
evidence stream as <code>human_action</code>. Actions so far: <b>${i.humanActions}</b>.</div>
</div>`;

  const resolveForm = `
<h2>Hand control back</h2>
<div class="card">
<form method="POST" action="/i/${esc(i.id)}/resolve${q}">
<table>
<tr><td>decision</td><td><select name="decision">${i.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></td></tr>
<tr><td>note</td><td><input name="note" size="52" placeholder="recorded in the artifact evidence"></td></tr>
<tr><td></td><td><button class="primary" type="submit">Resume automation</button></td></tr>
</table>
</form>
</div>`;

  return shell(
    `Intervention ${i.id}`,
    `<h1><a href="/${q}">&larr;</a> ${esc(i.id)} <span class="badge ${i.status}">${esc(i.status)}</span></h1>
<div class="card">
<table>
<tr><th>reason</th><td>${esc(i.reason)}</td></tr>
<tr><th>why</th><td><b>${esc(i.why)}</b></td></tr>
<tr><th>run</th><td>${esc(i.runId)} (${esc(i.mode)})</td></tr>
<tr><th>capability</th><td>${esc(i.capability ? `${i.capability.key}@${i.capability.version}` : i.goal ?? '')}</td></tr>
<tr><th>step</th><td>${esc(i.stepId ?? '-')}${i.stepIntent ? ` &mdash; ${esc(i.stepIntent)}` : ''}${i.stepIndex !== undefined ? ` (${i.stepIndex + 1}/${i.stepTotal})` : ''}</td></tr>
<tr><th>pending action</th><td><code>${esc(i.pendingAction ? JSON.stringify(i.pendingAction) : '-')}</code></td></tr>
<tr><th>location</th><td>${esc(i.context.location)}</td></tr>
<tr><th>options</th><td>${i.options.map((o) => `<code>${esc(o)}</code>`).join(' ')}</td></tr>
${i.resolution ? `<tr><th>resolution</th><td>${esc(i.resolution.decision)} by ${esc(i.resolution.by)} &mdash; ${esc(i.resolution.note ?? '')}</td></tr>` : ''}
</table>
</div>

${resolved ? '' : claimed ? '' : `<form method="POST" action="/i/${esc(i.id)}/claim${q}"><button class="primary" type="submit">Claim &amp; take control of the live session</button></form><p class="dim">Claiming transfers the control lease to you. The automation is already parked and cannot act.</p>`}

<div class="grid">
<div>
<h2>Live session</h2>
<div class="card">
${claimed ? `<img class="screen" src="/i/${esc(i.id)}/screen.png${q}&cb=${Date.now()}" alt="live session">` : `<div class="dim">Claim the intervention to view and drive the live session.</div>`}
${i.context.screenshotPath ? `<div class="dim">Escalation-time screenshot saved to the run evidence.</div>` : ''}
</div>
</div>
<div>
<h2>Screen at escalation</h2>
<div class="card"><pre>${esc(i.context.observationSummary)}</pre></div>
</div>
</div>

${claimed ? actForm + resolveForm : ''}

<h2>Recent evidence</h2>
<div class="card"><pre>${esc(events)}</pre></div>`,
    claimed ? 4 : 3,
  );
}

function compact(e: { type: string } & Record<string, unknown>): string {
  const skip = new Set(['seq', 'at', 'runId', 'actor', 'elapsedMs', 'type']);
  const bits: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k)) continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    bits.push(`${k}=${s.length > 90 ? s.slice(0, 89) + '…' : s}`);
  }
  return bits.join(' ');
}
