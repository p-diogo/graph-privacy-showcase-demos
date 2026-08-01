// Renders docs/*.md into a static site.
//
// The markdown in docs/ stays the source of truth: it is what syncs from the
// program repo and what renders on GitHub. This produces a hosted view of it.
//
// verify.html is the product surface and keeps its styling and behaviour inline
// so it still works opened straight from disk. The build touches only its
// sibling links (.md -> .html) and asserts it carries the same theme bootstrap
// as the generated pages, so the two surfaces cannot silently diverge.

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { marked } from "marked";
import { masthead, THEME_BOOT, THEME_SCRIPT, FONT_LINKS } from "./partials/head.mjs";

const DIAGRAMS = join("partials", "diagrams");

const DOCS = join("..", "docs");
const OUT = "dist";

// matrix is the front page; the rest follow in reading order.
const ORDER = ["matrix.md", "private-bond-audit-replay.md", "encrypted-anchor-stream.md"];

const NAV = [
  { href: "./index.html", label: "Demonstrations" },
  { href: "./verify.html", label: "Verify" },
  { href: "https://github.com/p-diogo/graph-privacy-showcase-demos", label: "Code", external: true },
];

const shell = ({ title, body, nav }) => `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Proof-of-concepts showing The Graph serving the read and audit path for confidential systems on public Ethereum. Demo-grade evidence on fictional data.">
<link rel="icon" href="https://storage.thegraph.com/favicons/64x64.png">
${THEME_BOOT}
${FONT_LINKS}
<link rel="stylesheet" href="./brand.css">
<style>
  .wrap { max-width: 780px; margin: 0 auto; padding: var(--sp-7) var(--sp-5) var(--sp-8); }
  .wrap > h1 { margin-bottom: var(--sp-4); }
  .wrap > h2 { margin: var(--sp-7) 0 var(--sp-3); }
  .wrap > h3 { margin: var(--sp-6) 0 var(--sp-2); }
  .wrap > p, .wrap > ul, .wrap > ol { margin: var(--sp-3) 0; }
  .wrap > p, .wrap li { max-width: 72ch; }
  .wrap > p > em:only-child { color: var(--ink-muted); font-style: normal; }

  ul, ol { padding-left: 1.15rem; }
  li { margin: var(--sp-1) 0; }
  li::marker { color: var(--ink-subtle); }

  code { background: var(--surface); color: var(--ink); padding: .12em .38em;
    border-radius: var(--r-sm); border: 1px solid var(--line); }
  pre { background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--r); padding: var(--sp-4); overflow-x: auto;
    font-size: var(--t-13); line-height: 1.6; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }

  blockquote { margin: var(--sp-5) 0; padding: var(--sp-4) var(--sp-5);
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--r); }
  blockquote > :first-child { margin-top: 0; }
  blockquote > :last-child { margin-bottom: 0; }
  blockquote h3 { font-size: var(--t-16); margin-bottom: var(--sp-2); }

  .tablewrap { overflow-x: auto; margin: var(--sp-5) 0;
    border: 1px solid var(--line); border-radius: var(--r); }
  table { border-collapse: collapse; font-size: var(--t-13); min-width: 100%; }
  th, td { text-align: left; padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { background: var(--panel); color: var(--ink-muted); font-size: var(--t-12);
    font-weight: 500; white-space: nowrap; position: sticky; top: 0; }
  tbody tr { transition: background var(--fast) var(--ease); }
  tbody tr:hover { background: var(--panel); }

  hr { border: 0; border-top: 1px solid var(--line); margin: var(--sp-7) 0; }

  figure.diagram { margin: var(--sp-6) 0; padding: var(--sp-4);
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--r); overflow-x: auto; }
  figure.diagram svg { display: block; min-width: 620px; }

  .colophon { border-top: 1px solid var(--line); margin-top: var(--sp-8);
    padding-top: var(--sp-5); color: var(--ink-muted); font-size: var(--t-13); }
  .colophon p { max-width: 72ch; }
  .colophon strong { color: var(--ink); font-weight: 500; }

  @media (max-width: 640px) {
    .wrap { padding: var(--sp-5) var(--sp-4) var(--sp-7); }
    h1 { font-size: var(--t-28); }
  }
</style>
</head>
<body>
${masthead(nav)}
<main class="wrap">
${body}
<footer class="colophon">
  <p><strong>Demo-grade evidence on fictional data, not a product.</strong> No SLA,
  no certification, nothing here is a production service. The Graph indexes public
  chain state and adds no confidentiality of its own; read privacy does not exist on
  any of these paths. Every claim is backed by an artifact someone re-ran, or is
  labelled as not yet run.</p>
  <p><a href="https://github.com/p-diogo/graph-privacy-showcase-demos">Source and code</a>
  · <a href="https://github.com/ethsystems/map">EthSystems Institutional Privacy Map</a></p>
</footer>
</main>
${THEME_SCRIPT}
</body>
</html>
`;

