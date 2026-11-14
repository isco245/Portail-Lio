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
  discord: 40,
  note: 1000,
  vehicule: 60,
  vehicules: 100,
  ligne: 20,
  details: 5000,
  mdpMin: 8,
  mdpMax: 128,
  lignes: 150,
  rapportsParJour: 50,
};
const COULEUR_DEFAUT = "#0b2149";
const COULEUR_RE = /^#[0-9a-f]{6}$/i;
const ACCIDENT_TYPES = ["routier", "voyageur", "externe"];
const NOTE_TYPES = ["information", "attention", "perturbation", "danger"];
const PLAQUE_RE = /^[A-Z0-9][A-Z0-9 -]{1,14}$/;
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

// Les lignes sont des objets { nom, couleur } (les anciennes listes de simples noms restent lisibles)
const normLignes = (c) =>
  Array.isArray(c?.lignes)
    ? c.lignes
        .map((l) =>
          typeof l === "string"
            ? { nom: l, couleur: COULEUR_DEFAUT }
            : { nom: String(l?.nom ?? ""), couleur: COULEUR_RE.test(l?.couleur) ? l.couleur.toLowerCase() : COULEUR_DEFAUT }
        )
        .filter((l) => l.nom)
    : [];
const getLignes = async (s) => normLignes(await s.get("config:lignes", { type: "json" }));

// Note de service (une seule à la fois)
const getNote = async (s) => {
  const n = await s.get("config:note", { type: "json" });
  return n && NOTE_TYPES.includes(n.type) && typeof n.texte === "string" && n.texte ? n : null;
};

// Véhicules : catalogue défini par les exploitants, activation + plaque par conducteur
const getVehicules = async (s) => {
  const c = await s.get("config:vehicules", { type: "json" });
  return Array.isArray(c?.vehicules) ? c.vehicules.filter((v) => typeof v?.id === "string" && typeof v?.nom === "string") : [];
};
const getUserVeh = async (s, uid) => {
  const c = await s.get(`veh:${uid}`, { type: "json" });
  return c && typeof c.items === "object" && c.items ? c.items : {};
};
const normPlaque = (v) => str(v).toUpperCase().replace(/\s+/g, " ");

const publicUser = ({ salt, hash, sessionsFrom, ...rest }) => ({ ...rest, discord: rest.discord || "", suspendu: !!rest.suspendu });

// Crée le compte exploitant à partir des variables d'environnement, s'il n'existe pas encore.
// Une fois vérifié, on ne relit plus la liste des comptes à chaque connexion (même instance).
let adminVerifie = false;
const ensureAdmin = async (s) => {
  if (adminVerifie) return;
  const m = process.env.ADMIN_MATRICULE;
  const pw = process.env.ADMIN_PASSWORD;
  if (!m || !pw) return;
  if (pw.length < LIM.mdpMin) {
    console.error(`ADMIN_PASSWORD trop court (${LIM.mdpMin} caractères minimum)`);
    return;
  }
  const users = await listAll(s, "user:");
  if (users.some((u) => u.role === "exploitant")) {
    adminVerifie = true;
    return;
  }
  const id = crypto.randomUUID();
  await s.setJSON(`user:${id}`, {
    id,
    matricule: m,
    nom: "Exploitant",
    prenom: "Admin",
    pseudo: "",
    discord: "",
    role: "exploitant",
    ...(await hashPassword(pw)),
  });
  adminVerifie = true;
};

