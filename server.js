/* ============================================================
   OrthograFix BTP — serveur applicatif autonome
   Prérequis : Node.js 18 ou supérieur (aucune installation de module)
   Variables d'environnement nécessaires :
     GROQ_API_KEY    : clé gratuite obtenue sur console.groq.com
     SUPABASE_URL    : https://xxxx.supabase.co
     SUPABASE_KEY    : clé anon (public) de Supabase
     ADMIN_TOKEN     : lien secret enseignant, choisi par vous (ex : mon-lien-secret-2026)
   Lancement local :  node server.js
   ============================================================ */

const http = require("http");
const crypto = require("crypto");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;           // ex. https://abc.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_KEY;            // clé anon
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "demo-secret";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELES_EXCLUS = [/whisper/, /tts/, /guard/, /prompt/]; // modèles non conversationnels
let MODELE_CHOISI = null; // déterminé automatiquement au premier appel

/* Sélectionne automatiquement un modèle de conversation disponible sur le compte.
   GROQ_MODEL (variable d'environnement) permet d'imposer un modèle précis si vous le souhaitez. */
async function choisirModele() {
  if (MODELE_CHOISI) return MODELE_CHOISI;
  if (process.env.GROQ_MODEL) {
    MODELE_CHOISI = process.env.GROQ_MODEL;
    return MODELE_CHOISI;
  }
  const r = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Impossible de lister les modèles Groq (${r.status}).`);
  const data = await r.json();
  const candidats = (data.data || [])
    .map((m) => m.id)
    .filter((id) => !GROQ_MODELES_EXCLUS.some((re) => re.test(id)))
    .sort(); // tri alphabétique : choisit un modèle stable par défaut
  if (!candidats.length) throw new Error("Aucun modèle de conversation disponible sur ce compte Groq.");
  MODELE_CHOISI = candidats[0];
  console.log("Modèle Groq retenu :", MODELE_CHOISI);
  return MODELE_CHOISI;
}

/* ---------- Appel au LLM (Groq, quota gratuit) ---------- */
async function appelerLLM(messages, formatJSON) {
  const modele = await choisirModele();
  const reponse = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: modele,
      messages,
      temperature: 0.4,
      ...(formatJSON ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!reponse.ok) {
    const texte = await reponse.text();
    throw new Error(`Erreur Groq (${reponse.status}) : ${texte}`);
  }
  const data = await reponse.json();
  return data.choices[0].message.content;
}

/* ---------- Base de données (Supabase, REST) ---------- */
const sbHeaders = {
  "Content-Type": "application/json",
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

async function sbPost(table, objet) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(objet),
  });
  if (!r.ok) throw new Error(`Erreur Supabase : ${await r.text()}`);
  return (await r.json())[0];
}

async function sbGet(table, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Erreur Supabase : ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, params, objet) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(objet),
  });
  if (!r.ok) throw new Error(`Erreur Supabase : ${await r.text()}`);
  return r.json();
}

/* ---------- 1. Génération d'un parcours (enseignant) ---------- */
const CONSIGNE_GENERATION = `Tu es un professeur de français en lycée professionnel, spécialiste du BTP.
L'enseignant te décrit un parcours d'orthographe. Tu produis des messages professionnels
destinés à des entreprises de BTP (emails, comptes rendus de chantier, devis, bons de commande),
contenant des fautes d'orthographe réalistes et fréquentes (accords, homophones, participe passé).
Réponds STRICTEMENT en JSON avec ce format :
{
  "titre": "titre du parcours",
  "seances": [
    {
      "contexte": "brève mise en situation (1 phrase)",
      "phraseFautive": "le message fautif, entre guillemets français",
      "correction": "le même message, corrigé",
      "listeFautes": ["faute 1", "faute 2"]
    }
  ]
}
Chaque message doit comporter entre 3 et 5 fautes. Rédige des énoncés adaptés au lycée professionnel.`;

async function genererParcours(commande) {
  const texte = await appelerLLM(
    [
      { role: "system", content: CONSIGNE_GENERATION },
      { role: "user", content: commande },
    ],
    true
  );
  const contenu = JSON.parse(texte);
  const token = crypto.randomBytes(8).toString("hex");
  const ligne = await sbPost("parcours", { token, titre: contenu.titre, contenu });
  return ligne;
}

/* ---------- 2. Dialogue socratique (élève) ---------- */
const CONSIGNE_SOCRATIQUE = `Tu es un tuteur virtuel de français en lycée professionnel, dans le secteur du BTP.
Tu appliques STRICTEMENT la méthode socratique : tu ne donnes JAMAIS la correction directement.
Tu poses UNE SEULE question à la fois, courte et bienveillante, qui guide l'élève vers la découverte
de la faute par lui-même (ex. : « Combien de camionnettes sont arrivées ? Donc quel accord ? »).
Si l'élève se trompe, reformule avec un indice, sans donner la réponse.
Si l'élève donne la bonne réponse, félicite-le brièvement et passe à la faute suivante.
Quand toutes les fautes du message ont été corrigées par l'élève, félicite-le et termine ta réponse
exactement par le marqueur : [TERMINE]
Réponds toujours en français, en 1 à 3 phrases maximum.`;

async function dialogueSocratique(seance, historique) {
  const contexteEleve = `Message fautif à faire corriger : ${seance.phraseFautive}
Contexte : ${seance.contexte}
Correction de référence (ne jamais révéler) : ${seance.correction}`;
  const messages = [
    { role: "system", content: CONSIGNE_SOCRATIQUE },
    { role: "system", content: contexteEleve },
    ...historique,
  ];
  return appelerLLM(messages, false);
}

async function evaluerSeance(seance, historique) {
  const texte = await appelerLLM(
    [
      {
        role: "system",
        content: `Tu évalues un dialogue de tutorat socratique en orthographe. Réponds STRICTEMENT en JSON :
{"score": nombre entre 0 et 100, "commentaire": "une phrase d'encouragement et de conseil pour l'élève"}
Le score est élevé si l'élève a trouvé les corrections avec peu d'aide.`,
      },
      {
        role: "user",
        content: `Message de référence corrigé : ${seance.correction}\n\nDialogue :\n${JSON.stringify(historique)}`,
      },
    ],
    true
  );
  return JSON.parse(texte);
}

/* ---------- 3. Serveur HTTP ---------- */
function lireCorps(req) {
  return new Promise((resolve) => {
    let corps = "";
    req.on("data", (c) => (corps += c));
    req.on("end", () => {
      try { resolve(JSON.parse(corps || "{}")); } catch { resolve({}); }
    });
  });
}

function envoyerJSON(res, code, objet) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(objet));
}

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  /* --- API enseignant : générer --- */
  if (req.method === "POST" && url.pathname === "/api/generer") {
    try {
      const corps = await lireCorps(req);
      if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
        return envoyerJSON(res, 403, { erreur: "Lien d'administration invalide." });
      const parcours = await genererParcours(corps.commande);
      return envoyerJSON(res, 200, {
        titre: parcours.titre,
        lienEleve: `/e/${parcours.token}`,
        token: parcours.token,
      });
    } catch (e) { return envoyerJSON(res, 500, { erreur: e.message }); }
  }

  /* --- API : récupérer un parcours --- */
  if (req.method === "GET" && url.pathname.startsWith("/api/parcours/")) {
    try {
      const token = url.pathname.split("/")[3];
      const lignes = await sbGet("parcours", `select=*&token=eq.${token}`);
      if (!lignes.length) return envoyerJSON(res, 404, { erreur: "Parcours introuvable." });
      return envoyerJSON(res, 200, lignes[0]);
    } catch (e) { return envoyerJSON(res, 500, { erreur: e.message }); }
  }

  /* --- API : récupérer les résultats (enseignant) --- */
  if (req.method === "GET" && url.pathname === "/api/resultats") {
    try {
      if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
        return envoyerJSON(res, 403, { erreur: "Lien d'administration invalide." });
      const token = url.searchParams.get("token");
      const lignes = await sbGet(
        "participations",
        `select=surnom,seance_index,score,commentaire,termine,updated_at&parcours_id=(select id from parcours where token eq.${token})&order=updated_at.desc`
      );
      return envoyerJSON(res, 200, lignes);
    } catch (e) { return envoyerJSON(res, 500, { erreur: e.message }); }
  }

  /* --- API élève : une étape du dialogue socratique --- */
  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const corps = await lireCorps(req);
      const lignes = await sbGet("parcours", `select=*&token=eq.${corps.token}`);
      if (!lignes.length) return envoyerJSON(res, 404, { erreur: "Parcours introuvable." });
      const parcours = lignes[0];
      const seance = parcours.contenu.seances[corps.seanceIndex];

      // Récupère ou crée la participation de l'élève
      let part = (
        await sbGet(
          "participations",
          `select=*&parcours_id=eq.${parcours.id}&surnom=eq.${encodeURIComponent(corps.surnom)}&seance_index=eq.${corps.seanceIndex}`
        )
      )[0];
      if (!part) {
        part = await sbPost("participations", {
          parcours_id: parcours.id,
          surnom: corps.surnom,
          seance_index: corps.seanceIndex,
          messages: [],
        });
      }

      let historique = corps.historique || [];
      if (corps.message) historique.push({ role: "user", content: corps.message });

      const reponse = await dialogueSocratique(seance, historique);
      historique.push({ role: "assistant", content: reponse });

      const termine = reponse.includes("[TERMINE]");
      let evaluation = null;
      if (termine) {
        evaluation = await evaluerSeance(seance, historique);
      }

      await sbPatch(
        "participations",
        `id=eq.${part.id}`,
        {
          messages: historique,
          termine,
          ...(evaluation ? { score: evaluation.score, commentaire: evaluation.commentaire } : {}),
        }
      );

      return envoyerJSON(res, 200, {
        reponse: reponse.replace("[TERMINE]", "").trim(),
        termine,
        ...(evaluation ? { score: evaluation.score, commentaire: evaluation.commentaire } : {}),
      });
    } catch (e) { return envoyerJSON(res, 500, { erreur: e.message }); }
  }

  /* --- Pages HTML --- */
  if (url.pathname === `/a/${ADMIN_TOKEN}`) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_ENSEIGNANT);
  }
  if (url.pathname.startsWith("/e/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_ELEVE);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Page introuvable.");
});

const PORT = process.env.PORT || 3000;
serveur.listen(PORT, () => console.log(`OrthograFix démarré sur le port ${PORT}`));

/* ============================================================
   PAGES (HTML intégré, aucune dépendance)
   ============================================================ */
const STYLE = `<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #f8fafc; color: #1e293b; }
  .cadre { max-width: 720px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.3rem; }
  .boite { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin: 12px 0; }
  textarea, input { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 1rem; }
  button { background: #059669; color: white; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 1rem; cursor: pointer; margin-top: 8px; }
  button.sec { background: #e2e8f0; color: #1e293b; }
  .msg { padding: 10px 14px; border-radius: 10px; margin: 8px 0; max-width: 85%; font-size: 0.95rem; }
  .bot { background: #ecfdf5; border: 1px solid #a7f3d0; }
  .eleve { background: #e2e8f0; margin-left: auto; }
  .ok { background: #ecfdf5; border-color: #059669; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0; }
</style>`;

const PAGE_ENSEIGNANT = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OrthograFix — Enseignant</title>${STYLE}</head>
<body><div class="cadre">
<h1>OrthograFix BTP — Espace enseignant</h1>
<div class="boite">
  <label><b>Décrivez le parcours souhaité (en langage naturel) :</b></label>
  <textarea id="commande" rows="4">Crée un parcours socratique d'orthographe sur les messages professionnels adressés à des entreprises de BTP, pour des élèves de lycée professionnel, en 2 séances.</textarea>
  <button onclick="generer()">Générer avec l'IA</button>
  <p id="statut"></p>
</div>
<div class="boite" id="resultat" style="display:none">
  <b id="titreParcours"></b>
  <p>Lien à partager avec les élèves :</p>
  <p id="lienEleve" style="font-family:monospace; word-break:break-all"></p>
  <button class="sec" onclick="copier()">Copier le lien</button>
  <button class="sec" onclick="voirResultats()">Voir les résultats</button>
</div>
<div class="boite" id="resultats" style="display:none"></div>
</div>
<script>
async function generer() {
  document.getElementById('statut').textContent = 'Génération en cours…';
  const r = await fetch('/api/generer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': '${ADMIN_TOKEN}' },
    body: JSON.stringify({ commande: document.getElementById('commande').value })
  });
  const data = await r.json();
  if (data.erreur) { document.getElementById('statut').textContent = 'Erreur : ' + data.erreur; return; }
  document.getElementById('statut').textContent = '';
  document.getElementById('resultat').style.display = 'block';
  document.getElementById('titreParcours').textContent = data.titre;
  document.getElementById('lienEleve').textContent = location.origin + data.lienEleve;
  window._token = data.token;
}
function copier() {
  navigator.clipboard.writeText(document.getElementById('lienEleve').textContent);
}
async function voirResultats() {
  const r = await fetch('/api/resultats?token=' + window._token, { headers: { 'x-admin-token': '${ADMIN_TOKEN}' } });
  const lignes = await r.json();
  const box = document.getElementById('resultats');
  box.style.display = 'block';
  if (!lignes.length) { box.innerHTML = '<p>Aucun résultat pour le moment.</p>'; return; }
  let html = '<table><tr><th>Surnom</th><th>Séance</th><th>Score</th><th>Commentaire</th><th>Statut</th></tr>';
  for (const l of lignes) {
    html += '<tr><td>' + l.surnom + '</td><td>' + (l.seance_index + 1) + '</td><td>' +
      (l.score == null ? '—' : l.score + '/100') + '</td><td>' + (l.commentaire || '') +
      '</td><td>' + (l.termine ? 'Terminé' : 'En cours') + '</td></tr>';
  }
  box.innerHTML = html + '</table>';
}
</script></body></html>`;

const PAGE_ELEVE = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OrthograFix — Parcours</title>${STYLE}</head>
<body><div class="cadre">
<h1 id="titre">Parcours d'orthographe</h1>
<div class="boite" id="identification">
  <p><b>Bienvenue !</b> Choisissez un surnom (il sera visible par votre enseignant, sans votre nom réel) :</p>
  <input id="surnom" placeholder="Votre surnom">
  <button onclick="demarrer()">Commencer</button>
</div>
<div id="zone" style="display:none">
  <div class="boite" id="contexte"></div>
  <div id="messages"></div>
  <div class="boite">
    <input id="saisie" placeholder="Écrivez votre réponse…" onkeydown="if(event.key==='Enter')envoyer()">
    <button onclick="envoyer()">Envoyer</button>
    <button class="sec" onclick="indice()">Demander un indice</button>
  </div>
</div>
</div>
<script>
const token = location.pathname.split('/')[2];
let parcours, seanceIndex = 0, surnom, historique = [], termine = false;

async function demarrer() {
  surnom = document.getElementById('surnom').value.trim();
  if (!surnom) return alert('Choisissez un surnom.');
  const r = await fetch('/api/parcours/' + token);
  parcours = await r.json();
  if (parcours.erreur) return alert(parcours.erreur);
  document.getElementById('identification').style.display = 'none';
  document.getElementById('zone').style.display = 'block';
  document.getElementById('titre').textContent = parcours.titre;
  afficherSeance();
  await etape(null);
}

function afficherSeance() {
  const s = parcours.contenu.seances[seanceIndex];
  document.getElementById('contexte').innerHTML =
    '<p style="color:#64748b;font-size:0.85rem">' + s.contexte + '</p>' +
    '<p style="font-size:1.05rem"><i>' + s.phraseFautive + '</i></p>';
  document.getElementById('messages').innerHTML = '';
  historique = [];
  termine = false;
}

async function etape(message) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, surnom, seanceIndex, message, historique })
  });
  const data = await r.json();
  if (data.erreur) return alert(data.erreur);
  historique.push({ role: 'user', content: message });
  historique.push({ role: 'assistant', content: data.reponse });
  ajouterMessage(data.reponse, 'bot');
  if (data.termine) {
    termine = true;
    const div = document.createElement('div');
    div.className = 'boite ok';
    div.innerHTML = '<b>Séance terminée !</b><br>Score : ' + data.score + '/100<br>' + data.commentaire;
    document.getElementById('messages').appendChild(div);
    if (seanceIndex < parcours.contenu.seances.length - 1) {
      const b = document.createElement('button');
      b.textContent = 'Séance suivante';
      b.onclick = () => { seanceIndex++; afficherSeance(); etape(null); };
      div.appendChild(b);
    } else {
      div.innerHTML += '<p>Vos résultats ont été transmis à votre enseignant.</p>';
    }
  }
}

function envoyer() {
  if (termine) return;
  const saisie = document.getElementById('saisie');
  const msg = saisie.value.trim();
  if (!msg) return;
  ajouterMessage(msg, 'eleve');
  saisie.value = '';
  etape(msg);
}

function indice() {
  if (!termine) etape("Je suis bloqué, pouvez-vous me donner un indice ?");
}

function ajouterMessage(texte, auteur) {
  const div = document.createElement('div');
  div.className = 'msg ' + auteur;
  div.textContent = texte;
  document.getElementById('messages').appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}
</script></body></html>`;
