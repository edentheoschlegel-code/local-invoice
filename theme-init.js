/* Set data-theme as early as possible (before first paint) to avoid a flash of
 * the wrong theme. Loaded as an external file (not inline) so it satisfies the
 * strict CSP's script-src 'self' — no inline scripts allowed. "system"/unset
 * follows prefers-color-scheme; "light"/"dark" force that theme. app.js later
 * wires the toggle and keeps "system" live-updating. */
(function () {
  try {
    var pref = localStorage.getItem("localinvoice.theme");
    var dark = pref === "dark" || ((pref === "system" || !pref) &&
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } catch (e) { /* private-browsing / storage blocked — fall back to light */ }
})();
