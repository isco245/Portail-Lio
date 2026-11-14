const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

async function loadLignes() {
  const { lignes } = await api("/lignes");
  const sel = $("ligne");
  sel.innerHTML = `<option value="">Choisir une ligne</option>` +
    lignes.map((l) => `<option value="${esc(l.nom)}">${esc(l.nom)}</option>`).join("");
  $("aucuneLigne").hidden = lignes.length > 0;
  $("envoyer").disabled = lignes.length === 0;
}

async function loadHistorique() {
  const rows = await api("/reports");
  $("historique").innerHTML = rows.length
    ? rows.map((r) => `
        <tr>
          <td>${fmtDate(r.date)}</td>
          <td>${ligneBadge(r.ligne)}</td>
          <td>${esc(r.debut)} – ${esc(r.fin)}</td>
          <td>${fmtH(r.minutes)}</td>
          <td>${accidentCell(r)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5">Aucun rapport</td></tr>`;
}

(async () => {
  await requireUser(); // conducteurs ET exploitants peuvent envoyer des rapports
  const f = $("f");
  const zone = $("zoneAccident");
  f.date.value = today();
  f.date.max = today();

  // Si accident : type et description obligatoires
  const setAccident = (oui) => {
    zone.hidden = !oui;
    $("details").required = oui;
    f.querySelectorAll('input[name="accidentType"]').forEach((r) => (r.required = oui));
    if (!oui) {
      $("details").value = "";
      f.querySelectorAll('input[name="accidentType"]').forEach((r) => (r.checked = false));
    }
  };
  document.querySelectorAll('input[name="accident"]').forEach((r) =>
    r.addEventListener("change", () => setAccident(f.accident.value === "oui"))
  );

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f));
    const accident = fd.accident === "oui";
    $("envoyer").disabled = true;
    try {
      await api("/reports", {
        method: "POST",
        body: { date: fd.date, ligne: fd.ligne, debut: fd.debut, fin: fd.fin, accident, accidentType: accident ? fd.accidentType : "", details: accident ? fd.details : "" },
      });
      f.reset();
      f.date.value = today();
      setAccident(false);
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
