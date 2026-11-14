// Mode clair / sombre : chargé dans <head> pour éviter un flash au chargement.
(function () {
  var KEY = "theme";
  var root = document.documentElement;
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function initial() {
    var s = stored();
    if (s === "dark" || s === "light") return s;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function apply(t) {
    root.setAttribute("data-theme", t);
    var sombre = t === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.textContent = sombre ? "☀ Mode clair" : "☾ Mode sombre";
      b.setAttribute("aria-label", sombre ? "Passer en mode clair" : "Passer en mode sombre");
    });
  }
  window.updateThemeButtons = function () { apply(root.getAttribute("data-theme") || "light"); };
  apply(initial());
  document.addEventListener("DOMContentLoaded", window.updateThemeButtons);
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (err) { /* stockage indisponible : choix valable pour cette page */ }
    apply(next);
  });
})();
