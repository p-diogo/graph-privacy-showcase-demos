# The site

Renders `docs/*.md` into the static site published at
**[confidential-showcase.thegraph.foundation](https://confidential-showcase.thegraph.foundation)**.

The markdown in `docs/` is the source of truth. It syncs from the private program
repo's `pages/` directory and still renders on GitHub; this only produces a
hosted view of it.

## Build

```sh
cd site && npm install && npm run build   # -> site/dist
npm run serve                              # build + preview on :8788
```

Cloudflare Pages runs exactly that: build command `cd site && npm install && npm run build`,
output directory `site/dist`, deploying on every push to `main`.

## What the build does that is not obvious

- **`docs/verify.html` is not templated.** It is the product surface and keeps its
  styling and behaviour inline so it still works opened straight from disk, with
  no build step and no sibling files. The build touches only its sibling links
  (`.md` → `.html`) and **asserts** it carries the same theme bootstrap and toggle
  as the generated pages — if someone edits one and not the other, the build
  fails rather than shipping two different behaviours.
- **Diagrams.** A `<!-- diagram:NAME -->` marker in a markdown file is replaced
  with themed inline SVG from `partials/diagrams/NAME.svg`, and the mermaid fence
  sitting next to the marker is dropped. GitHub readers see the mermaid; the site
  shows the SVG. Inline rather than `<img>` so the diagram inherits the page's
  theme tokens and follows the light/dark toggle.
- **Status values become GDS Tags.** Strings like `live — single indexer` in the
  matrix table are rewritten as filled pills. Adding a new status means adding it
  to `TAGS` in `build.mjs`, or it renders as bare text.
- **The matrix is served twice**, as `index.html` and `matrix.html`, so both the
  site root and any `matrix.md` link resolve.
- **`_headers`** is emitted with nosniff, a referrer policy and frame-deny.
  Deliberately **no `connect-src` CSP**: `verify.html` lets a reader substitute
  their own RPC endpoint, and locking that down would defeat the property the
  page exists to demonstrate.

## Design system

`partials/brand.css` carries The Graph Design System tokens, read from
`graphprotocol/gds` (`packages/css/styles/theme.css`) — that repo is the source
of truth and is **private**, so fetch it with `gh`, not an anonymous clone.

Dark is the default register and is declared on `:root`, not inside a media
query, so it renders correctly regardless of OS preference. Light is opt-in via
`[data-theme="light"]`, set by the header toggle and persisted to `localStorage`.

**Fonts load via `<link>` in the head, never `@import`.** An `@import` must
precede every other rule or browsers silently drop it; an earlier revision put it
at the bottom of `brand.css` and the webfont never loaded at all, on any page, for
several days. If typography ever looks wrong, check this first.

The typeface is **Poppins**, the brand's sanctioned fallback, not Euclid Circular
A. Euclid is the official face and ships in GDS, but that repo is private and the
typeface is commercially licensed — the MIT LICENSE there covers the design
system, not a font redistribution grant. Putting those woff2 files in this public
repo would republish a licensed font. The `@font-face` block is written and
commented out in `brand.css`; switching is a two-line change once someone
confirms the licence permits it. Tracked as queue R14 in the program repo.

## The attested-query proxy

`../worker/` — see its own README. It holds the gateway API key as a Worker
secret so the browser can query the decentralized network without one, and
returns the indexer's EIP-712 attestation so the page can verify the response
without trusting the proxy.

## Accessibility

WCAG 2.1 AA, verified rather than assumed: all eleven foreground/background
pairs clear AA in **both** themes. That audit is why light mode uses `brand-600`
for links (`brand-500` is 4.1:1 on white and fails) and a darker muted ink than
`foam-1000`. Pass/fail state carries a word as well as a colour. Re-run the check
if you change any token.
