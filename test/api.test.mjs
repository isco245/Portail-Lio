import assert from "node:assert/strict";
import { createHandler } from "../netlify/functions/api.mjs";
import { memStore } from "./mem.mjs";

process.env.SESSION_SECRET = "x".repeat(48);
process.env.ADMIN_MATRICULE = "ADMIN01";
process.env.ADMIN_PASSWORD = "AdminPass123";
const st = memStore();
const h = createHandler(() => st);
let ip = "1.1.1.1";
const call = async (method, path, body, token, rawBody) => {
  const r = await h({ httpMethod: method, path: "/api" + path, headers: { "x-nf-client-connection-ip": ip, ...(token ? { authorization: "Bearer " + token } : {}) }, body: rawBody ?? (body ? JSON.stringify(body) : undefined) });
  return { s: r.statusCode, b: JSON.parse(r.body), h: r.headers };
};
let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

// --- connexion
let r = await call("POST", "/login", { matricule: "ADMIN01", password: "AdminPass123" });
assert.equal(r.s, 200); const adminTok = r.b.token; const adminId = r.b.user.id; assert.equal(r.h["Cache-Control"], "no-store"); ok("connexion exploitant + Cache-Control no-store");
assert.equal((await call("POST", "/login", { matricule: "admin01", password: "AdminPass123" })).s, 200); ok("matricule insensible à la casse");
assert.equal(r.b.user.hash, undefined); assert.equal(r.b.user.salt, undefined); ok("hash/sel jamais renvoyés");

// --- lignes
r = await call("PUT", "/admin/lignes", { lignes: ["12", "A3", "12", " b4 ", "<script>"] }, adminTok);
assert.equal(r.s, 400); ok("ligne avec < > refusée");
r = await call("PUT", "/admin/lignes", { lignes: ["12", "A3", "12", " B4 ", "", "T1/T2"] }, adminTok);
assert.equal(r.s, 200); assert.deepEqual(r.b.lignes, ["12", "A3", "B4", "T1/T2"]); ok("lignes nettoyées, dédoublonnées, triées");
assert.equal((await call("PUT", "/admin/lignes", { lignes: "x" }, adminTok)).s, 400); ok("lignes non-tableau refusé");

// --- création conducteur
r = await call("POST", "/admin/users", { matricule: "C042", nom: "Martin", prenom: "Léa", pseudo: "lea", role: "conducteur", password: "short" }, adminTok);
assert.equal(r.s, 400); ok("mot de passe < 8 refusé");
r = await call("POST", "/admin/users", { matricule: "C042", nom: "Martin", prenom: "Léa", pseudo: "lea", role: "conducteur", password: "c042" + "xxxx" }, adminTok);
assert.equal(r.s, 201); const lea = r.b; assert.equal(lea.suspendu, false);
r = await call("POST", "/admin/users", { matricule: "c042", nom: "X", prenom: "Y", role: "conducteur", password: "motdepasse1" }, adminTok);
assert.equal(r.s, 400); ok("doublon de matricule (casse différente) refusé");
r = await call("POST", "/admin/users", { matricule: "C0" + "9".repeat(40), nom: "X", prenom: "Y", role: "conducteur", password: "motdepasse1" }, adminTok);
assert.equal(r.s, 400); ok("champ trop long refusé");
r = await call("POST", "/admin/users", { matricule: "C2", nom: "Dupont", prenom: "Paul", role: "conducteur", password: "motdepasse2" }, adminTok);
const paul = r.b;

r = await call("POST", "/login", { matricule: "C042", password: "c042xxxx" }); assert.equal(r.s, 200); let leaTok = r.b.token; ok("connexion conducteur");

// --- droits
assert.equal((await call("GET", "/admin/overview", null, leaTok)).s, 403); ok("conducteur bloqué sur /admin/overview");
assert.equal((await call("GET", "/admin/users", null, leaTok)).s, 403);
assert.equal((await call("DELETE", `/admin/users/${paul.id}`, null, leaTok)).s, 403);
assert.equal((await call("PUT", "/admin/lignes", { lignes: ["1"] }, leaTok)).s, 403); ok("conducteur bloqué sur toutes les routes admin");
assert.equal((await call("GET", "/me")).s, 401); assert.equal((await call("GET", "/me", null, "a.b")).s, 401); assert.equal((await call("GET", "/me", null, "n'importe.quoi")).s, 401); ok("sans jeton / jeton forgé : 401");
const [bd, sg] = leaTok.split("."); const forged = Buffer.from(JSON.stringify({ uid: lea.id, exp: Date.now() + 1e9 })).toString("base64url") + "." + sg;
assert.equal((await call("GET", "/me", null, forged)).s, 401); ok("jeton modifié (signature invalide) refusé");

