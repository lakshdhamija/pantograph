/**
 * Scripted planner -- the mocked side of the planner boundary.
 *
 * The brief says: if you cannot get a live model working for part of the task,
 * mock the boundary cleanly and document it. This is that mock, and it is
 * deliberately a real `Planner`, not a bypass. Discovery with `--mock-llm`
 * exercises every other component for real: the same guarded surface, the same
 * perception, the same descriptor synthesis, the same compiler, the same
 * evidence. Only the "which control next" decision is scripted.
 *
 * It is written as CONDITION -> ACTION rules evaluated against the rendered
 * screen, not as a fixed list of steps, so it still has to cope with whatever
 * the app actually shows it -- including an unexpected dialog or an interstitial
 * appearing mid-flow. A straight-line script would quietly hide those.
 *
 * What this is NOT: evidence that a model can discover these flows. That claim
 * requires a live run, which is what `discover` does without `--mock-llm`.
 */

import type { Planner, PlannerRequest, PlannerResponse, PlannerToolCall } from './types.ts';

export type Rule = {
  readonly id: string;
  readonly when: (req: PlannerRequest) => boolean;
  readonly calls: (req: PlannerRequest) => PlannerToolCall[];
};

const screenHas = (req: PlannerRequest, ...needles: string[]) => needles.every((n) => req.screen.includes(n));
const already = (req: PlannerRequest, marker: string) => req.history.some((h) => h.includes(marker));

/** Pull a control's handle out of the rendered screen by its printed label. */
function refByName(req: PlannerRequest, role: string, name: string): string | undefined {
  const line = req.screen.split('\n').find((l) => l.trimStart().startsWith(`${role} "${name}"`) && l.includes('ref='));
  return line?.match(/ref=(\S+)$/)?.[1];
}

/**
 * The nameless-control case. The screen dump prints `(NO ACCESSIBLE NAME)` for
 * these, so the planner finds them positionally -- the first unnamed control of
 * a role after a line containing a given label -- exactly the reasoning a model
 * has to do, and exactly what the descriptor synthesiser then formalises.
 */
function refNearLabel(req: PlannerRequest, label: string, role: string): string | undefined {
  const lines = req.screen.split('\n');
  const at = lines.findIndex((l) => l.includes(`"${label}"`));
  if (at < 0) return undefined;
  for (let i = at; i < Math.min(lines.length, at + 6); i++) {
    const l = lines[i]!;
    if (l.trimStart().startsWith(role) && /\b(ref|read)=/.test(l)) return l.match(/(?:ref|read)=(\S+)$/)?.[1];
  }
  return undefined;
}

/**
 * The ref of the first cell AFTER the cell whose text matches -- the value beside
 * a label, or the next column in a table row. This is the reasoning a model does
 * when it reads a table; the descriptor synthesiser then turns the chosen node
 * into a durable relational locator.
 */
function refInNextCell(req: PlannerRequest, cellText: string): string | undefined {
  const lines = req.screen.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith('cell "') && l.includes(`"${cellText}"`));
  if (at < 0) return undefined;
  for (let i = at + 1; i < Math.min(lines.length, at + 3); i++) {
    const l = lines[i]!;
    if (l.trimStart().startsWith('cell') && l.includes('read=')) return l.match(/read=(\S+)$/)?.[1];
  }
  return undefined;
}

function param(req: PlannerRequest, name: string): string | undefined {
  return req.parameters.find((p) => p.name === name)?.value;
}

