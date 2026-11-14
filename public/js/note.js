const flash = (texte, ok = true) => {
  $("msg").className = ok ? "success" : "error";
  $("msg").textContent = texte;
};

function afficher(note) {
  $("actuelle").hidden = !note;
  $("aucune").hidden = !!note;
  $("formTitre").textContent = note ? "Remplacer la note" : "Publier une note";
  if (!note) {
    $("apercu").innerHTML = "";
    return;
  }
  $("apercu").innerHTML =
    `<div class="note note-${esc(note.type)}"><p class="note-titre">Note de service · ${esc(NOTE_LABELS[note.type] || "Information")}</p>` +
    `<p class="note-texte">${esc(note.texte)}</p>` +
    (note.updatedAt ? `<small>Publiée le ${esc(new Date(note.updatedAt).toLocaleDateString("fr-FR"))}</small>` : "") +
    `</div>`;
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/admin/note", { method: "PUT", body: { type: e.target.type.value, texte: e.target.texte.value } });
    afficher(r.note);
    e.target.texte.value = "";
    flash("Note publiée.");
  } catch (err) {
    flash(err.message, false);
  }
});

$("bSupprimer").addEventListener("click", async () => {
  if (!confirm("Supprimer la note de service ?")) return;
  try {
    await api("/admin/note", { method: "DELETE" });
    afficher(null);
    flash("Note supprimée.");
  } catch (err) {
    flash(err.message, false);
  }
});

requireUser("exploitant")
  .then((me) => afficher(me.note))
  .catch((e) => console.error(e));