// --- rapports
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const rep = (o = {}) => ({ date: today, ligne: "12", debut: "08:00", fin: "10:30", accident: false, ...o });
r = await call("POST", "/reports", rep(), leaTok); assert.equal(r.s, 201); assert.equal(r.b.minutes, 150); ok("rapport valide (150 min)");
assert.equal((await call("POST", "/reports", rep({ ligne: "99" }), leaTok)).s, 400); ok("ligne hors liste refusée");
assert.equal((await call("POST", "/reports", rep({ date: "2999-01-01" }), leaTok)).s, 400); ok("date future refusée");
assert.equal((await call("POST", "/reports", rep({ date: "2026-02-31" }), leaTok)).s, 400); ok("date inexistante refusée");
assert.equal((await call("POST", "/reports", rep({ debut: "25:00" }), leaTok)).s, 400); ok("heure invalide refusée");
assert.equal((await call("POST", "/reports", rep({ fin: "08:00" }), leaTok)).s, 400); ok("durée nulle refusée");
assert.equal((await call("POST", "/reports", rep({ date: "<img src=x onerror=alert(1)>" }), leaTok)).s, 400); ok("XSS dans la date refusé");
r = await call("POST", "/reports", rep({ accident: "oui", details: "x" }), leaTok); assert.equal(r.b.accident, false); ok("accident non-booléen => false");
r = await call("POST", "/reports", rep({ date: "2026-10-05", debut: "22:00", fin: "01:00", accident: true, details: "d".repeat(9000) }), leaTok);
assert.equal(r.s, 201); assert.equal(r.b.minutes, 180); assert.equal(r.b.details.length, 5000); ok("service de nuit + détails tronqués à 5000");
assert.equal((await call("POST", "/reports", null, leaTok, "null")).s, 400); assert.equal((await call("POST", "/reports", null, leaTok, "[1]")).s, 400); assert.equal((await call("POST", "/reports", null, leaTok, "{oops")).s, 400); ok("corps null / tableau / JSON cassé : 400 (pas 500)");
assert.equal((await call("POST", "/reports", null, leaTok, "a".repeat(200000))).s, 413); ok("corps > 100 ko refusé (413)");

// --- stats mensuelles
r = await call("GET", "/admin/overview", null, adminTok);
const cur = today.slice(0, 7);
assert.equal(r.b.mois, cur); assert.equal(r.b.courant.services, 2);
assert.equal(r.b.precedents.length, 3);
const prev = r.b.precedents[0]; const [y, mo] = cur.split("-").map(Number); const expPrev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
assert.equal(prev.mois, expPrev);
ok(`récap du mois en cours (${cur}) = 2 services ; 3 mois précédents listés`);
r = await call("GET", `/admin/users/${lea.id}`, null, adminTok);
assert.equal(r.b.total.services, 3); assert.equal(r.b.mois.services, 2); assert.equal(r.b.recents.length, 3);
assert.equal(r.b.user.hash, undefined); ok("profil conducteur : cumul 3 / mois 2, sans hash");
r = await call("GET", "/me", null, leaTok); assert.equal(r.b.mois.services, 2); assert.equal(r.b.stats.services, 3); ok("/me : mois + cumul séparés");

