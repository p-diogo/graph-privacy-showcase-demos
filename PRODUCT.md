# Product

## Register

product

## Users

Engineers and technical evaluators assessing whether The Graph actually serves the
read and audit path for confidential systems on public Ethereum. They arrive
skeptical, often from a background of scoring vendors against published criteria,
and they are looking for reasons to discount the claim. Some will clone the repo
and run the CLIs; many will not, and for them this site is the whole encounter.

The job to be done: *establish, in a few minutes and without installing anything,
whether these demonstrations are real.* The primary task on the main surface is
running a verification and reading its result.

## Product Purpose

`verify.html` is the product. It performs live cryptographic checks against
Ethereum Sepolia in the reader's own browser: reading the bond's anchored
commitments and Merkle roots from the contract, rebuilding a ten-anchor encrypted
stream from raw transaction calldata, and recomputing the keccak chain that links
it. No API key, no install, and no component from The Graph in the trust path.

The explainer pages and the demonstration matrix are supporting documentation
around that tool. Success is a reader who runs the checks, watches them pass,
tries to break one, and leaves believing the evidence rather than the copy.

## Brand Personality

Precise, self-effacing, unhurried. The voice states what a thing establishes and
what it does not, in that order. Confidence comes from showing the failure modes,
naming the limits before anyone asks, and inviting the reader to re-derive
everything without us. Never enthusiastic on its own behalf.

Follows The Graph's brand and the Graph Design System: see the review checklist in
the `thegraph-brand` skill. Dark is the default register.

## Anti-references

- **A crypto marketing site.** No gradient hero, no glowing orbs, no animated
  network motifs, no "the future of" copy. This audience scores vendors for a
  living and discounts marketing on sight.
- **A generic AI-built SaaS page.** No identical card grids, no big-number stat
  rows, no uppercase tracked eyebrows above every section, no cream backgrounds.
- Not a wall of undifferentiated grey documentation either. Readable and
  considered, without becoming decorative.

## Design Principles

1. **The evidence is the interface.** The most persuasive element on any screen is
   a check that just ran and its result. Design serves reading that result, not
   framing it.
2. **Show the failure.** Every claim ships next to its limit, and the tool lets
   the reader try to break it. An interface that can only succeed proves nothing.
3. **Earned familiarity.** Standard affordances, one type family, consistent
   component vocabulary. Strangeness costs trust here, and trust is the product.
4. **Restraint is credibility.** Accent colour marks state and primary action,
   never decoration. If a flourish would make an evaluator raise an eyebrow, it
   costs more than it gains.
5. **Nothing hidden behind a build step.** The verification page works opened
   straight from disk, with its logic readable in view-source.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text ≥4.5:1 against its surface, large text ≥3:1, verified
rather than assumed. Pass/fail state is never carried by colour alone: results
carry a word ("passed", "failed") as well as a hue, which also covers colour
blindness. Every interactive control is keyboard reachable with a visible focus
ring. All motion respects `prefers-reduced-motion`, and no content is gated behind
a transition.
