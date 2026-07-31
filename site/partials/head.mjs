// Fragments shared by the generated doc pages and the standalone verify page,
// so the two surfaces cannot drift apart. build.mjs asserts that verify.html
// carries the same theme bootstrap; if someone edits one and not the other the
// build fails rather than shipping two different toggles.

export const LOGO_PATH =
  "M14.2958 20.7692C9.17277 20.7692 5 16.6308 5 11.5385C5 6.44615 9.17277 2.30769 14.2958 2.30769C19.4188 2.30769 23.5915 6.44615 23.5915 11.5385C23.5915 16.6308 19.4188 20.7692 14.2958 20.7692ZM14.2958 5.38462C10.877 5.38462 8.09859 8.14359 8.09859 11.5385C8.09859 14.9333 10.877 17.6923 14.2958 17.6923C17.7146 17.6923 20.493 14.9333 20.493 11.5385C20.493 8.14359 17.7146 5.38462 14.2958 5.38462ZM16.9399 29.5487L23.1371 23.3949C23.7413 22.7949 23.7413 21.8205 23.1371 21.2205C22.5329 20.6205 21.5516 20.6205 20.9474 21.2205L14.7502 27.3744C14.146 27.9744 14.146 28.9487 14.7502 29.5487C15.0549 29.8513 15.4474 30 15.8451 30C16.2427 30 16.6404 29.8513 16.9399 29.5487ZM25.1408 2C24.1183 2 23.2817 2.83077 23.2817 3.84615C23.2817 4.86154 24.1183 5.69231 25.1408 5.69231C26.1634 5.69231 27 4.86154 27 3.84615C27 2.83077 26.1634 2 25.1408 2Z";

// White orbit on a purple tile — the only correct treatment on a dark surface.
export const MARK = `<span class="mark"><svg viewBox="0 0 32 32" fill="#fff" width="19" height="19" aria-hidden="true"><path d="${LOGO_PATH}"/></svg></span>`;

// Runs before first paint so a light-mode reader never sees a dark flash.
export const THEME_BOOT =
  `<script>(function(){try{var t=localStorage.getItem("gps-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()</script>`;

export const THEME_TOGGLE = `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to light theme" title="Switch theme">
<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentcolor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentcolor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>
</button>`;

export const THEME_SCRIPT = `<script>
(function(){
  var b=document.querySelector("[data-theme-toggle]");
  if(!b)return;
  function label(){
    var light=document.documentElement.getAttribute("data-theme")==="light";
    b.setAttribute("aria-label",light?"Switch to dark theme":"Switch to light theme");
  }
  label();
  b.addEventListener("click",function(){
    var next=document.documentElement.getAttribute("data-theme")==="light"?"dark":"light";
    document.documentElement.setAttribute("data-theme",next);
    try{localStorage.setItem("gps-theme",next)}catch(e){}
    label();
  });
})();
</script>`;

// Preconnect matters: without it the webfont waits on a fresh TLS handshake.
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap">`;

export const masthead = (nav) => `<header class="masthead"><div class="masthead-inner">
  <a class="brand" href="./index.html">${MARK}<span>Graph Privacy Showcase</span></a>
  <nav>${nav}${THEME_TOGGLE}</nav>
</div></header>`;