/** Rules shared by every goal against the CORETELLER fixture. */
function commonRules(): Rule[] {
  return [
    {
      id: 'answer-unexpected-dialog',
      when: (req) => req.screen.includes('DIALOG IS OPEN'),
      calls: () => [{ name: 'act', input: { intent: 'confirm the action the application asked me to confirm', kind: 'answer_dialog', accept: true } }],
    },
    {
      id: 'dismiss-maintenance-interstitial',
      when: (req) => screenHas(req, 'System Notice', 'Continue'),
      calls: (req) => [{ name: 'act', input: { intent: 'dismiss the system maintenance notice', kind: 'click', ref: refByName(req, 'button', 'Continue') } }],
    },
    {
      id: 'sign-on',
      when: (req) => screenHas(req, 'Operator ID', 'Sign On'),
      calls: (req) => [
        { name: 'act', input: { intent: 'enter the operator id', kind: 'fill', ref: refByName(req, 'textbox', 'Operator ID'), value: param(req, 'operatorId') ?? 'teller01', parameter: 'operatorId' } },
        { name: 'act', input: { intent: 'enter the operator password', kind: 'fill', ref: refByName(req, 'textbox', 'Password'), value: param(req, 'operatorPassword') ?? '', parameter: 'operatorPassword' } },
        { name: 'act', input: { intent: 'submit the sign-on form', kind: 'click', ref: refByName(req, 'button', 'Sign On') } },
      ],
    },
    {
      id: 'declare-not-found',
      when: (req) => req.screen.includes('NO MATCHING RECORDS FOUND') && !already(req, 'MEMBER_NOT_FOUND'),
      calls: () => [
        {
          name: 'declare_outcome',
          input: {
            code: 'MEMBER_NOT_FOUND',
            title: 'No member exists for the supplied member number',
            description: 'The inquiry completed and the core returned no matching record. A legitimate answer, not an error.',
            detectText: 'NO MATCHING RECORDS FOUND',
            severity: 'info',
          },
        },
      ],
    },
    {
      id: 'declare-permission-denied',
      when: (req) => req.screen.includes('SEC-4031') && !already(req, 'MEMBER_RESTRICTED'),
      calls: () => [
        {
          name: 'declare_outcome',
          input: {
            code: 'MEMBER_RESTRICTED',
            title: 'The signed-on operator is not authorised to view this member',
            description: 'The record exists but is restricted. The caller needs to route this to a supervisor rather than retry.',
            detectText: 'SEC-4031',
            severity: 'warning',
          },
        },
      ],
    },
  ];
}

function searchRules(): Rule[] {
  return [
    {
      id: 'open-member-inquiry',
      // Guarded on what the CONTENT frame shows, not on the nav link, which is
      // present on every screen. Keying off the menu alone makes this rule fire
      // forever once the menu is visible.
      when: (req) =>
        req.screen.includes('link "Member Inquiry"') &&
        // Only from a screen that is not already part of a flow. Keying off the
        // menu alone makes this rule fire forever, and worse, navigate away from
        // a half-filled form.
        !req.screen.includes('Member Number') &&
        !req.screen.includes('Account Holder ID') &&
        !req.screen.includes('Inquiry Results') &&
        !req.screen.includes('Member Detail') &&
        !req.screen.includes('Product Code') &&
        !req.screen.includes('Request Confirmed') &&
        !req.screen.includes('NO MATCHING'),
      calls: (req) => [{ name: 'act', input: { intent: 'open the member inquiry screen from the menu', kind: 'click', ref: refByName(req, 'link', 'Member Inquiry') } }],
    },
    {
      id: 'type-member-number',
      when: (req) =>
        (req.screen.includes('Member Number') || req.screen.includes('Account Holder ID')) &&
        (req.screen.includes('button "Go"') || req.screen.includes('button "Search"')),
      calls: (req) => {
        const label = req.screen.includes('Account Holder ID') ? 'Account Holder ID' : 'Member Number';
        const submit = refByName(req, 'button', 'Go') ?? refByName(req, 'button', 'Search');
        return [
          { name: 'act', input: { intent: 'type the member number into the inquiry field', kind: 'fill', ref: refNearLabel(req, label, 'textbox'), value: param(req, 'memberId') ?? '', parameter: 'memberId' } },
          { name: 'act', input: { intent: 'run the member inquiry', kind: 'click', ref: submit } },
        ];
      },
    },
    {
      id: 'open-member-from-results',
      when: (req) => req.screen.includes('Inquiry Results'),
      calls: (req) => {
        const id = param(req, 'memberId') ?? '';
        return [{ name: 'act', input: { intent: 'open the member record from the results list', kind: 'click', ref: refByName(req, 'link', id), parameter: 'memberId' } }];
      },
    },
  ];
}

