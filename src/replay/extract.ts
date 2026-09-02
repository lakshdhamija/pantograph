/**
 * Typed output extraction.
 *
 * An artifact declares what it returns and in what shape. Extraction is
 * therefore three separable things -- locate, read a property, normalise -- and
 * the last one matters more than it looks: a legacy screen renders a balance as
 * "18,234.55", and a caller that asked for a `money` output must receive
 * 18234.55, not a string it has to guess how to parse. Getting the coercion
 * wrong at this boundary is how a downstream agent ends up comparing "1,000.00"
 * to 999 and deciding the account is overdrawn.
 */

import type { Observation, Portability } from '../surface/types.ts';
import { describeTarget, isResolveFailure } from '../surface/types.ts';
import { resolveTarget } from '../surface/resolve.ts';
import type { Extraction, OutputSpec, Transform, ValueType } from '../artifact/schema.ts';

export type ExtractionResult =
  | { readonly ok: true; readonly value: unknown; readonly raw: string; readonly degraded: boolean }
  | { readonly ok: false; readonly error: string; readonly raw?: string };

export function readProperty(obs: Observation, e: Extraction, floor?: Portability): { ok: true; raw: string; degraded: boolean } | { ok: false; error: string } {
  if (e.property === 'location') return { ok: true, raw: obs.location, degraded: false };

  const r = resolveTarget(obs, e.target, { portabilityFloor: floor });
  if (isResolveFailure(r)) return { ok: false, error: `${describeTarget(e.target)}: ${r.message}` };

  let raw: string | undefined;
  switch (e.property) {
    case 'text': raw = r.node.text ?? r.node.name; break;
    case 'value': raw = r.node.value ?? r.node.text ?? r.node.name; break;
    case 'name': raw = r.node.name; break;
    case 'attribute': raw = e.attribute === 'testId' ? r.node.native?.testId : undefined; break;
  }
  if (raw === undefined) return { ok: false, error: `property "${e.property}" is not available on ${describeTarget(e.target)}` };
  return { ok: true, raw, degraded: r.degraded };
}

export function applyTransforms(input: string, transforms: readonly Transform[]): string {
  let s = input;
  for (const t of transforms) {
    switch (t.op) {
      case 'trim': s = s.trim(); break;
      case 'upper': s = s.toUpperCase(); break;
      case 'lower': s = s.toLowerCase(); break;
      case 'strip_grouping': s = s.replace(/,/g, ''); break;
      case 'strip_currency': s = s.replace(/[$€£¥]|\bUSD\b|\bEUR\b/gi, '').trim(); break;
      case 'to_number': s = s.replace(/[^0-9.\-]/g, ''); break;
      case 'regex_extract': {
        const m = new RegExp(t.pattern, t.flags ?? '').exec(s);
        s = m ? (m[t.group] ?? '') : '';
        break;
      }
      case 'replace': s = s.replace(new RegExp(t.pattern, t.flags ?? 'g'), t.with); break;
    }
  }
  return s;
}

export function coerce(raw: string, type: ValueType): { ok: true; value: unknown } | { ok: false; error: string } {
  const s = raw.trim();
  switch (type) {
    case 'string':
    case 'enum':
    case 'date':
      return { ok: true, value: s };
    case 'boolean':
      return { ok: true, value: /^(true|yes|y|1|on|checked)$/i.test(s) };
    case 'integer': {
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `expected an integer, got ${JSON.stringify(raw)}` };
      return { ok: true, value: n };
    }
    case 'number':
    case 'money': {
      const n = Number(s.replace(/,/g, '').replace(/[$€£¥]/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: `expected a ${type}, got ${JSON.stringify(raw)}` };
      // Money is carried as a number here because the fixture's precision is
      // trivially safe. In production this would be minor units or a decimal
      // type: IEEE-754 is the wrong carrier for account balances. Flagged in
      // REPORT.md under Cuts.
      return { ok: true, value: type === 'money' ? Math.round(n * 100) / 100 : n };
    }
  }
}

export function extractOutput(obs: Observation, spec: OutputSpec, floor?: Portability): ExtractionResult {
  const read = readProperty(obs, spec.extract, floor);
  if (!read.ok) {
    if (!spec.required) return { ok: true, value: undefined, raw: '', degraded: false };
    return { ok: false, error: read.error };
  }
  const transformed = applyTransforms(read.raw, spec.extract.transforms);
  if (transformed === '' && spec.required) {
    return { ok: false, error: `extraction for "${spec.name}" produced an empty string from ${JSON.stringify(read.raw)}`, raw: read.raw };
  }
  const coerced = coerce(transformed, spec.type);
  if (!coerced.ok) return { ok: false, error: `output "${spec.name}": ${coerced.error}`, raw: read.raw };
  return { ok: true, value: coerced.value, raw: read.raw, degraded: read.degraded };
}
