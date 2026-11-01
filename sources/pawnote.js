// Source réelle : bibliothèque Pawnote (API interne de PRONOTE, non officielle).
//
// ATTENTION : ce fichier n'a PAS été exécuté contre un vrai serveur PRONOTE ni contre la
// bibliothèque installée (le registre npm était inaccessible lors de l'écriture). Les noms de fonctions
// ci-dessous sont ceux de Pawnote 1.x tels que je les connais. Au démarrage, le relais vérifie que chaque
// fonction existe et affiche exactement ce qui manque. Si une version plus récente a changé l'API,
// seul ce fichier est à adapter : le reste du relais et l'application n'en dépendent pas.
let P;
const REQUIRED = ["createSessionHandle", "loginQrCode", "loginToken", "AccountKind", "timetableFromIntervals", "parseTimetable", "assignmentsFromIntervals", "gradesOverview", "notebook"];

async function lib() {
  if (P) return P;
  let mod;
  try { mod = await import("pawnote"); }
  catch { throw Object.assign(new Error("Bibliothèque pawnote introuvable : lancez « npm install »"), { status: 500, expose: true }); }
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
function loginError(e) {
  const err = new Error("Connexion refusée : " + text(e?.message || e));
  err.status = 401; err.code = "login_failed"; err.expose = true;
  return err;
}

export default {
  name: "pawnote",

  async loginQr({ qr, pin, deviceUUID }) {
    const p = await lib();
    const handle = p.createSessionHandle();
    try {
      const refresh = await p.loginQrCode(handle, { deviceUUID, pin, qr });
      return { handle, creds: toCreds(refresh), student: describeStudent(handle) };
    } catch (e) { throw loginError(e); }
  },

  async loginToken({ url, kind, username, token, deviceUUID }) {
    const p = await lib();
    const handle = p.createSessionHandle();
    try {
      const refresh = await p.loginToken(handle, { url, kind: kind ?? p.AccountKind.STUDENT, username, token, deviceUUID });
      return { handle, creds: toCreds(refresh), student: describeStudent(handle) };
    } catch (e) { throw loginError(e); }
  },

  async timetable(handle, from, to) {
    const p = await lib();
    const raw = await p.timetableFromIntervals(handle, d0(from), d0(to));
    const classes = p.parseTimetable(raw, { withSuperposedCanceledClasses: false, withCanceledClasses: true, withPlannedClasses: true });
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
    const periods = handle.instance?.periods || [];
    const now = Date.now();
    const period = periods.find((x) => x.startDate && x.endDate && x.startDate <= now && now <= x.endDate) || periods[0];
    const start = new Date(); start.setDate(start.getDate() - 7);
    const end = new Date(); end.setDate(end.getDate() + 45);

    const [assign, gradesRaw, book] = await Promise.all([
      p.assignmentsFromIntervals(handle, start, end).catch(() => []),
      period ? p.gradesOverview(handle, period).catch(() => null) : null,
      period ? p.notebook(handle, period).catch(() => null) : null,
    ]);

    const homework = (assign || []).map((a, i) => ({
      id: text(a.id || "a" + i), subject: text(a.subject?.name), due: parts(a.deadline).ymd,
      text: text(a.description), type: "Devoir", done: Boolean(a.done),
    }));
    const grades = (gradesRaw?.grades || []).filter((g) => g.value && g.value.kind !== "unreturned").map((g, i) => ({
      id: text(g.id || "g" + i), subject: text(g.subject?.name), title: text(g.comment || "Évaluation"),
      value: Number(g.value.points ?? g.value), outOf: Number(g.outOf?.points ?? g.outOf ?? 20), coef: Number(g.coefficient ?? 1),
      classAvg: Number(g.average?.points ?? g.average ?? NaN), date: parts(g.date).ymd, comment: "",
    })).filter((g) => Number.isFinite(g.value));
    const absences = [
      ...(book?.absences || []).map((x) => ({ kind: "Absence", date: parts(x.startDate).ymd, len: text(x.hoursMissed ? x.hoursMissed + " h" : "Absence"), hours: Number(x.hoursMissed || 0), justified: Boolean(x.justified), reason: text(x.reason) })),
      ...(book?.delays || []).map((x) => ({ kind: "Retard", date: parts(x.date).ymd, len: text(x.minutes != null ? x.minutes + " min" : "Retard"), hours: 0, justified: Boolean(x.justified), reason: text(x.reason) })),
    ];
    return { student: describeStudent(handle), period: text(period?.name || ""), homework, grades, absences };
  },
};