/**
 * Sign-on as a capability in its own right. It exists so the `reauthenticate`
 * recovery has something to invoke: when a replay loses its session mid-flow,
 * the engine runs this capability against the SAME live browser context, then
 * retries the step that was interrupted. Capability composition, rather than a
 * hardcoded login routine buried in the engine.
 */
export const SIGN_ON_RULES: Rule[] = [
  ...commonRules(),
  {
    id: 'confirm-signed-on',
    when: (req) => req.screen.includes('link "Member Inquiry"'),
    calls: () => [
      { name: 'finish', input: { summary: 'Signed on and reached the teller desktop.', successText: 'Member Inquiry' } },
    ],
  },
];

export const READ_BALANCE_RULES: Rule[] = [
  ...commonRules(),
  ...searchRules(),
  {
    id: 'declare-balance-and-finish',
    when: (req) => screenHas(req, 'Member Detail', 'REGULAR SHARE (SAVINGS)'),
    calls: (req) => {
      // The balance is the cell immediately right of the product cell in the
      // savings row; the member name is the cell right of the "Name" label.
      const balanceRef = refInNextCell(req, 'REGULAR SHARE (SAVINGS)');
      const nameRef = refInNextCell(req, 'Name');
      const calls: PlannerToolCall[] = [];
      if (balanceRef) {
        calls.push({ name: 'declare_output', input: { name: 'savingsBalance', type: 'money', description: 'Current balance of the member regular share (savings) account.', ref: balanceRef, property: 'text', sensitivity: 'public' } });
      }
      if (nameRef) {
        calls.push({ name: 'declare_output', input: { name: 'memberName', type: 'string', description: 'Name on the member record, for the caller to confirm it read the right person.', ref: nameRef, property: 'text', sensitivity: 'pii' } });
      }
      calls.push({ name: 'finish', input: { summary: 'Reached the member detail screen and located the regular share savings balance.', successText: 'Share / Deposit Accounts' } });
      return calls;
    },
  },
];

/**
 * Rule order is priority order. The most specific screen wins, and the generic
 * "go to the menu" rules come last -- otherwise a menu link that is visible on
 * every screen navigates away from a half-filled form.
 */
export const OPEN_SUBACCOUNT_RULES: Rule[] = [
  ...commonRules(),
  {
    id: 'open-subaccount-form',
    when: (req) => req.screen.includes('Member Detail') && (req.screen.includes('link "Open Sub-Account"') || req.screen.includes('link "New Sub-Account"')),
    calls: (req) => [
      {
        name: 'act',
        input: {
          intent: 'start a new sub-account request for this member',
          kind: 'click',
          ref: refByName(req, 'link', 'Open Sub-Account') ?? refByName(req, 'link', 'New Sub-Account'),
        },
      },
    ],
  },
  {
    id: 'fill-subaccount-form',
    when: (req) => req.screen.includes('Product Code') && req.screen.includes('button "Submit Request"'),
    calls: (req) => {
      const calls: PlannerToolCall[] = [
        { name: 'act', input: { intent: 'choose the product code for the new sub-account', kind: 'select', ref: refByName(req, 'combobox', 'Product Code'), value: param(req, 'productCode') ?? 'S06', parameter: 'productCode' } },
        { name: 'act', input: { intent: 'enter the opening deposit amount', kind: 'fill', ref: refNearLabel(req, 'Opening Deposit', 'textbox'), value: param(req, 'openingDeposit') ?? '100.00', parameter: 'openingDeposit' } },
      ];
      const branchRef = refNearLabel(req, 'Branch Code', 'textbox');
      if (branchRef) {
        calls.push({ name: 'act', input: { intent: 'enter the branch code this institution requires', kind: 'fill', ref: branchRef, value: param(req, 'branchCode') ?? '002', parameter: 'branchCode' } });
      }
      calls.push({ name: 'act', input: { intent: 'submit the new sub-account request', kind: 'click', ref: refByName(req, 'button', 'Submit Request') } });
      return calls;
    },
  },
  {
    id: 'declare-validation-outcome',
    when: (req) => req.screen.includes('The request could not be completed') && !already(req, 'REQUEST_REJECTED'),
    calls: () => [
      {
        name: 'declare_outcome',
        input: {
          code: 'REQUEST_REJECTED',
          title: 'The core rejected the sub-account request',
          description: 'Server-side validation refused the request. The message names the reason; the caller must correct its inputs.',
          detectText: 'The request could not be completed',
          severity: 'warning',
        },
      },
    ],
  },
  {
    id: 'read-confirmation',
    when: (req) => screenHas(req, 'Request Confirmed', 'Confirmation Reference'),
    calls: (req) => {
      const refRef = refInNextCell(req, 'Confirmation Reference');
      const acctRef = refInNextCell(req, 'New Account Number');
      const calls: PlannerToolCall[] = [];
      if (refRef) calls.push({ name: 'declare_output', input: { name: 'confirmationReference', type: 'string', description: 'Reference the core issued for the sub-account request.', ref: refRef, property: 'text' } });
      if (acctRef) calls.push({ name: 'declare_output', input: { name: 'newAccountNumber', type: 'string', description: 'Account number assigned to the new sub-account.', ref: acctRef, property: 'text' } });
      calls.push({ name: 'finish', input: { summary: 'Submitted the sub-account request and reached the confirmation screen.', successText: 'Request Confirmed' } });
      return calls;
    },
  },
  ...searchRules(),
];

