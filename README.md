# Relais Carnet de classe

Petit serveur Node qui relaie l'application vers PRONOTE. Un navigateur ne peut pas parler directement à PRONOTE (blocage CORS, session chiffrée), d'où ce relais.

## Connexion par l'ENT : comment ça marche

La bibliothèque utilisée (Pawnote) ne gère pas la connexion par ENT et ne le fera pas : chaque ENT a sa propre page de connexion. Pour les comptes qui passent par un ENT, elle recommande le **code QR**, que PRONOTE génère lui-même une fois connecté :

1. Connectez-vous à votre ENT et ouvrez PRONOTE.
2. Générez un code QR (menu « Mon compte » ou « Application mobile », selon la version) et choisissez un code PIN à 4 chiffres.
3. Dans l'application, ouvrez « Connexion PRONOTE », scannez le code (ou collez son contenu) et saisissez le PIN.

Le relais échange le code QR contre un **jeton**. L'application garde ce jeton sur l'appareil. Il change à chaque connexion. Le mot de passe de l'ENT n'est jamais saisi ni stocké.

## Lancer le relais

Il faut Node 20 ou plus.

```bash
cd server
npm install
ALLOWED_ORIGIN=https://votre-application.example.com npm start
```

Variables d'environnement :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute | `8787` |
| `ALLOWED_ORIGIN` | Adresse de l'application autorisée à appeler le relais (CORS) | `*` (à restreindre) |
| `MOCK` | `1` pour des données simulées, sans PRONOTE | désactivé |

Avec Docker : `docker build -t relais . && docker run -p 8787:8787 -e ALLOWED_ORIGIN=https://... relais`.

Hébergement : le relais doit être joignable en **HTTPS** (l'application l'est aussi). Render, Fly.io ou un Raspberry Pi derrière Caddy conviennent.

## Essayer sans PRONOTE

```bash
MOCK=1 npm start
```

Dans l'application, saisissez `http://localhost:8787` comme relais, collez ce contenu comme code QR et utilisez le PIN `1234` :

```
{"jeton":"demo","login":"lea.martin","url":"http://localhost/pronote/mobile.eleve.html"}
```

## À vérifier avant de s'en servir

`sources/pawnote.js` est le seul fichier qui touche à PRONOTE. Il a été écrit sans pouvoir installer ni exécuter Pawnote, et n'a jamais été testé sur un vrai compte. Au premier essai :

- Si le relais répond « Version de pawnote incompatible », il liste les fonctions qui manquent : adaptez ce fichier à la version installée (`npm ls pawnote`), puis figez cette version dans `package.json`.
- Les formes de données (emploi du temps, devoirs, notes, absences) sont lues de façon tolérante, mais certains champs peuvent rester vides selon l'établissement.
- Tout le reste (routes, sessions, jetons, limites de débit, CORS) est couvert par le mode `MOCK`.

## Sécurité

- Les jetons et le contenu des codes QR ne sont jamais écrits dans les journaux.
- Une session relais expire après 30 minutes d'inactivité ; l'application se reconnecte seule avec son jeton.
- 10 tentatives de connexion par minute et par adresse IP.
- Restreignez `ALLOWED_ORIGIN` à l'adresse de votre application.
- Ce projet n'est pas affilié à Index Éducation. L'API interne de PRONOTE peut changer sans préavis ; à utiliser pour votre propre compte.

## API

| Route | Corps / paramètres | Réponse |
|---|---|---|
| `GET /health` | | `{ ok, source }` |
| `POST /api/login/qr` | `{ qr: {jeton, login, url}, pin, deviceUUID }` | `{ session, creds, student }` |
| `POST /api/login/token` | `{ url, kind, username, token, deviceUUID }` | `{ session, creds, student }` |
| `GET /api/overview` | `Authorization: Bearer <session>` | `{ student, period, homework, grades, absences }` |
| `GET /api/timetable?from=AAAA-MM-JJ&to=AAAA-MM-JJ` | idem, 35 jours maximum | `{ lessons }` |
| `POST /api/logout` | idem | `{ ok }` |
