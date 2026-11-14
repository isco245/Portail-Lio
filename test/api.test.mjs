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
assert.equal(r.s, 200); assert.deepEqual(r.b.lignes.map((l) => l.nom), ["12", "A3", "B4", "T1/T2"]); assert.ok(r.b.lignes.every((l) => /^#[0-9a-f]{6}$/.test(l.couleur))); ok("lignes nettoyées, dédoublonnées, triées, couleur par défaut");
r = await call("PUT", "/admin/lignes", { lignes: [{ nom: "12", couleur: "#FF0000" }, { nom: "A3", couleur: "#00aa55" }, { nom: "B4" }, "T1/T2"] }, adminTok);
assert.equal(r.s, 200); assert.equal(r.b.lignes[0].couleur, "#ff0000"); assert.equal(r.b.lignes[1].couleur, "#00aa55"); ok("couleur de ligne choisie et enregistrée");
assert.equal((await call("PUT", "/admin/lignes", { lignes: [{ nom: "12", couleur: "red" }] }, adminTok)).s, 400);
assert.equal((await call("PUT", "/admin/lignes", { lignes: [{ nom: "12", couleur: "url(javascript:1)" }] }, adminTok)).s, 400); ok("couleur invalide refusée");
r = await call("GET", "/lignes", null, adminTok); assert.equal(r.b.lignes[0].nom, "12"); assert.equal(r.b.lignes[0].couleur, "#ff0000"); ok("GET /lignes renvoie nom + couleur");
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
assert.equal((await call("POST", "/reports", rep({ accident: true, accidentType: "routier" }), leaTok)).s, 400);
assert.equal((await call("POST", "/reports", rep({ accident: true, accidentType: "routier", details: "   " }), leaTok)).s, 400); ok("accident sans description : refusé");
assert.equal((await call("POST", "/reports", rep({ accident: true, details: "choc" }), leaTok)).s, 400);
assert.equal((await call("POST", "/reports", rep({ accident: true, accidentType: "meteo", details: "choc" }), leaTok)).s, 400); ok("accident sans type valide : refusé");
for (const t of ["routier", "voyageur", "externe"]) { r = await call("POST", "/reports", rep({ date: "2026-09-01", accident: true, accidentType: t, details: "choc" }), leaTok); assert.equal(r.s, 201); assert.equal(r.b.accidentType, t); }
ok("accident routier / voyageur / externe acceptés");
r = await call("POST", "/reports", rep({ date: "2026-10-05", debut: "22:00", fin: "01:00", accident: true, accidentType: "externe", details: "d".repeat(9000) }), leaTok);
assert.equal(r.s, 201); assert.equal(r.b.minutes, 180); assert.equal(r.b.details.length, 5000); ok("service de nuit + détails tronqués à 5000");
r = await call("POST", "/reports", rep({ accidentType: "routier", details: "ignoré" }), leaTok); assert.equal(r.b.accidentType, ""); assert.equal(r.b.details, ""); ok("sans accident : type et détails vidés");
r = await call("POST", "/reports", rep({ date: "2026-08-01" }), adminTok); assert.equal(r.s, 201); ok("un exploitant peut envoyer un rapport de service");
assert.equal((await call("POST", "/reports", null, leaTok, "null")).s, 400); assert.equal((await call("POST", "/reports", null, leaTok, "[1]")).s, 400); assert.equal((await call("POST", "/reports", null, leaTok, "{oops")).s, 400); ok("corps null / tableau / JSON cassé : 400 (pas 500)");
assert.equal((await call("POST", "/reports", null, leaTok, "a".repeat(200000))).s, 413); ok("corps > 100 ko refusé (413)");

// --- stats mensuelles
r = await call("GET", "/admin/overview", null, adminTok);
const cur = today.slice(0, 7);
assert.equal(r.b.mois, cur); assert.equal(r.b.courant.services, 3);
assert.equal(r.b.precedents.length, 3);
const prev = r.b.precedents[0]; const [y, mo] = cur.split("-").map(Number); const expPrev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
assert.equal(prev.mois, expPrev);
ok(`récap du mois en cours (${cur}) ; 3 mois précédents listés`);
r = await call("GET", `/admin/users/${lea.id}`, null, adminTok);
assert.equal(r.b.total.services, 7); assert.equal(r.b.mois.services, 3); assert.equal(r.b.recents.length, 7);
assert.equal(r.b.user.hash, undefined); ok("profil conducteur : cumul / mois, sans hash");
r = await call("GET", "/me", null, leaTok); assert.equal(r.b.mois.services, 3); assert.equal(r.b.stats.services, 7); ok("/me : mois + cumul séparés");

// --- pseudos Roblox / Discord modifiables par le conducteur
r = await call("PUT", "/me", { pseudo: "LeaRbx", discord: "lea#1234", role: "exploitant", matricule: "HACK" }, leaTok);
assert.equal(r.s, 200); assert.equal(r.b.user.pseudo, "LeaRbx"); assert.equal(r.b.user.discord, "lea#1234"); assert.equal(r.b.user.role, "conducteur"); assert.equal(r.b.user.matricule, "C042"); ok("PUT /me : pseudos modifiés, rôle/matricule intouchables");
assert.equal((await call("PUT", "/me", { pseudo: "x".repeat(41) }, leaTok)).s, 400);
assert.equal((await call("PUT", "/me", { discord: "a\nb" }, leaTok)).s, 400); ok("pseudos trop longs / caractères de contrôle refusés");
r = await call("GET", `/admin/users/${lea.id}`, null, adminTok); assert.equal(r.b.user.discord, "lea#1234"); ok("l'exploitant voit le Discord");
assert.equal((await call("PUT", "/me", { pseudo: "x" })).s, 401); ok("PUT /me sans session : 401");

// --- note de service
assert.equal((await call("PUT", "/admin/note", { type: "info", texte: "x" }, leaTok)).s, 403); ok("note : conducteur bloqué");
assert.equal((await call("PUT", "/admin/note", { type: "inconnu", texte: "x" }, adminTok)).s, 400);
assert.equal((await call("PUT", "/admin/note", { type: "danger", texte: "  " }, adminTok)).s, 400);
assert.equal((await call("PUT", "/admin/note", { type: "danger", texte: "x".repeat(1001) }, adminTok)).s, 400); ok("note : type, texte vide, texte trop long refusés");
assert.equal((await call("GET", "/me", null, leaTok)).b.note, null); ok("pas de note au départ");
r = await call("PUT", "/admin/note", { type: "danger", texte: "Route barrée\nDéviation ligne 12" }, adminTok); assert.equal(r.s, 200);
r = await call("GET", "/me", null, leaTok); assert.equal(r.b.note.type, "danger"); assert.equal(r.b.note.texte, "Route barrée\nDéviation ligne 12"); ok("note publiée, visible par le conducteur");
await call("PUT", "/admin/note", { type: "information", texte: "Nouvelle note" }, adminTok);
assert.equal((await call("GET", "/me", null, leaTok)).b.note.type, "information"); ok("note remplacée");
assert.equal((await call("DELETE", "/admin/note", null, leaTok)).s, 403);
assert.equal((await call("DELETE", "/admin/note", null, adminTok)).s, 200); assert.equal((await call("GET", "/me", null, leaTok)).b.note, null); ok("note supprimée par l'exploitant");

// --- véhicules
assert.equal((await call("POST", "/admin/vehicules", { nom: "Citaro" }, leaTok)).s, 403); ok("véhicules : catalogue réservé à l'exploitant");
assert.equal((await call("POST", "/admin/vehicules", { nom: " " }, adminTok)).s, 400);
r = await call("POST", "/admin/vehicules", { nom: "Mercedes Citaro" }, adminTok); assert.equal(r.s, 201);
assert.equal((await call("POST", "/admin/vehicules", { nom: "mercedes citaro" }, adminTok)).s, 400); ok("véhicule ajouté, doublon refusé");
r = await call("POST", "/admin/vehicules", { nom: "Heuliez GX" }, adminTok); const vehs = r.b.vehicules; const citaro = vehs.find((v) => v.nom === "Mercedes Citaro"); const gx = vehs.find((v) => v.nom === "Heuliez GX");
r = await call("GET", "/vehicules", null, leaTok); assert.equal(r.b.vehicules.length, 2); assert.ok(r.b.vehicules.every((v) => !v.actif)); ok("le conducteur voit le catalogue, rien d'activé");
assert.equal((await call("PUT", `/vehicules/${citaro.id}`, { actif: true, plaque: "" }, leaTok)).s, 400);
assert.equal((await call("PUT", `/vehicules/${citaro.id}`, { actif: true, plaque: "<b>" }, leaTok)).s, 400);
assert.equal((await call("PUT", "/vehicules/inconnu", { actif: true, plaque: "AB-123-CD" }, leaTok)).s, 404);
assert.equal((await call("PUT", `/vehicules/${citaro.id}`, { actif: "oui", plaque: "AB-123-CD" }, leaTok)).s, 400); ok("activation sans plaque valide / véhicule inconnu : refusée");
r = await call("PUT", `/vehicules/${citaro.id}`, { actif: true, plaque: " ab-123-cd " }, leaTok); assert.equal(r.s, 200); assert.equal(r.b.plaque, "AB-123-CD"); ok("véhicule activé, plaque normalisée en majuscules");
r = await call("GET", "/vehicules", null, leaTok); assert.equal(r.b.vehicules.filter((v) => v.actif).length, 1);
r = await call("GET", `/admin/users/${lea.id}`, null, adminTok); assert.deepEqual(r.b.vehicules.map((v) => [v.nom, v.plaque]), [["Mercedes Citaro", "AB-123-CD"]]); ok("l'exploitant voit les véhicules du conducteur dans son profil");
r = await call("GET", "/admin/vehicules", null, adminTok); assert.equal(r.b.vehicules.find((v) => v.id === citaro.id).actifs, 1);
r = await call("PUT", `/vehicules/${citaro.id}`, { actif: false }, leaTok); assert.equal(r.s, 200);
r = await call("GET", `/admin/users/${lea.id}`, null, adminTok); assert.equal(r.b.vehicules.length, 0); ok("désactivation : le véhicule disparaît du profil");
await call("PUT", `/vehicules/${gx.id}`, { actif: true, plaque: "ZZ 999 ZZ" }, leaTok);
assert.equal((await call("DELETE", `/admin/vehicules/${gx.id}`, null, leaTok)).s, 403);
assert.equal((await call("DELETE", `/admin/vehicules/${gx.id}`, null, adminTok)).s, 200);
r = await call("GET", "/vehicules", null, leaTok); assert.equal(r.b.vehicules.length, 1); ok("véhicule retiré du catalogue");

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
assert.equal([...st._m.keys()].filter((k) => k.startsWith("report:") && JSON.parse(st._m.get(k)).userId === lea.id).length, 0); assert.ok(!st._m.has(`veh:${lea.id}`)); ok("suppression : profil, rapports ET véhicules effacés");
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

// --- mot de passe provisoire (première connexion)
ip = "5.5.5.5";
r = await call("POST", "/admin/users", { matricule: "P077", nom: "Durand", prenom: "Eva", role: "conducteur", password: "Prov-7x9K", provisoire: true }, adminTok);
assert.equal(r.s, 201); assert.equal(r.b.mustChangePassword, true); assert.equal(r.b.password, undefined); const eva = r.b; ok("compte créé avec mot de passe provisoire (mot de passe jamais renvoyé)");
r = await call("POST", "/admin/users", { matricule: "P078", nom: "Petit", prenom: "Luc", role: "conducteur", password: "motdepasse78" }, adminTok);
assert.equal(r.b.mustChangePassword, false); ok("sans l'option : mot de passe définitif");
r = await call("POST", "/login", { matricule: "P077", password: "Prov-7x9K" }); assert.equal(r.s, 200); assert.equal(r.b.user.mustChangePassword, true); let evaTok = r.b.token; ok("connexion avec le provisoire : le drapeau est renvoyé");
r = await call("GET", "/me", null, evaTok); assert.equal(r.s, 200); assert.equal(r.b.user.mustChangePassword, true); ok("/me reste accessible pour afficher l'écran de changement");
assert.equal((await call("GET", "/reports", null, evaTok)).b.code, "mdp_provisoire");
assert.equal((await call("POST", "/reports", rep(), evaTok)).s, 403);
assert.equal((await call("PUT", "/me", { pseudo: "x" }, evaTok)).s, 403);
assert.equal((await call("GET", "/vehicules", null, evaTok)).s, 403); ok("tant que le mot de passe n'est pas remplacé : toutes les autres routes sont bloquées");
assert.equal((await call("GET", "/lignes", null, evaTok)).s, 200); ok("liste des lignes (non personnelle) accessible pendant le changement");
r = await call("PUT", "/me/password", { actuel: "mauvais", nouveau: "nouveaumdp" }, evaTok); assert.equal(r.s, 400); assert.match(r.b.error, /provisoire incorrect/); ok("changement : ancien mot de passe vérifié");
assert.equal((await call("PUT", "/me/password", { actuel: "Prov-7x9K", nouveau: "short" }, evaTok)).s, 400);
assert.equal((await call("PUT", "/me/password", { actuel: "Prov-7x9K", nouveau: "p077" }, evaTok)).s, 400); // matricule
assert.equal((await call("PUT", "/me/password", { actuel: "Prov-7x9K", nouveau: "Prov-7x9K" }, evaTok)).s, 400);
assert.equal((await call("PUT", "/me/password", { actuel: 123, nouveau: "xxxxxxxxxx" }, evaTok)).s, 400);
assert.equal((await call("PUT", "/me/password", { actuel: "Prov-7x9K", nouveau: "x".repeat(129) }, evaTok)).s, 400); ok("nouveau mot de passe : longueur, matricule et identique refusés");
r = await call("PUT", "/me/password", { actuel: "Prov-7x9K", nouveau: "MonMotDePasse!1" }, evaTok);
assert.equal(r.s, 200); assert.equal(r.b.user.mustChangePassword, false); assert.equal(r.b.user.hash, undefined); assert.ok(r.b.token); const evaTok2 = r.b.token; ok("mot de passe défini par le conducteur, nouveau jeton renvoyé");
assert.equal((await call("GET", "/me", null, evaTok)).s, 401); ok("ancien jeton (session provisoire) invalidé");
r = await call("GET", "/reports", null, evaTok2); assert.equal(r.s, 200); ok("nouveau jeton utilisable : accès complet rétabli");
assert.equal((await call("POST", "/login", { matricule: "P077", password: "Prov-7x9K" })).s, 401); ok("l'ancien provisoire ne fonctionne plus");
r = await call("POST", "/login", { matricule: "P077", password: "MonMotDePasse!1" }); assert.equal(r.s, 200); assert.equal(r.b.user.mustChangePassword, false); ok("connexion avec le nouveau mot de passe, sans nouvel écran");
r = await call("PUT", "/me/password", { actuel: "MonMotDePasse!1", nouveau: "Autre-motdepasse" }, evaTok2); assert.equal(r.s, 200); ok("le conducteur peut ensuite changer son mot de passe librement");
r = await call("PUT", `/admin/users/${eva.id}`, { password: "Reset-2026ab", provisoire: true }, adminTok);
assert.equal(r.s, 200); assert.equal(r.b.mustChangePassword, true); ok("réinitialisation par l'exploitant avec mot de passe provisoire");
r = await call("PUT", `/admin/users/${eva.id}`, { nom: "Durand-Lacroix" }, adminTok); assert.equal(r.b.mustChangePassword, true); ok("modifier le profil sans changer le mot de passe garde le provisoire");
r = await call("PUT", `/admin/users/${eva.id}`, { password: "Definitif-2026" }, adminTok); assert.equal(r.b.mustChangePassword, false); ok("réinitialisation définitive : le drapeau est retiré");
r = await call("PUT", `/admin/users/${eva.id}`, { password: "Reset-2026ab", provisoire: "on" }, adminTok); assert.equal(r.b.mustChangePassword, false); ok("option envoyée sous une autre forme que true : non provisoire (sûr par défaut)");
ip = "1.1.1.1";

// --- config
process.env.SESSION_SECRET = "court";
r = await call("GET", "/me"); assert.equal(r.s, 500); assert.ok(!JSON.stringify(r.b).includes("SESSION")); ok("secret trop court : 500 générique sans fuite d'info");

console.log(`\n${n} vérifications OK`);
