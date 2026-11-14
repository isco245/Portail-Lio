const m = new URLSearchParams(location.search).get("m");
if (MESSAGES[m]) {
  $("info").textContent = MESSAGES[m];
  $("info").hidden = false;
}

// « Se souvenir de moi » : si une session est encore valable, on entre directement
(async () => {
  if (!getToken() || MESSAGES[m]) return;
  try {
    const { user } = await api("/me");
    location.replace(user.role === "exploitant" ? "admin.html" : "driver.html");
  } catch {
    clearAuth(); // jeton expiré ou refusé : on reste sur la connexion
  }
})();

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const remember = fd.get("remember") === "1";
  const bouton = e.target.querySelector("button");
  bouton.disabled = true;
  try {
    const { token, user } = await api("/login", {
      method: "POST",
      body: { matricule: fd.get("matricule"), password: fd.get("password"), remember },
    });
    setAuth(token, user.role, remember);
    location.href = user.role === "exploitant" ? "admin.html" : "driver.html";
  } catch (err) {
    $("err").textContent = err.message;
    bouton.disabled = false;
  }
});
