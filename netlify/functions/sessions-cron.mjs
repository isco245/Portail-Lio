// Tâche planifiée Netlify : toutes les 5 minutes, envoie sur Discord le récap des sessions dont l'heure de fin est passée.
import { closeDueSessions, store } from "./api.mjs";

export default async () => {
  try {
    const n = await closeDueSessions(store());
    return new Response(JSON.stringify({ recaps: n }), { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("erreur", { status: 500 });
  }
};

export const config = { schedule: "*/5 * * * *" };
