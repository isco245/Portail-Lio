let lignes = [];

function render() {
  $("liste").innerHTML = lignes.map((l) => `
    <li class="chip">${esc(l)}
      <button type="button" data-ligne="${esc(l)}" aria-label="Retirer la ligne ${esc(l)}">×</button>
    </li>`).join("");
  $("vide").hidden = lignes.length > 0;
}

async function enregistrer(nouvelle, message) {
  try {
    const r = await api("/admin/lignes", { method: "PUT", body: { lignes: nouvelle } });
    lignes = r.lignes;
    render();
    $("msg").className = "success";
    $("msg").textContent = message;
    return true;
  } catch (err) {
    $("msg").className = "error";
    $("msg").textContent = err.message;
    return false;
  }
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = e.target.ligne.value.trim();
  if (!v) return;
  if (lignes.some((l) => l.toLowerCase() === v.toLowerCase())) {
    $("msg").className = "error";
    $("msg").textContent = `La ligne ${v} existe déjà.`;
    return;
  }
  if (await enregistrer([...lignes, v], `Ligne ${v} ajoutée.`)) {
    e.target.reset();
    e.target.ligne.focus();
  }
});

$("liste").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ligne]");
  if (b) enregistrer(lignes.filter((l) => l !== b.dataset.ligne), `Ligne ${b.dataset.ligne} retirée.`);
});

requireUser("exploitant")
  .then(() => api("/lignes"))
  .then((r) => {
    lignes = r.lignes;
    render();
  })
  .catch((e) => console.error(e));