// --- suspension
assert.equal((await call("POST", `/admin/users/${lea.id}/suspend`, { suspendu: true }, leaTok)).s, 403);
assert.equal((await call("POST", `/admin/users/${adminId}/suspend`, { suspendu: true }, adminTok)).s, 400); ok("on ne peut pas se suspendre soi-même");
assert.equal((await call("POST", `/admin/users/${lea.id}/suspend`, { suspendu: "oui" }, adminTok)).s, 400);
r = await call("POST", `/admin/users/${lea.id}/suspend`, { suspendu: true }, adminTok); assert.equal(r.s, 200); assert.equal(r.b.suspendu, true);
r = await call("GET", "/me", null, leaTok); assert.equal(r.s, 401); assert.equal(r.b.code, "suspendu"); ok("session en cours coupée dès la suspension");
r = await call("POST", "/login", { matricule: "C042", password: "c042xxxx" }); assert.equal(r.s, 403); assert.equal(r.b.code, "suspendu"); ok("connexion refusée si suspendu (message explicite)");
r = await call("POST", "/login", { matricule: "C042", password: "mauvais-mdp" }); assert.equal(r.s, 401); ok("suspendu + mauvais mdp : message générique (pas de fuite)");
await call("POST", `/admin/users/${lea.id}/suspend`, { suspendu: false }, adminTok);
assert.equal((await call("GET", "/me", null, leaTok)).s, 401); ok("ancien jeton reste invalide après réactivation");
r = await call("POST", "/login", { matricule: "C042", password: "c042xxxx" }); assert.equal(r.s, 200); leaTok = r.b.token; ok("reconnexion possible après réactivation");

// --- changement de mot de passe => anciennes sessions invalides
r = await call("PUT", `/admin/users/${lea.id}`, { password: "nouveaumdp99" }, adminTok); assert.equal(r.s, 200); assert.equal(r.b.reauth, false);
assert.equal((await call("GET", "/me", null, leaTok)).s, 401); ok("changement de mot de passe : ancien jeton invalide");
assert.equal((await call("PUT", `/admin/users/${adminId}`, { role: "conducteur" }, adminTok)).s, 400); ok("l'exploitant ne peut pas se rétrograder");
r = await call("PUT", `/admin/users/${lea.id}`, { role: "admin; DROP", password: "" }, adminTok); assert.equal(r.s, 400); ok("rôle invalide refusé");
r = await call("PUT", `/admin/users/${lea.id}`, { suspendu: true, hash: "pirate", salt: "x", id: "autre" }, adminTok);
assert.equal(r.s, 200); assert.equal(r.b.suspendu, false); assert.equal(r.b.id, lea.id); ok("mass assignment ignoré (suspendu/hash/id non modifiables par PUT)");

// --- suppression
assert.equal((await call("DELETE", `/admin/users/${adminId}`, null, adminTok)).s, 400); ok("on ne peut pas se supprimer soi-même");
r = await call("DELETE", `/admin/users/${lea.id}`, null, adminTok); assert.equal(r.s, 200);
assert.equal([...st._m.keys()].filter((k) => k.startsWith("report:")).length, 0); ok("suppression : profil ET rapports effacés");
assert.equal((await call("GET", `/admin/users/${lea.id}`, null, adminTok)).s, 404);
assert.equal((await call("POST", "/login", { matricule: "C042", password: "nouveaumdp99" })).s, 401); ok("compte supprimé : connexion impossible");

// --- force brute
ip = "9.9.9.9";
for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/login", { matricule: "C2", password: "faux" + i })).s, 401);
r = await call("POST", "/login", { matricule: "C2", password: "motdepasse2" }); assert.equal(r.s, 429); ok("verrouillage après 5 échecs (même avec le bon mot de passe)");
ip = "8.8.8.8"; assert.equal((await call("POST", "/login", { matricule: "C2", password: "motdepasse2" })).s, 200); ok("autre IP non affectée (pas de blocage du compte par un tiers)");
ip = "7.7.7.7";
for (let i = 0; i < 30; i++) await call("POST", "/login", { matricule: "inconnu" + i, password: "faux" });
assert.equal((await call("POST", "/login", { matricule: "C2", password: "motdepasse2" })).s, 429); ok("verrouillage par IP après 30 échecs (matricules variés)");
const keys = [...st._m.keys()].filter((k) => k.startsWith("rl:")); assert.ok(keys.length > 0 && keys.every((k) => /^rl:(ip|id):[0-9a-f]{40}$/.test(k))); ok("IP et matricule hachés dans les compteurs");
ip = "6.6.6.6";
assert.equal((await call("POST", "/login", { matricule: "x".repeat(5000), password: "y" })).s, 401);
assert.equal((await call("POST", "/login", { matricule: { $ne: 1 }, password: ["a"] })).s, 401); ok("login avec objets/valeurs géantes : 401 propre");

// --- config
process.env.SESSION_SECRET = "court";
r = await call("GET", "/me"); assert.equal(r.s, 500); assert.ok(!JSON.stringify(r.b).includes("SESSION")); ok("secret trop court : 500 générique sans fuite d'info");

console.log(`\n${n} vérifications OK`);