// the matrix is served both as index.html and matrix.html; treat them as one page
const canonical = (p) => (p === "matrix.html" ? "index.html" : p);

const navFor = (page) =>
  NAV.map(({ href, label, external }) => {
    const here = !external && canonical(basename(href)) === canonical(page);
    return `<a href="${href}"${external ? ' rel="noopener"' : ""}${here ? ' aria-current="page"' : ""}>${label}</a>`;
  }).join("");

// ./foo.md -> ./foo.html, preserving any #fragment
const relink = (html) =>
  html.replace(/href="(\.\/)?([A-Za-z0-9._-]+)\.md(#[^"]*)?"/g,
    (_m, dot, name, frag) => `href="${dot ?? ""}${name}.html${frag ?? ""}"`);

// A status is a GDS Tag, not free text.
const TAGS = [
  ["live — single indexer", "tag-live"],
  ["spec-only", "tag-spec"],
  ["upstream fix branches", "tag-spec"],
];
const tagStatuses = (html) =>
  TAGS.reduce((acc, [label, cls]) =>
    acc.replaceAll(`<td>${label}</td>`, `<td><span class="tag ${cls}">${label}</span></td>`), html);

const wrapTables = (html) =>
  html.replace(/<table>[\s\S]*?<\/table>/g, (t) => `<div class="tablewrap">${t}</div>`);

// A marker in the markdown becomes inline SVG here; on GitHub the mermaid fence
// next to it renders instead. Inline (not <img>) so the diagram inherits the
// page's theme tokens and switches with the light/dark toggle.
const diagramStyle = await readFile(join(DIAGRAMS, "_style.svg"), "utf8");
async function injectDiagrams(html) {
  const markers = [...html.matchAll(/<!--\s*diagram:([a-z0-9-]+)\s*-->/g)];
  for (const m of markers) {
    const svg = (await readFile(join(DIAGRAMS, `${m[1]}.svg`), "utf8"))
      .replace("<!--STYLE-->", diagramStyle);
    // drop the mermaid fence that follows the marker; it is the GitHub fallback
    const after = html.slice(m.index);
    const fence = after.match(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/);
    html = html.replace(m[0], svg);
    if (fence && after.indexOf(fence[0]) < 400) html = html.replace(fence[0], "");
  }
  return html;
}

const titleOf = (md, fallback) => (md.match(/^#\s+(.+)$/m)?.[1] ?? fallback).trim();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const all = (await readdir(DOCS)).filter((f) => f.endsWith(".md"));
const missing = ORDER.filter((f) => !all.includes(f));
if (missing.length) throw new Error(`docs/ is missing expected pages: ${missing.join(", ")}`);
const pages = [...ORDER, ...all.filter((f) => !ORDER.includes(f))];

for (const file of pages) {
  const md = await readFile(join(DOCS, file), "utf8");
  const name = file.replace(/\.md$/, ".html");
  const html = shell({
    title: `${titleOf(md, name)} — Graph Privacy Showcase`,
    body: await injectDiagrams(wrapTables(tagStatuses(relink(marked.parse(md))))),
    nav: navFor(name),
  });
  await writeFile(join(OUT, name), html);
  if (file === ORDER[0]) await writeFile(join(OUT, "index.html"), html);
  console.log(`  rendered ${file} -> ${name}`);
}

await writeFile(join(OUT, "brand.css"), await readFile(join("partials", "brand.css"), "utf8"));
console.log("  wrote    brand.css (GDS tokens)");

// The standalone product surface. Only its sibling links are rewritten, but the
// theme bootstrap must match the generated pages or the two would persist theme
// differently — fail the build rather than ship that.
const verify = await readFile(join(DOCS, "verify.html"), "utf8");
if (!verify.includes('localStorage.getItem("gps-theme")')) {
  throw new Error("docs/verify.html is missing the shared theme bootstrap (gps-theme)");
}
if (!verify.includes('data-theme-toggle')) {
  throw new Error("docs/verify.html is missing the theme toggle control");
}
await writeFile(join(OUT, "verify.html"), relink(verify));
console.log("  copied   verify.html (sibling links relinked, theme parity checked)");

// Safe defaults. Deliberately no connect-src CSP: verify.html lets the reader
// point it at an RPC of their choosing, and locking that down would defeat the
// one property the page exists to demonstrate.
await writeFile(join(OUT, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
`);
console.log("  wrote    _headers");
console.log(`\nbuilt ${pages.length + 3} files into ${OUT}/`);
