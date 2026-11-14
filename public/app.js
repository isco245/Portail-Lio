const $ = (id) => document.getElementById(id);
// Session : sessionStorage (fermeture de l'onglet = déconnexion) ou localStorage si « Se souvenir de moi » (15 jours)
const safe = (fn, def = null) => { try { return fn(); } catch { return def; } };
const getToken = () => safe(() => sessionStorage.getItem("token") || localStorage.getItem("token"));
const getRole = () => safe(() => sessionStorage.getItem("role") || localStorage.getItem("role"));
const setAuth = (token, role, remember) => {
  clearAuth();
  const st = remember ? localStorage : sessionStorage;
  safe(() => { st.setItem("token", token); st.setItem("role", role); });
};
// Nouveau jeton (changement de mot de passe) : on le remet là où l'ancien était
const saveToken = (token) => {
  const st = safe(() => localStorage.getItem("token")) ? localStorage : sessionStorage;
  safe(() => st.setItem("token", token));
};
const setRole = (role) => {
  const st = safe(() => localStorage.getItem("token")) ? localStorage : sessionStorage;
  safe(() => st.setItem("role", role));
};
const clearAuth = () => safe(() => { for (const st of [sessionStorage, localStorage]) { st.removeItem("token"); st.removeItem("role"); } });

