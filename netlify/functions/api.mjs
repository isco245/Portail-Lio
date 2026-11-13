import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const SECRET = process.env.SESSION_SECRET || "";
const ROLES = ["conducteur", "exploitant"];

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------- Mots de passe ----------
const hashPassword = (pw, salt = crypto.randomBytes(16).toString("hex")) => ({
  salt,
  hash: crypto.scryptSync(pw, salt, 64).toString("hex"),
});

const checkPassword = (pw, u) => {
  const { hash } = hashPassword(pw, u.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(u.hash, "hex"));
};

// ---------- Jetons de session signés ----------
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
};

const verify = (token) => {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  return p.exp > Date.now() ? p : null;
};

// ---------- Données ----------
const store = () => getStore("cheminot");

const listAll = async (s, prefix) => {
  const { blobs } = await s.list({ prefix });
  return Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
};

const minutesBetween = (debut, fin) => {
  const [h1, m1] = debut.split(":").map(Number);
  const [h2, m2] = fin.split(":").map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 24 * 60; // service de nuit
  return d;
};

const summarize = (list) => {
  const out = { minutes: 0, services: list.length, accidents: 0, lignes: {} };
  for (const r of list) {
    out.minutes += r.minutes;
    if (r.accident) out.accidents++;
    const l = (out.lignes[r.ligne] ||= { services: 0, minutes: 0 });
    l.services++;
    l.minutes += r.minutes;
  }
  return out;
};

const publicUser = ({ salt, hash, ...rest }) => rest;

// Crée le compte exploitant à partir des variables d'environnement, s'il n'existe pas encore
const ensureAdmin = async (s) => {
  const m = process.env.ADMIN_MATRICULE;
  const pw = process.env.ADMIN_PASSWORD;
  if (!m || !pw) return;
  const users = await listAll(s, "user:");
  if (users.some((u) => u.role === "exploitant")) return;
  const id = crypto.randomUUID();
  await s.setJSON(`user:${id}`, {
    id,
    matricule: m,
    nom: "Exploitant",
    prenom: "Admin",
    pseudo: "",
    role: "exploitant",
    ...hashPassword(pw),
  });
};

const validateUser = async (s, b, id) => {
  const matricule = String(b.matricule || "").trim();
  if (!matricule || !String(b.nom || "").trim() || !String(b.prenom || "").trim())
    return "Matricule, nom et prénom sont obligatoires";
  if (!ROLES.includes(b.role)) return "Rôle invalide";
  if (b.password && String(b.password).length < 6) return "Mot de passe : 6 caractères minimum";
  if (!id && !b.password) return "Mot de passe obligatoire";
  const users = await listAll(s, "user:");
  if (users.some((u) => u.matricule === matricule && u.id !== id)) return "Ce matricule existe déjà";
  return null;
};

