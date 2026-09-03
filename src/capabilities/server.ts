/**
 * The capability catalog as an HTTP surface.
 *
 * This is the stretch goal from the brief -- "expose saved artifacts as a
 * catalog of callable capabilities an AI agent could discover and invoke by
 * name with typed args" -- and it is intentionally thin, because the artifact
 * already IS the contract. Discovery is a projection (see ./catalog.ts) and
 * invocation is a replay.
 *
 * The one piece of real judgement here is the refusal: a capability in `draft`
 * cannot be invoked through this surface, even though the CLI will run it for
 * development. An agent-facing endpoint is the unattended path, and unattended
 * execution of an unreviewed recording against a bank's core is exactly what the
 * approval state exists to prevent.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CapabilityStore, materialize } from '../artifact/store.ts';
import { catalogEntry, toolDefinitionFor } from './catalog.ts';
import { createSession } from '../runtime.ts';
import { replayCapability } from '../replay/engine.ts';
import type { ReplayResult } from '../replay/outcomes.ts';

export type CatalogServerOptions = {
  readonly store: CapabilityStore;
  readonly port?: number;
  readonly baseUrl: string;
  /** Allow invoking draft capabilities. Off by default, and it should stay off. */
  readonly allowDraft?: boolean;
  /** Path to the policy file this server enforces. */
  readonly policyFile?: string;
  /**
   * Escalation stance for every invocation, fixed by whoever RUNS the server.
   *
   * Deliberately not readable from the request body. Taking it from the
   * caller's JSON would let the AI agent this endpoint exists to serve nominate
   * a scripted operator and approve its own irreversible actions with one
   * field, turning the human-in-the-loop control into a no-op on the path that
   * most needs it.
   */
  readonly operatorMode?: 'abort' | 'console';
};

export async function startCatalogServer(
  opts: CatalogServerOptions,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const port = opts.port ?? 8733;

  const server = createServer((req, res) => {
    void route(req, res).catch((e) => json(res, 500, { error: String(e) }));
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const caps = () => opts.store.list().map((c) => materialize(c, opts.store));

    if (url.pathname === '/' || url.pathname === '/capabilities') {
      return json(res, 200, { capabilities: caps().map(catalogEntry) });
    }
    if (url.pathname === '/tools') {
      // Only approved capabilities are advertised to a model.
      return json(res, 200, { tools: caps().filter((c) => c.approval.state === 'approved').map(toolDefinitionFor) });
    }

    if (parts[0] === 'capabilities' && parts[1]) {
      const key = decodeURIComponent(parts[1]);
      const cap = caps().find((c) => c.key === key);
      if (!cap) return json(res, 404, { error: `no capability "${key}"` });

      if (!parts[2] && req.method === 'GET') return json(res, 200, { capability: cap, catalog: catalogEntry(cap) });

      if (parts[2] === 'invoke' && req.method === 'POST') {
        if (cap.approval.state !== 'approved' && !opts.allowDraft) {
          return json(res, 409, {
            error: 'capability_not_approved',
            message: `"${cap.key}" is in state "${cap.approval.state}". Approve it before invoking it from an agent: node src/cli.ts approve ${cap.key} --by "<reviewer>"`,
          });
        }
        const body = await readJson(req);
        const inputs = (body['inputs'] ?? {}) as Record<string, unknown>;
        if ('operator' in body) {
          return json(res, 400, {
            error: 'operator_not_caller_selectable',
            message:
              'The escalation stance is fixed by whoever runs this server, not by the caller. Approving an irreversible action is not a decision the invoking agent gets to make on its own behalf.',
          });
        }

        // One browser session per invocation. Fine at this scale and honest
        // about the cost; a production build would pool warm sessions per
        // tenant, which is a resourcing concern rather than a design one.
        const session = await createSession({
          mode: 'replay',
          // Server-fixed, never caller-supplied. `abort` means an irreversible
          // step stops the run rather than proceeding unreviewed.
          operatorMode: opts.operatorMode ?? 'abort',
          // No auto-operator on this path at all: there is no human here, so
          // there is nobody for a scripted stand-in to stand in for.
          policyFile: opts.policyFile,
          echo: false,
        });
        try {
          const result: ReplayResult = await replayCapability({
            capability: cap,
            inputs,
            surface: session.surface,
            recorder: session.recorder,
            broker: session.broker,
            env: { baseUrl: opts.baseUrl },
          });
          session.recorder.finish(result.status);
          const status = result.status === 'failed' ? 502 : 200;
          return json(res, status, session.recorder.redactor.deep(result));
        } finally {
          await session.close();
        }
      }
    }

    return json(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}
