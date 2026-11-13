import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

// ---------- Constantes ----------
const ROLES = ["conducteur", "exploitant"];
const LIM = {
  matricule: 30,
  nom: 60,
  prenom: 60,
  pseudo: 40,
  ligne: 20,
  details: 5000,
  mdpMin: 8,
  mdpMax: 128,
  lignes: 150,
  rapportsParJour: 50,
};
const SESSION_MS = 12 * 3600e3;
const WINDOW_MS = 15 * 60e3; // fenêtre anti force brute
const MAX_FAILS_ID = 5; // échecs par IP + matricule
const MAX_FAILS_IP = 30; // échecs par IP
const TZ = "Europe/Paris";
const BODY_MAX = 100_000;

const secret = () => process.env.SESSION_SECRET || "";

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
  body: JSON.stringify(body),
});

// ---------- Utilitaires de saisie ----------
const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const hasCtrl = (v) => /[\u0000-\u001f\u007f]/.test(v);
const norm = (v) => str(v).toLowerCase();

// ---------- Mots de passe (scrypt + sel, asynchrone) ----------
const hashPassword = async (pw, salt = crypto.randomBytes(16).toString("hex")) => ({
  salt,
  hash: (await scrypt(pw, salt, 64)).toString("hex"),
});

const checkPassword = async (pw, u) => {
  const { hash } = await hashPassword(pw, u.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(u.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Faux compte utilisé pour que la durée de réponse ne révèle pas si un matricule existe
let dummy;
const getDummy = async () => (dummy ||= await hashPassword("mot-de-passe-factice-inutilise"));

// ---------- Jetons de session signés ----------
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
};

const verify = (token) => {
  try {
    const [body, sig] = (token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof p?.uid !== "string" || !(p.exp > Date.now())) return null;
    return p;
  } catch {
    return null;
  }
};

// ---------- Dates (fuseau Europe/Paris) ----------
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const currentMonth = () => today().slice(0, 7);
const shiftMonth = (ym, delta) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`;
};
const isValidDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutesBetween = (debut, fin) => {
  const [h1, m1] = debut.split(":").map(Number);
  const [h2, m2] = fin.split(":").map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 24 * 60; // service de nuit
  return d;
};

// ---------- Statistiques ----------
const summarize = (list) => {
  const out = { minutes: 0, services: list.length, accidents: 0, lignes: {} };
  for (const r of list) {
    const min = Number(r.minutes) || 0;
    out.minutes += min;
    if (r.accident) out.accidents++;
    const l = (out.lignes[r.ligne] ||= { services: 0, minutes: 0 });
    l.services++;
    l.minutes += min;
  }
  return out;
};
const monthOf = (r) => (typeof r.date === "string" ? r.date.slice(0, 7) : "");
const inMonth = (reports, ym) => reports.filter((r) => monthOf(r) === ym);
// Les 3 mois complets qui précèdent le mois en cours
const previousMonths = (reports, cur) =>
  [1, 2, 3].map((i) => {
    const mois = shiftMonth(cur, -i);
    const { minutes, services, accidents } = summarize(inMonth(reports, mois));
    return { mois, minutes, services, accidents };
  });

// ---------- Données ----------
const store = () => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  // Si les identifiants manuels sont fournis, on les utilise (nécessaire quand
  // le contexte automatique de Netlify Blobs n'est pas injecté dans la fonction).
  if (siteID && token) return getStore({ name: "cheminot", siteID, token });
  return getStore("cheminot");
};

const listAll = async (s, prefix) => {
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean);
};

const getLignes = async (s) => {
  const c = await s.get("config:lignes", { type: "json" });
  return Array.isArray(c?.lignes) ? c.lignes : [];
};

const publicUser = ({ salt, hash, sessionsFrom, ...rest }) => ({ ...rest, suspendu: !!rest.suspendu });

// Crée le compte exploitant à partir des variables d'environnement, s'il n'existe pas encore
const ensureAdmin = async (s) => {
  const m = process.env.ADMIN_MATRICULE;
  const pw = process.env.ADMIN_PASSWORD;
  if (!m || !pw) return;
  if (pw.length < LIM.mdpMin) {
    console.error(`ADMIN_PASSWORD trop court (${LIM.mdpMin} caractères minimum)`);
    return;
  }
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
    ...(await hashPassword(pw)),
  });
};

const validateUser = async (s, b, id) => {
  const matricule = str(b.matricule);
  const nom = str(b.nom);
  const prenom = str(b.prenom);
  const pseudo = str(b.pseudo);
  if (!matricule || !nom || !prenom) return "Matricule, nom et prénom sont obligatoires";
  if (matricule.length > LIM.matricule || nom.length > LIM.nom || prenom.length > LIM.prenom || pseudo.length > LIM.pseudo)
    return "Un des champs est trop long";
  if ([matricule, nom, prenom, pseudo].some(hasCtrl)) return "Caractères non autorisés";
  if (!ROLES.includes(b.role)) return "Rôle invalide";
  if (b.password !== undefined && b.password !== "") {
    if (typeof b.password !== "string") return "Mot de passe invalide";
    if (b.password.length < LIM.mdpMin) return `Mot de passe : ${LIM.mdpMin} caractères minimum`;
    if (b.password.length > LIM.mdpMax) return `Mot de passe : ${LIM.mdpMax} caractères maximum`;
    if (b.password.toLowerCase() === matricule.toLowerCase()) return "Le mot de passe ne doit pas être le matricule";
  } else if (!id) {
    return "Mot de passe obligatoire";
  }
  const users = await listAll(s, "user:");
  if (users.some((u) => norm(u.matricule) === norm(matricule) && u.id !== id)) return "Ce matricule existe déjà";
  return null;
};

const validateLignes = (arr) => {
  if (!Array.isArray(arr)) return { error: "Liste de lignes invalide" };
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const l = str(raw);
    if (!l) continue;
    if (l.length > LIM.ligne) return { error: `Un nom de ligne ne peut pas dépasser ${LIM.ligne} caractères` };
    if (!/^[\p{L}\p{N} ._\-/+]+$/u.test(l)) return { error: "Nom de ligne : lettres, chiffres, espaces et . _ - / + uniquement" };
    if (seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    out.push(l);
  }
  if (out.length > LIM.lignes) return { error: `${LIM.lignes} lignes maximum` };
  out.sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  return { lignes: out };
};

// ---------- Anti force brute (compteurs stockés, IP et matricule hachés) ----------
const hmac = (v) => crypto.createHmac("sha256", secret()).update(v).digest("hex").slice(0, 40);
const clientIp = (h) =>
  h["x-nf-client-connection-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || "inconnue";

const throttleKeys = (ip, matricule) => [
  { key: `rl:ip:${hmac(ip)}`, max: MAX_FAILS_IP },
  { key: `rl:id:${hmac(`${ip}|${matricule.toLowerCase()}`)}`, max: MAX_FAILS_ID },
];
const isLocked = async (s, keys) => {
  for (const { key, max } of keys) {
    const rec = await s.get(key, { type: "json" });
    if (rec && Date.now() - rec.first < WINDOW_MS && rec.count >= max) return true;
  }
  return false;
};
const recordFailure = async (s, keys) => {
  for (const { key } of keys) {
    let rec = await s.get(key, { type: "json" });
    if (!rec || Date.now() - rec.first >= WINDOW_MS) rec = { count: 0, first: Date.now() };
    rec.count++;
    await s.setJSON(key, rec);
  }
};

// ---------- Handler ----------
export const createHandler = (getS) => async (event) => {
  if (secret().length < 32) {
    console.error("SESSION_SECRET absent ou trop court (32 caractères minimum)");
    return json(500, { error: "Erreur de configuration du serveur" });
  }

  const headers = event.headers || {};
  const s = getS();
  const path =
    event.path
      .replace(/^\/\.netlify\/functions\/api/, "")
      .replace(/^\/api/, "")
      .replace(/\/$/, "") || "/";
  const method = event.httpMethod;

  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  if (raw.length > BODY_MAX) return json(413, { error: "Requête trop volumineuse" });
  let body = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Requête invalide" });
    }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "Requête invalide" });
  }

  try {
    // ---------- Connexion ----------
    if (method === "POST" && path === "/login") {
      await ensureAdmin(s);
      const matricule = str(body.matricule);
      const password = typeof body.password === "string" ? body.password : "";
      const bad = () => json(401, { error: "Matricule ou mot de passe incorrect" });
      if (!matricule || !password || matricule.length > LIM.matricule || password.length > LIM.mdpMax) return bad();

      const keys = throttleKeys(clientIp(headers), matricule);
      if (await isLocked(s, keys)) {
        return json(429, { error: "Trop de tentatives. Réessayez dans 15 minutes." });
      }

      const users = await listAll(s, "user:");
      const u = users.find((x) => norm(x.matricule) === norm(matricule));
      const ok = await checkPassword(password, u || (await getDummy()));
      if (!u || !ok) {
        await recordFailure(s, keys);
        return bad();
      }
      if (u.suspendu) {
        return json(403, { error: "Compte suspendu. Contactez l'exploitant.", code: "suspendu" });
      }
      await s.delete(keys[1].key);
      const now = Date.now();
      return json(200, { token: sign({ uid: u.id, iat: now, exp: now + SESSION_MS }), user: publicUser(u) });
    }

    // Tout le reste exige une session valide
    const auth = verify((headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!auth) return json(401, { error: "Non connecté" });

    const me = await s.get(`user:${auth.uid}`, { type: "json" });
    if (!me) return json(401, { error: "Compte introuvable" });
    if (me.suspendu) return json(401, { error: "Compte suspendu", code: "suspendu" });
    if (me.sessionsFrom && !(auth.iat >= me.sessionsFrom)) return json(401, { error: "Session expirée" });
    const isAdmin = me.role === "exploitant";

    // Lignes que les conducteurs peuvent choisir
    if (method === "GET" && path === "/lignes") {
      return json(200, { lignes: await getLignes(s) });
    }

    // Profil + statistiques personnelles
    if (method === "GET" && path === "/me") {
      const reports = await listAll(s, "report:");
      const mine = reports.filter((r) => r.userId === me.id);
      const cur = currentMonth();
      return json(200, {
        user: publicUser(me),
        stats: summarize(mine),
        mois: { mois: cur, ...summarize(inMonth(mine, cur)) },
        precedents: previousMonths(mine, cur),
      });
    }

    // Rapports de service du conducteur connecté
    if (method === "GET" && path === "/reports") {
      const reports = await listAll(s, "report:");
      const mine = reports
        .filter((r) => r.userId === me.id)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.debut).localeCompare(String(a.debut)));
      return json(200, mine);
    }

    if (method === "POST" && path === "/reports") {
      const date = str(body.date);
      const ligne = str(body.ligne);
      const debut = str(body.debut);
      const fin = str(body.fin);
      if (!date || !ligne || !debut || !fin) {
        return json(400, { error: "Date, ligne, heure de début et de fin sont obligatoires" });
      }
      if (!isValidDate(date) || date < "2020-01-01") return json(400, { error: "Date invalide" });
      if (date > today()) return json(400, { error: "La date ne peut pas être dans le futur" });
      if (!TIME_RE.test(debut) || !TIME_RE.test(fin)) return json(400, { error: "Horaires invalides" });
      if (debut === fin) return json(400, { error: "L'heure de fin doit être différente de l'heure de début" });
      const lignes = await getLignes(s);
      if (!lignes.includes(ligne)) {
        return json(400, { error: "Cette ligne n'est pas disponible : choisissez-en une dans la liste" });
      }

      const reports = await listAll(s, "report:");
      const since = Date.now() - 24 * 3600e3;
      const recent = reports.filter((r) => r.userId === me.id && Date.parse(r.createdAt) > since).length;
      if (recent >= LIM.rapportsParJour) {
        return json(429, { error: "Trop de rapports envoyés aujourd'hui. Réessayez plus tard." });
      }

      const accident = body.accident === true;
      const id = crypto.randomUUID();
      const report = {
        id,
        userId: me.id,
        date,
        ligne,
        debut,
        fin,
        minutes: minutesBetween(debut, fin),
        accident,
        details: accident ? String(body.details ?? "").slice(0, LIM.details) : "",
        createdAt: new Date().toISOString(),
      };
      await s.setJSON(`report:${id}`, report);
      return json(201, report);
    }

    // ---------- Espace exploitant ----------
    if (path.startsWith("/admin")) {
      if (!isAdmin) return json(403, { error: "Accès réservé à l'exploitant" });

      // Récap global du mois en cours (repart à zéro chaque mois) + 3 mois précédents
      if (method === "GET" && path === "/admin/overview") {
        const [users, reports] = await Promise.all([listAll(s, "user:"), listAll(s, "report:")]);
        const cur = currentMonth();
        return json(200, {
          mois: cur,
          courant: summarize(inMonth(reports, cur)),
          precedents: previousMonths(reports, cur),
          comptes: {
            total: users.length,
            suspendus: users.filter((u) => u.suspendu).length,
          },
        });
      }

      // Liste des comptes (recherche faite côté navigateur)
      if (method === "GET" && path === "/admin/users") {
        const [users, reports] = await Promise.all([listAll(s, "user:"), listAll(s, "report:")]);
        const cur = currentMonth();
        const byUser = new Map();
        for (const r of reports) {
          if (!byUser.has(r.userId)) byUser.set(r.userId, []);
          byUser.get(r.userId).push(r);
        }
        return json(
          200,
          users
            .map((u) => {
              const mine = byUser.get(u.id) || [];
              const m = summarize(inMonth(mine, cur));
              const t = summarize(mine);
              return {
                ...publicUser(u),
                mois: { minutes: m.minutes, services: m.services },
                total: { minutes: t.minutes, services: t.services },
              };
            })
            .sort((a, b) => a.matricule.localeCompare(b.matricule, "fr", { numeric: true }))
        );
      }

      // Création d'un compte
      if (method === "POST" && path === "/admin/users") {
        const err = await validateUser(s, body, null);
        if (err) return json(400, { error: err });
        const id = crypto.randomUUID();
        const user = {
          id,
          matricule: str(body.matricule),
          nom: str(body.nom),
          prenom: str(body.prenom),
          pseudo: str(body.pseudo),
          role: body.role,
          suspendu: false,
          ...(await hashPassword(body.password)),
        };
        await s.setJSON(`user:${id}`, user);
        return json(201, publicUser(user));
      }

      // Liste des lignes disponibles pour les conducteurs
      if (method === "PUT" && path === "/admin/lignes") {
        const { error, lignes } = validateLignes(body.lignes);
        if (error) return json(400, { error });
        await s.setJSON("config:lignes", { lignes, updatedAt: new Date().toISOString() });
        return json(200, { lignes });
      }

      // Suspension / réactivation
      const mSus = path.match(/^\/admin\/users\/([\w-]{1,64})\/suspend$/);
      if (method === "POST" && mSus) {
        const target = await s.get(`user:${mSus[1]}`, { type: "json" });
        if (!target) return json(404, { error: "Compte introuvable" });
        if (target.id === me.id) return json(400, { error: "Vous ne pouvez pas suspendre votre propre compte" });
        if (typeof body.suspendu !== "boolean") return json(400, { error: "Requête invalide" });
        const updated = { ...target, suspendu: body.suspendu };
        if (body.suspendu) updated.sessionsFrom = Date.now(); // coupe les sessions en cours
        await s.setJSON(`user:${target.id}`, updated);
        return json(200, publicUser(updated));
      }

      const mUser = path.match(/^\/admin\/users\/([\w-]{1,64})$/);

      // Profil détaillé d'un conducteur
      if (method === "GET" && mUser) {
        const target = await s.get(`user:${mUser[1]}`, { type: "json" });
        if (!target) return json(404, { error: "Compte introuvable" });
        const reports = await listAll(s, "report:");
        const mine = reports
          .filter((r) => r.userId === target.id)
          .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.debut).localeCompare(String(a.debut)));
        const cur = currentMonth();
        return json(200, {
          user: publicUser(target),
          total: summarize(mine),
          mois: { mois: cur, ...summarize(inMonth(mine, cur)) },
          precedents: previousMonths(mine, cur),
          recents: mine.slice(0, 20),
        });
      }

      // Suppression du profil et de tous ses rapports
      if (method === "DELETE" && mUser) {
        const target = await s.get(`user:${mUser[1]}`, { type: "json" });
        if (!target) return json(404, { error: "Compte introuvable" });
        if (target.id === me.id) return json(400, { error: "Vous ne pouvez pas supprimer votre propre compte" });
        const reports = await listAll(s, "report:");
        await Promise.all(reports.filter((r) => r.userId === target.id).map((r) => s.delete(`report:${r.id}`)));
        await s.delete(`user:${target.id}`);
        return json(200, { ok: true });
      }

      // Modification d'un compte (matricule, rôle, pseudo Roblox, mot de passe...)
      if (method === "PUT" && mUser) {
        const target = await s.get(`user:${mUser[1]}`, { type: "json" });
        if (!target) return json(404, { error: "Compte introuvable" });
        if (target.id === me.id && body.role && body.role !== "exploitant") {
          return json(400, { error: "Vous ne pouvez pas retirer votre propre rôle exploitant" });
        }

        const merged = { ...target, ...body };
        const err = await validateUser(s, merged, target.id);
        if (err) return json(400, { error: err });

        const updated = {
          ...target,
          matricule: str(merged.matricule),
          nom: str(merged.nom),
          prenom: str(merged.prenom),
          pseudo: str(merged.pseudo),
          role: merged.role,
        };
        const pwChanged = typeof body.password === "string" && body.password !== "";
        if (pwChanged) Object.assign(updated, await hashPassword(body.password));
        // Mot de passe ou rôle modifié : les anciennes sessions ne sont plus valables
        if (pwChanged || updated.role !== target.role) updated.sessionsFrom = Date.now();

        await s.setJSON(`user:${target.id}`, updated);
        return json(200, { ...publicUser(updated), reauth: target.id === me.id && pwChanged });
      }
    }

    return json(404, { error: "Route inconnue" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Erreur serveur" });
  }
};

export const handler = createHandler(store);
