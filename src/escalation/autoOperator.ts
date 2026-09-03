/**
 * A scripted stand-in for a human operator.
 *
 * This exists so the handoff is exercised end to end in CI and in the recorded
 * demo, with nobody at a keyboard. It is NOT a fallback that quietly rescues
 * production runs -- it only runs when the caller explicitly passes
 * `--operator auto`, and the unattended default is `abort`.
 *
 * What makes it a real test of the handoff rather than a bypass: it goes through
 * exactly the same broker API a person using the console does. It claims the
 * intervention, which moves the control lease. It acts through
 * `broker.operatorAct`, so its actions run on the same live BrowserContext, pass
 * the same policy gate, and land in the same evidence stream tagged
 * `human_action`. Then it resolves with a decision, which hands the lease back.
 * If any of that were broken, this would fail too.
 */

import type { AutoOperator, Intervention } from './broker.ts';
import { eq, has } from '../surface/types.ts';
import { evaluateAssertion } from '../replay/assert.ts';

const SIGN_ON = { user: 'teller01', pass: 'demo-only-not-a-secret' };

export type AutoOperatorOptions = {
  readonly credentials?: { user: string; pass: string };
  /**
   * Whether this operator may authorise an irreversible action.
   *
   * DEFAULT FALSE, and that default is the point. A scripted operator that
   * approves whatever it is shown is a rubber stamp, and a rubber stamp reachable
   * from an untrusted caller is not an approval control at all -- it is a
   * decorative one. Only a surface that has independently established a human is
   * accountable for the run may pass `true`; today that means the CLI's explicit
   * `--operator auto`, used by the demo and by CI to exercise the handoff.
   */
  readonly approveIrreversible?: boolean;
};

export function createAutoOperator(opts: AutoOperatorOptions = {}): AutoOperator {
  const creds = opts.credentials ?? SIGN_ON;
  const mayApprove = opts.approveIrreversible === true;

  return async (intervention: Intervention, session) => {
    // 1. Policy asked a human to authorise an irreversible action.
    if (intervention.reason === 'approval_required') {
      if (!mayApprove) {
        return {
          decision: 'reject',
          note:
            'auto-operator is not authorised to approve irreversible actions. A real operator must review this. ' +
            `Pending action: ${describeAction(intervention)}`,
        };
      }
      // The note records what was actually authorised, not a claim that
      // something was reviewed. An audit line that overstates the review is
      // worse than none.
      return {
        decision: 'approve',
        note: `auto-operator approved (scripted, --operator auto): ${describeAction(intervention)} for step "${intervention.stepId ?? '?'}" -- ${intervention.why}`,
      };
    }

    // 2. Otherwise, look at the live screen and try the obvious manual fixes --
    //    the same three things a teller would try.
    let obs = await session.observe();

    if (obs.blockingDialog) {
      await session.surface.withContext({ intent: 'operator confirmed the dialog the automation could not' }).act({ kind: 'answer_dialog', accept: true });
      return { decision: 'retry_step', note: `dismissed a blocking ${obs.blockingDialog.kind} dialog: "${obs.blockingDialog.message}"` };
    }

    const sessionExpired = evaluateAssertion(obs, { kind: 'text_present', text: has('Your session has expired') }).passed;
    if (sessionExpired) {
      await session.surface.withContext({ intent: 'operator signed the session back on' }).act({
        kind: 'fill',
        target: { role: 'textbox', name: eq('Operator ID'), strategies: [{ kind: 'role_name' }] },
        value: creds.user,
      });
      await session.surface.withContext({ intent: 'operator entered the sign-on password' }).act({
        kind: 'fill',
        target: { role: 'textbox', name: eq('Password'), strategies: [{ kind: 'role_name' }] },
        value: creds.pass,
        secret: true,
      });
      await session.surface.withContext({ intent: 'operator submitted the sign-on form' }).act({
        kind: 'click',
        target: { role: 'button', name: eq('Sign On'), strategies: [{ kind: 'role_name' }] },
      });
      return { decision: 'retry_step', note: 'signed the operator session back on manually and handed control back' };
    }

    const hasContinue = evaluateAssertion(obs, {
      kind: 'element_present',
      target: { role: 'button', name: eq('Continue'), strategies: [{ kind: 'role_name' }] },
    }).passed;
    if (hasContinue) {
      await session.surface.withContext({ intent: 'operator dismissed the interstitial' }).act({
        kind: 'click',
        target: { role: 'button', name: eq('Continue'), strategies: [{ kind: 'role_name' }] },
      });
      obs = await session.observe();
      return { decision: 'retry_step', note: 'dismissed a system notice interstitial that the automation had no declared recovery for' };
    }

    // 3. Nothing obvious. A real operator would investigate; the scripted one
    //    declines rather than guessing, which is the honest behaviour.
    return {
      decision: intervention.options.includes('abort') ? 'abort' : 'resume',
      note: `auto-operator found nothing it knows how to fix on "${obs.title}" (${obs.location}); a person is needed`,
    };
  };
}

/** A one-line, redaction-safe rendering of what the human is being asked to allow. */
function describeAction(intervention: Intervention): string {
  const a = intervention.pendingAction;
  if (!a) return '(no pending action recorded)';
  if (a.kind === 'navigate') return `navigate to ${a.url}`;
  if ('target' in a && a.target) {
    const name = a.target.name?.value ?? '(unnamed)';
    const where = a.target.container?.length ? ` in [${a.target.container.join('/')}]` : '';
    return `${a.kind} ${a.target.role} "${name}"${where}`;
  }
  return a.kind;
}