export class ScriptedPlanner implements Planner {
  readonly provider = 'scripted';
  readonly model: string;
  private readonly rules: readonly Rule[];
  private readonly fired: string[] = [];

  constructor(rules: readonly Rule[], label = 'scripted-planner') {
    this.rules = rules;
    this.model = label;
  }

  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    for (const rule of this.rules) {
      if (!rule.when(req)) continue;
      const calls = rule.calls(req).filter((c) => c.name !== 'act' || validAct(c));
      if (!calls.length) continue;
      // A rule that fires twice in a row means the screen did not change; that
      // is a genuine stuck state and should escalate rather than loop.
      if (this.fired.at(-1) === rule.id && this.fired.at(-2) === rule.id) {
        return { reasoning: `rule "${rule.id}" fired three times without progress`, calls: [{ name: 'give_up', input: { reason: `no progress after repeating "${rule.id}"; the screen is not changing as expected` } }] };
      }
      this.fired.push(rule.id);
      return { reasoning: `rule "${rule.id}"`, calls };
    }
    return {
      reasoning: 'no rule matched the current screen',
      calls: [{ name: 'give_up', input: { reason: `the scripted planner has no rule for this screen (${req.location})` } }],
    };
  }
}

function validAct(call: PlannerToolCall): boolean {
  if (call.name !== 'act') return true;
  const i = call.input;
  if (['click', 'fill', 'select'].includes(i.kind)) return Boolean(i.ref);
  return true;
}

/**
 * The button inside a named product's own card, with the label it currently
 * carries. Six cards share the label "Add to cart", and adding one swaps that
 * card's button to "Remove" in place, so both the rule guard and the click have
 * to be scoped to the product rather than to the label.
 */
function productButton(req: PlannerRequest, product: string): { ref?: string; label?: string } {
  const lines = req.screen.split('\n');
  const at = lines.findIndex((l) => l.includes(`"${product}"`) && l.trimStart().startsWith('link'));
  if (at < 0) return {};
  for (let i = at + 1; i < Math.min(lines.length, at + 5); i++) {
    const l = lines[i]!;
    if (!l.trimStart().startsWith('button')) continue;
    return { ref: l.match(/ref=(\S+)$/)?.[1], label: l.match(/button "([^"]*)"/)?.[1] };
  }
  return {};
}

