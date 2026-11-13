const m = new URLSearchParams(location.search).get("m");
if (MESSAGES[m]) {
  $("info").textContent = MESSAGES[m];
  $("info").hidden = false;
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const bouton = e.target.querySelector("button");
  bouton.disabled = true;
  try {
    const { token, user } = await api("/login", { method: "POST", body: fd });
    sessionStorage.setItem("token", token);
    location.href = user.role === "exploitant" ? "admin.html" : "driver.html";
  } catch (err) {
    $("err").textContent = err.message;
    bouton.disabled = false;
  }
});