// ---------- Handler ----------
export const handler = async (event) => {
  if (!SECRET) return json(500, { error: "SESSION_SECRET manquant dans les variables Netlify" });

  const s = store();
  const path =
    event.path
      .replace(/^\/\.netlify\/functions\/api/, "")
      .replace(/^\/api/, "")
      .replace(/\/$/, "") || "/";
  const method = event.httpMethod;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "Requête invalide" });
  }

  try {
    // Connexion
    if (method === "POST" && path === "/login") {
      await ensureAdmin(s);
      const users = await listAll(s, "user:");
      const u = users.find((x) => x.matricule === String(body.matricule || "").trim());
      if (!u || !checkPassword(String(body.password || ""), u)) {
        return json(401, { error: "Matricule ou mot de passe incorrect" });
      }
      const token = sign({ uid: u.id, exp: Date.now() + 12 * 3600e3 });
      return json(200, { token, user: publicUser(u) });
    }

    // Tout le reste exige une session valide
    const auth = verify((event.headers.authorization || "").replace("Bearer ", ""));
    if (!auth) return json(401, { error: "Non connecté" });

    const me = await s.get(`user:${auth.uid}`, { type: "json" });
    if (!me) return json(401, { error: "Compte introuvable" });
    const isAdmin = me.role === "exploitant";

    // Profil + statistiques personnelles
    if (method === "GET" && path === "/me") {
      const reports = await listAll(s, "report:");
      const mine = reports.filter((r) => r.userId === me.id);
      return json(200, { user: publicUser(me), stats: summarize(mine) });
    }

    // Rapports de service du conducteur connecté
    if (method === "GET" && path === "/reports") {
      const reports = await listAll(s, "report:");
      const mine = reports
        .filter((r) => r.userId === me.id)
        .sort((a, b) => b.date.localeCompare(a.date) || b.debut.localeCompare(a.debut));
      return json(200, mine);
    }

    if (method === "POST" && path === "/reports") {
      const { date, ligne, debut, fin, accident, details } = body;
      if (!date || !String(ligne || "").trim() || !debut || !fin) {
        return json(400, { error: "Date, ligne, heure de début et de fin sont obligatoires" });
      }
      const id = crypto.randomUUID();
      const report = {
        id,
        userId: me.id,
        date,
        ligne: String(ligne).trim(),
        debut,
        fin,
        minutes: minutesBetween(debut, fin),
        accident: !!accident,
        details: accident ? String(details || "").slice(0, 5000) : "",
        createdAt: new Date().toISOString(),
      };
      await s.setJSON(`report:${id}`, report);
      return json(201, report);
    }

    // ---------- Espace exploitant ----------
    if (path.startsWith("/admin")) {
      if (!isAdmin) return json(403, { error: "Accès réservé à l'exploitant" });

      // Récap global + liste des conducteurs avec leurs statistiques
      if (method === "GET" && path === "/admin/overview") {
        const [users, reports] = await Promise.all([listAll(s, "user:"), listAll(s, "report:")]);
        return json(200, {
          totals: summarize(reports),
          users: users
            .map((u) => ({
              ...publicUser(u),
              stats: summarize(reports.filter((r) => r.userId === u.id)),
            }))
            .sort((a, b) => a.matricule.localeCompare(b.matricule)),
        });
      }

      // Création d'un compte
      if (method === "POST" && path === "/admin/users") {
        const err = await validateUser(s, body, null);
        if (err) return json(400, { error: err });
        const id = crypto.randomUUID();
        const user = {
          id,
          matricule: String(body.matricule).trim(),
          nom: String(body.nom).trim(),
          prenom: String(body.prenom).trim(),
          pseudo: String(body.pseudo || "").trim(),
          role: body.role,
          ...hashPassword(String(body.password)),
        };
        await s.setJSON(`user:${id}`, user);
        return json(201, publicUser(user));
      }

      // Modification d'un compte (matricule, rôle, pseudo Roblox, mot de passe...)
      const m = path.match(/^\/admin\/users\/([\w-]+)$/);
      if (method === "PUT" && m) {
        const target = await s.get(`user:${m[1]}`, { type: "json" });
        if (!target) return json(404, { error: "Compte introuvable" });
        if (target.id === me.id && body.role && body.role !== "exploitant") {
          return json(400, { error: "Vous ne pouvez pas retirer votre propre rôle exploitant" });
        }

        const merged = { ...target, ...body };
        const err = await validateUser(s, merged, target.id);
        if (err) return json(400, { error: err });

        const updated = {
          ...target,
          matricule: String(merged.matricule).trim(),
          nom: String(merged.nom).trim(),
          prenom: String(merged.prenom).trim(),
          pseudo: String(merged.pseudo || "").trim(),
          role: merged.role,
        };
        if (body.password) Object.assign(updated, hashPassword(String(body.password)));

        await s.setJSON(`user:${target.id}`, updated);
        return json(200, publicUser(updated));
      }
    }

    return json(404, { error: "Route inconnue" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Erreur serveur" });
  }
};
