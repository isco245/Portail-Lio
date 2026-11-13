async function load() {
  const o = await api("/admin/overview");
  const t = o.courant;
  $("titre").textContent = `Récap de ${fmtMois(o.mois).toLowerCase()}`;
  $("gServices").textContent = t.services;
  $("gHeures").textContent = fmtH(t.minutes);
  $("gLignes").textContent = Object.keys(t.lignes).length;
  $("gAccidents").textContent = t.accidents;
  $("moisBody").innerHTML = moisRows(o.precedents);

  const lignes = Object.entries(t.lignes).sort((a, b) => a[0].localeCompare(b[0], "fr", { numeric: true }));
  $("gTable").innerHTML = lignes.length
    ? lignes.map(([l, v]) => `<tr><td><span class="ligne">${esc(l)}</span></td><td>${v.services}</td><td>${fmtH(v.minutes)}</td></tr>`).join("")
    : `<tr><td colspan="3">Aucun service ce mois-ci</td></tr>`;

  const c = o.comptes;
  $("comptes").textContent = `${c.total} compte(s), dont ${c.suspendus} suspendu(s).`;
}

requireUser("exploitant").then(load).catch((e) => console.error(e));
