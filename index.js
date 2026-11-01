// Relais Carnet de classe : une petite API HTTP entre l'application web et PRONOTE.
// Le navigateur ne peut pas parler directement à PRONOTE (CORS, chiffrement de session), d'où ce relais.
// Connexion par code QR (généré dans PRONOTE après connexion à l'ENT) puis par jeton, jamais par mot de passe.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const MOCK = process.env.MOCK === "1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const source = MOCK ? (await import("./sources/mock.js")).default : (await import("./sources/pawnote.js")).default;

/** sid -> { handle, creds, last } */
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.last > SESSION_TTL_MS) sessions.delete(sid);
}, 60 * 1000).unref();

/** Limite simple : 10 tentatives de connexion par minute et par IP. */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 10;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Requête trop volumineuse"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("JSON invalide"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function fail(status, message, code) { return Object.assign(new Error(message), { status, code }); }

function need(cond, message) { if (!cond) throw fail(400, message, "bad_request"); }

function isUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || (MOCK && x.protocol === "http:"); } catch { return false; }
}

function openSession(handle, creds) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { handle, creds, last: Date.now() });
  return sid;
}

function auth(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || "");
  const s = m && sessions.get(m[1]);
  if (!s) throw fail(401, "Session expirée", "session_expired");
  s.last = Date.now();
  return { sid: m[1], s };
}

const routes = {
  "GET /health": async () => ({ ok: true, source: source.name, mock: MOCK, ...(source.version ? { pawnote: await source.version() } : {}) }),

  // Première connexion : contenu du code QR + code PIN à 4 chiffres choisi dans PRONOTE.
  "POST /api/login/qr": async (req, body) => {
    need(body.qr && typeof body.qr === "object", "Code QR manquant");
    const { jeton, login, url } = body.qr;
    need(typeof jeton === "string" && typeof login === "string" && isUrl(url), "Code QR incomplet : jeton, login et url sont requis");
    need(/^\d{4}$/.test(String(body.pin || "")), "Le code PIN doit comporter 4 chiffres");
    need(typeof body.deviceUUID === "string" && body.deviceUUID.length >= 8 && body.deviceUUID.length <= 64, "Identifiant d'appareil invalide");
    const { handle, creds, student } = await source.loginQr({ qr: { jeton, login, url }, pin: String(body.pin), deviceUUID: body.deviceUUID });
    return { session: openSession(handle, { ...creds, deviceUUID: body.deviceUUID }), creds, student };
  },

  // Connexions suivantes : le jeton reçu à la connexion précédente. Il change à chaque connexion.
  "POST /api/login/token": async (req, body) => {
    need(isUrl(body.url), "Adresse PRONOTE invalide");
    need(typeof body.username === "string" && typeof body.token === "string", "Jeton manquant");
    need(typeof body.deviceUUID === "string" && body.deviceUUID.length >= 8, "Identifiant d'appareil invalide");
    const { handle, creds, student } = await source.loginToken({ url: body.url, kind: body.kind, username: body.username, token: body.token, deviceUUID: body.deviceUUID });
    return { session: openSession(handle, { ...creds, deviceUUID: body.deviceUUID }), creds, student };
  },

  "GET /api/overview": async (req) => { const { s } = auth(req); return source.overview(s.handle); },

  "GET /api/timetable": async (req, _b, url) => {
    const { s } = auth(req);
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    need(/^\d{4}-\d{2}-\d{2}$/.test(from || "") && /^\d{4}-\d{2}-\d{2}$/.test(to || ""), "Dates attendues au format AAAA-MM-JJ");
    need(new Date(to) - new Date(from) <= 35 * 86400000 && new Date(to) >= new Date(from), "Période invalide (35 jours maximum)");
    return { lessons: await source.timetable(s.handle, from, to) };
  },

  "POST /api/logout": async (req) => { const { sid } = auth(req); sessions.delete(sid); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: "Introuvable" });
  try {
    if (url.pathname.startsWith("/api/login") && tooMany(ip)) throw fail(429, "Trop de tentatives, réessayez dans une minute", "rate_limited");
    const body = req.method === "POST" ? await readJson(req) : {};
    send(res, 200, await handler(req, body, url));
  } catch (e) {
    const status = e.status || 502;
    // On ne journalise jamais les jetons ni le contenu du code QR.
    if (status >= 500) console.error(new Date().toISOString(), req.method, url.pathname, e.code || "", e.message);
    send(res, status, { error: status >= 500 && !e.expose ? "PRONOTE n'a pas répondu comme prévu : " + e.message : e.message, code: e.code || "error" });
  }
});

server.listen(PORT, () => console.log(`Relais Carnet de classe sur le port ${PORT} (source : ${source.name})`));
