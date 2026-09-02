/**
 * App profiles: what we know about a vendor product, independent of any one flow.
 *
 * The key move for the multi-tenant story. Session expiry, the maintenance
 * interstitial, the CT-500 error page and the SEC-4031 refusal are properties of
 * CORETELLER, not of "read a savings balance". Recording them per flow means
 * re-discovering the same four quirks across ~20 capabilities per app, times
 * hundreds of tenants, and getting them subtly inconsistent each time. So they
 * live once, on the profile, and the compiler merges them into every capability
 * recorded against that product; a tenant whose build differs overrides the one
 * entry via `tenant.overrides` rather than forking the flow.
 *
 * The detectors here are text matches, which is as fragile as it sounds across
 * localisation and vendor versions -- a real limit, discussed in REPORT.md. The
 * mitigation is that they are data, so a correction is a reviewed JSON edit.
 */

import { has, re } from '../surface/types.ts';
import type { RiskPatternOverrides } from '../policy/policy.ts';
import type { Assertion, BusinessOutcome, FailureSignature, Recovery } from './schema.ts';

export type AppProfile = {
  readonly id: string;
  readonly title: string;
  readonly vendor: string;
  /** Merged into every capability recorded against this product. */
  readonly recoveries: readonly Recovery[];
  readonly failureSignatures: readonly FailureSignature[];
  /** Outcomes common to every screen, e.g. a global permission refusal. */
  readonly commonOutcomes: readonly BusinessOutcome[];
  /** Capability that re-establishes a session, used by the auth recovery. */
  readonly signOnCapabilityKey: string;
  /**
   * Per-product risk vocabulary. Merged over the deployment's list rather than
   * replacing it, so a product opts out of one verb instead of restating the rest.
   */
  readonly riskPatterns?: RiskPatternOverrides;
  /**
   * Text that only ever appears on this product's error screen. Added to every
   * success condition as a `text_absent` clause, because a success condition
   * that can also hold on an error page is not a success condition. Per-product
   * rather than global: asserting the absence of a CORETELLER error code on a
   * storefront is a clause that can never fail and never means anything.
   */
  readonly errorBanner?: string;
  /** Recorded into every artifact's provenance. What the reader needs to know
   *  about the data the recording ran against. */
  readonly recordingNote?: string;
};

const sessionExpired: Assertion = {
  kind: 'all',
  of: [
    { kind: 'text_present', text: has('Your session has expired') },
    { kind: 'element_present', target: { role: 'button', name: { op: 'equals', value: 'Sign On' }, strategies: [{ kind: 'role_name' }] } },
  ],
};

export const CORETELLER_PROFILE: AppProfile = {
  id: 'coreteller',
  title: 'CORETELLER core banking (fixture)',
  vendor: 'Fiservish Systems (fixture)',
  signOnCapabilityKey: 'coreteller.sign-on',
  errorBanner: 'CT-500',
  recordingNote: 'Recorded against the CORETELLER fixture in fixtures/legacy-bank. All data is synthetic.',

  recoveries: [
    {
      id: 'reauthenticate',
      title: 'Session expired; sign on again and retry the step',
      // Detected by BOTH the message and the sign-on control: the message alone
      // matches a page that merely mentions the phrase, and the control alone
      // matches the login screen at the start of a run.
      detect: sessionExpired,
      remedy: { kind: 'run_capability', key: 'coreteller.sign-on' },
      maxAttempts: 1,
      atSteps: [],
      // Signing back on lands on the teller desktop, not mid-inquiry, so
      // retrying the interrupted step would click a control that is gone. A read
      // capability starts over; a write capability escalates instead.
      resume: 'restart_capability',
    },
    {
      id: 'dismiss-maintenance-notice',
      title: 'Dismiss the scheduled-maintenance interstitial',
      detect: {
        kind: 'all',
        of: [
          { kind: 'text_present', text: has('Scheduled maintenance') },
          { kind: 'element_present', target: { role: 'button', name: { op: 'equals', value: 'Continue' }, strategies: [{ kind: 'role_name' }] } },
        ],
      },
      remedy: {
        kind: 'actions',
        steps: [
          {
            id: 'click-continue',
            intent: 'dismiss the maintenance notice and return to the requested screen',
            action: { kind: 'click', target: { role: 'button', name: { op: 'equals', value: 'Continue' }, strategies: [{ kind: 'role_name' }] } },
            timeoutMs: 8_000,
            risk: 'safe',
            optional: false,
            expect: { kind: 'text_absent', text: has('Scheduled maintenance') },
          },
        ],
      },
      maxAttempts: 2,
      atSteps: [],
      resume: 'retry_step',
    },
    {
      id: 'wait-out-blank-screen',
      title: 'The screen rendered nothing; give a slow core time to answer',
      // Ordinary slowness is NOT handled here: every gate and checkpoint polls
      // to its own timeout, so a slow core is absorbed by the step budget and
      // never reaches triage. This backstop covers the narrower case where the
      // app served an empty document. Two attempts, then escalate.
      detect: { kind: 'not', of: { kind: 'text_present', text: re('.') } },
      remedy: { kind: 'wait', ms: 2_000 },
      maxAttempts: 2,
      atSteps: [],
      resume: 'retry_step',
    },
  ],

  failureSignatures: [
    {
      code: 'CORE_SYSTEM_ERROR',
      title: 'The core returned an unexpected system error',
      detect: { kind: 'text_present', text: has('CT-500') },
      failureClass: 'app_error',
      data: [
        {
          name: 'coreErrorDetail',
          type: 'string',
          description: 'The core\'s own error detail, needed to raise a vendor ticket.',
          required: false,
          sensitivity: 'public',
          extract: {
            target: {
              role: 'cell',
              container: ['content'],
              strategies: [
                {
                  kind: 'relative',
                  anchor: { role: 'cell', name: { op: 'equals', value: 'Detail' }, container: ['content'], strategies: [{ kind: 'role_name' }] },
                  direction: 'right_of',
                  maxDistancePx: 600,
                },
              ],
            },
            property: 'text',
            transforms: [{ op: 'trim' }],
          },
        },
      ],
    },
  ],

  commonOutcomes: [
    {
      // "No matching records" is how the CORETELLER inquiry screen answers a
      // query that finds nothing, so every inquiry capability inherits it.
      code: 'MEMBER_NOT_FOUND',
      title: 'No member exists for the supplied member number',
      description:
        'The inquiry completed and the core returned no matching record. This is a legitimate answer, not an error: the caller should tell the user the number is unknown rather than retry.',
      detect: { kind: 'text_present', text: has('NO MATCHING RECORDS FOUND') },
      afterSteps: [],
      data: [],
      severity: 'info',
    },
    {
      // Every CORETELLER maintenance form rejects the same way. An OUTCOME, not
      // a failure signature: the request was understood and refused on its
      // merits, so the caller can fix its inputs. A CT-500 is the opposite.
      code: 'REQUEST_REJECTED',
      title: 'The core rejected the request on validation grounds',
      description:
        'Server-side validation refused the request. `validationMessages` carries the core\'s own wording, which the caller should surface rather than paraphrase.',
      detect: { kind: 'text_present', text: has('The request could not be completed') },
      afterSteps: [],
      data: [
        {
          name: 'validationMessages',
          type: 'string',
          description: 'The validation messages exactly as the core worded them.',
          required: false,
          sensitivity: 'public',
          extract: {
            target: { role: 'text', container: ['content'], strategies: [{ kind: 'text', text: re('^VAL-') }] },
            property: 'text',
            transforms: [{ op: 'trim' }],
          },
        },
      ],
      severity: 'warning',
    },
    {
      code: 'MEMBER_RESTRICTED',
      title: 'The signed-on operator is not authorised to view this member',
      description: 'The record exists but is restricted to a higher permission level. Retrying will not help; the caller should route to a supervisor.',
      detect: { kind: 'text_present', text: has('SEC-4031') },
      afterSteps: [],
      data: [],
      severity: 'warning',
    },
  ],
};


