// Fit / inspect the guitar-likeness gate on tools/gate_features.mjs output.
//   node tools/gate_fit.mjs [--in=/mnt/aegis/chord-bunny/gate/features.jsonl] [--features=resid,flat,rev] [--fit] [--thr=0.5]
// Prints per-feature class quantiles, single-feature threshold sweeps
// (share of TV frames passing vs share of strum-aligned guitar frames
// passing), and with --fit a logistic regression on the chosen features
// (standardised, gradient descent, held-out session for the numbers).
import fs from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const rows = fs.readFileSync(args.in || '/mnt/aegis/chord-bunny/gate/features.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// dynamics are not in the file: recompute from level sequences per tag (rows are in time order per tag)
{
  const W = 0.5; const by = new Map();
  for (const r of rows) (by.get(r.tag) || by.set(r.tag, []).get(r.tag)).push(r);
  for (const [, rs] of by) {
    const L = [];
    for (const r of rs) {
      if (L.length && r.ts - L[L.length - 1][0] > 0.1) L.length = 0;   // a gap (silence) resets, as gate.silent() does
      L.push([r.ts, r.level]); while (L.length && r.ts - L[0][0] > W) L.shift();
      let mx = 0, mn = Infinity, rev = 0, up = 0, dir = 0;
      for (let i = 0; i < L.length; i++) { const l = L[i][1]; if (l > mx) mx = l; if (l < mn) mn = l; if (i > 0) { const d = l - L[i - 1][1], s = Math.abs(d) > 0.05 * l ? Math.sign(d) : 0; if (s && dir && s !== dir) rev++; if (s) dir = s; if (d > 0) up++; } }
      r.mod = mx > 0 ? (mx - mn) / mx : 0; r.rev = rev; r.upFrac = L.length > 1 ? up / (L.length - 1) : 0;
    }
  }
}
const FEATS = (args.features ? String(args.features).split(',') : ['resid', 'flat', 'cmax', 'cent', 'top4', 'crest', 'fit', 'conf', 'level', 'mod', 'rev', 'upFrac']);
const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = x => `${(100 * x).toFixed(1)}%`;
const classes = ['guitar', 'gs', 'other', 'tv'];
console.log(`${rows.length} frames: ` + classes.map(c => `${c} ${rows.filter(r => r.label === c).length}`).join(', '));
console.log('\nfeature   class    p10     p25     p50     p75     p90');
for (const f of FEATS) for (const c of classes) { const xs = rows.filter(r => r.label === c).map(r => r[f]); console.log(`${f.padEnd(8)}  ${c.padEnd(6)} ` + [0.1, 0.25, 0.5, 0.75, 0.9].map(p => q(xs, p).toFixed(3).padStart(7)).join(' ')); }
// single-feature sweeps: for each feature, the threshold that lets 95% / 98% of guitar frames through, and the TV share that passes then
console.log('\nsingle feature: keep 98% (95%) of strum-aligned guitar frames → TV frames passing');
const G = rows.filter(r => r.label === 'guitar'), TV = rows.filter(r => r.label === 'tv'), GS = rows.filter(r => r.label === 'gs');
for (const f of FEATS) {
  const gx = G.map(r => r[f]), lowIsGuitar = q(gx, 0.5) < q(TV.map(r => r[f]), 0.5);
  const line = [0.98, 0.95].map(keep => { const thr = lowIsGuitar ? q(gx, keep) : q(gx, 1 - keep); const pass = r => lowIsGuitar ? r[f] <= thr : r[f] >= thr; return `thr ${thr.toFixed(3)}: tv ${pct(TV.filter(pass).length / TV.length)}, gs ${pct(GS.filter(pass).length / GS.length)}`; });
  console.log(`  ${f.padEnd(8)} ${lowIsGuitar ? 'low ' : 'high'} = guitar   98%→ ${line[0]}   95%→ ${line[1]}`);
}
if (args.fit) {
  const F = args.features ? FEATS : ['resid', 'flat', 'rev'];
  const lab = r => r.label === 'tv' ? 0 : (r.label === 'guitar' || r.label === 'gs') ? 1 : null;
  const data = rows.filter(r => lab(r) !== null);
  const mean = {}, sd = {}; for (const f of F) { const xs = data.map(r => r[f]); const m = xs.reduce((a, b) => a + b, 0) / xs.length; mean[f] = m; sd[f] = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1; }
  const train = data.filter(r => r.tag !== 'ho9k' || r.label === 'tv' && r.ts % 2 < 1), test = data.filter(r => r.tag === 'ho9k' && !(r.label === 'tv' && r.ts % 2 < 1));
  // balanced logistic regression, standardised inputs
  const w = new Array(F.length).fill(0); let b = 0; const lr = 0.5;
  const npos = train.filter(r => lab(r) === 1).length, nneg = train.length - npos;
  for (let it = 0; it < 400; it++) {
    const gw = new Array(F.length).fill(0); let gb = 0;
    for (const r of train) { const y = lab(r), cw = y ? 0.5 / npos : 0.5 / nneg; let z = b; for (let i = 0; i < F.length; i++) z += w[i] * (r[F[i]] - mean[F[i]]) / sd[F[i]]; const p = 1 / (1 + Math.exp(-z)); const e = (p - y) * cw; gb += e; for (let i = 0; i < F.length; i++) gw[i] += e * (r[F[i]] - mean[F[i]]) / sd[F[i]]; }
    b -= lr * gb; for (let i = 0; i < F.length; i++) w[i] -= lr * gw[i];
  }
  // express in raw feature units: z = bias + Σ w_i/sd_i · x_i
  const raw = {}; let bias = b; for (let i = 0; i < F.length; i++) { raw[F[i]] = w[i] / sd[F[i]]; bias -= w[i] * mean[F[i]] / sd[F[i]]; }
  const score = r => { let z = bias; for (const f of F) z += raw[f] * r[f]; return 1 / (1 + Math.exp(-z)); };
  console.log(`\nlogistic fit on ${F.join(',')}: bias ${bias.toFixed(3)}, weights ${JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, +v.toFixed(3)])))}`);
  for (const [name, set] of [['train', train], ['test (ho9k guitar + half its tv)', test]]) {
    for (const thr of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const g = set.filter(r => lab(r) === 1), t = set.filter(r => lab(r) === 0);
      console.log(`  ${name.padEnd(34)} thr ${thr}: guitar pass ${pct(g.filter(r => score(r) >= thr).length / g.length)}   tv pass ${pct(t.filter(r => score(r) >= thr).length / t.length)}   other pass ${pct(rows.filter(r => r.label === 'other' && set.includes(r) === false && r.tag === 'ho9k').filter(r => score(r) >= thr).length / Math.max(1, rows.filter(r => r.label === 'other' && r.tag === 'ho9k').length))}`);
    }
  }
}
