// Renders docs/*.md into a static site.
//
// The markdown in docs/ stays the source of truth: it is what syncs from the
// program repo and what renders on GitHub. This only produces a hosted view of
// it. verify.html keeps its styling and crypto inline — it is deliberately
// self-contained so it still works opened straight from disk. The build touches
// only its sibling links: the source points at .md so it works on GitHub, and
// here they become .html so they work on the hosted site.

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { marked } from "marked";

const DOCS = join("..", "docs");
const OUT = "dist";

// matrix is the front page; the rest follow in reading order.
const ORDER = ["matrix.md", "private-bond-audit-replay.md", "encrypted-anchor-stream.md"];

const NAV = [
  { href: "./index.html", label: "Demonstrations" },
  { href: "./verify.html", label: "Verify it yourself" },
  { href: "https://github.com/p-diogo/graph-privacy-showcase-demos", label: "Code", external: true },
];

const shell = ({ title, body, nav }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Proof-of-concepts showing The Graph serving the read and audit path for confidential systems on public Ethereum. Demo-grade evidence on fictional data.">
<link rel="icon" href="https://storage.thegraph.com/favicons/64x64.png">
<link rel="stylesheet" href="./brand.css">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg-canvas);color:var(--text-default);
    font-size:16px;line-height:1.65}
  .wrap{max-width:920px;margin:0 auto;padding:0 1.25rem 5rem}
  header.site{border-bottom:1px solid var(--border-muted);margin-bottom:2.25rem;
    background:var(--bg-subtle)}
  header.site .inner{max-width:920px;margin:0 auto;padding:.85rem 1.25rem;
    display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap}
  .logo{display:inline-flex;align-items:center;justify-content:center;
    width:32px;height:32px;background:var(--brand-500);border-radius:8px;flex:none}
  .brand{display:flex;align-items:center;gap:.6rem;font-weight:500;
    letter-spacing:-.01em;color:var(--text-default);text-decoration:none}
  header.site nav{display:flex;gap:1.15rem;margin-left:auto;flex-wrap:wrap}
  header.site nav a{color:var(--text-muted);text-decoration:none;font-size:14px}
  header.site nav a:hover{color:var(--accent)}
  h1{font-size:40px;line-height:1.15;letter-spacing:-.025em;margin:.5rem 0 .6rem}
  h2{font-size:24px;letter-spacing:-.015em;margin:2.6rem 0 .5rem}
  h3{font-size:18px;margin:1.9rem 0 .4rem}
  p,li{max-width:74ch}
  a{color:var(--accent)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;
    background:var(--bg-muted);padding:.12em .38em;border-radius:4px}
  pre{background:var(--bg-muted);padding:.9rem 1rem;border-radius:var(--radius);
    overflow-x:auto;border:1px solid var(--border-subtle)}
  pre code{background:none;padding:0;font-size:13px;line-height:1.55}
  blockquote{margin:1.6rem 0;padding:1rem 1.2rem;border-left:3px solid var(--brand-500);
    background:var(--bg-muted);border-radius:0 var(--radius) var(--radius) 0}
  blockquote h3{margin-top:0}
  blockquote p:last-child{margin-bottom:0}
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.1rem 0;
    border:1px solid var(--border-subtle);border-radius:var(--radius)}
  table{border-collapse:collapse;font-size:14px;min-width:100%}
  th,td{text-align:left;padding:.6rem .75rem;border-bottom:1px solid var(--border-subtle);
    vertical-align:top}
  tr:last-child td{border-bottom:0}
  th{color:var(--text-muted);font-size:12px;text-transform:uppercase;
    letter-spacing:.04em;white-space:nowrap;background:var(--bg-subtle)}
  hr{border:0;border-top:1px solid var(--border-subtle);margin:2.6rem 0}
  em{color:var(--text-muted)}
  footer.site{border-top:1px solid var(--border-subtle);margin-top:3.5rem;
    padding-top:1.25rem;color:var(--text-muted);font-size:14px}
  footer.site p{max-width:74ch}
