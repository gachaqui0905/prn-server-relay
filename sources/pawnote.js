// Source réelle : bibliothèque Pawnote (API interne de PRONOTE, non officielle).
//
// ATTENTION : ce fichier n'a PAS été exécuté contre un vrai serveur PRONOTE ni contre la
// bibliothèque installée (le registre npm était inaccessible lors de l'écriture). Les noms de fonctions
// ci-dessous sont ceux de Pawnote 1.x tels que je les connais. Au démarrage, le relais vérifie que chaque
// fonction existe et affiche exactement ce qui manque. Si une version plus récente a changé l'API,
// seul ce fichier est à adapter : le reste du relais et l'application n'en dépendent pas.
// PRONOTE 2026 a changé sa phase de connexion : la version officielle de Pawnote (1.6.2) ne la gère pas.
// Par défaut on utilise donc le fork maintenu @blockshub/pawnote-lts (même API). Pour revenir à la version
// officielle : PAWNOTE_PACKAGE=pawnote (après « npm install pawnote »).
const PKG = process.env.PAWNOTE_PACKAGE || "@blockshub/pawnote-lts";
let P;
const REQUIRED = ["createSessionHandle", "loginQrCode", "loginToken", "AccountKind", "timetableFromIntervals", "parseTimetable", "assignmentsFromIntervals", "gradesOverview", "notebook"];

async function lib() {
  if (P) return P;
  let mod;
  try { mod = await import(PKG); }
  catch { throw Object.assign(new Error(`Bibliothèque ${PKG} introuvable : lancez « npm install »`), { status: 500, expose: true }); }
  const missing = REQUIRED.filter((n) => mod[n] === undefined);
  if (missing.length) throw Object.assign(new Error(`Version de pawnote incompatible : export(s) absent(s) : ${missing.join(", ")}. Adaptez server/sources/pawnote.js (voir le README de pawnote).`), { status: 500, expose: true });
  return (P = mod);
}

