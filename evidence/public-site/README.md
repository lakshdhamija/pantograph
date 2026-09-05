# Evidence: a public site

Produced by `node scripts/demo-public.ts` on 2026-09-05, against
Sauce Labs' Swag Labs demo storefront, an application I did not write and cannot change.

Kept out of CI on purpose: a green build should not depend on a third party's uptime, and
re-running someone else's site on every push is rude.

## Runs

- **01-discover** (exit 0, as expected), Record the flow against a storefront I did not write. Note the locator ladder in the artifact: role+name is ambiguous on the product grid (six buttons read "Add to cart"), so it falls to a relational anchor on the product title -- which the compiler then templates as {{inputs.productName}}.
- **02-replay-sauce-labs-backpack** (exit 0, as expected), Replay for Sauce Labs Backpack. Three different products, three different totals, one artifact -- which is the whole point of parameterising the locator rather than recording a test id that names one product.
- **02-replay-sauce-labs-fleece-jacket** (exit 0, as expected), Replay for Sauce Labs Fleece Jacket. Three different products, three different totals, one artifact -- which is the whole point of parameterising the locator rather than recording a test id that names one product.
- **02-replay-sauce-labs-onesie** (exit 0, as expected), Replay for Sauce Labs Onesie. Three different products, three different totals, one artifact -- which is the whole point of parameterising the locator rather than recording a test id that names one product.
- **03-business-outcome-locked-out** (exit 0, as expected), Sauce Labs ships a deliberately locked account. No fault injection: this is a real, intended, non-happy answer on somebody else's application, and it comes back as a typed business outcome rather than a crash.
- **04-stability-three-runs** (exit 0, as expected), Drift measurement against a site I do not control. Watch which rungs each step resolves on.

## Why this exists

A fixture I wrote myself invites the obvious objection: that the app was shaped around the
solution. This surface answers it. It also exercises four things the fixture cannot:

- a `data-test` attribute convention, so the cheap locator rung is present and has to be
  handled on exactly the class of app that has one
- an href-less anchor (the cart control) which strict ARIA computes as generic, which is why roles
  here describe affordances for automation rather than following the spec exactly
- an order total rendered as `Total: $32.39`, which is why the compiler verifies each extraction
  against the value discovery observed rather than trusting the pipeline
- a product-specific test id, `add-to-cart-sauce-labs-backpack`, which is why a locator keying on
  a run parameter has to be templated: pinned, it would declare a `productName` input and then
  return the Backpack's price for a Fleece Jacket.

## The contrast worth reading

| | local fixture | this storefront |
|---|---|---|
| declared `portabilityFloor` | `any_surface` | `any_web` |
| why | no test IDs anywhere, so the ladder derives relational locators | test IDs present, and the ladder uses one where nothing portable is unique |
| framesets | yes | no |
| error taxonomy | fully exercised, faults injected on demand | two business outcomes declared, one exercised; no injection possible |

Same recorder, same engine, neither told which app it was looking at.
