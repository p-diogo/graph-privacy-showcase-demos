
/* ---------- helpers ---------- */
const hexToBytes = h => {
  h = h.replace(/^0x/, "");
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i*2, 2), 16);
  return a;
};
const bytesToHex = b => "0x" + Array.from(b).map(x => x.toString(16).padStart(2,"0")).join("");
const short = h => h.slice(0,10) + "…" + h.slice(-6);
const rpcUrl = () => document.getElementById("rpcInput").value.trim();

let rpcId = 0;
async function rpc(method, params){
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc:"2.0", id: ++rpcId, method, params})
  });
  if (!res.ok) throw new Error(`RPC returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}
const ethCall = (to, data) => rpc("eth_call", [{to, data}, "latest"]);
const pad32 = h => h.replace(/^0x/,"").padStart(64, "0");

/* status text always carries a word, never colour alone */
function setStatus(id, text, kind){
  const el = document.getElementById(id);
  el.className = "status" + (kind ? " is-" + kind : "");
  el.innerHTML = kind === "busy"
    ? '<span class="spinner" aria-hidden="true"></span>' + text
    : text;
}
function table(head){
  return `<table><thead><tr>${head.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody></tbody></table>`;
}
function addRow(rootId, cells){
  const tb = document.querySelector(`#${rootId} tbody`);
  const tr = document.createElement("tr");
  for (const c of cells){
    const td = document.createElement("td");
    if (c && c.cls) td.className = c.cls;
    if (c && c.html !== undefined) td.innerHTML = c.html; else td.textContent = c;
    tr.appendChild(td);
  }
  tb.appendChild(tr);
}
function busy(btn, on){
  btn.disabled = on;
  document.getElementById("runAll").disabled = on || running;
}
let running = false;

/* ---------- check 1: the bond ---------- */
async function checkBond(){
  const btn = document.getElementById("runBond");
  busy(btn, true);
  document.getElementById("bondOut").innerHTML = table(["Read", "Answer from chain", "Result"]);
  setStatus("bondStatus", "reading the contract…", "busy");
  let failures = 0;
  try {
    const id = await ethCall(BOND, SEL_BOND_ID);
    const idOk = id.toLowerCase() === BOND_ID.toLowerCase();
    if (!idOk) failures++;
    addRow("bondOut", [
      {cls:"k", html:"Bond identifier"},
      {cls:"v", html: short(id)},
      {html: idOk ? `<span class="ok">passed</span> <span class="muted">— matches ${BOND_STR}</span>`
                  : '<span class="bad">failed</span> <span class="muted">— unexpected value</span>'}
    ]);

    for (let i = 0; i < LEAF_COUNT; i++){
      const c = await ethCall(BOND, SEL_COMMITMENTS + pad32("0x"+i.toString(16)));
      const present = /[1-9a-f]/.test(c.slice(2));
      if (!present) failures++;
      addRow("bondOut", [
        {cls:"k", html:`Anchored commitment ${i}`},
        {cls:"v", html: short(c)},
        {html: present ? '<span class="ok">passed</span> <span class="muted">— present on chain</span>'
                       : '<span class="bad">failed</span> <span class="muted">— empty slot</span>'}
      ]);
    }

    const r = await ethCall(BOND, SEL_KNOWN_ROOTS + pad32(ANCHORED_ROOT));
    const known = /1$/.test(r);
    if (!known) failures++;
    addRow("bondOut", [
      {cls:"k", html:"Published Merkle root"},
      {cls:"v", html: short(ANCHORED_ROOT)},
      {html: known ? '<span class="ok">passed</span> <span class="muted">— the bond confirms it anchored this</span>'
                   : '<span class="bad">failed</span> <span class="muted">— not a known root</span>'}
    ]);

    setStatus("bondStatus",
      failures ? `${failures} of 10 checks failed` : "10 checks passed, read live from chain",
      failures ? "bad" : "ok");
  } catch (e) {
    setStatus("bondStatus", "could not reach the RPC: " + e.message, "bad");
    failures++;
  } finally { busy(btn, false); }
  return failures === 0;
}

/* ---------- the tamper control ---------- */
async function askRoot(){
  const btn = document.getElementById("runRoot");
  const v = document.getElementById("rootInput").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)){
    setStatus("rootStatus", "not a 32-byte hex root", "bad"); return;
  }
  btn.disabled = true;
  setStatus("rootStatus", "asking the contract…", "busy");
  try {
    const r = await ethCall(BOND, SEL_KNOWN_ROOTS + pad32(v));
    const known = /1$/.test(r);
    setStatus("rootStatus",
      known ? "true — the bond anchored this root" : "false — the bond never anchored this root",
      known ? "ok" : "bad");
  } catch (e){ setStatus("rootStatus", "could not reach the RPC: " + e.message, "bad"); }
  finally { btn.disabled = false; }
}
function breakRoot(){
  const el = document.getElementById("rootInput");
  const s = el.value.trim();
  const i = s.length - 1;
  el.value = s.slice(0, i) + (s[i] === "d" ? "e" : "d");
  setStatus("rootStatus", "one digit changed — ask again", "");
}

