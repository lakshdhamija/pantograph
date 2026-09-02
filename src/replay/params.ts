/**
 * Input validation and template resolution.
 *
 * Validation runs before the browser is touched. A caller that passes
 * memberId="abc" to a capability declaring `pattern: ^\d{6}$` gets
 * `input_invalid` in milliseconds, with no side effects and no evidence noise --
 * rather than a mystery "element not found" three steps in, after the app has
 * already been driven halfway through a flow.
 */

import type { ParamSpec } from '../artifact/schema.ts';

export type ValidationIssue = { readonly param: string; readonly problem: string };

export type ValidatedInputs = { readonly ok: true; readonly values: Record<string, unknown> } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export function validateInputs(specs: readonly ParamSpec[], supplied: Record<string, unknown>): ValidatedInputs {
  const issues: ValidationIssue[] = [];
  const values: Record<string, unknown> = {};

  for (const spec of specs) {
    const raw = supplied[spec.name] ?? spec.default;
    if (raw === undefined || raw === '') {
      if (spec.required) issues.push({ param: spec.name, problem: 'required but not supplied' });
      continue;
    }
    const s = String(raw);

    switch (spec.type) {
      case 'integer':
      case 'number':
      case 'money': {
        const n = Number(s.replace(/,/g, ''));
        if (!Number.isFinite(n)) { issues.push({ param: spec.name, problem: `expected ${spec.type}, got ${JSON.stringify(s)}` }); continue; }
        if (spec.type === 'integer' && !Number.isInteger(n)) { issues.push({ param: spec.name, problem: `expected an integer, got ${JSON.stringify(s)}` }); continue; }
        if (spec.minimum !== undefined && n < spec.minimum) { issues.push({ param: spec.name, problem: `must be >= ${spec.minimum}` }); continue; }
        if (spec.maximum !== undefined && n > spec.maximum) { issues.push({ param: spec.name, problem: `must be <= ${spec.maximum}` }); continue; }
        values[spec.name] = n;
        break;
      }
      case 'boolean':
        values[spec.name] = /^(true|yes|y|1|on)$/i.test(s);
        break;
      case 'enum':
        if (spec.enum?.length && !spec.enum.includes(s)) {
          issues.push({ param: spec.name, problem: `must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}` });
          continue;
        }
        values[spec.name] = s;
        break;
      default:
        values[spec.name] = s;
    }

    if (spec.pattern && !new RegExp(spec.pattern).test(s)) {
      issues.push({ param: spec.name, problem: `does not match required pattern /${spec.pattern}/` });
      delete values[spec.name];
    }
  }

  const declared = new Set(specs.map((s) => s.name));
  for (const k of Object.keys(supplied)) {
    // Refusing unknown inputs is deliberate. Silently ignoring a typo'd
    // parameter name is how a caller ends up querying the wrong member.
    if (!declared.has(k)) issues.push({ param: k, problem: 'not declared by this capability' });
  }

  return issues.length ? { ok: false, issues } : { ok: true, values };
}

export type TemplateScope = {
  readonly inputs: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly outputs?: Record<string, unknown>;
};

const TOKEN = /\{\{\s*(inputs|env|outputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export class TemplateError extends Error {}

/** Strict: an unresolved reference is a capability bug, not an empty string. */
export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(TOKEN, (_m, ns: 'inputs' | 'env' | 'outputs', key: string) => {
    const bag = ns === 'inputs' ? scope.inputs : ns === 'env' ? scope.env : (scope.outputs ?? {});
    const v = bag[key];
    if (v === undefined) throw new TemplateError(`template references {{${ns}.${key}}} but it is not defined`);
    return String(v);
  });
}

