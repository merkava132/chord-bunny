// Practice statistics from the telemetry the app writes (telemetry/<session>.jsonl).
//   node tools/stats.mjs [--tel-dir=DIR] [--meta=data/user/sessions.json] [--json]
//                        [--min-matches=10] [--days=14] [--top=12]
// Pure aggregation (aggregate()) + a CLI; serve.py exposes the JSON at
// GET /api/stats and the progress panel / weak-spot drilling read it.
//
// What counts: sessions with ≥ minMatches detector matches (an open tab left
// running for 36 h has 5); targets shown while the mic was on (timer advances
// before the mic is enabled are not practice); nothing inside a session's
// annotated non-guitar ranges (data/user/sessions.json `noise`, stream ts).
// A transition is prev target → this target across an advance/timer pair
// event; its time is the match's sinceShown (the target appeared at the
// advance). Practice minutes = gaps < idleGapSec between practice events,
// summed — not frame samples, so it survives telemetry.frameEvery changes.
import fs from 'node:fs';
import path from 'node:path';

const WANT = ['"type":"session"', '"type":"pair"', '"type":"match"', '"type":"miss"', '"type":"label"', '"type":"mic"', '"type":"enroll"'];

// Only the lines we need are parsed: the big sessions are 99% frame/strum samples.
export function parseSession(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let keep = false; for (const w of WANT) if (line.includes(w)) { keep = true; break; }
    if (!keep) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line at the end of a live file */ }
  }
  return out;
}

