// SVG chord-chart renderer. Input: a chord object from chords.json.
// Output: SVGElement to inject into the DOM.

const W = 130, H = 160;
const GRID_X = 18, GRID_Y = 32;
const STR_GAP = 18;          // horizontal: 6 strings → 5 gaps
const FRET_GAP = 22;         // vertical: 5 frets shown
const STRINGS = 6;
const FRETS = 5;

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(c);
  return e;
}

export function renderChord(chord) {
  const { fingering } = chord;
  const { frets, fingers, baseFret = 1 } = fingering;

  const svg = el('svg', {
    width: W, height: H, viewBox: `0 0 ${W} ${H}`,
    xmlns: NS, role: 'img',
    'aria-label': `${chord.fullName} chord diagram`,
  });

  // strings (vertical lines), low E on the left
  for (let s = 0; s < STRINGS; s++) {
    const x = GRID_X + s * STR_GAP;
    svg.appendChild(el('line', {
      x1: x, y1: GRID_Y,
      x2: x, y2: GRID_Y + FRETS * FRET_GAP,
      class: 'grid',
    }));
  }
  // frets (horizontal lines)
  for (let f = 0; f <= FRETS; f++) {
    const y = GRID_Y + f * FRET_GAP;
    svg.appendChild(el('line', {
      x1: GRID_X, y1: y,
      x2: GRID_X + (STRINGS - 1) * STR_GAP, y2: y,
      class: f === 0 && baseFret === 1 ? 'nut' : 'grid',
    }));
  }

  // base-fret label (e.g. "5fr") if not showing the nut
  if (baseFret > 1) {
    svg.appendChild(el('text', {
      x: GRID_X + (STRINGS - 1) * STR_GAP + 6,
      y: GRID_Y + 14, class: 'label',
    }, [document.createTextNode(`${baseFret}fr`)]));
  }

  // O / X marks above the nut + finger dots
  for (let s = 0; s < STRINGS; s++) {
    const x = GRID_X + s * STR_GAP;
    const fret = frets[s];
    const finger = fingers[s];

    if (fret === -1) {
      const cx = x, cy = GRID_Y - 12;
      svg.appendChild(el('line', {
        x1: cx - 4, y1: cy - 4, x2: cx + 4, y2: cy + 4, class: 'mute',
      }));
      svg.appendChild(el('line', {
        x1: cx - 4, y1: cy + 4, x2: cx + 4, y2: cy - 4, class: 'mute',
      }));
    } else if (fret === 0) {
      svg.appendChild(el('circle', {
        cx: x, cy: GRID_Y - 12, r: 4, class: 'open',
      }));
    } else {
      const relFret = fret - baseFret + 1;
      if (relFret >= 1 && relFret <= FRETS) {
        const cy = GRID_Y + (relFret - 0.5) * FRET_GAP;
        svg.appendChild(el('circle', {
          cx: x, cy, r: 7, class: 'dot',
        }));
        if (finger > 0) {
          svg.appendChild(el('text', {
            x, y: cy + 3, 'text-anchor': 'middle', class: 'finger',
          }, [document.createTextNode(String(finger))]));
        }
      }
    }
  }

  return svg;
}

export function renderInto(container, chord) {
  container.innerHTML = '';
  if (!chord) return;
  container.appendChild(renderChord(chord));
}
