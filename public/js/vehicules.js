let vehicules = [];

const flash = (texte, ok = true) => {
  $("msg").className = ok ? "success" : "error";
  $("msg").textContent = texte;
};

function render() {
  $("vide").hidden = vehicules.length > 0;
  $("liste").innerHTML = vehicules.map((v) => `
    <form class="vehicule ${v.actif ? "actif" : ""}" data-id="${esc(v.id)}">
      <div class="vehicule-tete">
        <h4>${esc(v.nom)}</h4>
        ${v.actif ? `<span class="badge ok">Activé</span>` : `<span class="badge">Non activé</span>`}
      </div>
      <div class="inline-form">
        <label>Plaque d'immatriculation
          <input name="plaque" value="${esc(v.plaque)}" placeholder="ex : AB-123-CD" required maxlength="15" autocomplete="off">
        </label>
        ${v.actif
          ? `<button>Enregistrer la plaque</button><button type="button" class="ghost" data-desactiver>Désactiver</button>`
          : `<button>Activer ce véhicule</button>`}
      </div>
    </form>`).join("");
}

async function envoyer(id, actif, plaque) {
  try {
    const r = await api(`/vehicules/${encodeURIComponent(id)}`, { method: "PUT", body: { actif, plaque } });
    const v = vehicules.find((x) => x.id === id);
    v.actif = r.actif;
    v.plaque = r.plaque || v.plaque;
    render();
    flash(actif ? `${v.nom} activé (${r.plaque}).` : `${v.nom} désactivé.`);
  } catch (err) {
    flash(err.message, false);
  }
}

$("liste").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.closest("form[data-id]");
  envoyer(f.dataset.id, true, f.plaque.value);
});
$("liste").addEventListener("click", (e) => {
  if (!e.target.closest("[data-desactiver]")) return;
  const f = e.target.closest("form[data-id]");
  envoyer(f.dataset.id, false, "");
});

requireUser()
  .then(() => api("/vehicules"))
  .then((r) => {
    vehicules = r.vehicules;
    render();
  })
  .catch((e) => console.error(e));
