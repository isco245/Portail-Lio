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
  vehiculesParRapport: 10,
  lignesParRapport: 10,
  commentaire: 1000,
  sessionNom: 60,
  sessions: 500,
  sessionHeures: 72,
};
const COLOR_ROUGE = 0xc10130;
const COLOR_BLEU = 0x0b2149;
const SITE_URL = "https://portail-lio.netlify.app";
const COULEUR_DEFAUT = "#0b2149";
const COULEUR_RE = /^#[0-9a-f]{6}$/i;
const ACCIDENT_TYPES = ["routier", "voyageur", "externe"];
const ACCIDENT_LABELS = { routier: "accident routier", voyageur: "accident voyageur", externe: "accident externe" };
const NOTE_TYPES = ["information", "attention", "perturbation", "danger"];
const PLAQUE_RE = /^[A-Z0-9][A-Z0-9 -]{1,14}$/;
const SESSION_MS = 12 * 3600e3;
const REMEMBER_MS = 15 * 24 * 3600e3; // « Se souvenir de moi » : 15 jours
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

// Heure « murale » de Paris -> timestamp (gère l'heure d'été)
const parisParts = (ms) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const parisOffset = (ms) => {
  const { date, time } = parisParts(ms);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / 60000) * 60000;
};
const parisMs = (date, time) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  return asUtc - parisOffset(asUtc - parisOffset(asUtc));
};

const minutesBetween = (debut, fin) => {
  const [h1, m1] = debut.split(":").map(Number);
  const [h2, m2] = fin.split(":").map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 24 * 60; // service de nuit
  return d;
};