const MESSAGES = {
  suspendu: "Votre compte est suspendu. Contactez l'exploitant.",
  expire: "Votre session a expiré. Reconnectez-vous.",
  mdp: "Mot de passe modifié. Reconnectez-vous.",
};

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (getToken()) headers.Authorization = `Bearer ${getToken()}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") {
    logout(data.code === "suspendu" ? "suspendu" : "expire");
    throw new Error(data.error || "Session expirée");
  }
  if (!res.ok) throw new Error(data.error || "Erreur");
  return data;
}

function logout(reason) {
  clearAuth();
  location.replace("index.html" + (MESSAGES[reason] ? `?m=${reason}` : ""));
}

// ---------- Menu (selon le rôle) ----------
const NAV = {
  conducteur: [
    ["driver.html", "Accueil", "accueil"],
    ["service.html", "Rapport de service", "service"],
    ["vehicules.html", "Véhicules", "vehicules"],
    ["profil.html", "Mon profil", "profil"],
  ],
  exploitant: [
    ["admin.html", "Récap", "accueil"],
    ["conducteurs.html", "Conducteurs", "conducteurs"],
    ["lignes.html", "Lignes", "lignes"],
    ["flotte.html", "Véhicules", "flotte"],
    ["sessions.html", "Sessions", "sessions"],
    ["note.html", "Note de service", "note"],
    ["service.html", "Rapport de service", "service"],
    ["vehicules.html", "Mes véhicules", "vehicules"],
    ["profil.html", "Mon profil", "profil"],
  ],
};

function buildNav(role) {
  const nav = document.getElementById("nav");
  if (!nav || !NAV[role]) return;
  const page = nav.dataset.page;
  nav.id = "nav";
  nav.innerHTML =
    NAV[role]
      .map(([href, label, key]) => `<a href="${href}"${key === page ? ' class="active" aria-current="page"' : ""}>${label}</a>`)
      .join("") +
    `<button type="button" class="ghost" data-theme-toggle></button>` +
    `<button type="button" class="ghost" data-logout>Déconnexion</button>`;
  const brand = document.querySelector("header .brand");
  if (brand) {
    brand.href = role === "exploitant" ? "admin.html" : "driver.html";
    const label = brand.querySelector("span");
    if (label) label.textContent = role === "exploitant" ? "Espace exploitant" : "Espace conducteurs";
  }
  // Bouton menu (téléphone / tablette)
  const header = nav.closest("header");
  if (header && !header.querySelector(".nav-toggle")) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "nav-toggle";
    t.setAttribute("aria-controls", "nav");
    t.setAttribute("aria-expanded", "false");
    t.innerHTML = `<span class="barres" aria-hidden="true"></span><span class="sr-only">Menu</span>`;
    t.addEventListener("click", () => {
      const ouvert = header.classList.toggle("menu-ouvert");
      t.setAttribute("aria-expanded", String(ouvert));
    });
    nav.before(t);
  }
  if (header && !header.dataset.burger) {
    header.dataset.burger = "1";
    const mq = matchMedia(`(max-width: ${role === "exploitant" ? 1500 : 1080}px)`);
    const maj = () => {
      header.classList.toggle("burger", mq.matches);
      if (!mq.matches) header.classList.remove("menu-ouvert");
    };
    mq.addEventListener("change", maj);
    maj();
  }
  if (window.updateThemeButtons) window.updateThemeButtons();
}

// ---------- Couleurs des lignes ----------
let COULEURS = {};
const COULEUR_DEFAUT = "#0b2149";

async function loadCouleurs() {
  try {
    const { lignes } = await api("/lignes");
    COULEURS = Object.fromEntries(lignes.map((l) => [l.nom, l.couleur]));
  } catch {
    COULEURS = {};
  }
}

// Pastille de ligne : la couleur est appliquée par paint() (la CSP interdit les attributs style en ligne)
const ligneBadge = (nom) => `<span class="ligne" data-c="${esc(COULEURS[nom] || COULEUR_DEFAUT)}">${esc(nom)}</span>`;

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function paint(root) {
  if (!root || root.nodeType !== 1) return;
  const els = [...root.querySelectorAll("[data-c]")];
  if (root.matches("[data-c]")) els.push(root);
  for (const el of els) {
    const c = el.dataset.c;
    if (!/^#[0-9a-f]{6}$/i.test(c)) continue;
    el.style.background = c;
    el.style.color = luminance(c) > 0.55 ? "#0b2149" : "#ffffff";
  }
}
new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(paint))).observe(document.body, {
  childList: true,
  subtree: true,
});
paint(document.body);

// ---------- Note de service ----------
const NOTE_LABELS = { information: "Information", attention: "Attention", perturbation: "Perturbation", danger: "Danger" };

function renderNote(note) {
  document.querySelectorAll(".note-banniere").forEach((n) => n.remove());
  const main = document.querySelector("main.page");
  if (!note || !main || document.body.dataset.noNote) return;
  const el = document.createElement("section");
  el.className = `note note-${NOTE_LABELS[note.type] ? note.type : "information"} note-banniere`;
  el.setAttribute("role", note.type === "danger" ? "alert" : "status");
  el.innerHTML =
    `<p class="note-titre">Note de service · ${esc(NOTE_LABELS[note.type] || "Information")}</p>` +
    `<p class="note-texte">${esc(note.texte)}</p>` +
    (note.updatedAt ? `<small>Publiée le ${esc(new Date(note.updatedAt).toLocaleDateString("fr-FR"))}</small>` : "");
  main.prepend(el);
}

// ---------- Mot de passe provisoire : changement obligatoire à la première connexion ----------
function changerMotDePasse() {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dlg-mdp";
    dlg.setAttribute("aria-labelledby", "mdpTitre");
    dlg.innerHTML = `
      <h2 id="mdpTitre">Définissez votre mot de passe</h2>
      <p class="muted">Votre mot de passe est provisoire. Choisissez-en un nouveau, que vous seul connaîtrez, pour accéder à votre espace.</p>
      <form novalidate>
        <label>Mot de passe provisoire
          <input type="password" name="actuel" required maxlength="128" autocomplete="current-password">
        </label>
        <label>Nouveau mot de passe
          <input type="password" name="nouveau" required maxlength="128" autocomplete="new-password">
        </label>
        <label>Confirmer le nouveau mot de passe
          <input type="password" name="confirme" required maxlength="128" autocomplete="new-password">
        </label>
        <p class="muted">8 caractères minimum. Ne reprenez pas votre matricule.</p>
        <p class="error" role="alert"></p>
        <div class="actions"><button>Enregistrer et continuer</button></div>
      </form>`;
    document.body.append(dlg);

    const form = dlg.querySelector("form");
    const msg = dlg.querySelector(".error");
    const bouton = dlg.querySelector("button");
    dlg.oncancel = (e) => e.preventDefault(); // impossible de fermer sans changer le mot de passe

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      msg.textContent = "";
      if (fd.get("nouveau") !== fd.get("confirme")) {
        msg.textContent = "Les deux mots de passe ne correspondent pas.";
        return;
      }
      bouton.disabled = true;
      try {
        const r = await api("/me/password", {
          method: "PUT",
          body: { actuel: fd.get("actuel"), nouveau: fd.get("nouveau") },
        });
        saveToken(r.token);
        dlg.close();
        dlg.remove();
        resolve(r.user);
      } catch (err) {
        msg.textContent = err.message;
        bouton.disabled = false;
      }
    });

    dlg.showModal();
    form.actuel.focus();
  });
}

async function requireUser(role) {
  if (!getToken()) {
    location.replace("index.html");
    throw new Error("redirection");
  }
  // Le profil et les couleurs des lignes sont chargés en parallèle
  const [me] = await Promise.all([api("/me"), loadCouleurs()]);
  if (role && me.user.role !== role) {
    location.replace(me.user.role === "exploitant" ? "admin.html" : "driver.html");
    throw new Error("redirection");
  }
  setRole(me.user.role);
  buildNav(me.user.role);
  if (me.user.mustChangePassword) {
    // La page reste bloquée jusqu'au changement, puis se charge normalement
    await changerMotDePasse();
    me.user.mustChangePassword = false;
    await loadCouleurs();
  }
  renderNote(me.note);
  return me;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const fmtH = (min) => `${((Number(min) || 0) / 60).toFixed(1).replace(".", ",")} h`;
const fmtDate = (d) => esc(new Date(d + "T00:00").toLocaleDateString("fr-FR"));
const fmtMois = (ym) => {
  const t = new Date(ym + "-01T12:00").toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Lignes de tableau pour un historique mensuel [{ mois, services, minutes, accidents }]
const moisRows = (rows) =>
  rows
    .map(
      (r) =>
        `<tr><td>${esc(fmtMois(r.mois))}</td><td>${Number(r.services) || 0}</td><td>${fmtH(r.minutes)}</td><td>${Number(r.accidents) || 0}</td></tr>`
    )
    .join("");

const ACCIDENTS = { routier: "Accident routier", voyageur: "Accident voyageur", externe: "Accident externe" };
// Cellule « Accident » d'un rapport : type + description
const accidentCell = (r) =>
  r.accident
    ? `<span class="badge alerte">${esc(ACCIDENTS[r.accidentType] || "Oui")}</span>` + (r.details ? `<br><small>${esc(r.details)}</small>` : "")
    : "Non";

const statutBadge = (u) =>
  u.suspendu
    ? `<span class="badge alerte">Suspendu</span>`
    : `<span class="badge ok">Actif</span>` +
      (u.mustChangePassword ? ` <span class="badge attente">Mot de passe provisoire</span>` : "");

// Copie dans le presse-papiers (repli pour les navigateurs qui refusent l'API moderne)
async function copierTexte(texte) {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch {
    const zone = document.createElement("textarea");
    zone.value = texte;
    zone.setAttribute("readonly", "");
    zone.style.position = "fixed";
    zone.style.opacity = "0";
    document.body.append(zone);
    zone.select();
    const ok = document.execCommand("copy");
    zone.remove();
    return ok;
  }
}
const roleBadge = (u) => `<span class="badge ${u.role === "exploitant" ? "fort" : ""}">${esc(u.role)}</span>`;

// Véhicules utilisés pendant un service
const vehiculesCell = (r) =>
  (r.vehicules || []).length
    ? r.vehicules.map((v) => `<span class="plaque petite" title="${esc(v.nom)}">${esc(v.plaque)}</span>`).join(" ")
    : "—";

// ---------- Fenêtre de confirmation Oui / Non ----------
function ouiNon({ titre, texte, oui = "Oui", non = "Non", danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dlg-ouinon";
    dlg.setAttribute("aria-labelledby", "ouinonTitre");
    dlg.innerHTML = `
      <h2 id="ouinonTitre"></h2>
      <div class="ouinon-texte"></div>
      <div class="actions ouinon-actions">
        <button type="button" class="${danger ? "danger" : ""}" data-oui></button>
        <button type="button" class="ghost" data-non></button>
      </div>`;
    dlg.querySelector("h2").textContent = titre;
    const zone = dlg.querySelector(".ouinon-texte");
    if (texte instanceof Node) zone.append(texte);
    else zone.textContent = texte || "";
    dlg.querySelector("[data-oui]").textContent = oui;
    dlg.querySelector("[data-non]").textContent = non;
    let fait = false;
    const fin = (v) => {
      if (fait) return;
      fait = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.querySelector("[data-oui]").onclick = () => fin(true);
    dlg.querySelector("[data-non]").onclick = () => fin(false);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); fin(false); }); // Échap = Non
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("[data-non]").focus();
  });
}

// Déconnexion : un seul gestionnaire pour tous les boutons [data-logout], avec confirmation
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-logout]")) return;
  const ok = await ouiNon({ titre: "Se déconnecter ?", texte: "Voulez-vous vraiment vous déconnecter de votre espace ?" });
  if (ok) logout();
});

// Menu tout de suite si le rôle est déjà connu (évite un menu vide le temps du chargement)
buildNav(getRole());
