# Evidence

Produced by `node scripts/demo.ts` --live on 2026-09-05.

Planner: **live model via groq**.

Each directory contains:

- `events.jsonl`, the structured event stream. Every action, policy decision, assertion, detector, recovery and control transfer, attributed to an actor and redacted.
- `manifest.json`, run status, duration, event count, and a tally of what redaction caught.
- `blobs/`, screenshots and full multi-frame HTML snapshots, captured on failure and at every escalation.
- `transcript.json`, for discovery runs, what the planner actually said.
- `result.json`, for replay runs, the structured result the caller receives.

Alongside each directory, `<name>.console.txt` is the terminal output.

## Runs

- **01-discover-sign-on** (exit 0, as expected), Discover a sign-on capability. It exists so the session-expiry recovery has something to invoke.
- **02-discover-read-balance** (exit 0, as expected), The main read capability. The planner drives a frameset, types into a control with no accessible name, and declares its typed output.
- **03-discover-open-sub-account** (exit 0, as expected), A capability that WRITES. The submit step is classified irreversible, so discovery itself escalates for approval before the write; the scripted operator authorises it.
- **04-catalog**, the catalog and the Anthropic tool definitions projected from the artifacts.
- **05-replay-success** (exit 0, as expected), Deterministic replay, no model in the loop. Same member as the recording.
- **06-replay-different-member** (exit 0, as expected), A DIFFERENT member. Proves the recording was parameterised and that the balance locator is structural rather than keyed on the value it read.
- **07-replay-business-outcome-not-found** (exit 0, as expected), An unknown member. This is a BUSINESS OUTCOME, not a failure: the caller gets MEMBER_NOT_FOUND and knows retrying is pointless.
- **08-replay-business-outcome-restricted** (exit 0, as expected), A record the operator is not cleared to see. A different outcome code, with a different severity, so the caller can route it to a supervisor.
- **09-replay-input-invalid** (exit 1, as expected), A caller passes a malformed member number. Rejected in about a millisecond, against the declared input contract, before a browser is opened.
- **10-replay-app-error** (exit 1, as expected), An injected core 500, mid-flow. A declared failure signature turns "expected text not found" into app_error plus the core's own ORA reference.
- **11-replay-recovered-interstitial** (exit 0, as expected), An unexpected maintenance interstitial appears mid-flow. A declared recovery dismisses it; the step's checkpoint then already holds, so the step is not re-run.
- **12-replay-recovered-session-expiry** (exit 0, as expected), The session dies mid-flow. The engine runs the sign-on capability against the SAME live browser context, then restarts this capability, because re-authentication lands on the home screen and retrying one step could not work.
- **13-replay-write-unattended-blocked** (exit 0, as expected), The write capability with no human available. It escalates and stops BEFORE the irreversible step. Nothing is written.
- **14-replay-write-human-approved** (exit 0, as expected), The same capability with an operator available. The operator claims the intervention, takes the control lease, approves, and the automation completes the write on a one-shot grant.
- **15-replay-write-rejected-by-core** (exit 0, as expected), A deposit below the product minimum. The core refuses it; that refusal is a declared business outcome carrying the core's own wording, not a crash.
- **16-replay-second-tenant** (exit 0, as expected), A second institution running the same vendor product, with relabelled fields. Not a re-recording: the artifact extends the base and patches five points, contributing no steps of its own.
- **17-stability-five-runs** (exit 0, as expected), Replay the same capability five times against fresh sessions. Reports whether the ANSWER varied (flaky) and whether locators moved down their ladder (degrading) -- the drift signal, before anything breaks.

## Reading the interesting ones

**07 / 08 / 15, business outcomes.** `result.json` has `status: "business_outcome"`, not an error. That distinction is the point of the result contract.

**10, a hard failure.** `status: "failed"`, `class: "app_error"`, and `observed` carries the core's own `ORA-01722`. `blobs/` has the screenshot and the frame-by-frame HTML from the moment it broke.

**12, recovery by capability composition.** Grep `events.jsonl` for `sub-capability`: the engine runs `coreteller.sign-on` on the same browser context, then restarts.

**13 vs 14, the guardrail.** Same capability, same inputs. Without an operator it stops before writing; with one it completes. Grep for `policy_decision` and `control_transferred`.

**16, cross-tenant reuse.** `artifacts/granite.member.read-savings-balance@1.0.0.json` contributes no steps of its own: five overrides and an empty step list, which the schema permits exactly when `tenant.extends` is set.

**17, the drift signal.** Five runs, `rungs [0,0,0,0,0,0,0]` every time: every locator on its preferred strategy, nothing degraded. A step that starts winning on a later rung shows up here long before any assertion fails.

## Redaction

`manifest.json` counts what was scrubbed. The operator password is supplied on the command line and never appears in any artifact, log or transcript; the member tax IDs rendered by the fixture are redacted wherever they were observed.
