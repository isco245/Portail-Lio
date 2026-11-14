let vehicules = [];

const flash = (texte, ok = true) => {
  $("msg").className = ok ? "success" : "error";
  $("msg").textContent = texte;
};

function render() {
  $("vide").hidden = vehicules.length > 0;
  $("liste").innerHTML = vehicules.map((v) => `
    <li>
      <span><strong>${esc(v.nom)}</strong>${v.actifs !== undefined ? ` <span class="muted">· activé par ${v.actifs} conducteur(s)</span>` : ""}</span>
      <button type="button" class="ghost" data-id="${esc(v.id)}" aria-label="Retirer ${esc(v.nom)}">Retirer</button>
    </li>`).join("");
}

async function charger() {
  vehicules = (await api("/admin/vehicules")).vehicules;
  render();
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nom = e.target.nom.value.trim();
  if (!nom) return;
  try {
    await api("/admin/vehicules", { method: "POST", body: { nom } });
    e.target.reset();
    e.target.nom.focus();
    await charger();
    flash(`${nom} ajouté.`);
  } catch (err) {
    flash(err.message, false);
  }
});

$("liste").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-id]");
  if (!b) return;
  const v = vehicules.find((x) => x.id === b.dataset.id);
  if (!v || !confirm(`Retirer ${v.nom} de la liste ? Les conducteurs ne le verront plus.`)) return;
  try {
    await api(`/admin/vehicules/${encodeURIComponent(v.id)}`, { method: "DELETE" });
    await charger();
    flash(`${v.nom} retiré.`);
  } catch (err) {
    flash(err.message, false);
  }
});

requireUser("exploitant").then(charger).catch((e) => console.error(e));
