const UID_RE = /^[\w-]{1,64}$/;
const form = $("uForm");
let moi = null;
let users = [];
let profil = null;

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const flash = (id, texte, ok = true) => {
  $(id).className = ok ? "success" : "error";
  $(id).textContent = texte;
};

// ---------- Fenêtre de confirmation ----------
function confirmer({ titre, texte, bouton, saisie }) {
  return new Promise((resolve) => {
    const dlg = $("dlgConfirm");
    const ok = $("confOk");
    const inp = $("confSaisie");
    $("confTitre").textContent = titre;
    $("confTexte").textContent = texte;
    ok.textContent = bouton;
    $("confSaisieWrap").hidden = !saisie;
    $("confMatricule").textContent = saisie || "";
    inp.value = "";
    ok.disabled = !!saisie;
    inp.oninput = () => (ok.disabled = norm(inp.value.trim()) !== norm(saisie));
    const fin = (v) => {
      dlg.close();
      resolve(v);
    };
    ok.onclick = () => fin(true);
    $("confAnnuler").onclick = () => fin(false);
    dlg.oncancel = () => resolve(false); // touche Échap
    dlg.showModal();
  });
}

// ---------- Liste ----------
async function chargerListe() {
  users = await api("/admin/users");
  renderListe();
}

// Tris proposés (toujours départagés par le matricule)
const parMatricule = (a, b) => a.matricule.localeCompare(b.matricule, "fr", { numeric: true });
const TRIS = {
  matricule: parMatricule,
  nom: (a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, "fr") || parMatricule(a, b),
  "heures-desc": (a, b) => b.mois.minutes - a.mois.minutes || parMatricule(a, b),
  "heures-asc": (a, b) => a.mois.minutes - b.mois.minutes || parMatricule(a, b),
  "cumul-desc": (a, b) => b.total.minutes - a.total.minutes || parMatricule(a, b),
  "cumul-asc": (a, b) => a.total.minutes - b.total.minutes || parMatricule(a, b),
  "statut-actif": (a, b) => Number(a.suspendu) - Number(b.suspendu) || parMatricule(a, b),
  "statut-suspendu": (a, b) => Number(b.suspendu) - Number(a.suspendu) || parMatricule(a, b),
  "role-exploitant": (a, b) => Number(b.role === "exploitant") - Number(a.role === "exploitant") || parMatricule(a, b),
  "role-conducteur": (a, b) => Number(a.role === "exploitant") - Number(b.role === "exploitant") || parMatricule(a, b),
};
const compact = (s) => norm(s).replace(/[\s\-_.]/g, "");

function renderListe() {
  const q = norm($("q").value.trim());
  const qc = compact($("q").value);
  const statut = $("fStatut").value;
  const role = $("fRole").value;
  const filtre = q || statut || role;
  const rows = users
    .filter((u) => (!statut || (statut === "suspendu") === !!u.suspendu) && (!role || u.role === role))
    .map((u) => {
      const plaquesTrouvees = qc.length >= 2 ? (u.vehicules || []).filter((v) => compact(v.plaque).includes(qc)) : [];
      const textes = norm(`${u.matricule} ${u.nom} ${u.prenom} ${u.prenom} ${u.nom} ${u.pseudo} ${u.discord}`).includes(q);
      return { u, plaquesTrouvees, ok: !q || textes || plaquesTrouvees.length > 0 };
    })
    .filter((x) => x.ok)
    .sort((a, b) => (TRIS[$("tri").value] || parMatricule)(a.u, b.u));
  $("nb").textContent = filtre
    ? `${rows.length} résultat(s) sur ${users.length} compte(s)`
    : `${users.length} compte(s)`;
  $("uTable").innerHTML = rows.length
    ? rows.map(({ u, plaquesTrouvees }) => `
        <tr class="${u.suspendu ? "suspendu" : ""}">
          <td data-label="Matricule"><strong>${esc(u.matricule)}</strong>${
            plaquesTrouvees.length
              ? `<div class="plaques-trouvees">${plaquesTrouvees.map((v) => `<span class="plaque petite" title="${esc(v.nom)}">${esc(v.plaque)}</span>`).join(" ")}</div>`
              : ""
          }</td>
          <td data-label="Nom">${esc(u.nom)}</td>
          <td data-label="Prénom">${esc(u.prenom)}</td>
          <td data-label="Rôle">${roleBadge(u)}</td>
          <td data-label="Statut">${statutBadge(u)}</td>
          <td data-label="Heures ce mois">${fmtH(u.mois.minutes)}</td>
          <td data-label="Heures cumulées">${fmtH(u.total.minutes)}</td>
          <td class="cell-action"><button type="button" class="ghost" data-profil="${esc(u.id)}">Voir le profil</button></td>
        </tr>`).join("")
    : `<tr><td colspan="8">Aucun compte ne correspond à cette recherche.</td></tr>`;
}

