const $ = (id) => document.getElementById(id);
const getToken = () => sessionStorage.getItem("token");

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
    logout();
    throw new Error("Session expirée");
  }
  if (!res.ok) throw new Error(data.error || "Erreur");
  return data;
}

function logout() {
  sessionStorage.clear();
  location.replace("index.html");
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

const fmtH = (min) => `${(min / 60).toFixed(1).replace(".", ",")} h`;
const fmtDate = (d) => new Date(d + "T00:00").toLocaleDateString("fr-FR");
