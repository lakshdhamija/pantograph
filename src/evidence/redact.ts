/**
 * Redaction. Applied at two chokepoints and nowhere else:
 *   - the evidence writer (everything that reaches disk)
 *   - the planner adapter (everything that reaches the model)
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *   Declared sensitivity  authoritative. A parameter marked `secret` never has
 *                         its value written or sent, full stop.
 *   Pattern scanning      a safety net for regulated data that shows up in
 *                         *observed* content, which nobody declared -- a tax ID
 *                         rendered on a member detail screen, for instance.
 *
 * Pattern scanning is best-effort by nature and is treated as such: it reduces
 * blast radius, it is not a compliance control. See REPORT.md ("Safety").
 */

import type { Sensitivity } from '../artifact/schema.ts';

export type RedactionRule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replace: (match: string) => string;
};

const keepLast = (n: number) => (m: string) => {
  const digits = m.replace(/\D/g, '');
  return digits.length <= n ? '[REDACTED]' : `[REDACTED:****${digits.slice(-n)}]`;
};

export const DEFAULT_RULES: readonly RedactionRule[] = [
  { id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: keepLast(4) },
  { id: 'ssn_compact', pattern: /\b(?!000)\d{9}\b(?=\s*(?:SSN|TIN|Tax))/gi, replace: keepLast(4) },
  { id: 'pan', pattern: /\b(?:\d[ -]?){13,19}\b/g, replace: (m) => (luhn(m) ? keepLast(4)(m) : m) },
  // A fixed-width card field pads on the left with zeros, which pushes the
  // number past 19 digits and out of the rule above. Legacy screens do this
  // constantly, so strip the padding before testing.
  { id: 'pan_zero_padded', pattern: /\b0{2,}\d{13,19}\b/g, replace: (m) => (luhn(m.replace(/^0+/, '')) ? keepLast(4)(m) : m) },
  // ABA routing numbers are nine digits with their own checksum. Without the
  // checksum this rule would redact every nine-digit number on the screen.
  { id: 'aba', pattern: /\b\d{9}\b/g, replace: (m) => (aba(m) ? '[REDACTED:ABA]' : m) },
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replace: () => 'Bearer [REDACTED]' },
  { id: 'api_key', pattern: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{12,}/gi, replace: () => '[REDACTED:KEY]' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => '[REDACTED:JWT]' },
  {
    id: 'password_kv',
    pattern: /\b(pass(?:word|wd)?|pwd|secret|token)\s*[=:]\s*("?)([^\s"&,;]{3,})\2/gi,
    replace: (m) => m.replace(/([=:]\s*"?)([^\s"&,;]{3,})/, '$1[REDACTED]'),
  },
  // The domain must not be all-numeric, or this eats the project's own version
  // strings: `member.open-sub-account@1.0.0.json` is an `@`, a dotted "domain"
  // and a letters-only "TLD", and redacting it corrupts every log line naming an
  // artifact. A false positive on a scanner is worse than a miss.
  {
    id: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@(?![\d.]+\b)[A-Za-z0-9.-]*[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/g,
    replace: (m) => `[REDACTED:EMAIL:${m.slice(0, 1)}***@${m.split('@')[1] ?? ''}]`,
  },
];

/** ABA checksum: 3,7,1 weighting over the nine digits, sum divisible by ten. */
function aba(candidate: string): boolean {
  const d = candidate.replace(/\D/g, '');
  if (d.length !== 9 || /^0{9}$/.test(d)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  return sum % 10 === 0;
}

function luhn(candidate: string): boolean {
  const d = candidate.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export class Redactor {
  private readonly rules: readonly RedactionRule[];
  /** Exact literal values (e.g. supplied secret inputs) scrubbed everywhere. */
  private readonly literals = new Set<string>();
  private hits = new Map<string, number>();

  constructor(rules: readonly RedactionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  /**
   * Register a concrete value that must never appear in output. Called with
   * every `secret`/`pii` input before a run starts, so even if the app echoes
   * the value back into the page, it cannot reach the log.
   */
  addLiteral(value: string | undefined): void {
    if (value && value.length >= 3) this.literals.add(value);
  }

  text(input: string): string {
    let out = input;
    for (const lit of this.literals) {
      if (out.includes(lit)) {
        this.count('literal');
        out = out.split(lit).join('[REDACTED:INPUT]');
      }
    }
    for (const rule of this.rules) {
      out = out.replace(rule.pattern, (m) => {
        const r = rule.replace(m);
        if (r !== m) this.count(rule.id);
        return r;
      });
    }
    return out;
  }

  /**
   * Would `text()` change this string? Asked of a node's name and value to
   * decide whether its pixels must be covered in a screenshot, so one policy
   * governs both media rather than two that can disagree.
   *
   * Runs the rules without counting hits: this is a question, not a redaction.
   */
  wouldRedact(input: string): boolean {
    if (!input) return false;
    for (const lit of this.literals) if (input.includes(lit)) return true;
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0;
      let changed = false;
      input.replace(rule.pattern, (m) => {
        if (rule.replace(m) !== m) changed = true;
        return m;
      });
      if (changed) return true;
    }
    return false;
  }

  /** Deep-clone with every string redacted. Keys are redacted too if telling. */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = /^(password|pass|pwd|secret|token|apiKey|api_key|authorization)$/i.test(k)
          ? '[REDACTED]'
          : this.walk(val);
      }
      return out;
    }
    return v;
  }

  private count(id: string): void {
    this.hits.set(id, (this.hits.get(id) ?? 0) + 1);
  }

  /** Summary for the run manifest, so redaction is auditable. */
  report(): Record<string, number> {
    return Object.fromEntries([...this.hits.entries()].sort());
  }
}

/**
 * Value masking driven by the artifact's declared sensitivity.
 * `secret` never round-trips at all; `pii` keeps a short suffix so a human
 * reviewer can still correlate a run with a record.
 */
export function maskBySensitivity(value: unknown, sensitivity: Sensitivity): unknown {
  if (sensitivity === 'public') return value;
  if (sensitivity === 'secret') return '[REDACTED:SECRET]';
  const s = String(value ?? '');
  if (s.length <= 4) return '[REDACTED:PII]';
  return `[REDACTED:PII:****${s.slice(-4)}]`;
}