$("q").addEventListener("input", renderListe);
for (const id of ["tri", "fStatut", "fRole"]) $(id).addEventListener("change", renderListe);
$("uTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-profil]");
  if (b) location.hash = b.dataset.profil;
});

// ---------- Profil ----------
async function chargerProfil(id) {
  const d = await api(`/admin/users/${encodeURIComponent(id)}`);
  profil = d;
  const u = d.user;
  $("pNom").textContent = `${u.prenom} ${u.nom}`;
  $("pMois").textContent = `${fmtMois(d.mois.mois)} : ces compteurs repartent à zéro le 1er de chaque mois.`;
  $("pBadges").innerHTML = `${statutBadge(u)} ${roleBadge(u)}`;
  $("pHeures").textContent = fmtH(d.mois.minutes);
  $("pServices").textContent = d.mois.services;
  $("pAccidents").textContent = d.mois.accidents;
  $("cHeures").textContent = fmtH(d.total.minutes);
  $("cServices").textContent = d.total.services;
  $("cAccidents").textContent = d.total.accidents;
  $("pMoisBody").innerHTML = moisRows(d.precedents);
  $("pInfos").innerHTML = [
    ["Matricule", u.matricule],
    ["Nom", u.nom],
    ["Prénom", u.prenom],
    ["Pseudo Roblox", u.pseudo || "—"],
    ["Pseudo Discord", u.discord || "—"],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  $("pVehicules").innerHTML = d.vehicules.length
    ? d.vehicules.map((v) => `<li><span>${esc(v.nom)}</span><span class="plaque">${esc(v.plaque)}</span></li>`).join("")
    : "<li>Aucun véhicule activé</li>";

  const lignes = Object.entries(d.total.lignes);
  $("pLignes").innerHTML = lignes.length
    ? lignes.map(([l, v]) => `<li>${ligneBadge(l)}<span>${v.services} service(s)</span></li>`).join("")
    : "<li>Aucun service pour l'instant</li>";

  $("pRecents").innerHTML = d.recents.length
    ? d.recents.map((r) => `
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

  const self = u.id === moi.id;
  $("bSuspendre").hidden = self;
  $("bSupprimer").hidden = self;
  $("bProvisoire").hidden = self;
  $("bSuspendre").textContent = u.suspendu ? "Réactiver le compte" : "Suspendre";
  $("msgProfil").textContent = self ? "C'est votre compte : vous ne pouvez ni le suspendre ni le supprimer." : "";
  $("msgProfil").className = "muted";
}

// ---------- Navigation (liste / profil) ----------
async function route() {
  const id = location.hash.slice(1);
  if (id && UID_RE.test(id)) {
    try {
      await chargerProfil(id);
      $("vueListe").hidden = true;
      $("vueProfil").hidden = false;
      window.scrollTo(0, 0);
      return;
    } catch (err) {
      location.hash = "";
      flash("msgListe", err.message, false);
    }
  }
  $("vueProfil").hidden = true;
  $("vueListe").hidden = false;
  await chargerListe();
}
window.addEventListener("hashchange", route);
$("retour").addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});

// ---------- Mot de passe provisoire ----------
// Option cochée par défaut. En modification, elle ne s'applique que si un nouveau mot de passe est saisi.
const majProvisoire = () => {
  form.provisoire.disabled = !!form.uid.value && !form.password.value;
};
form.password.addEventListener("input", majProvisoire);

// Mot de passe aléatoire sans caractères ambigus (0/O, 1/l/I)
const genererMotDePasse = (longueur = 12) => {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const valeurs = crypto.getRandomValues(new Uint32Array(longueur));
  return Array.from(valeurs, (v) => alphabet[v % alphabet.length]).join("");
};
$("bGenerer").addEventListener("click", () => {
  form.password.value = genererMotDePasse();
  majProvisoire();
});

// ---------- Ajout / modification ----------
function ouvrirForm(u) {
  form.reset();
  $("uMsg").textContent = "";
  form.uid.value = u ? u.id : "";
  if (u) {
    form.matricule.value = u.matricule;
    form.nom.value = u.nom;
    form.prenom.value = u.prenom;
    form.pseudo.value = u.pseudo || "";
    form.discord.value = u.discord || "";
    form.role.value = u.role;
  }
  form.password.required = !u;
  form.provisoire.checked = true;
  majProvisoire();
  $("formTitre").textContent = u ? `Modifier ${u.prenom} ${u.nom}` : "Ajouter un compte";
  $("aideMdp").textContent = u
    ? "Laissez le mot de passe vide pour ne pas le changer. S'il change, le conducteur sera déconnecté."
    : "8 caractères minimum.";
  $("dlgForm").showModal();
}
$("bAjouter").addEventListener("click", () => ouvrirForm(null));
$("bModifier").addEventListener("click", () => ouvrirForm(profil.user));
$("fAnnuler").addEventListener("click", () => $("dlgForm").close());

// ---------- Message d'accès à transmettre au conducteur ----------
const SITE_URL = "https://portail-lio.netlify.app";
function ouvrirAcces({ nom, prenom, matricule, motDePasse, reset = false }) {
  const texte = (reset
    ? [
        "Lio Aston - Réinitialisation du mot de passe",
        "",
        `Bonjour ${nom} ${prenom},`,
        "",
        "Votre mot de passe a été réinitialisé. Vous devez en créer un nouveau avec le code de connexion suivant.",
        "",
        `Site : ${SITE_URL}`,
        `Matricule : ${matricule}`,
        `Code de connexion (mot de passe provisoire) : ${motDePasse}`,
        "",
        "Merci de contacter la direction en cas de problème.",
      ]
    : [
        "Lio Aston - Accès Portail Conducteur",
        "",
        `Bonjour ${nom} ${prenom} à la Lio d'Aston.`,
        "",
        "Lors de votre première connexion, il vous sera demandé de changer de mot de passe. N'hésitez pas à vérifier les informations de votre profil et à les modifier au besoin.",
        "",
        `Site : ${SITE_URL}`,
        `Matricule : ${matricule}`,
        `Mot de passe provisoire : ${motDePasse}`,
        "",
        "Merci de contacter la direction en cas de problème.",
      ]
  ).join("\n");
  $("accesTitre").textContent = reset ? "Lio Aston - Mot de passe réinitialisé" : "Lio Aston - Accès Portail Conducteur";
  $("accesTexte").textContent = texte;
  $("accesCopier").textContent = "Copier le message";
  $("accesCopier").classList.remove("copie-ok");
  $("dlgAcces").showModal();
}
$("accesFermer").addEventListener("click", () => $("dlgAcces").close());
// Le mot de passe provisoire n'est gardé nulle part une fois la fenêtre fermée
$("dlgAcces").addEventListener("close", () => ($("accesTexte").textContent = ""));

