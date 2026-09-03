/**
 * The agent-facing view of the catalog.
 *
 * A capability artifact already carries a typed input and output contract, so
 * projecting it into JSON Schema -- and from there into a tool definition an
 * LLM can be handed directly -- is a rendering job, not a new abstraction. That
 * is the point: the artifact was designed as a callable contract, so the
 * agent-facing surface falls out of it rather than being bolted on.
 *
 * Two policy decisions are enforced in this projection, not left to the caller:
 *   - a capability in `draft` is not offered for unattended invocation
 *   - a capability whose risk tier is irreversible is advertised as requiring
 *     approval, so a calling agent knows before it calls that a human is in the
 *     path
 */

import type { Capability, ParamSpec, OutputSpec, ValueType } from '../artifact/schema.ts';
import { capabilityRisk } from '../replay/outcomes.ts';

export type JsonSchema = Record<string, unknown>;

const JSON_TYPE: Record<ValueType, string> = {
  string: 'string',
  enum: 'string',
  date: 'string',
  boolean: 'boolean',
  integer: 'integer',
  number: 'number',
  money: 'number',
};

function paramSchema(p: ParamSpec): JsonSchema {
  const s: JsonSchema = { type: JSON_TYPE[p.type], description: p.description };
  if (p.enum?.length) s['enum'] = p.enum;
  if (p.pattern) s['pattern'] = p.pattern;
  if (p.minimum !== undefined) s['minimum'] = p.minimum;
  if (p.maximum !== undefined) s['maximum'] = p.maximum;
  if (p.example !== undefined) s['examples'] = [p.example];
  if (p.sensitivity !== 'public') {
    // Advertised so a calling agent knows not to log the value it passes, and
    // so a human reading the catalog knows this field carries regulated data.
    s['x-sensitivity'] = p.sensitivity;
    s['writeOnly'] = true;
  }
  return s;
}

function outputSchema(o: OutputSpec): JsonSchema {
  const s: JsonSchema = { type: JSON_TYPE[o.type], description: o.description };
  if (o.sensitivity !== 'public') s['x-sensitivity'] = o.sensitivity;
  return s;
}

export function inputSchemaFor(cap: Capability): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(cap.inputs.map((p) => [p.name, paramSchema(p)])),
    required: cap.inputs.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

/**
 * The result schema is a discriminated union on `status`, mirroring
 * ReplayResult exactly. A calling agent that generates code against this cannot
 * accidentally read `outputs` off a business outcome.
 */
export function resultSchemaFor(cap: Capability): JsonSchema {
  return {
    oneOf: [
      {
        type: 'object',
        title: 'success',
        properties: {
          status: { const: 'success' },
          outputs: {
            type: 'object',
            properties: Object.fromEntries(cap.outputs.map((o) => [o.name, outputSchema(o)])),
            required: cap.outputs.filter((o) => o.required).map((o) => o.name),
          },
        },
        required: ['status', 'outputs'],
      },
      {
        type: 'object',
        title: 'business_outcome',
        description: 'A legitimate non-happy answer from the application. Not an error; retrying will not change it.',
        properties: {
          status: { const: 'business_outcome' },
          outcome: {
            type: 'object',
            properties: {
              code: { enum: cap.outcomes.map((o) => o.code) },
              title: { type: 'string' },
              severity: { enum: ['info', 'warning'] },
            },
          },
        },
        required: ['status', 'outcome'],
      },
      {
        type: 'object',
        title: 'escalated',
        description: 'A human operator was required. The decision they made is reported.',
        properties: { status: { const: 'escalated' }, intervention: { type: 'object' } },
        required: ['status', 'intervention'],
      },
      {
        type: 'object',
        title: 'failed',
        description: 'The automation, the application, or the environment is broken. Includes the step and what was observed.',
        properties: { status: { const: 'failed' }, failure: { type: 'object' } },
        required: ['status', 'failure'],
      },
    ],
  };
}

export type CatalogEntry = {
  readonly name: string;
  readonly key: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly tenant: string;
  readonly appProfile: string;
  readonly approval: string;
  readonly riskTier: string;
  readonly requiresHumanApproval: boolean;
  readonly invocable: boolean;
  readonly notInvocableReason?: string;
  readonly outcomes: ReadonlyArray<{ code: string; title: string; severity: string }>;
  readonly inputSchema: JsonSchema;
  readonly resultSchema: JsonSchema;
  readonly stability: Capability['stability'];
};

/** Tool names have to be a safe identifier; dots and dashes are not. */
export function toolNameFor(cap: Capability): string {
  return cap.key.replace(/[.-]/g, '_');
}

export function catalogEntry(cap: Capability): CatalogEntry {
  const risk = capabilityRisk(cap);
  const invocable = cap.approval.state === 'approved';
  return {
    name: toolNameFor(cap),
    key: cap.key,
    version: cap.version,
    title: cap.title,
    description: cap.description,
    tenant: cap.tenant.id,
    appProfile: cap.app.profile,
    approval: cap.approval.state,
    riskTier: risk,
    requiresHumanApproval: cap.policy.requiresHumanApproval,
    invocable,
    notInvocableReason: invocable
      ? undefined
      : cap.approval.state === 'draft'
        ? 'this capability is still in draft; a reviewer must approve it before unattended invocation'
        : 'this capability is deprecated',
    outcomes: cap.outcomes.map((o) => ({ code: o.code, title: o.title, severity: o.severity })),
    inputSchema: inputSchemaFor(cap),
    resultSchema: resultSchemaFor(cap),
    stability: cap.stability,
  };
}

/**
 * An Anthropic tool definition, ready to paste into a `tools` array. The
 * description tells the calling model the two things it will otherwise get
 * wrong: that a business outcome is data rather than an error, and that an
 * irreversible capability will pause for a human.
 */
export function toolDefinitionFor(cap: Capability): Record<string, unknown> {
  const outcomeLines = cap.outcomes.map((o) => `  - ${o.code}: ${o.title}`).join('\n');
  return {
    name: toolNameFor(cap),
    description: [
      cap.description,
      '',
      `Returns status="success" with typed outputs (${cap.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || 'none'}).`,
      cap.outcomes.length
        ? `May instead return status="business_outcome" with one of these codes. These are legitimate answers, not errors, and retrying will not change them:\n${outcomeLines}`
        : '',
      cap.policy.requiresHumanApproval
        ? 'This capability writes to a system of record and will pause for a human operator to approve before it completes.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    input_schema: inputSchemaFor(cap),
  };
}
