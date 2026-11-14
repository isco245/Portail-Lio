let lignes = []; // [{ nom, couleur }]
const PALETTE = ["#c10130", "#e8710a", "#e6b800", "#0f7a3d", "#0aa5a5", "#2f6fde", "#0b2149", "#7b3fb0", "#d6409f", "#566180"];

function render() {
  $("liste").innerHTML = lignes.map((l) => `
    <li class="chip">${ligneBadge(l.nom)}
      <input type="color" value="${esc(l.couleur)}" data-couleur="${esc(l.nom)}" aria-label="Couleur de la ligne ${esc(l.nom)}" title="Changer la couleur">
      <button type="button" data-ligne="${esc(l.nom)}" aria-label="Retirer la ligne ${esc(l.nom)}">×</button>
    </li>`).join("");
  $("vide").hidden = lignes.length > 0;
}

async function enregistrer(nouvelle, message) {
  try {
    const r = await api("/admin/lignes", { method: "PUT", body: { lignes: nouvelle } });
    lignes = r.lignes;
    await loadCouleurs();
    render();
    $("msg").className = "success";
    $("msg").textContent = message;
    return true;
  } catch (err) {
    $("msg").className = "error";
    $("msg").textContent = err.message;
    render();
    return false;
  }
}

$("swatches").innerHTML = PALETTE.map(
  (c) => `<button type="button" class="swatch" data-c="${c}" data-couleur-rapide="${c}" aria-label="Couleur ${c}"></button>`
).join("");
$("swatches").addEventListener("click", (e) => {
  const b = e.target.closest("[data-couleur-rapide]");
  if (b) $("f").couleur.value = b.dataset.couleurRapide;
});

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = e.target.ligne.value.trim();
  if (!v) return;
  if (lignes.some((l) => l.nom.toLowerCase() === v.toLowerCase())) {
    $("msg").className = "error";
    $("msg").textContent = `La ligne ${v} existe déjà.`;
    return;
  }
  if (await enregistrer([...lignes, { nom: v, couleur: e.target.couleur.value }], `Ligne ${v} ajoutée.`)) {
    e.target.ligne.value = "";
    e.target.ligne.focus();
  }
});

$("liste").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ligne]");
  if (b) enregistrer(lignes.filter((l) => l.nom !== b.dataset.ligne), `Ligne ${b.dataset.ligne} retirée.`);
});

// Changer la couleur d'une ligne existante (à la validation du sélecteur)
$("liste").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-couleur]");
  if (!inp) return;
  const nom = inp.dataset.couleur;
  enregistrer(lignes.map((l) => (l.nom === nom ? { ...l, couleur: inp.value } : l)), `Couleur de la ligne ${nom} modifiée.`);
});

requireUser("exploitant")
  .then(() => api("/lignes"))
  .then((r) => {
    lignes = r.lignes;
    render();
  })
  .catch((e) => console.error(e));