let minuteurCopie = 0;
$("accesCopier").addEventListener("click", async () => {
  const bouton = $("accesCopier");
  clearTimeout(minuteurCopie);
  if (await copierTexte($("accesTexte").textContent)) {
    bouton.textContent = "Copié ✓";
    bouton.classList.remove("copie-ok");
    void bouton.offsetWidth; // relance l'animation
    bouton.classList.add("copie-ok");
    minuteurCopie = setTimeout(() => (bouton.textContent = "Copier le message"), 2200);
  } else {
    // Repli : on sélectionne le texte pour une copie manuelle
    const plage = document.createRange();
    plage.selectNodeContents($("accesTexte"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(plage);
    bouton.textContent = "Copie impossible : texte sélectionné, copiez-le à la main";
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const uid = data.uid;
  delete data.uid;
  if (!data.password) delete data.password;
  // Provisoire seulement si un mot de passe est envoyé et que l'option est cochée
  const provisoire = !!data.password && !form.provisoire.disabled && form.provisoire.checked;
  data.provisoire = provisoire;
  const acces = { nom: data.nom, prenom: data.prenom, matricule: data.matricule, motDePasse: data.password };
  $("uMsg").textContent = "";
  try {
    if (uid) {
      const r = await api(`/admin/users/${encodeURIComponent(uid)}`, { method: "PUT", body: data });
      if (r.reauth) return logout("mdp");
      $("dlgForm").close();
      await chargerProfil(uid);
      flash("msgProfil", "Modifications enregistrées.");
      if (provisoire) ouvrirAcces({ ...acces, reset: true });
    } else {
      await api("/admin/users", { method: "POST", body: data });
      $("dlgForm").close();
      await chargerListe();
      flash("msgListe", "Compte créé.");
      if (provisoire) ouvrirAcces(acces);
    }
  } catch (err) {
    $("uMsg").textContent = err.message;
  }
});

// ---------- Mot de passe provisoire (réinitialisation) ----------
$("bProvisoire").addEventListener("click", async () => {
  const u = profil.user;
  const ok = await confirmer({
    titre: `Réinitialiser le mot de passe de ${u.prenom} ${u.nom} ?`,
    texte: "Un mot de passe provisoire est généré. Le conducteur est déconnecté tout de suite et devra en créer un nouveau avec ce code à sa prochaine connexion. Un message à lui envoyer s'affichera ensuite.",
    bouton: "Réinitialiser",
  });
  if (!ok) return;
  const motDePasse = genererMotDePasse();
  try {
    await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: { password: motDePasse, provisoire: true } });
    await chargerProfil(u.id);
    flash("msgProfil", "Mot de passe réinitialisé.");
    ouvrirAcces({ nom: u.nom, prenom: u.prenom, matricule: u.matricule, motDePasse, reset: true });
  } catch (err) {
    flash("msgProfil", err.message, false);
  }
});

// ---------- Suspension / suppression ----------
$("bSuspendre").addEventListener("click", async () => {
  const u = profil.user;
  const suspendre = !u.suspendu;
  const ok = await confirmer(
    suspendre
      ? {
          titre: `Suspendre ${u.prenom} ${u.nom} ?`,
          texte: "Le conducteur est déconnecté tout de suite et ne peut plus se connecter. Ses données sont conservées et vous pouvez le réactiver à tout moment.",
          bouton: "Suspendre",
        }
      : {
          titre: `Réactiver ${u.prenom} ${u.nom} ?`,
          texte: "Le conducteur pourra de nouveau se connecter avec son mot de passe actuel.",
          bouton: "Réactiver",
        }
  );
  if (!ok) return;
  try {
    await api(`/admin/users/${encodeURIComponent(u.id)}/suspend`, { method: "POST", body: { suspendu: suspendre } });
    await chargerProfil(u.id);
    flash("msgProfil", suspendre ? "Compte suspendu." : "Compte réactivé.");
  } catch (err) {
    flash("msgProfil", err.message, false);
  }
});

$("bSupprimer").addEventListener("click", async () => {
  const u = profil.user;
  const ok = await confirmer({
    titre: `Supprimer le profil de ${u.prenom} ${u.nom} ?`,
    texte: "Le compte et tous ses rapports de service sont effacés définitivement. Cette action est irréversible. Pour garder les données, préférez la suspension.",
    bouton: "Supprimer définitivement",
    saisie: u.matricule,
  });
  if (!ok) return;
  try {
    await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
    location.hash = "";
    flash("msgListe", `Le profil de ${u.prenom} ${u.nom} a été supprimé.`);
  } catch (err) {
    flash("msgProfil", err.message, false);
  }
});

requireUser("exploitant")
  .then((me) => {
    moi = me.user;
    return route();
  })
  .catch((e) => console.error(e));