const validateUser = async (s, b, id) => {
  const matricule = str(b.matricule);
  const nom = str(b.nom);
  const prenom = str(b.prenom);
  const pseudo = str(b.pseudo);
  const discord = str(b.discord);
  if (!matricule || !nom || !prenom) return "Matricule, nom et prénom sont obligatoires";
  if (matricule.length > LIM.matricule || nom.length > LIM.nom || prenom.length > LIM.prenom || pseudo.length > LIM.pseudo || discord.length > LIM.discord)
    return "Un des champs est trop long";
  if ([matricule, nom, prenom, pseudo, discord].some(hasCtrl)) return "Caractères non autorisés";
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
    const l = str(typeof raw === "object" && raw !== null ? raw.nom : raw);
    if (!l) continue;
    if (l.length > LIM.ligne) return { error: `Un nom de ligne ne peut pas dépasser ${LIM.ligne} caractères` };
    if (!/^[\p{L}\p{N} ._\-/+]+$/u.test(l)) return { error: "Nom de ligne : lettres, chiffres, espaces et . _ - / + uniquement" };
    let couleur = COULEUR_DEFAUT;
    if (typeof raw === "object" && raw !== null && raw.couleur !== undefined && raw.couleur !== "") {
      if (typeof raw.couleur !== "string" || !COULEUR_RE.test(raw.couleur)) return { error: "Couleur invalide" };
      couleur = raw.couleur.toLowerCase();
    }
    if (seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    out.push({ nom: l, couleur });
  }
  if (out.length > LIM.lignes) return { error: `${LIM.lignes} lignes maximum` };
  out.sort((a, b) => a.nom.localeCompare(b.nom, "fr", { numeric: true }));
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

    // Mot de passe provisoire : tant qu'il n'est pas remplacé, seul le profil et le changement de mot de passe sont accessibles
    // (la liste des lignes, non personnelle, reste lisible pour que la page se prépare)
    const estPourChangement =
      (method === "GET" && (path === "/me" || path === "/lignes")) || (method === "PUT" && path === "/me/password");
    if (me.mustChangePassword && !estPourChangement) {
      return json(403, { error: "Vous devez d'abord définir un nouveau mot de passe", code: "mdp_provisoire" });
    }

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
        note: await getNote(s),
        stats: summarize(mine),
        mois: { mois: cur, ...summarize(inMonth(mine, cur)) },
        precedents: previousMonths(mine, cur),
      });
    }

    // Le conducteur change lui-même ses pseudos Roblox et Discord
    if (method === "PUT" && path === "/me") {
      const pseudo = str(body.pseudo);
      const discord = str(body.discord);
      if (pseudo.length > LIM.pseudo || discord.length > LIM.discord) return json(400, { error: "Un des champs est trop long" });
      if ([pseudo, discord].some(hasCtrl)) return json(400, { error: "Caractères non autorisés" });
      const updated = { ...me, pseudo, discord };
      await s.setJSON(`user:${me.id}`, updated);
      return json(200, { user: publicUser(updated) });
    }

    // Le conducteur définit son propre mot de passe (obligatoire après un mot de passe provisoire)
    if (method === "PUT" && path === "/me/password") {
      const actuel = typeof body.actuel === "string" ? body.actuel : "";
      const nouveau = typeof body.nouveau === "string" ? body.nouveau : "";
      if (!actuel || !nouveau) return json(400, { error: "Renseignez le mot de passe provisoire et le nouveau mot de passe" });
      if (actuel.length > LIM.mdpMax || nouveau.length > LIM.mdpMax) return json(400, { error: `Mot de passe : ${LIM.mdpMax} caractères maximum` });
      if (!(await checkPassword(actuel, me))) return json(400, { error: "Mot de passe provisoire incorrect" });
      if (nouveau.length < LIM.mdpMin) return json(400, { error: `Mot de passe : ${LIM.mdpMin} caractères minimum` });
      if (nouveau === actuel) return json(400, { error: "Le nouveau mot de passe doit être différent du provisoire" });
      if (nouveau.toLowerCase() === me.matricule.toLowerCase()) return json(400, { error: "Le mot de passe ne doit pas être le matricule" });

      // Les anciennes sessions sont coupées ; on remet un jeton valide pour l'appareil en cours
      const now = Date.now();
      const updated = { ...me, mustChangePassword: false, sessionsFrom: now, ...(await hashPassword(nouveau)) };
      await s.setJSON(`user:${me.id}`, updated);
      return json(200, {
        user: publicUser(updated),
        token: sign({ uid: me.id, iat: now, exp: now + SESSION_MS }),
      });
    }

    // Véhicules : catalogue + ceux activés par le conducteur
    if (method === "GET" && path === "/vehicules") {
      const [cat, mine] = await Promise.all([getVehicules(s), getUserVeh(s, me.id)]);
      cat.sort((a, b) => a.nom.localeCompare(b.nom, "fr", { numeric: true }));
      return json(200, {
        vehicules: cat.map((v) => ({ id: v.id, nom: v.nom, actif: !!mine[v.id], plaque: mine[v.id]?.plaque || "" })),
      });
    }
    const mVeh = path.match(/^\/vehicules\/([\w-]{1,64})$/);
    if (method === "PUT" && mVeh) {
      if (typeof body.actif !== "boolean") return json(400, { error: "Requête invalide" });
      const v = (await getVehicules(s)).find((x) => x.id === mVeh[1]);
      if (!v) return json(404, { error: "Véhicule introuvable" });
      const items = await getUserVeh(s, me.id);
      let plaque = "";
      if (body.actif) {
        plaque = normPlaque(body.plaque);
        if (!plaque) return json(400, { error: "La plaque d'immatriculation est obligatoire" });
        if (!PLAQUE_RE.test(plaque)) return json(400, { error: "Plaque : lettres, chiffres, tirets et espaces (2 à 15 caractères)" });
        items[v.id] = { plaque, at: new Date().toISOString() };
      } else {
        delete items[v.id];
      }
      await s.setJSON(`veh:${me.id}`, { items });
      return json(200, { id: v.id, nom: v.nom, actif: body.actif, plaque });
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
      if (!lignes.some((l) => l.nom === ligne)) {
        return json(400, { error: "Cette ligne n'est pas disponible : choisissez-en une dans la liste" });
      }

      const reports = await listAll(s, "report:");
      const since = Date.now() - 24 * 3600e3;
      const recent = reports.filter((r) => r.userId === me.id && Date.parse(r.createdAt) > since).length;
      if (recent >= LIM.rapportsParJour) {
        return json(429, { error: "Trop de rapports envoyés aujourd'hui. Réessayez plus tard." });
      }

      const accident = body.accident === true;
      const details = accident ? String(body.details ?? "").trim() : "";
      const accidentType = accident ? str(body.accidentType) : "";
      if (accident) {
        if (!ACCIDENT_TYPES.includes(accidentType)) {
          return json(400, { error: "Choisissez le type d'accident : routier, voyageur ou externe" });
        }
        if (!details) return json(400, { error: "La description de l'accident est obligatoire" });
      }
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
        accidentType,
        details: details.slice(0, LIM.details),
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
          discord: str(body.discord),
          role: body.role,
          suspendu: false,
          // Mot de passe provisoire : le conducteur doit le remplacer à sa première connexion
          mustChangePassword: body.provisoire === true,
          ...(await hashPassword(body.password)),
        };
        await s.setJSON(`user:${id}`, user);
        return json(201, publicUser(user));
      }

      // Note de service (affichée en haut de l'espace de tous les utilisateurs)
      if (method === "PUT" && path === "/admin/note") {
        const type = str(body.type);
        const texte = String(body.texte ?? "").trim();
        if (!NOTE_TYPES.includes(type)) return json(400, { error: "Type de note invalide" });
        if (!texte) return json(400, { error: "Le texte de la note est obligatoire" });
        if (texte.length > LIM.note) return json(400, { error: `La note ne peut pas dépasser ${LIM.note} caractères` });
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(texte)) return json(400, { error: "Caractères non autorisés" });
        const note = { type, texte, updatedAt: new Date().toISOString() };
        await s.setJSON("config:note", note);
        return json(200, { note });
      }
      if (method === "DELETE" && path === "/admin/note") {
        await s.delete("config:note");
        return json(200, { ok: true });
      }

      // Catalogue des véhicules (les conducteurs les activent et saisissent leur plaque)
      if (method === "GET" && path === "/admin/vehicules") {
        const [cat, all] = await Promise.all([getVehicules(s), listAll(s, "veh:")]);
        const nb = {};
        for (const u of all) for (const id of Object.keys(u.items || {})) nb[id] = (nb[id] || 0) + 1;
        cat.sort((a, b) => a.nom.localeCompare(b.nom, "fr", { numeric: true }));
        return json(200, { vehicules: cat.map((v) => ({ ...v, actifs: nb[v.id] || 0 })) });
      }
      if (method === "POST" && path === "/admin/vehicules") {
        const nom = str(body.nom);
        if (!nom) return json(400, { error: "Le nom du véhicule est obligatoire" });
        if (nom.length > LIM.vehicule) return json(400, { error: `Nom du véhicule : ${LIM.vehicule} caractères maximum` });
        if (hasCtrl(nom)) return json(400, { error: "Caractères non autorisés" });
        const cat = await getVehicules(s);
        if (cat.some((v) => norm(v.nom) === norm(nom))) return json(400, { error: "Ce véhicule existe déjà" });
        if (cat.length >= LIM.vehicules) return json(400, { error: `${LIM.vehicules} véhicules maximum` });
        cat.push({ id: crypto.randomUUID(), nom });
        await s.setJSON("config:vehicules", { vehicules: cat, updatedAt: new Date().toISOString() });
        return json(201, { vehicules: cat });
      }
      const mDelVeh = path.match(/^\/admin\/vehicules\/([\w-]{1,64})$/);
      if (method === "DELETE" && mDelVeh) {
        const cat = await getVehicules(s);
        if (!cat.some((v) => v.id === mDelVeh[1])) return json(404, { error: "Véhicule introuvable" });
        const rest = cat.filter((v) => v.id !== mDelVeh[1]);
        await s.setJSON("config:vehicules", { vehicules: rest, updatedAt: new Date().toISOString() });
        return json(200, { vehicules: rest });
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
        const [cat, items] = await Promise.all([getVehicules(s), getUserVeh(s, target.id)]);
        return json(200, {
          user: publicUser(target),
          vehicules: cat.filter((v) => items[v.id]).map((v) => ({ id: v.id, nom: v.nom, plaque: items[v.id].plaque })),
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
        await s.delete(`veh:${target.id}`);
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
          discord: str(merged.discord),
          role: merged.role,
        };
        const pwChanged = typeof body.password === "string" && body.password !== "";
        if (pwChanged) Object.assign(updated, await hashPassword(body.password));
        // Nouveau mot de passe : provisoire seulement si l'exploitant le demande ; sinon le drapeau reste tel quel
        updated.mustChangePassword = pwChanged ? body.provisoire === true : !!target.mustChangePassword;
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
