const $ = (id) => document.getElementById(id);
const getToken = () => sessionStorage.getItem("token");

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
  sessionStorage.clear();
  location.replace("index.html" + (MESSAGES[reason] ? `?m=${reason}` : ""));
}

async function requireUser(role) {
  if (!getToken()) {
    location.replace("index.html");
    throw new Error("redirection");
  }
  const me = await api("/me");
  if (role && me.user.role !== role) {
    location.replace(me.user.role === "exploitant" ? "admin.html" : "driver.html");
    throw new Error("redirection");
  }
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

const statutBadge = (u) =>
  u.suspendu ? `<span class="badge alerte">Suspendu</span>` : `<span class="badge ok">Actif</span>`;
const roleBadge = (u) => `<span class="badge ${u.role === "exploitant" ? "fort" : ""}">${esc(u.role)}</span>`;

// Déconnexion : un seul gestionnaire pour tous les boutons [data-logout]
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-logout]")) logout();
});
