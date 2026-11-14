const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

let VEHICULES = [];

async function loadLignes() {
  const { lignes } = await api("/lignes");
  $("listeLignes").innerHTML = lignes
    .map((l) => `<label class="choix"><input type="checkbox" name="lignes" value="${esc(l.nom)}">${ligneBadge(l.nom)}</label>`)
    .join("");
  $("aucuneLigne").hidden = lignes.length > 0;
  $("envoyer").disabled = lignes.length === 0;
}

async function loadVehicules() {
  const { vehicules } = await api("/vehicules");
  const actifs = vehicules.filter((v) => v.actif);
  VEHICULES = actifs;
  $("aucunVehicule").hidden = actifs.length > 0;
  $("listeVehicules").innerHTML = actifs
    .map(
      (v) => `<label class="choix"><input type="checkbox" name="vehicules" value="${esc(v.id)}">
        <span>${esc(v.nom)}</span><span class="plaque petite">${esc(v.plaque)}</span></label>`
    )
    .join("");
}

async function loadHistorique() {
  const rows = await api("/reports");
  $("historique").innerHTML = rows.length
    ? rows.map((r) => `
        <tr>
          <td data-label="Date">${fmtDate(r.date)}</td>
          <td data-label="Lignes">${lignesCell(r)}</td>
          <td data-label="Horaires">${esc(r.debut)} – ${esc(r.fin)}</td>
          <td data-label="Durée">${fmtH(r.minutes)}</td>
          <td data-label="Véhicules">${vehiculesCell(r)}</td>
          <td data-label="Accident">${accidentCell(r)}</td>
          <td data-label="Commentaire">${commentaireCell(r)}</td>
        </tr>`).join("")
    : `<tr><td colspan="7">Aucun rapport</td></tr>`;
}

// Récapitulatif montré dans la fenêtre de confirmation
function recapRapport(d) {
  const dl = document.createElement("dl");
  dl.className = "recap-confirm";
  const lignes = [
    ["Date", new Date(d.date + "T00:00").toLocaleDateString("fr-FR")],
    [d.lignes.length > 1 ? "Lignes" : "Ligne", d.lignes.join(", ")],
    ["Horaires", `${d.debut} – ${d.fin}`],
    ["Véhicules", d.vehiculesTxt || "Aucun"],
    ["Accident", d.accident ? `Oui (${ACCIDENTS[d.accidentType] || ""})` : "Non"],
    ...(d.commentaire ? [["Commentaire", d.commentaire]] : []),
  ];
  for (const [k, v] of lignes) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "Une fois envoyé, le rapport ne peut plus être modifié.";
  const box = document.createElement("div");
  box.append(dl, p);
  return box;
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
    const lignes = [...f.querySelectorAll('input[name="lignes"]:checked')].map((c) => c.value);
    if (!lignes.length) {
      $("msg").className = "error";
      $("msg").textContent = "Cochez au moins une ligne.";
      return;
    }
    const vehicules = [...f.querySelectorAll('input[name="vehicules"]:checked')].map((c) => c.value);
    const nomsVeh = VEHICULES.filter((v) => vehicules.includes(v.id)).map((v) => `${v.nom} (${v.plaque})`).join(", ");

    // Confirmation Oui / Non avant l'envoi
    const confirme = await ouiNon({
      titre: "Envoyer ce rapport de service ?",
      texte: recapRapport({ ...fd, lignes, accident, vehiculesTxt: nomsVeh }),
      oui: "Oui",
      non: "Non",
    });
    if (!confirme) return;

    $("envoyer").disabled = true;
    try {
      await api("/reports", {
        method: "POST",
        body: { date: fd.date, lignes, commentaire: fd.commentaire || "", debut: fd.debut, fin: fd.fin, vehicules, accident, accidentType: accident ? fd.accidentType : "", details: accident ? fd.details : "" },
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

  await Promise.all([loadLignes(), loadVehicules(), loadHistorique()]);
})().catch((e) => console.error(e));
