(async () => {
  const { user, stats, mois, precedents } = await requireUser("conducteur");
  $("titre").textContent = `${user.prenom} ${user.nom}`;
  $("moisLabel").textContent = `${fmtMois(mois.mois)} : vos compteurs repartent à zéro le 1er de chaque mois.`;
  $("heures").textContent = fmtH(mois.minutes);
  $("services").textContent = mois.services;
  $("accidents").textContent = mois.accidents;
  $("tHeures").textContent = fmtH(stats.minutes);
  $("tServices").textContent = stats.services;
  $("tAccidents").textContent = stats.accidents;
  $("moisBody").innerHTML = moisRows(precedents);
  $("infos").innerHTML = [
    ["Matricule", user.matricule],
    ["Nom", user.nom],
    ["Prénom", user.prenom],
    ["Pseudo Roblox", user.pseudo || "—"],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  const lignes = Object.entries(stats.lignes);
  $("lignes").innerHTML = lignes.length
    ? lignes.map(([l, v]) => `<li><span class="ligne">${esc(l)}</span><span>${v.services} service(s) · ${fmtH(v.minutes)}</span></li>`).join("")
    : "<li>Aucun service pour l'instant</li>";
})().catch((e) => console.error(e));