export const SAUCEDEMO_RULES: Rule[] = [
  {
    id: 'sign-in',
    when: (req) => req.screen.includes('textbox "Username"'),
    calls: (req) => [
      { name: 'act', input: { intent: 'enter the storefront username', kind: 'fill', ref: refByName(req, 'textbox', 'Username'), value: param(req, 'username') ?? 'standard_user', parameter: 'username' } },
      { name: 'act', input: { intent: 'enter the storefront password', kind: 'fill', ref: refByName(req, 'textbox', 'Password'), value: param(req, 'password') ?? '', parameter: 'password' } },
      { name: 'act', input: { intent: 'sign in to the storefront', kind: 'click', ref: refByName(req, 'button', 'Login') } },
    ],
  },
  {
    id: 'declare-locked-out',
    when: (req) => req.screen.includes('locked out') && !already(req, 'USER_LOCKED_OUT'),
    calls: () => [
      {
        name: 'declare_outcome',
        input: {
          code: 'USER_LOCKED_OUT',
          title: 'The account is locked and cannot sign in',
          description: 'Correct credentials, administratively locked account. Retrying will not help.',
          detectText: 'this user has been locked out',
          severity: 'warning',
        },
      },
    ],
  },
  {
    id: 'add-the-requested-product',
    when: (req) =>
      req.screen.includes('/inventory.html') &&
      productButton(req, param(req, 'productName') ?? 'Sauce Labs Backpack').label === 'Add to cart',
    calls: (req) => {
      const product = param(req, 'productName') ?? 'Sauce Labs Backpack';
      return [{ name: 'act', input: { intent: `add ${product} to the cart`, kind: 'click', ref: productButton(req, product).ref, parameter: 'productName' } }];
    },
  },
  {
    id: 'open-the-cart',
    when: (req) =>
      req.screen.includes('/inventory.html') &&
      productButton(req, param(req, 'productName') ?? 'Sauce Labs Backpack').label === 'Remove',
    calls: (req) => [{ name: 'act', input: { intent: 'open the shopping cart', kind: 'click', ref: refByName(req, 'link', '1') } }],
  },
  {
    id: 'start-checkout',
    when: (req) => req.screen.includes('/cart.html'),
    calls: (req) => [{ name: 'act', input: { intent: 'begin checkout', kind: 'click', ref: refByName(req, 'button', 'Checkout') } }],
  },
  {
    id: 'fill-checkout-details',
    when: (req) => req.screen.includes('/checkout-step-one.html'),
    calls: (req) => [
      { name: 'act', input: { intent: 'enter the first name', kind: 'fill', ref: refByName(req, 'textbox', 'First Name'), value: param(req, 'firstName') ?? 'Ada', parameter: 'firstName' } },
      { name: 'act', input: { intent: 'enter the last name', kind: 'fill', ref: refByName(req, 'textbox', 'Last Name'), value: param(req, 'lastName') ?? 'Lovelace', parameter: 'lastName' } },
      { name: 'act', input: { intent: 'enter the postal code', kind: 'fill', ref: refByName(req, 'textbox', 'Zip/Postal Code'), value: param(req, 'postalCode') ?? '02115', parameter: 'postalCode' } },
      { name: 'act', input: { intent: 'continue to the order review', kind: 'click', ref: refByName(req, 'button', 'Continue') } },
    ],
  },
  {
    id: 'read-the-review-total',
    when: (req) => req.screen.includes('/checkout-step-two.html'),
    calls: (req) => {
      const totalRef = req.screen.split('\n').find((l) => l.includes('Total: $'))?.match(/read=(\S+)$/)?.[1];
      const calls: PlannerToolCall[] = [];
      if (totalRef) {
        calls.push({ name: 'declare_output', input: { name: 'orderTotal', type: 'money', description: 'Order total including tax, as shown on the review page.', ref: totalRef, property: 'text', sensitivity: 'public' } });
      }
      calls.push({ name: 'finish', input: { summary: 'Added the product and reached the checkout review page.', successText: 'Payment Information' } });
      return calls;
    },
  },
];

export const SCRIPTED_RULE_SETS: Record<string, Rule[]> = {
  'sign-on': SIGN_ON_RULES,
  'saucedemo-checkout': SAUCEDEMO_RULES,
  'read-savings-balance': READ_BALANCE_RULES,
  'open-sub-account': OPEN_SUBACCOUNT_RULES,
};
