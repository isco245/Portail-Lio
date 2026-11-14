(async () => {
  const { user } = await requireUser();
  const f = $("f");
  const afficher = (u) => {
    $("infos").innerHTML = [
      ["Matricule", u.matricule],
      ["Nom", u.nom],
      ["Prénom", u.prenom],
      ["Rôle", u.role],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
    f.pseudo.value = u.pseudo || "";
    f.discord.value = u.discord || "";
  };
  afficher(user);

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("enregistrer").disabled = true;
    try {
      const r = await api("/me", { method: "PUT", body: { pseudo: f.pseudo.value, discord: f.discord.value } });
      afficher(r.user);
      $("msg").className = "success";
      $("msg").textContent = "Pseudos enregistrés.";
    } catch (err) {
      $("msg").className = "error";
      $("msg").textContent = err.message;
    } finally {
      $("enregistrer").disabled = false;
    }
  });
})().catch((e) => console.error(e));
