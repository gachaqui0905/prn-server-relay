// Source simulée : permet de tester l'application et le relais sans compte PRONOTE.
// Lancer avec MOCK=1. Code QR de test : {"jeton":"demo","login":"lea.martin","url":"http://localhost/pronote/mobile.eleve.html"}, PIN 1234.
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const schoolDay = (d) => (d.getDay() === 6 ? addDays(d, 2) : d.getDay() === 0 ? addDays(d, 1) : d);

const T = { fr: "Mme Lefèvre", ma: "M. Durand", hg: "M. Girard", pc: "M. Roux", en: "Mme Walker", es: "Mme Ortega", nsi: "Mme Chen" };
const N = { fr: "FRANCAIS", ma: "MATHEMATIQUES", hg: "HISTOIRE-GEOGRAPHIE", pc: "PHYSIQUE-CHIMIE", en: "ANGLAIS LV1", es: "ESPAGNOL LV2", nsi: "NUM.SCIENCES INFORM." };
const WEEK = [
  [["08:00", "08:55", "fr", "A112"], ["09:00", "09:55", "fr", "A112"], ["10:10", "11:05", "ma", "B204"], ["11:10", "12:05", "en", "C301"], ["13:30", "14:25", "es", "C105"]],
  [["08:00", "08:55", "ma", "B204"], ["09:00", "09:55", "ma", "B204"], ["10:10", "11:05", "hg", "A210"], ["13:30", "14:25", "nsi", "Info 1"], ["14:30", "15:25", "nsi", "Info 1"]],
  [["08:00", "08:55", "fr", "A112"], ["09:00", "09:55", "en", "C301"], ["10:10", "11:05", "hg", "A210"]],
  [["10:10", "11:05", "fr", "A112"], ["11:10", "12:05", "es", "C105"], ["13:30", "14:25", "ma", "B204"], ["14:30", "15:25", "pc", "Labo 2"]],
  [["08:00", "08:55", "nsi", "Info 1"], ["09:00", "09:55", "pc", "Labo 2"], ["10:10", "11:05", "pc", "Labo 2"], ["11:10", "12:05", "ma", "B204"]],
];

const student = { name: "Léa Martin", className: "1ère G3", school: "Établissement de test", rows: [["Classe", "1ère G3"], ["Régime", "Demi-pensionnaire"], ["Établissement", "Établissement de test"]] };

export default {
  name: "mock",
  async loginQr({ qr, pin }) {
    if (qr.jeton !== "demo" || pin !== "1234") throw Object.assign(new Error("Code QR ou PIN incorrect"), { status: 401, code: "bad_credentials", expose: true });
    return { handle: { n: 0 }, creds: { url: qr.url, kind: "student", username: qr.login, token: "tok-1" }, student };
  },
  async loginToken({ url, kind, username, token }) {
    const m = /^tok-(\d+)$/.exec(token);
    if (!m) throw Object.assign(new Error("Jeton refusé : reconnectez-vous avec un nouveau code QR"), { status: 401, code: "token_rejected", expose: true });
    return { handle: { n: +m[1] }, creds: { url, kind: kind || "student", username, token: "tok-" + (+m[1] + 1) }, student };
  },
  async overview() {
    const base = schoolDay(today());
    const d = (n) => ymd(schoolDay(addDays(base, n)));
    return {
      student,
      period: "Trimestre 1",
      homework: [
        { id: "m1", subject: N.ma, due: d(0), text: "Exercices 24 à 28 p. 112", type: "Devoir", done: false },
        { id: "m2", subject: N.en, due: d(1), text: "Préparer l'exposé sur les médias", type: "Exposé", done: false },
        { id: "m3", subject: N.hg, due: d(3), text: "Réviser le chapitre 2", type: "Évaluation", done: true },
      ],
      grades: [
        { id: "g1", subject: N.fr, title: "Dissertation", value: 12, outOf: 20, coef: 3, classAvg: 10.4, date: d(-40), comment: "Plan clair." },
        { id: "g2", subject: N.ma, title: "DS Dérivation", value: 14, outOf: 20, coef: 3, classAvg: 11.4, date: d(-30), comment: "" },
        { id: "g3", subject: N.nsi, title: "Projet Python", value: 18, outOf: 20, coef: 2, classAvg: 14.6, date: d(-35), comment: "" },
        { id: "g4", subject: N.en, title: "Expression orale", value: 16, outOf: 20, coef: 1, classAvg: 14.2, date: d(-25), comment: "" },
      ],
      absences: [
        { kind: "Absence", date: d(-45), len: "Journée entière", hours: 7, justified: true, reason: "Maladie" },
        { kind: "Retard", date: d(-28), len: "12 min", hours: 0, justified: false, reason: "" },
      ],
    };
  },
  async timetable(_h, from, to) {
    const out = [];
    for (let d = new Date(from + "T00:00:00"); ymd(d) <= to; d = addDays(d, 1)) {
      if (d.getDay() < 1 || d.getDay() > 5) continue;
      WEEK[d.getDay() - 1].forEach(([start, end, s, room], i) =>
        out.push({ date: ymd(d), start, end, subject: N[s], room, teacher: T[s], canceled: d.getDay() === 5 && i === 1, note: d.getDay() === 5 && i === 1 ? "Professeur absent" : "" }));
    }
    return out;
  },
};