// Session id → wall-clock start (the id is a UTC timestamp: 2026-09-25T02-32-27-ho9k)
export function sessionStart(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => x === null || x === undefined ? null : Math.round(x * 10) / 10;

// sessions: [{ id, events, noise?: [[ts0, ts1|null], …] }]
export function aggregate(sessions, { minMatches = 10, idleGapSec = 180, days = 14, top = 12, now = new Date() } = {}) {
  const chords = new Map(), trans = new Map(), byDay = new Map(), labels = [], enrolls = [];
  const sessRows = [];
  for (const s of sessions) {
    const ev = s.events;
    const matchesAll = ev.filter(e => e.type === 'match');
    if (matchesAll.length < minMatches) continue;
    const start = sessionStart(s.id) || new Date(0);
    const micOn = ev.find(e => e.type === 'mic' && e.state === 'on');
    const micT = micOn ? micOn.t : Infinity;
    const noisy = (ts) => ts !== undefined && (s.noise || []).some(([a, b]) => ts >= a && ts < (b ?? Infinity));
    const inPlay = (e) => e.t >= micT && !noisy(e.ts);
    // targets: each pair event opens a target window until the next pair event
    const pairs = ev.filter(e => e.type === 'pair');
    const matches = ev.filter(e => e.type === 'match'), misses = ev.filter(e => e.type === 'miss');
    let mi = 0, xi = 0;
    const targets = [];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i], end = pairs[i + 1]?.t ?? Infinity;
      const tgt = { t: p.t, ts: p.ts, end, id: p.cur, reason: p.reason, from: null, matched: false, timeToMatch: null, heardInstead: [], play: inPlay(p) };
      const prev = pairs[i - 1];
      if (prev && (p.reason === 'advance' || p.reason === 'timer') && !p.sequence) tgt.from = prev.cur;
      while (mi < matches.length && matches[mi].t < p.t) mi++;
      for (let j = mi; j < matches.length && matches[j].t < end; j++) {
        const m = matches[j]; if (m.target !== p.cur) continue;
        if (!tgt.matched) { tgt.matched = true; tgt.timeToMatch = m.sinceShown; }
      }
      while (xi < misses.length && misses[xi].t < p.t) xi++;
      for (let j = xi; j < misses.length && misses[j].t < end; j++) {
        const x = misses[j]; if (x.target !== p.cur) continue;
        if (x.sinceShown < 1 && prev && x.heard?.[0] === prev.cur) continue;   // the previous chord still ringing
        tgt.heardInstead.push(x.heard?.[0]);
      }
      targets.push(tgt);
    }
    const played = targets.filter(t => t.play);
    if (!played.length) continue;
    // practice minutes: practice events (targets, matches, misses) with idle gaps removed
    const times = [...played.map(t => t.t), ...matches.filter(inPlay).map(m => m.t), ...misses.filter(inPlay).map(m => m.t)].sort((a, b) => a - b);
    let active = 0; for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g < idleGapSec) active += g; }
    const day = localDay(new Date(start.getTime() + micT * 1000 * (isFinite(micT) ? 1 : 0)));
    const matchedN = played.filter(t => t.matched).length;
    sessRows.push({ id: s.id, startedAt: start.toISOString(), day, minutes: r1(active / 60), targets: played.length, matched: matchedN,
      timeToMatchP50: r1(q(played.filter(t => t.matched).map(t => t.timeToMatch), 0.5)) });
    const d = byDay.get(day) || byDay.set(day, { day, minutes: 0, targets: 0, matched: 0, sessions: 0 }).get(day);
    d.minutes += active / 60; d.targets += played.length; d.matched += matchedN; d.sessions++;
    for (const t of played) {
      const c = chords.get(t.id) || chords.set(t.id, { id: t.id, shown: 0, matched: 0, times: [], heardInstead: new Map() }).get(t.id);
      c.shown++; if (t.matched) { c.matched++; c.times.push(t.timeToMatch); }
      for (const h of t.heardInstead) if (h) c.heardInstead.set(h, (c.heardInstead.get(h) || 0) + 1);
      if (t.from && t.from !== t.id) {
        const k = `${t.from}→${t.id}`;
        const x = trans.get(k) || trans.set(k, { from: t.from, to: t.id, n: 0, matched: 0, times: [] }).get(k);
        x.n++; if (t.matched) { x.matched++; x.times.push(t.timeToMatch); }
      }
    }
    for (const e of ev) {
      if (e.type === 'label') labels.push({ session: s.id, target: e.target, kind: e.kind, heard: e.heard || [], ts0: e.ts0, ts1: e.ts1 });
      if (e.type === 'enroll') enrolls.push({ session: s.id, kind: e.kind, chord: e.chord, string: e.string, ts0: e.ts0, ts1: e.ts1 });
    }
  }
  const chordRows = [...chords.values()].map(c => ({ id: c.id, shown: c.shown, matched: c.matched, rate: c.matched / c.shown,
    p50: r1(q(c.times, 0.5)), p90: r1(q(c.times, 0.9)),
    heardInstead: [...c.heardInstead].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => ({ id, n })) }))
    .sort((a, b) => b.shown - a.shown);
  const transRows = [...trans.values()].map(x => ({ from: x.from, to: x.to, n: x.n, matched: x.matched, rate: x.matched / x.n, p50: r1(q(x.times, 0.5)) }));
  // "slowest": by median time among transitions with a median, then by miss rate
  const slowest = transRows.filter(x => x.n >= 2).sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0)).slice(0, top);
  const mostMissed = transRows.filter(x => x.n >= 2 && x.rate < 1).sort((a, b) => a.rate - b.rate || b.n - a.n).slice(0, top);
  const dayRows = [...byDay.values()].sort((a, b) => a.day < b.day ? -1 : 1).map(d => ({ ...d, minutes: r1(d.minutes) }));
  // streak: consecutive practice days ending today or yesterday
  const daySet = new Set(dayRows.map(d => d.day));
  let streak = 0; const cur = new Date(now); cur.setHours(12, 0, 0, 0);
  if (!daySet.has(localDay(cur))) cur.setDate(cur.getDate() - 1);
  while (daySet.has(localDay(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  // last N days including empty ones (for the chart)
  const lastDays = []; const c2 = new Date(now); c2.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) { const d = new Date(c2); d.setDate(d.getDate() - i); const k = localDay(d); lastDays.push(byDay.get(k) ? { ...byDay.get(k), minutes: r1(byDay.get(k).minutes) } : { day: k, minutes: 0, targets: 0, matched: 0, sessions: 0 }); }
  const totals = { minutes: r1(dayRows.reduce((s, d) => s + d.minutes, 0)), sessions: sessRows.length, days: dayRows.length, streak,
    targets: chordRows.reduce((s, c) => s + c.shown, 0), matched: chordRows.reduce((s, c) => s + c.matched, 0),
    lastPractised: dayRows.length ? dayRows[dayRows.length - 1].day : null };
  totals.timeToMatchP50 = r1(q([...chords.values()].flatMap(c => c.times), 0.5));
  totals.timeToMatchP90 = r1(q([...chords.values()].flatMap(c => c.times), 0.9));
  return { generatedAt: new Date(now).toISOString(), totals, days: lastDays, allDays: dayRows, sessions: sessRows.slice(-20), chords: chordRows,
    transitions: Object.fromEntries(transRows.map(x => [`${x.from}→${x.to}`, x])), slowest, mostMissed,
    labels: { fp: labels.filter(l => l.kind === 'fp').length, fn: labels.filter(l => l.kind === 'fn').length, recent: labels.slice(-20) },
    enrolls: { chords: enrolls.filter(e => e.kind === 'chord').length, strings: enrolls.filter(e => e.kind === 'string').length } };
}

export function loadSessions(telDir, metaPath) {
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* no annotations */ }
  const out = [];
  for (const f of fs.readdirSync(telDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const id = f.replace(/\.jsonl$/, '');
    out.push({ id, events: parseSession(fs.readFileSync(path.join(telDir, f), 'utf8')), noise: meta[id]?.noise || [] });
  }
  return out;
}

export function formatText(st) {
  const pct = (x) => `${Math.round(100 * x)}%`;
  const L = [];
  const T = st.totals;
  L.push(`practised ${T.minutes} min over ${T.days} day(s), ${T.sessions} session(s); streak ${T.streak} day(s); ${T.targets} targets, ${pct(T.matched / Math.max(1, T.targets))} matched, time to match p50 ${T.timeToMatchP50}s p90 ${T.timeToMatchP90}s`);
  if (st.labels.fp || st.labels.fn) L.push(`player labels: ${st.labels.fp} wrong match(es) flagged, ${st.labels.fn} missed chord(s) flagged`);
  if (st.enrolls.chords || st.enrolls.strings) L.push(`calibration takes: ${st.enrolls.chords} chord(s), ${st.enrolls.strings} open string(s)`);
  L.push('', '  day         min  targets  matched');
  for (const d of st.allDays) L.push(`  ${d.day}  ${String(d.minutes).padStart(5)}  ${String(d.targets).padStart(7)}  ${pct(d.matched / Math.max(1, d.targets)).padStart(7)}`);
  L.push('', '  chord   shown  matched   p50    p90   heard instead');
  for (const c of st.chords) L.push(`  ${c.id.padEnd(7)} ${String(c.shown).padStart(5)}  ${pct(c.rate).padStart(7)}  ${String(c.p50 ?? '-').padStart(4)}s  ${String(c.p90 ?? '-').padStart(4)}s   ${c.heardInstead.map(h => `${h.id}×${h.n}`).join(' ')}`);
  L.push('', '  slowest transitions (n ≥ 2)     n  matched   p50');
  for (const x of st.slowest) L.push(`  ${`${x.from} → ${x.to}`.padEnd(30)} ${String(x.n).padStart(3)}  ${pct(x.rate).padStart(7)}  ${String(x.p50 ?? '-').padStart(4)}s`);
  L.push('', '  most missed transitions (n ≥ 2)  n  matched   p50');
  for (const x of st.mostMissed) L.push(`  ${`${x.from} → ${x.to}`.padEnd(30)} ${String(x.n).padStart(3)}  ${pct(x.rate).padStart(7)}  ${String(x.p50 ?? '-').padStart(4)}s`);
  return L.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
  const telDir = args['tel-dir'] || path.resolve(import.meta.dirname, '../telemetry');
  const meta = args.meta || path.resolve(import.meta.dirname, '../data/user/sessions.json');
  const st = aggregate(loadSessions(telDir, meta), { minMatches: Number(args['min-matches'] ?? 10), days: Number(args.days ?? 14), top: Number(args.top ?? 12) });
  if (args.json) process.stdout.write(JSON.stringify(st) + '\n');
  else console.log(formatText(st));
}