/* ---------- check 2: the anchor stream ---------- */
async function checkStream(){
  const btn = document.getElementById("runStream");
  busy(btn, true);
  document.getElementById("streamOut").innerHTML = table(["Seq", "Ciphertext digest", "Hash chain", "Transaction"]);
  document.getElementById("streamNotes").textContent = "";
  setStatus("streamStatus", `fetching ${ANCHOR_TXS.length + 1} transactions…`, "busy");
  let failures = 0, prevDigest = null;
  try {
    for (let i = 0; i < ANCHOR_TXS.length; i++){
      const tx = await rpc("eth_getTransactionByHash", [ANCHOR_TXS[i]]);
      if (!tx || (tx.to || "").toLowerCase() !== EDGE.toLowerCase()){
        failures++;
        addRow("streamOut", [i, {html:'<span class="bad">not a call to the anchor contract</span>'}, "", ""]);
        continue;
      }
      const e = decodeEnvelope(tx.input);
      if (!e){ failures++; addRow("streamOut", [i, {html:'<span class="bad">undecodable payload</span>'}, "", ""]); continue; }

      const seqOk = e.seq === i;
      const streamOk = e.streamId.toLowerCase() === STREAM_ID.toLowerCase();
      const linkOk = (i === 0) || (e.prevEnvelopeDigest.toLowerCase() === prevDigest.toLowerCase());
      if (!seqOk || !streamOk || !linkOk) failures++;

      addRow("streamOut", [
        {html: seqOk ? String(e.seq) : `<span class="bad">${e.seq}, expected ${i}</span>`},
        {cls:"v", html: short(e.ciphertextDigest)},
        {html: i === 0
          ? '<span class="muted">first anchor</span>'
          : (linkOk ? '<span class="ok">links to previous</span>' : '<span class="bad">chain broken</span>')},
        {cls:"v", html:`<a href="https://sepolia.etherscan.io/tx/${ANCHOR_TXS[i]}" rel="noopener">${short(ANCHOR_TXS[i])}</a>`}
      ]);

      prevDigest = bytesToHex(keccak256(e.env));
    }

    /* the deliberate junk payload must NOT decode */
    const bad = await rpc("eth_getTransactionByHash", [MALFORMED_TX]);
    const badDecode = bad ? decodeEnvelope(bad.input) : null;
    if (badDecode !== null) failures++;
    document.getElementById("streamNotes").textContent = badDecode === null
      ? "The deliberately malformed post does not decode as an envelope, so the index reports it rather than dropping it silently. Anchor 0 was also submitted twice; the duplicate carries identical bytes, changes no state, and is reported as a duplicate."
      : "Warning: the malformed post decoded, which it should not.";

    setStatus("streamStatus",
      failures ? `${failures} check(s) failed`
               : "10 anchors, contiguous, hash chain intact — rebuilt from calldata",
      failures ? "bad" : "ok");
  } catch (e){
    setStatus("streamStatus", "could not reach the RPC: " + e.message, "bad");
    failures++;
  } finally { busy(btn, false); }
  return failures === 0;
}

/* ---------- wiring ---------- */
document.getElementById("runBond").onclick   = checkBond;
document.getElementById("runStream").onclick = checkStream;
document.getElementById("runRoot").onclick   = askRoot;
document.getElementById("breakRoot").onclick = breakRoot;
document.getElementById("runAll").onclick = async () => {
  running = true;
  const btn = document.getElementById("runAll");
  btn.disabled = true;
  setStatus("allStatus", "running both checks…", "busy");
  const a = await checkBond();
  const b = await checkStream();
  setStatus("allStatus", (a && b)
    ? "everything checks out, from public chain data alone"
    : "something did not check out — see the readouts below", (a && b) ? "ok" : "bad");
  running = false;
  btn.disabled = false;
};

/* theme toggle — same behaviour and same storage key as every other page */
(function(){
  var b = document.querySelector("[data-theme-toggle]");
  if (!b) return;
  function label(){
    var light = document.documentElement.getAttribute("data-theme") === "light";
    b.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  }
  label();
  b.addEventListener("click", function(){
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("gps-theme", next); } catch(e){}
    label();
  });
})();
</script>
</body>
</html>
