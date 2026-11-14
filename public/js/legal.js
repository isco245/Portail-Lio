// Si l'on est déjà connecté, le lien de retour mène à son espace
if (getToken()) {
  const a = $("retour");
  a.href = sessionStorage.getItem("role") === "exploitant" ? "admin.html" : "driver.html";
  a.textContent = "Retour à mon espace";
}
