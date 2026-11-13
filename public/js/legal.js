// Si l'on est déjà connecté, le lien de retour mène à son espace
if (getToken()) {
  const a = $("retour");
  a.href = "driver.html";
  a.textContent = "Retour à mon espace";
}
