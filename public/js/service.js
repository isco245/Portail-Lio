const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

async function loadLignes() {
  const { lignes } = await api("/lignes");
  const sel = $("ligne");
  sel.innerHTML = `<option value="">Choisir une ligne</option>` +
    lignes.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  $("aucuneLigne").hidden = lignes.length > 0;
  $("envoyer").disabled = lignes.length === 0;
}

async function loadHistorique() {
  const rows = await api("/reports");
  $("historique").innerHTML = rows.length
    ? rows.map((r) => `
        <tr>
          <td>${fmtDate(r.date)}</td>
          <td><span class="ligne">${esc(r.ligne)}</span></td>
          <td>${esc(r.debut)} – ${esc(r.fin)}</td>
          <td>${fmtH(r.minutes)}</td>
          <td>${r.accident ? `<span class="badge alerte">Oui</span>` + (r.details ? `<br><small>${esc(r.details)}</small>` : "") : "Non"}</td>
        </tr>`).join("")
    : `<tr><td colspan="5">Aucun rapport</td></tr>`;
}

(async () => {
  await requireUser("conducteur");
  const f = $("f");
  const zone = $("zoneAccident");
  f.date.value = today();
  f.date.max = today();

  document.querySelectorAll('input[name="accident"]').forEach((r) =>
    r.addEventListener("change", () => (zone.hidden = f.accident.value !== "oui"))
  );

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f));
    $("envoyer").disabled = true;
    try {
      await api("/reports", { method: "POST", body: { ...fd, accident: fd.accident === "oui" } });
      f.reset();
      f.date.value = today();
      zone.hidden = true;
      $("msg").className = "success";
      $("msg").textContent = "Rapport enregistré.";
      await loadHistorique();
    } catch (err) {
      $("msg").className = "error";
      $("msg").textContent = err.message;
    } finally {
      $("envoyer").disabled = $("aucuneLigne").hidden === false;
    }
  });

  await Promise.all([loadLignes(), loadHistorique()]);
})().catch((e) => console.error(e));