// ---------- Statistiques ----------
// Un rapport peut couvrir plusieurs lignes (anciens rapports : une seule)
const lignesOf = (r) => (Array.isArray(r.lignes) && r.lignes.length ? r.lignes : r.ligne ? [r.ligne] : []);
const summarize = (list) => {
  const out = { minutes: 0, services: list.length, accidents: 0, lignes: {} };
  for (const r of list) {
    const min = Number(r.minutes) || 0;
    out.minutes += min;
    if (r.accident) out.accidents++;
    const ls = lignesOf(r);
    for (const nom of ls) {
      // Par ligne : nombre de services seulement (pas de durée par ligne)
      const l = (out.lignes[nom] ||= { services: 0 });
      l.services++;
    }
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
export const store = () => {
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
// Véhicules activés de tous les conducteurs : Map(uid -> items)
const listVeh = async (s) => {
  const { blobs } = await s.list({ prefix: "veh:" });
  const rows = await Promise.all(blobs.map(async (b) => [b.key.slice(4), await s.get(b.key, { type: "json" })]));
  return new Map(rows.filter(([, c]) => c && typeof c.items === "object" && c.items).map(([uid, c]) => [uid, c.items]));
};
const normPlaque = (v) => str(v).toUpperCase().replace(/\s+/g, " ");

// Unicité du matricule : on ignore casse, accents et espaces, et on réserve la clé dans la base
const matNorm = (m) => str(m).normalize("NFKD").replace(/[\u0300-\u036f\s]/g, "").toLowerCase();
const matKey = (m) => `mat:${crypto.createHash("sha256").update(matNorm(m)).digest("hex").slice(0, 32)}`;
// Réserve le matricule pour ce compte. Renvoie false s'il est déjà attribué à un autre compte.
const claimMatricule = async (s, matricule, userId) => {
  const key = matKey(matricule);
  const cur = await s.get(key, { type: "json" });
  if (cur && cur.id !== userId) {
    const owner = await s.get(`user:${cur.id}`, { type: "json" });
    if (owner && matKey(owner.matricule) === key) return false; // vraiment pris
  }
  if (cur) {
    if (cur.id !== userId) await s.setJSON(key, { id: userId }); // ancienne réservation orpheline
    return true;
  }
  const res = await s.setJSON(key, { id: userId }, { onlyIfNew: true });
  return !(res && res.modified === false); // false si quelqu'un l'a réservé entre-temps
};
const releaseMatricule = async (s, matricule, userId) => {
  const cur = await s.get(matKey(matricule), { type: "json" });
  if (cur && cur.id === userId) await s.delete(matKey(matricule));
};

// ---------- Discord (webhook défini uniquement par variable d'environnement) ----------
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
const clip = (v, n) => {
  const t = String(v ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sendDiscord = async (embed, { accident = false } = {}) => {
  const url = (accident && process.env.DISCORD_WEBHOOK_ACCIDENTS) || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  if (!WEBHOOK_RE.test(url)) {
    console.error("DISCORD_WEBHOOK_URL invalide");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Portail liO", embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) console.error("Webhook Discord refusé", res.status);
    return res.ok;
  } catch (e) {
    console.error("Webhook Discord injoignable", e?.message);
    return false;
  }
};
const fmtDateFr = (d) => d.split("-").reverse().join("/");
const fmtHeures = (min) => `${((Number(min) || 0) / 60).toFixed(1).replace(".", ",")} h`;

const notifyAccident = (r, u) =>
  sendDiscord(
    {
      title: `🚨 Accident déclaré : ${ACCIDENT_LABELS[r.accidentType] || "accident"}`,
      color: COLOR_ROUGE,
      fields: [
        { name: "Conducteur", value: clip(`${u.prenom} ${u.nom}`, 200), inline: true },
        { name: "Matricule", value: clip(u.matricule, 100), inline: true },
        { name: lignesOf(r).length > 1 ? "Lignes" : "Ligne", value: clip(lignesOf(r).join(", "), 100), inline: true },
        { name: "Date", value: fmtDateFr(r.date), inline: true },
        { name: "Horaires", value: `${r.debut} – ${r.fin}`, inline: true },
        { name: "Véhicule(s)", value: clip((r.vehicules || []).map((v) => `${v.nom} (${v.plaque})`).join(", ") || "Non renseigné", 1000), inline: true },
        { name: "Description", value: clip(r.details, 1024) },
        ...(r.commentaire ? [{ name: "Commentaire", value: clip(r.commentaire, 1024) }] : []),
      ],
      timestamp: r.createdAt,
      footer: { text: "Portail conducteurs liO" },
    },
    { accident: true }
  );

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
  await claimMatricule(s, m, id);
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
  if (users.some((u) => matKey(u.matricule) === matKey(matricule) && u.id !== id)) return "Ce matricule est déjà attribué à un autre compte";
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

// ---------- Sessions (créneaux définis par les exploitants) ----------
const reportWindow = (r) => {
  if (!isValidDate(r.date) || !TIME_RE.test(r.debut || "")) return null;
  const start = parisMs(r.date, r.debut);
  return { start, end: start + (Number(r.minutes) || 0) * 60000 };
};

// Récap d'une session : seuls les services qui chevauchent le créneau comptent (et seulement la part dans le créneau)
const sessionRecap = (sess, reports, usersById) => {
  const out = { conducteurs: [], services: 0, minutes: 0, accidents: 0, lignes: {}, vehicules: [] };
  const byUser = new Map();
  const veh = new Set();
  for (const r of reports) {
    const w = r._w === undefined ? reportWindow(r) : r._w;
    if (!w) continue;
    const overlap = Math.min(w.end, sess.endMs) - Math.max(w.start, sess.startMs);
    if (overlap <= 0) continue;
    const min = Math.round(overlap / 60000);
    const u = usersById.get(r.userId);
    let d = byUser.get(r.userId);
    if (!d) {
      d = { id: r.userId, matricule: u?.matricule || "?", nom: u?.nom || "Compte supprimé", prenom: u?.prenom || "", services: 0, minutes: 0, accidents: 0, lignes: {} };
      byUser.set(r.userId, d);
    }
    d.services++;
    d.minutes += min;
    for (const nom of lignesOf(r)) d.lignes[nom] = (d.lignes[nom] || 0) + 1;
    if (r.accident) d.accidents++;
    out.services++;
    out.minutes += min;
    if (r.accident) out.accidents++;
    for (const nom of lignesOf(r)) out.lignes[nom] = (out.lignes[nom] || 0) + 1;
    for (const v of r.vehicules || []) veh.add(`${v.nom} (${v.plaque})`);
  }
  out.conducteurs = [...byUser.values()].sort((a, b) => b.minutes - a.minutes);
  out.vehicules = [...veh].sort();
  return out;
};

const sessionStatut = (sess, now = Date.now()) => (now < sess.startMs ? "a_venir" : now < sess.endMs ? "en_cours" : "terminee");
const sessionTitre = (sess) => sess.nom || `Session du ${fmtDateFr(sess.debut.slice(0, 10))}`;

const sendSessionRecap = async (sess, recap) => {
  const lignes = Object.entries(recap.lignes).sort((a, b) => b[1] - a[1]).map(([l, n]) => `**${l}** ×${n}`).join(" · ");
  const conducteurs = recap.conducteurs
    .slice(0, 15)
    .map((d) => `• ${d.prenom} ${d.nom} (${d.matricule}) : ${d.services} service(s), ${fmtHeures(d.minutes)}${d.accidents ? " ⚠️" : ""}`)
    .join("\n");
  return sendDiscord({
    title: `📋 Récap de session : ${clip(sessionTitre(sess), 200)}`,
    description: `${fmtDateFr(sess.debut.slice(0, 10))} ${sess.debut.slice(11)} → ${fmtDateFr(sess.fin.slice(0, 10))} ${sess.fin.slice(11)}`,
    color: COLOR_BLEU,
    fields: [
      { name: "Conducteurs", value: String(recap.conducteurs.length), inline: true },
      { name: "Services", value: String(recap.services), inline: true },
      { name: "Heures", value: fmtHeures(recap.minutes), inline: true },
      { name: "Accidents", value: String(recap.accidents), inline: true },
      { name: "Lignes effectuées", value: clip(lignes || "Aucune", 1024) },
      { name: "Véhicules utilisés", value: clip(recap.vehicules.join(", ") || "Aucun renseigné", 1024) },
      { name: "Détail par conducteur", value: clip(conducteurs || "Aucun service déclaré sur ce créneau", 1024) },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Portail conducteurs liO" },
  });
};

// Envoie le récap d'une session terminée (une seule fois ; « force » pour renvoyer)
const envoyerRecap = async (s, sess, { force = false } = {}) => {
  if (!force && (sess.recapAt || (sess.recapEssais || 0) >= 3)) return sess;
  const [reports, users] = await Promise.all([listAll(s, "report:"), listAll(s, "user:")]);
  const recap = sessionRecap(sess, reports, new Map(users.map((u) => [u.id, u])));
  const ok = await sendSessionRecap(sess, recap);
  const updated = { ...sess, recapEssais: ok ? 0 : (sess.recapEssais || 0) + 1, recapAt: ok ? new Date().toISOString() : sess.recapAt || null };
  await s.setJSON(`session:${sess.id}`, updated);
  return updated;
};

// Clôture les sessions dont l'heure de fin est passée (appelée par la tâche planifiée et à l'ouverture de l'onglet)
export const closeDueSessions = async (s) => {
  if (!process.env.DISCORD_WEBHOOK_URL) return 0;
  const now = Date.now();
  const due = (await listAll(s, "session:")).filter((x) => x.endMs <= now && !x.recapAt && (x.recapEssais || 0) < 3);
  let n = 0;
  for (const sess of due) {
    // verrou : une seule instance envoie le récap
    const lock = await s.setJSON(`lock:session:${sess.id}:${sess.recapEssais || 0}`, { at: now }, { onlyIfNew: true });
    if (lock && lock.modified === false) continue;
    await envoyerRecap(s, sess);
    n++;
  }
  return n;
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
      const remember = body.remember === true;
      return json(200, {
        token: sign({ uid: u.id, iat: now, exp: now + (remember ? REMEMBER_MS : SESSION_MS), ...(remember ? { rem: 1 } : {}) }),
        user: publicUser(u),
        remember,
      });
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
        token: sign({ uid: me.id, iat: now, exp: now + (auth.rem ? REMEMBER_MS : SESSION_MS), ...(auth.rem ? { rem: 1 } : {}) }),
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
      await s.setJSON(`veh:${me.id}`, { userId: me.id, items });
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
      // Une ou plusieurs lignes (« lignes »), ou une seule via l'ancien champ « ligne »
      const demLignes = body.lignes !== undefined ? body.lignes : body.ligne !== undefined ? [body.ligne] : [];
      if (!Array.isArray(demLignes) || demLignes.some((l) => typeof l !== "string")) return json(400, { error: "Liste de lignes invalide" });
      const choisies = [...new Set(demLignes.map((l) => l.trim()).filter(Boolean))];
      const ligne = choisies[0] || "";
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
      if (choisies.length > LIM.lignesParRapport) return json(400, { error: `${LIM.lignesParRapport} lignes maximum par rapport` });
      if (choisies.some((nom) => !lignes.some((l) => l.nom === nom))) {
        return json(400, { error: "Cette ligne n'est pas disponible : choisissez-en dans la liste" });
      }
      const commentaire = String(body.commentaire ?? "").trim();
      if (commentaire.length > LIM.commentaire) return json(400, { error: `Le commentaire ne peut pas dépasser ${LIM.commentaire} caractères` });
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(commentaire)) return json(400, { error: "Caractères non autorisés" });

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

      // Véhicules utilisés pendant le service : uniquement ceux que le conducteur a activés
      const demandes = body.vehicules === undefined ? [] : body.vehicules;
      if (!Array.isArray(demandes) || demandes.some((v) => typeof v !== "string")) return json(400, { error: "Liste de véhicules invalide" });
      const ids = [...new Set(demandes)];
      if (ids.length > LIM.vehiculesParRapport) return json(400, { error: `${LIM.vehiculesParRapport} véhicules maximum par rapport` });
      let vehicules = [];
      if (ids.length) {
        const [cat, mine] = await Promise.all([getVehicules(s), getUserVeh(s, me.id)]);
        for (const vid of ids) {
          const v = cat.find((x) => x.id === vid);
          if (!v || !mine[vid]) return json(400, { error: "Véhicule non disponible : activez-le d'abord dans la page Véhicules" });
          vehicules.push({ id: v.id, nom: v.nom, plaque: mine[vid].plaque });
        }
      }

      const id = crypto.randomUUID();
      const report = {
        id,
        userId: me.id,
        date,
        ligne,
        lignes: choisies,
        debut,
        fin,
        minutes: minutesBetween(debut, fin),
        accident,
        accidentType,
        details: details.slice(0, LIM.details),
        vehicules,
        commentaire,
        createdAt: new Date().toISOString(),
      };
      await s.setJSON(`report:${id}`, report);
      // Accident : message rouge sur Discord (un échec d'envoi ne bloque jamais le rapport)
      if (accident) await notifyAccident(report, me);
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
        const [users, reports, cat, vehAll] = await Promise.all([listAll(s, "user:"), listAll(s, "report:"), getVehicules(s), listVeh(s)]);
        const cur = currentMonth();
        const catById = new Map(cat.map((v) => [v.id, v.nom]));
        const platesByUser = new Map();
        for (const [uid, items] of vehAll) {
          platesByUser.set(uid, Object.entries(items).filter(([id]) => catById.has(id)).map(([id, x]) => ({ nom: catById.get(id), plaque: x.plaque })));
        }
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
                vehicules: platesByUser.get(u.id) || [],
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
        if (!(await claimMatricule(s, str(body.matricule), id))) return json(400, { error: "Ce matricule est déjà attribué à un autre compte" });
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

      // ----- Sessions : créneaux avec récap détaillé -----
      const vueSession = (sess, recap, now) => ({
        id: sess.id,
        nom: sess.nom,
        titre: sessionTitre(sess),
        debut: sess.debut,
        fin: sess.fin,
        statut: sessionStatut(sess, now),
        creePar: sess.creePar,
        recapAt: sess.recapAt || null,
        recapEssais: sess.recapEssais || 0,
        recap,
      });
      if (method === "GET" && path === "/admin/sessions") {
        await closeDueSessions(s);
        const [all, reports, users] = await Promise.all([listAll(s, "session:"), listAll(s, "report:"), listAll(s, "user:")]);
        const byId = new Map(users.map((u) => [u.id, u]));
        const now = Date.now();
        for (const r of reports) r._w = reportWindow(r);
        all.sort((a, b) => b.startMs - a.startMs);
        return json(200, {
          discord: !!process.env.DISCORD_WEBHOOK_URL,
          sessions: all.map((x) => vueSession(x, sessionRecap(x, reports, byId), now)),
        });
      }
      if (method === "POST" && path === "/admin/sessions") {
        const nom = str(body.nom);
        const [dd, hd, df, hf] = [str(body.dateDebut), str(body.heureDebut), str(body.dateFin), str(body.heureFin)];
        if (!dd || !hd || !df || !hf) return json(400, { error: "Date et heure de début et de fin sont obligatoires" });
        if (nom.length > LIM.sessionNom) return json(400, { error: `Nom de session : ${LIM.sessionNom} caractères maximum` });
        if (hasCtrl(nom)) return json(400, { error: "Caractères non autorisés" });
        if (!isValidDate(dd) || !isValidDate(df) || !TIME_RE.test(hd) || !TIME_RE.test(hf)) return json(400, { error: "Date ou heure invalide" });
        const startMs = parisMs(dd, hd);
        const endMs = parisMs(df, hf);
        if (endMs <= startMs) return json(400, { error: "La fin de la session doit être après son début" });
        if (endMs - startMs > LIM.sessionHeures * 3600e3) return json(400, { error: `Une session dure ${LIM.sessionHeures} h maximum` });
        if (endMs <= Date.now()) return json(400, { error: "La fin de la session doit être dans le futur" });
        if ((await listAll(s, "session:")).length >= LIM.sessions) return json(400, { error: `${LIM.sessions} sessions maximum : supprimez les plus anciennes` });
        const sess = {
          id: crypto.randomUUID(),
          nom,
          debut: `${dd}T${hd}`,
          fin: `${df}T${hf}`,
          startMs,
          endMs,
          creePar: `${me.prenom} ${me.nom}`,
          createdAt: new Date().toISOString(),
          recapAt: null,
          recapEssais: 0,
        };
        await s.setJSON(`session:${sess.id}`, sess);
        return json(201, vueSession(sess, sessionRecap(sess, [], new Map()), Date.now()));
      }
      const mSess = path.match(/^\/admin\/sessions\/([\w-]{1,64})(\/end|\/recap)?$/);
      if (mSess) {
        const sess = await s.get(`session:${mSess[1]}`, { type: "json" });
        if (!sess) return json(404, { error: "Session introuvable" });
        const now = Date.now();
        if (method === "DELETE" && !mSess[2]) {
          await s.delete(`session:${sess.id}`);
          return json(200, { ok: true });
        }
        // Terminer maintenant : la fin passe à l'instant présent et le récap part tout de suite
        if (method === "POST" && mSess[2] === "/end") {
          if (now >= sess.endMs) return json(400, { error: "Cette session est déjà terminée" });
          if (now < sess.startMs) return json(400, { error: "Cette session n'a pas commencé : supprimez-la si besoin" });
          const p = parisParts(now);
          const ended = { ...sess, endMs: Math.floor(now / 60000) * 60000, fin: `${p.date}T${p.time}`, recapAt: null, recapEssais: 0 };
          if (ended.endMs <= ended.startMs) ended.endMs = ended.startMs + 60000;
          await s.setJSON(`session:${sess.id}`, ended);
          const sent = await envoyerRecap(s, ended, { force: true });
          const [reports, users] = await Promise.all([listAll(s, "report:"), listAll(s, "user:")]);
          return json(200, vueSession(sent, sessionRecap(sent, reports, new Map(users.map((u) => [u.id, u]))), Date.now()));
        }
        if (method === "POST" && mSess[2] === "/recap") {
          if (now < sess.endMs) return json(400, { error: "La session n'est pas terminée" });
          if (!process.env.DISCORD_WEBHOOK_URL) return json(400, { error: "Webhook Discord non configuré (variable DISCORD_WEBHOOK_URL)" });
          const sent = await envoyerRecap(s, sess, { force: true });
          if (!sent.recapAt || Date.parse(sent.recapAt) < now) return json(502, { error: "Discord n'a pas accepté le message. Vérifiez le webhook." });
          const [reports, users] = await Promise.all([listAll(s, "report:"), listAll(s, "user:")]);
          return json(200, vueSession(sent, sessionRecap(sent, reports, new Map(users.map((u) => [u.id, u]))), Date.now()));
        }
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
        await releaseMatricule(s, target.matricule, target.id);
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

        if (!(await claimMatricule(s, str(merged.matricule), target.id))) {
          return json(400, { error: "Ce matricule est déjà attribué à un autre compte" });
        }
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
        if (matKey(target.matricule) !== matKey(updated.matricule)) await releaseMatricule(s, target.matricule, target.id);
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
