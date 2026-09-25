// Progress panel (settings → progress): what the telemetry says about the
// player's practice — minutes per day, per-chord match rate, the slowest
// transitions. Data from GET /api/stats (tools/stats.mjs); the same object
// feeds weak-spot drilling in practice.js. Inline SVG, no libraries.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => `${Math.round(100 * x)}%`;
const fmtMin = (m) => m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`;

export async function fetchStats() {
  const r = await fetch('api/stats');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// Minutes per day, last N days: bars ≤ 24 px wide, rounded at the data end,
// square at the baseline, a 2 px surface gap between neighbours; only the
// tallest bar and today carry a number (the rest are in the hover title).
function daysChart(days) {
  const W = 320, H = 72, PAD_B = 16, PAD_T = 12, n = days.length;
  const slot = W / n, bw = Math.min(24, slot - 2), max = Math.max(1, ...days.map(d => d.minutes));
  const iMax = days.reduce((b, d, i) => d.minutes > days[b].minutes ? i : b, 0);
  let out = `<svg class="pg-days" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="minutes practised per day, last ${n} days">`;
  out += `<line x1="0" x2="${W}" y1="${H - PAD_B + 0.5}" y2="${H - PAD_B + 0.5}" class="axis"/>`;
  days.forEach((d, i) => {
    const h = d.minutes > 0 ? Math.max(2, (H - PAD_B - PAD_T) * d.minutes / max) : 0;
    const x = i * slot + (slot - bw) / 2, y = H - PAD_B - h, r = Math.min(4, h / 2);
    const wd = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(d.day + 'T12:00:00').getDay()];
    const title = `${d.day}: ${d.minutes} min, ${d.targets} targets, ${d.targets ? pct(d.matched / d.targets) : '–'} matched`;
    if (h > 0) out += `<path class="bar${i === n - 1 ? ' today' : ''}" d="M${x} ${H - PAD_B} v${-(h - r)} a${r} ${r} 0 0 1 ${r} ${-r} h${bw - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} z"><title>${esc(title)}</title></path>`;
    else out += `<rect class="bar empty" x="${x}" y="${H - PAD_B - 2}" width="${bw}" height="2"><title>${esc(title)}</title></rect>`;
    out += `<text class="lbl" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${wd}</text>`;
    if (d.minutes > 0 && (i === iMax || i === n - 1)) out += `<text class="val" x="${x + bw / 2}" y="${y - 3}" text-anchor="middle">${Math.round(d.minutes)}</text>`;
  });
  return out + '</svg>';
}

export function render(root, st) {
  if (!st || !st.totals || !st.totals.targets) {
    root.innerHTML = '<p class="pg-empty">no practice recorded yet — play a few targets with the mic on and come back.</p>';
    return;
  }
  const T = st.totals;
  const tiles = [
    [fmtMin(T.minutes), 'practised'],
    [T.days, `day${T.days === 1 ? '' : 's'} · streak ${T.streak}`],
    [pct(T.matched / Math.max(1, T.targets)), `of ${T.targets} targets matched`],
    [`${T.timeToMatchP50 ?? '–'} s`, 'median time to match'],
  ];
  const chords = st.chords.slice(0, 16);
  const slowest = st.slowest.slice(0, 8);
  const missed = st.mostMissed.filter(x => x.rate < 0.85).slice(0, 4);
  root.innerHTML = `
    <div class="pg-tiles">${tiles.map(([v, l]) => `<div class="pg-tile"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('')}</div>
    <div class="pg-row">
      <div class="pg-block">
        <div class="pg-title">last ${Math.min(7, st.days.length)} days, minutes</div>
        ${daysChart(st.days.slice(-7))}
      </div>
      <div class="pg-block pg-chords">
        <div class="pg-title">chords · matched share, median time</div>
        ${chords.map(c => `<div class="pg-chord" title="${esc(`${c.id}: shown ${c.shown}, matched ${c.matched}${c.heardInstead.length ? ', heard instead ' + c.heardInstead.map(h => `${h.id}×${h.n}`).join(' ') : ''}`)}">
          <span class="id">${esc(c.id)}</span>
          <span class="track"><span class="fill${c.rate < 0.7 ? ' low' : ''}" style="width:${Math.round(100 * c.rate)}%"></span></span>
          <span class="num">${pct(c.rate)} · ${c.p50 ?? '–'} s</span>
        </div>`).join('')}
      </div>
    </div>
    <div class="pg-block">
      <div class="pg-title">slowest transitions (median time to match, seen ≥ 2×)</div>
      <table class="pg-table"><thead><tr><th>from → to</th><th>median</th><th>matched</th><th>n</th></tr></thead><tbody>
        ${slowest.map(x => `<tr><td>${esc(x.from)} → ${esc(x.to)}</td><td>${x.p50 ?? '–'} s</td><td>${pct(x.rate)}</td><td>${x.n}</td></tr>`).join('')}
      </tbody></table>
      ${missed.length ? `<div class="pg-note">most missed: ${missed.map(x => `${esc(x.from)} → ${esc(x.to)} (${pct(x.rate)})`).join(', ')}</div>` : ''}
      ${st.labels.fp || st.labels.fn ? `<div class="pg-note">you flagged ${st.labels.fp} wrong match${st.labels.fp === 1 ? '' : 'es'} and ${st.labels.fn} missed chord${st.labels.fn === 1 ? '' : 's'} (N / Y after an advance).</div>` : ''}
      <div class="pg-note">with "drill weak spots" on, random pairs lean toward the slow and missed transitions above.</div>
    </div>`;
}
