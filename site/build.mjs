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
<style>
  :root{
    --bg:#ffffff; --fg:#16161d; --muted:#5b5b6b; --line:#e3e3ea;
    --card:#fafafc; --accent:#4c1d95; --code:#f4f4f8;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#0f0f14; --fg:#ececf1; --muted:#a0a0b0; --line:#2a2a35;
      --card:#17171f; --accent:#c4b5fd; --code:#1c1c26; }
  }
  :root[data-theme="dark"]{ --bg:#0f0f14; --fg:#ececf1; --muted:#a0a0b0; --line:#2a2a35;
    --card:#17171f; --accent:#c4b5fd; --code:#1c1c26; }
  :root[data-theme="light"]{ --bg:#ffffff; --fg:#16161d; --muted:#5b5b6b; --line:#e3e3ea;
    --card:#fafafc; --accent:#4c1d95; --code:#f4f4f8; }

  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:0 1.25rem 5rem}
  header.site{border-bottom:1px solid var(--line);margin-bottom:2.25rem}
  header.site .inner{max-width:920px;margin:0 auto;padding:1rem 1.25rem;
    display:flex;gap:1.25rem;align-items:baseline;flex-wrap:wrap}
  header.site .brand{font-weight:650;letter-spacing:-.01em}
  header.site nav{display:flex;gap:1rem;margin-left:auto;flex-wrap:wrap}
  header.site nav a{color:var(--muted);text-decoration:none;font-size:.92rem}
  header.site nav a:hover{color:var(--accent)}
  h1{font-size:2rem;line-height:1.2;letter-spacing:-.022em;margin:.4rem 0 .6rem}
  h2{font-size:1.3rem;letter-spacing:-.012em;margin:2.4rem 0 .5rem}
  h3{font-size:1.05rem;margin:1.8rem 0 .4rem}
  p,li{max-width:74ch}
  a{color:var(--accent)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;
    background:var(--code);padding:.12em .38em;border-radius:4px}
  pre{background:var(--code);padding:.9rem 1rem;border-radius:8px;overflow-x:auto;
    border:1px solid var(--line)}
  pre code{background:none;padding:0;font-size:.83rem;line-height:1.55}
  blockquote{margin:1.5rem 0;padding:.9rem 1.15rem;border-left:3px solid var(--accent);
    background:var(--card);border-radius:0 8px 8px 0}
  blockquote h3{margin-top:0}
  blockquote p:last-child{margin-bottom:0}
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.1rem 0}
  table{border-collapse:collapse;font-size:.88rem;min-width:100%}
  th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--line);
    vertical-align:top}
  th{font-weight:600;color:var(--muted);font-size:.78rem;text-transform:uppercase;
    letter-spacing:.04em;white-space:nowrap}
  hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
  em{color:var(--muted)}
  footer.site{border-top:1px solid var(--line);margin-top:3.5rem;padding-top:1.25rem;
    color:var(--muted);font-size:.86rem}
  footer.site p{max-width:74ch}
</style>
</head>
<body>
<header class="site"><div class="inner">
  <span class="brand">Graph Privacy Showcase</span>
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
    body: wrapTables(relink(marked.parse(md))),
    nav: navFor(name),
  });
  await writeFile(join(OUT, name), html);
  if (file === ORDER[0]) await writeFile(join(OUT, "index.html"), html);
  console.log(`  rendered ${file} -> ${name}`);
}

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