</style>
</head>
<body>
<header class="site"><div class="inner">
  <a class="brand" href="./index.html"><span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" fill="#fff" width="21" height="21"><path d="M14.2958 20.7692C9.17277 20.7692 5 16.6308 5 11.5385C5 6.44615 9.17277 2.30769 14.2958 2.30769C19.4188 2.30769 23.5915 6.44615 23.5915 11.5385C23.5915 16.6308 19.4188 20.7692 14.2958 20.7692ZM14.2958 5.38462C10.877 5.38462 8.09859 8.14359 8.09859 11.5385C8.09859 14.9333 10.877 17.6923 14.2958 17.6923C17.7146 17.6923 20.493 14.9333 20.493 11.5385C20.493 8.14359 17.7146 5.38462 14.2958 5.38462ZM16.9399 29.5487L23.1371 23.3949C23.7413 22.7949 23.7413 21.8205 23.1371 21.2205C22.5329 20.6205 21.5516 20.6205 20.9474 21.2205L14.7502 27.3744C14.146 27.9744 14.146 28.9487 14.7502 29.5487C15.0549 29.8513 15.4474 30 15.8451 30C16.2427 30 16.6404 29.8513 16.9399 29.5487ZM25.1408 2C24.1183 2 23.2817 2.83077 23.2817 3.84615C23.2817 4.86154 24.1183 5.69231 25.1408 5.69231C26.1634 5.69231 27 4.86154 27 3.84615C27 2.83077 26.1634 2 25.1408 2Z"/></svg></span><span>Graph Privacy Showcase</span></a>
  <nav>${nav}</nav>
</div></header>
<div class="wrap">
${body}
<footer class="site">
  <p><strong>Demo-grade evidence on fictional data — not a product.</strong> No SLA,
  no certification, nothing here is a production service. The Graph indexes public
  chain state and adds no confidentiality of its own; read privacy does not exist on
  any of these paths. Every claim is backed by an artifact someone re-ran, or is
  labelled as not yet run.</p>
  <p><a href="https://github.com/p-diogo/graph-privacy-showcase-demos">Source and code</a>
  · <a href="https://github.com/ethsystems/map">EthSystems Institutional Privacy Map</a></p>
</footer>
</div>
</body>
</html>
`;

// the matrix is served both as index.html and matrix.html; treat them as one page
const canonical = (p) => (p === "matrix.html" ? "index.html" : p);

const navFor = (page) =>
  NAV.map(({ href, label, external }) => {
    const here = !external && canonical(basename(href)) === canonical(page);
    return `<a href="${href}"${external ? ' rel="noopener"' : ""}${here ? ' aria-current="page" style="color:var(--accent)"' : ""}>${label}</a>`;
  }).join("");

// ./foo.md -> ./foo.html, preserving any #fragment
const relink = (html) =>
  html.replace(/href="(\.\/)?([A-Za-z0-9._-]+)\.md(#[^"]*)?"/g,
    (_m, dot, name, frag) => `href="${dot ?? ""}${name}.html${frag ?? ""}"`);

// GDS Tag: a status label is a filled pill with white text, not free text.
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
    body: wrapTables(tagStatuses(relink(marked.parse(md)))),
    nav: navFor(name),
  });
  await writeFile(join(OUT, name), html);
  if (file === ORDER[0]) await writeFile(join(OUT, "index.html"), html);
  console.log(`  rendered ${file} -> ${name}`);
}

await writeFile(join(OUT, "brand.css"), await readFile(join("partials", "brand.css"), "utf8"));
console.log("  wrote    brand.css (GDS tokens)");

// self-contained page: only its sibling links are rewritten (.md -> .html)
const verify = await readFile(join(DOCS, "verify.html"), "utf8");
await writeFile(join(OUT, "verify.html"), relink(verify));
console.log("  copied   verify.html (sibling links relinked)");
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
