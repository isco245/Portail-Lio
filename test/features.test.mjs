import assert from "node:assert/strict";
import { createHandler, closeDueSessions } from "../netlify/functions/api.mjs";
import { memStore } from "./mem.mjs";

process.env.SESSION_SECRET = "y".repeat(48);
process.env.ADMIN_MATRICULE = "ADMIN01";
process.env.ADMIN_PASSWORD = "AdminPass123";
process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123456/abc-DEF_ghi";

// Faux Discord : on garde les messages envoyés
const sent = [];
let discordOk = true;
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: discordOk, status: discordOk ? 204 : 500 };
};

const st = memStore();
const h = createHandler(() => st);
const call = async (method, path, body, token) => {
  const r = await h({ httpMethod: method, path: "/api" + path, headers: { "x-nf-client-connection-ip": "9.9.9." + Math.floor(Math.random() * 200), ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.statusCode, b: JSON.parse(r.body) };
};
let n = 0; const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);

const admin = (await call("POST", "/login", { matricule: "ADMIN01", password: "AdminPass123" })).b;
const A = admin.token;
await call("PUT", "/admin/lignes", { lignes: ["12", "A3"] }, A);
await call("POST", "/admin/vehicules", { nom: "Citaro" }, A);
await call("POST", "/admin/vehicules", { nom: "Urbanway" }, A);
const cat = (await call("GET", "/admin/vehicules", null, A)).b.vehicules;
const citaro = cat.find((v) => v.nom === "Citaro").id;
const urban = cat.find((v) => v.nom === "Urbanway").id;

// ---- matricule unique
let r = await call("POST", "/admin/users", { matricule: "C042", nom: "Martin", prenom: "Léa", role: "conducteur", password: "motdepasse1" }, A);
assert.equal(r.s, 201); const lea = r.b;
for (const m of ["c042", " C042 ", "C 042", "ADMIN01", "admin01"]) {
  r = await call("POST", "/admin/users", { matricule: m, nom: "X", prenom: "Y", role: "conducteur", password: "motdepasse1" }, A);
  assert.equal(r.s, 400, m); assert.match(r.b.error, /déjà attribué/);
}
ok("matricule déjà pris refusé (casse, espaces, matricule exploitant)");
r = await call("POST", "/admin/users", { matricule: "Ç7", nom: "A", prenom: "B", role: "conducteur", password: "motdepasse1" }, A);
assert.equal(r.s, 201); const c7 = r.b;
r = await call("POST", "/admin/users", { matricule: "C7", nom: "A", prenom: "B", role: "conducteur", password: "motdepasse1" }, A);
assert.equal(r.s, 400); ok("variante accentuée (Ç7 / C7) refusée");
r = await call("PUT", `/admin/users/${c7.id}`, { matricule: "c042" }, A); assert.equal(r.s, 400); ok("modifier vers un matricule pris : refusé");
r = await call("PUT", `/admin/users/${c7.id}`, { matricule: "D8" }, A); assert.equal(r.s, 200);
r = await call("POST", "/admin/users", { matricule: "C7", nom: "N", prenom: "P", role: "conducteur", password: "motdepasse1" }, A);
assert.equal(r.s, 201); ok("l'ancien matricule est libéré après modification");
const c7b = r.b;
await call("DELETE", `/admin/users/${c7b.id}`, null, A);
r = await call("POST", "/admin/users", { matricule: "C7", nom: "N", prenom: "P", role: "conducteur", password: "motdepasse1" }, A);
assert.equal(r.s, 201); ok("matricule libéré après suppression du compte");
// deux créations simultanées : une seule passe
const [x, y] = await Promise.all([1, 2].map((i) => call("POST", "/admin/users", { matricule: "RACE1", nom: "N" + i, prenom: "P", role: "conducteur", password: "motdepasse1" }, A)));
assert.deepEqual([x.s, y.s].sort(), [201, 400]); ok("création simultanée du même matricule : une seule réussit");

// ---- véhicules dans un rapport
const L = (await call("POST", "/login", { matricule: "C042", password: "motdepasse1" })).b.token;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const rep = (o = {}) => ({ date: today, ligne: "12", debut: "08:00", fin: "10:00", accident: false, ...o });
r = await call("POST", "/reports", rep({ vehicules: [citaro] }), L);
assert.equal(r.s, 400); ok("véhicule non activé par le conducteur : refusé");
await call("PUT", `/vehicules/${citaro}`, { actif: true, plaque: "ab-123-cd" }, L);
await call("PUT", `/vehicules/${urban}`, { actif: true, plaque: "ZZ 999 YY" }, L);
r = await call("POST", "/reports", rep({ vehicules: [citaro, citaro, urban] }), L);
assert.equal(r.s, 201); assert.deepEqual(r.b.vehicules.map((v) => v.plaque), ["AB-123-CD", "ZZ 999 YY"]); ok("véhicules du service enregistrés (doublons ignorés, plaque figée)");
assert.equal((await call("POST", "/reports", rep({ vehicules: "x" }), L)).s, 400);
assert.equal((await call("POST", "/reports", rep({ vehicules: [1] }), L)).s, 400);
assert.equal((await call("POST", "/reports", rep({ vehicules: ["inconnu"] }), L)).s, 400); ok("liste de véhicules invalide refusée");
r = await call("POST", "/reports", rep(), L); assert.equal(r.s, 201); assert.deepEqual(r.b.vehicules, []); ok("véhicules facultatifs");

// ---- recherche par plaque (la liste des comptes expose les plaques)
r = await call("GET", "/admin/users", null, A);
const ul = r.b.find((u) => u.matricule === "C042");
assert.deepEqual(ul.vehicules.map((v) => v.plaque).sort(), ["AB-123-CD", "ZZ 999 YY"]); ok("la liste des comptes contient les plaques");
assert.equal((await call("GET", "/admin/users", null, L)).s, 403);

// ---- webhook accident
sent.length = 0;
r = await call("POST", "/reports", rep({ accident: true, accidentType: "routier", details: "Choc @everyone avec un poteau", vehicules: [citaro] }), L);
assert.equal(r.s, 201); assert.equal(sent.length, 1);
const em = sent[0].body.embeds[0];
assert.equal(em.color, 0xc10130); assert.match(em.title, /accident routier/);
assert.ok(em.fields.some((f) => f.name === "Description" && f.value.includes("poteau")));
assert.ok(em.fields.some((f) => f.name === "Véhicule(s)" && f.value.includes("AB-123-CD")));
assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] }); ok("accident : message Discord rouge, sans mention de masse");
sent.length = 0;
await call("POST", "/reports", rep(), L); assert.equal(sent.length, 0); ok("rapport sans accident : aucun message");
discordOk = false;
r = await call("POST", "/reports", rep({ accident: true, accidentType: "externe", details: "x" }), L);
assert.equal(r.s, 201); discordOk = true; ok("Discord en panne : le rapport est quand même enregistré");

