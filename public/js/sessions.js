let sessions = [];
const ouvertes = new Set(); // sessions dépliées (conservées lors du rafraîchissement)

const flash = (texte, ok = true) => {
  $("msg").className = ok ? "success" : "error";
  $("msg").textContent = texte;
};

const STATUTS = {
  a_venir: ["À venir", "attente"],
  en_cours: ["En cours", "ok"],
  terminee: ["Terminée", ""],
};
const fmtDT = (v) => `${new Date(v.slice(0, 10) + "T00:00").toLocaleDateString("fr-FR")} à ${v.slice(11)}`;

function carte(x) {
  const r = x.recap;
  const [lib, cls] = STATUTS[x.statut] || ["", ""];
  const lignes = Object.entries(r.lignes).sort((a, b) => b[1] - a[1]);
  const recapBadge = x.statut === "terminee"
    ? x.recapAt
      ? `<span class="badge ok">Récap Discord envoyé</span>`
      : `<span class="badge attente">Récap Discord en attente</span>`
    : "";
  const actions =
    (x.statut === "en_cours" ? `<button type="button" data-act="end" data-id="${esc(x.id)}">Terminer maintenant</button>` : "") +
    (x.statut === "terminee" ? `<button type="button" class="ghost" data-act="recap" data-id="${esc(x.id)}">${x.recapAt ? "Renvoyer le récap sur Discord" : "Envoyer le récap sur Discord"}</button>` : "") +
    `<button type="button" class="danger" data-act="del" data-id="${esc(x.id)}">Supprimer</button>`;
  return `
  <details class="session" data-id="${esc(x.id)}"${ouvertes.has(x.id) ? " open" : ""}>
    <summary>
      <span class="session-titre">
        <strong>${esc(x.titre)}</strong>
        <small>${esc(fmtDT(x.debut))} → ${esc(fmtDT(x.fin))}</small>
      </span>
      <span class="session-etat"><span class="badge ${cls}">${lib}</span>
        <span class="session-chiffres"><b>${r.conducteurs.length}</b> conducteur(s) · <b>${r.services}</b> service(s)</span></span>
    </summary>
    <div class="session-corps">
      <div class="stats clair">
        <div class="stat"><span>${r.conducteurs.length}</span><small>Conducteurs</small></div>
        <div class="stat"><span>${r.services}</span><small>Services</small></div>
        <div class="stat"><span>${fmtH(r.minutes)}</span><small>Heures</small></div>
        <div class="stat"><span>${r.accidents}</span><small>Accidents</small></div>
      </div>
      <h4>Lignes effectuées</h4>
      ${lignes.length
        ? `<ul class="liste-lignes compacte">${lignes.map(([l, n]) => `<li>${ligneBadge(l)}<span>${n} service(s)</span></li>`).join("")}</ul>`
        : `<p class="vide">Aucun service déclaré sur ce créneau.</p>`}
      <h4>Véhicules utilisés</h4>
      <p>${r.vehicules.length ? r.vehicules.map((v) => `<span class="plaque petite">${esc(v)}</span>`).join(" ") : `<span class="muted">Aucun renseigné</span>`}</p>
      <h4>Conducteurs</h4>
      ${r.conducteurs.length
        ? `<div class="table-wrap"><table class="empilee">
            <thead><tr><th>Matricule</th><th>Conducteur</th><th>Services</th><th>Heures</th><th>Lignes</th><th>Accidents</th></tr></thead>
            <tbody>${r.conducteurs.map((d) => `
              <tr>
                <td data-label="Matricule">${esc(d.matricule)}</td>
                <td data-label="Conducteur">${esc(d.prenom)} ${esc(d.nom)}</td>
                <td data-label="Services">${d.services}</td>
                <td data-label="Heures">${fmtH(d.minutes)}</td>
                <td data-label="Lignes">${Object.entries(d.lignes).map(([l, n]) => `${ligneBadge(l)}${n > 1 ? ` ×${n}` : ""}`).join(" ")}</td>
                <td data-label="Accidents">${d.accidents ? `<span class="badge alerte">${d.accidents}</span>` : "0"}</td>
              </tr>`).join("")}</tbody></table></div>`
        : `<p class="vide">Aucun conducteur sur ce créneau.</p>`}
      <p class="muted">Créée par ${esc(x.creePar)}. ${recapBadge}</p>
      <div class="actions">${actions}</div>
    </div>
  </details>`;
}

function render() {
  $("vide").hidden = sessions.length > 0;
  $("liste").innerHTML = sessions.map(carte).join("");
}

async function charger() {
  const r = await api("/admin/sessions");
  sessions = r.sessions;
  $("badgeDiscord").textContent = r.discord ? "Discord connecté" : "Discord non configuré";
  $("badgeDiscord").className = `badge ${r.discord ? "ok" : "attente"}`;
  render();
}

$("liste").addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches("details.session")) return;
  d.open ? ouvertes.add(d.dataset.id) : ouvertes.delete(d.dataset.id);
}, true);

$("liste").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const x = sessions.find((s) => s.id === b.dataset.id);
  if (!x) return;
  const id = encodeURIComponent(x.id);
  try {
    if (b.dataset.act === "del") {
      if (!(await ouiNon({ titre: "Supprimer cette session ?", texte: `« ${x.titre} » sera supprimée. Les rapports des conducteurs ne sont pas touchés.`, danger: true }))) return;
      await api(`/admin/sessions/${id}`, { method: "DELETE" });
      flash("Session supprimée.");
    } else if (b.dataset.act === "end") {
      if (!(await ouiNon({ titre: "Terminer la session maintenant ?", texte: "La fin passe à l'heure actuelle et le récap est envoyé sur Discord." }))) return;
      b.disabled = true;
      await api(`/admin/sessions/${id}/end`, { method: "POST" });
      flash("Session terminée.");
    } else if (b.dataset.act === "recap") {
      b.disabled = true;
      await api(`/admin/sessions/${id}/recap`, { method: "POST" });
      flash("Récap envoyé sur Discord.");
    }
    await charger();
  } catch (err) {
    flash(err.message, false);
    b.disabled = false;
    charger().catch(() => {});
  }
});

const pad = (n) => String(n).padStart(2, "0");
const dateLocale = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const heureLocale = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function valeursParDefaut(f) {
  const debut = new Date();
  debut.setMinutes(Math.ceil(debut.getMinutes() / 15) * 15, 0, 0);
  const fin = new Date(debut.getTime() + 2 * 3600e3);
  f.dateDebut.value = dateLocale(debut);
  f.heureDebut.value = heureLocale(debut);
  f.dateFin.value = dateLocale(fin);
  f.heureFin.value = heureLocale(fin);
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  try {
    await api("/admin/sessions", { method: "POST", body });
    f.reset();
    valeursParDefaut(f);
    flash("Session créée.");
    await charger();
  } catch (err) {
    flash(err.message, false);
  }
});

requireUser("exploitant")
  .then(() => {
    valeursParDefaut($("f"));
    return charger();
  })
  .then(() => setInterval(() => { if (!document.hidden) charger().catch(() => {}); }, 60000))
  .catch((e) => console.error(e));