/**
 * Sauce Labs' demo storefront -- the second, not-self-built surface.
 *
 * A fixture I wrote myself invites the objection that the app was shaped around
 * the solution. This one I did not write and could not change.
 *
 * What it shows that CORETELLER cannot:
 *   - the ladder behaving as a ladder. Six buttons share the accessible name
 *     "Add to cart", so `role_name` is ambiguous and falls through to `test_id`,
 *     which is exact -- and the capability then declares `any_web`, honestly.
 *   - a modern DOM. Framesets, layout tables and nameless controls are absent,
 *     and the same recorder handles both without being told which it faces.
 *
 * What CORETELLER still has to cover: no public site lets you arm a session
 * expiry, a permission denial or a core 500 on demand.
 *
 * The two outcomes below need no fault injection -- Sauce Labs ships
 * deliberately broken users, so these are real answers on somebody else's app.
 */
export const SAUCEDEMO_PROFILE: AppProfile = {
  id: 'saucedemo',
  title: 'Swag Labs demo storefront (Sauce Labs)',
  vendor: 'Sauce Labs',
  // No sign-on capability to compose with: this app has no session-expiry
  // behaviour, so the key does not exist and the compiler's self-reference
  // filter leaves the recovery list empty.
  signOnCapabilityKey: 'saucedemo.sign-in',
  recordingNote: "Recorded against Sauce Labs' public demo storefront -- an application this project did not write and cannot change. The credentials are the ones printed on its own login page.",

  // "Remove" takes an item back out of a basket here. On a core banking screen
  // the same word removes an authorised signer. One global list cannot serve both.
  riskPatterns: { notIrreversible: ['remove', 'delete'] },

  recoveries: [],

  failureSignatures: [
    {
      code: 'STOREFRONT_ERROR',
      title: 'The storefront reported an error it could not recover from',
      detect: { kind: 'text_present', text: has('Sorry, this page could not be found') },
      failureClass: 'app_error',
      data: [],
    },
  ],

  commonOutcomes: [
    {
      code: 'USER_LOCKED_OUT',
      title: 'The account is locked and cannot sign in',
      description:
        'A legitimate answer, not an error: the credentials are correct and the account is administratively locked. Retrying will not help; the caller needs to route to whoever can unlock it.',
      detect: { kind: 'text_present', text: has('this user has been locked out') },
      afterSteps: [],
      data: [],
      severity: 'warning',
    },
    {
      code: 'CREDENTIALS_REJECTED',
      title: 'The storefront rejected the supplied credentials',
      description: 'Sign-in failed on the credentials themselves. The caller should not retry with the same pair.',
      detect: { kind: 'text_present', text: has('do not match any user in this service') },
      afterSteps: [],
      data: [],
      severity: 'warning',
    },
  ],
};

export const PROFILES: Record<string, AppProfile> = {
  coreteller: CORETELLER_PROFILE,
  saucedemo: SAUCEDEMO_PROFILE,
};

export function profileFor(id: string): AppProfile | undefined {
  return PROFILES[id];
}