// ---- sessions
const pad = (v) => String(v).padStart(2, "0");
const parisNow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).reduce((a, p) => ((a[p.type] = p.value), a), {});
const S = (o) => ({ nom: "Soirée", dateDebut: today, heureDebut: "00:00", dateFin: today, heureFin: "23:59", ...o });
assert.equal((await call("POST", "/admin/sessions", S(), L)).s, 403); ok("conducteur ne peut pas créer de session");
assert.equal((await call("POST", "/admin/sessions", S({ heureFin: "00:00" }), A)).s, 400); ok("fin avant début refusée");
assert.equal((await call("POST", "/admin/sessions", S({ dateDebut: "2020-01-01", dateFin: "2020-01-01" }), A)).s, 400); ok("session déjà terminée refusée");
assert.equal((await call("POST", "/admin/sessions", S({ dateFin: "2999-01-01" }), A)).s, 400); ok("session de plus de 72 h refusée");
assert.equal((await call("POST", "/admin/sessions", S({ heureDebut: "25:00" }), A)).s, 400);
r = await call("POST", "/admin/sessions", S(), A); assert.equal(r.s, 201); const sess = r.b; assert.equal(sess.statut, "en_cours"); ok("session créée");
r = await call("GET", "/admin/sessions", null, A);
const sv = r.b.sessions.find((x) => x.id === sess.id);
assert.equal(r.b.discord, true);
assert.equal(sv.recap.conducteurs.length, 1); assert.equal(sv.recap.conducteurs[0].matricule, "C042");
assert.equal(sv.recap.services, 5); assert.equal(sv.recap.accidents, 2); assert.deepEqual(sv.recap.lignes, { "12": 5 });
assert.equal(sv.recap.minutes, 5 * 120); ok("récap : conducteurs, services, lignes, accidents, minutes");
assert.deepEqual(sv.recap.vehicules, ["Citaro (AB-123-CD)", "Urbanway (ZZ 999 YY)"]); ok("récap : véhicules utilisés");

// créneau qui ne chevauche pas le service de 08:00-10:00 : récap vide ; chevauchement partiel : part comptée
r = await call("POST", "/admin/sessions", S({ nom: "Matin", heureDebut: "09:00", heureFin: "23:59" }), A);
const partiel = (await call("GET", "/admin/sessions", null, A)).b.sessions.find((x) => x.id === r.b.id);
assert.equal(partiel.recap.minutes, 5 * 60); ok("chevauchement partiel : seule la part dans le créneau est comptée");

// terminer maintenant => récap Discord immédiat
sent.length = 0;
r = await call("POST", `/admin/sessions/${sess.id}/end`, null, A);
assert.equal(r.s, 200); assert.equal(r.b.statut, "terminee"); assert.ok(r.b.recapAt);
assert.equal(sent.length, 1); assert.match(sent[0].body.embeds[0].title, /Récap de session/);
assert.equal(sent[0].body.embeds[0].fields.find((f) => f.name === "Conducteurs").value, "1"); ok("« terminer maintenant » : récap envoyé sur Discord");
assert.equal((await call("POST", `/admin/sessions/${sess.id}/end`, null, A)).s, 400); ok("on ne termine pas deux fois");
sent.length = 0; await closeDueSessions(st); assert.equal(sent.length, 0); ok("pas de double envoi");
r = await call("POST", `/admin/sessions/${sess.id}/recap`, null, A); assert.equal(r.s, 200); assert.equal(sent.length, 1); ok("renvoi manuel du récap");