const TZ = "Europe/Paris";
function parts(date) {
  const f = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { ymd: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}` };
}
const d0 = (s) => new Date(s + "T00:00:00");
const text = (v) => (v == null ? "" : String(v));

function toCreds(refresh) {
  return { url: refresh.url, kind: refresh.kind, username: refresh.username, token: refresh.token };
}
function describeStudent(session) {
  const res = session.user?.resources?.[0] || {};
  const name = text(res.name || session.user?.name);
  const className = text(res.className || res.class?.name);
  const school = text(session.instance?.name || session.user?.establishmentName);
  const rows = [name && ["Nom", name], className && ["Classe", className], school && ["Établissement", school]].filter(Boolean);
  return { name, className, school, rows };
}
// L'adresse d'un code QR est normalement celle du dossier PRONOTE (…/pronote). Si elle se termine par une page
// (mobile.eleve.html, eleve.html…), on la retire pour que la bibliothèque ajoute elle-même la bonne page.
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.search = ""; x.hash = "";
    x.pathname = x.pathname.replace(/\/[^/]*\.html?$/i, "").replace(/\/+$/, "");
    return x.toString().replace(/\/$/, "");
  } catch { return u; }
}
// Essaie l'adresse telle qu'elle figure dans le code QR, puis sans la page finale. On ne passe à la forme suivante
// que si PRONOTE répond que la page n'existe pas ; toute autre erreur (PIN, jeton) est renvoyée telle quelle.
function urlForms(u) { return [...new Set([u, normalizeUrl(u)])]; }
function pageMissing(e) { return /does not exist|n'existe pas|not found|404|introuvable/i.test(text(e?.message || e)); }
async function tryForms(url, attempt) {
  let first;
  for (const form of urlForms(url)) {
    try { return await attempt(form); }
    catch (e) {
      first = first || e;
      console.error(new Date().toISOString(), "login url", (() => { try { const x = new URL(form); return x.origin + x.pathname; } catch { return "?"; } })(), "->", e?.name || "Error", text(e?.message || e));
      if (!pageMissing(e)) break;
    }
  }
  throw first;
}
function loginError(e) {
  const err = new Error("Connexion refusée : " + text(e?.message || e) + (e?.name && e.name !== "Error" ? " (" + e.name + ")" : ""));
  err.status = 401; err.code = "login_failed"; err.expose = true;
  return err;
}

import { readFile } from "node:fs/promises";
async function installedVersion() {
  try { return PKG + "@" + JSON.parse(await readFile(new URL(`../node_modules/${PKG}/package.json`, import.meta.url), "utf8")).version; }
  catch { return PKG + " (version inconnue)"; }
}

// Texte brut à partir du HTML que PRONOTE renvoie pour les devoirs (<div>…</div>, <br>, entités).
function stripHtml(h) {
  return text(h)
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d)\s*>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

// Période de notes : onglet « Notes » de l'élève d'abord, sinon périodes de l'établissement.
function findPeriod(p, handle, tab) {
  try {
    const loc = p.TabLocation?.[tab];
    const t = loc !== undefined ? handle.userResource?.tabs?.get?.(loc) : undefined;
    const found = t?.defaultPeriod || t?.periods?.[0];
    if (found) return found;
  } catch { /* on essaie la suite */ }
  const periods = handle.instance?.periods || [];
  const now = Date.now();
  return periods.find((x) => x.startDate && x.endDate && x.startDate <= now && now <= x.endDate) || periods[0];
}
const msg = (e) => text(e?.message || e);

export default {
  name: "pawnote",
  version: installedVersion,

  async loginQr({ qr, pin, deviceUUID }) {
    const p = await lib();
    try {
      return await tryForms(qr.url, async (url) => {
        const handle = p.createSessionHandle();
        const refresh = await p.loginQrCode(handle, { deviceUUID, pin, qr: { ...qr, url } });
        return { handle, creds: toCreds(refresh), student: describeStudent(handle) };
      });
    } catch (e) { throw loginError(e); }
  },

  async loginToken({ url, kind, username, token, deviceUUID }) {
    const p = await lib();
    try {
      return await tryForms(url, async (u) => {
        const handle = p.createSessionHandle();
        const refresh = await p.loginToken(handle, { url: u, kind: kind ?? p.AccountKind.STUDENT, username, token, deviceUUID });
        return { handle, creds: toCreds(refresh), student: describeStudent(handle) };
      });
    } catch (e) { throw loginError(e); }
  },

  async timetable(handle, from, to) {
    const p = await lib();
    const raw = await p.timetableFromIntervals(handle, d0(from), d0(to));
    const opts = { withSuperposedCanceledClasses: false, withCanceledClasses: true, withPlannedClasses: true };
    // Pawnote 1.x remplit l'objet reçu (raw.classes) ; d'autres versions renvoient directement la liste.
    let ret;
    try { ret = p.parseTimetable(handle, raw, opts); }              // (session, emploi du temps, options)
    catch (e) { if (!(e instanceof TypeError)) throw e; ret = p.parseTimetable(raw, opts); } // ancienne signature
    const classes = [ret, ret?.classes, ret?.items, raw?.classes, raw?.items].find(Array.isArray);
    if (!classes) throw new Error("emploi du temps lu mais format inattendu (champs : " + Object.keys(raw || {}).join(", ") + ")");
    return classes
      .filter((c) => c.startDate && c.endDate)
      .map((c) => {
        const s = parts(c.startDate), e = parts(c.endDate);
        const canceled = Boolean(c.canceled) || /annul/i.test(text(c.status));
        return {
          date: s.ymd, start: s.hm, end: e.hm,
          subject: text(c.subject?.name || c.title || "Cours"),
          room: text(Array.isArray(c.classrooms) ? c.classrooms[0] : c.room),
          teacher: text(Array.isArray(c.teacherNames) ? c.teacherNames[0] : c.teacher),
          canceled,
          note: canceled ? "Cours annulé" : text(c.status && !/^(cours|normal)/i.test(text(c.status)) ? c.status : ""),
        };
      });
  },

  async overview(handle) {
    const p = await lib();
    const warnings = [];
    const gradesPeriod = findPeriod(p, handle, "Grades"), notebookPeriod = findPeriod(p, handle, "Notebook") || gradesPeriod;
    const start = new Date(); start.setDate(start.getDate() - 7);
    const end = new Date(); end.setDate(end.getDate() + 45);
    const guard = async (label, fn, fallback) => { try { return await fn(); } catch (e) { warnings.push(label + " : " + msg(e)); console.error(new Date().toISOString(), "overview", label, e?.name || "Error", msg(e)); return fallback; } };

    const [assign, gradesRaw, book] = await Promise.all([
      guard("Devoirs", () => p.assignmentsFromIntervals(handle, start, end), []),
      gradesPeriod ? guard("Notes", () => p.gradesOverview(handle, gradesPeriod), null) : (warnings.push("Notes : aucune période trouvée"), null),
      notebookPeriod ? guard("Vie scolaire", () => p.notebook(handle, notebookPeriod), null) : null,
    ]);

    const homework = (assign || []).map((a, i) => ({
      id: text(a.id || "a" + i), subject: text(a.subject?.name), due: parts(a.deadline).ymd,
      text: stripHtml(a.description), type: "Devoir", done: Boolean(a.done),
    }));
    const rawGrades = gradesRaw?.grades || [];
    const grades = rawGrades.filter((g) => g.value && g.value.kind !== "unreturned").map((g, i) => ({
      id: text(g.id || "g" + i), subject: text(g.subject?.name), title: stripHtml(g.comment) || "Évaluation",
      value: Number(g.value.points ?? g.value), outOf: Number(g.outOf?.points ?? g.outOf ?? 20), coef: Number(g.coefficient ?? 1),
      classAvg: Number(g.average?.points ?? g.average ?? NaN), date: parts(g.date).ymd, comment: "",
    })).filter((g) => Number.isFinite(g.value));
    if (rawGrades.length && !grades.length) warnings.push(`Notes : ${rawGrades.length} reçue(s) mais illisibles (format inattendu)`);
    const absences = [
      ...(book?.absences || []).map((x) => ({ kind: "Absence", date: parts(x.startDate).ymd, len: text(x.hoursMissed ? x.hoursMissed + " h" : "Absence"), hours: Number(x.hoursMissed || 0), justified: Boolean(x.justified), reason: text(x.reason) })),
      ...(book?.delays || []).map((x) => ({ kind: "Retard", date: parts(x.date).ymd, len: text(x.minutes != null ? x.minutes + " min" : "Retard"), hours: 0, justified: Boolean(x.justified), reason: text(x.reason) })),
    ];
    return { student: describeStudent(handle), period: text(gradesPeriod?.name || ""), homework, grades, absences, warnings };
  },
};