// fin naturelle : la tâche planifiée envoie le récap
const raw = [...st._m.keys()].find((k) => k.startsWith("session:") && JSON.parse(st._m.get(k)).id === partiel.id);
const o = JSON.parse(st._m.get(raw)); o.endMs = Date.now() - 1000; st._m.set(raw, JSON.stringify(o));
sent.length = 0;
assert.equal(await closeDueSessions(st), 1); assert.equal(sent.length, 1); assert.equal(await closeDueSessions(st), 0); ok("tâche planifiée : récap envoyé une seule fois à la fin");

// webhook en échec : 3 essais maximum
r = await call("POST", "/admin/sessions", S({ nom: "Échec" }), A); const ech = r.b.id;
const k2 = [...st._m.keys()].find((k) => k.startsWith("session:") && JSON.parse(st._m.get(k)).id === ech);
const o2 = JSON.parse(st._m.get(k2)); o2.endMs = Date.now() - 1000; st._m.set(k2, JSON.stringify(o2));
discordOk = false; sent.length = 0;
for (let i = 0; i < 6; i++) await closeDueSessions(st);
assert.equal(sent.length, 3); discordOk = true; ok("webhook en échec : 3 essais maximum, pas de boucle");

assert.equal((await call("DELETE", `/admin/sessions/${ech}`, null, A)).s, 200);
assert.equal((await call("DELETE", `/admin/sessions/${ech}`, null, A)).s, 404); ok("suppression de session");

// ---- plusieurs lignes + commentaire
r = await call("POST", "/reports", { date: today, lignes: ["12", "A3"], debut: "11:00", fin: "12:00", commentaire: "  RAS, bus en retard  " }, L);
assert.equal(r.s, 201); assert.deepEqual(r.b.lignes, ["12", "A3"]); assert.equal(r.b.commentaire, "RAS, bus en retard"); assert.equal(r.b.minutes, 60); ok("plusieurs lignes + commentaire enregistrés");
assert.equal((await call("POST", "/reports", { date: today, lignes: ["12", "ZZ"], debut: "11:00", fin: "12:00" }, L)).s, 400);
assert.equal((await call("POST", "/reports", { date: today, lignes: [], debut: "11:00", fin: "12:00" }, L)).s, 400);
assert.equal((await call("POST", "/reports", { date: today, lignes: "12", debut: "11:00", fin: "12:00" }, L)).s, 400);
assert.equal((await call("POST", "/reports", { date: today, lignes: ["12"], debut: "11:00", fin: "12:00", commentaire: "x".repeat(1001) }, L)).s, 400); ok("lignes invalides / vides / commentaire trop long refusés");
r = await call("POST", "/reports", { date: today, ligne: "A3", debut: "13:00", fin: "14:00" }, L);
assert.equal(r.s, 201); assert.deepEqual(r.b.lignes, ["A3"]); assert.equal(r.b.commentaire, ""); ok("ancien champ « ligne » toujours accepté, commentaire facultatif");
r = await call("GET", "/me", null, L); assert.equal(r.b.stats.lignes["A3"].services, 2); assert.equal(r.b.stats.lignes["A3"].minutes, undefined); ok("stats par ligne : nombre de services uniquement, pas de durée");
sent.length = 0;
await call("POST", "/reports", { date: today, lignes: ["12", "A3"], debut: "15:00", fin: "16:00", accident: true, accidentType: "voyageur", details: "chute", commentaire: "voir photo" }, L);
assert.ok(sent[0].body.embeds[0].fields.some((f) => f.name === "Lignes" && f.value === "12, A3"));
assert.ok(sent[0].body.embeds[0].fields.some((f) => f.name === "Commentaire")); ok("Discord : lignes multiples + commentaire");

// ---- se souvenir de moi
r = await call("POST", "/login", { matricule: "C042", password: "motdepasse1", remember: true });
const dec = (t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
const p = dec(r.b.token); assert.ok(Math.abs(p.exp - p.iat - 15 * 24 * 3600e3) < 1000); ok("« se souvenir de moi » : jeton valable 15 jours");
r = await call("POST", "/login", { matricule: "C042", password: "motdepasse1" });
const p2 = dec(r.b.token); assert.equal(p2.exp - p2.iat, 12 * 3600e3); ok("sans la case : 12 h");
r = await call("POST", "/login", { matricule: "C042", password: "motdepasse1", remember: "true" });
assert.equal(dec(r.b.token).exp - dec(r.b.token).iat, 12 * 3600e3); ok("remember non booléen ignoré");

console.log(`\n${n} vérifications OK`);
