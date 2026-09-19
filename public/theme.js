/* ============================================================
   Theme engine - 10 accent themes, each with an icon.
   Builds Material-style tonal palettes for light and dark modes.
   ============================================================ */

const THEMES = [
  { id: 'blue', name: 'Blue', icon: 'water_drop', seed: '#0061A4' },
  { id: 'blurple', name: 'Blurple', icon: 'forum', seed: '#5865F2' },
  { id: 'green', name: 'Green', icon: 'forest', seed: '#2E7D32' },
  { id: 'teal', name: 'Teal', icon: 'spa', seed: '#00796B' },
  { id: 'purple', name: 'Purple', icon: 'palette', seed: '#6750A4' },
  { id: 'pink', name: 'Pink', icon: 'favorite', seed: '#C2185B' },
  { id: 'orange', name: 'Orange', icon: 'local_fire_department', seed: '#E65100' },
  { id: 'red', name: 'Red', icon: 'emergency', seed: '#C62828' },
  { id: 'indigo', name: 'Indigo', icon: 'nightlight_round', seed: '#3949AB' },
  { id: 'amber', name: 'Amber', icon: 'wb_sunny', seed: '#F9A825' },
];

function hexToHsl(hex) {
  let c = String(hex).replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100) };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360}, ${Math.round(s)}%, ${Math.round(l)}%)`;

function makePalette(seed, mode) {
  const { h, s } = hexToHsl(seed);
  const dark = mode === 'dark';
  const v = {};

  if (!dark) {
    v['--primary'] = hsl(h, clamp(s, 42, 82), 40);
    v['--on-primary'] = '#ffffff';
    v['--primary-container'] = hsl(h, clamp(s, 55, 92), 90);
    v['--on-primary-container'] = hsl(h, clamp(s, 45, 80), 18);
    v['--secondary'] = hsl(h, clamp(s * 0.35, 12, 42), 40);
    v['--secondary-container'] = hsl(h, clamp(s * 0.4, 16, 48), 90);
    v['--on-secondary-container'] = hsl(h, clamp(s * 0.4, 16, 42), 18);
    v['--tertiary'] = hsl(h + 60, clamp(s * 0.5, 20, 55), 42);
    v['--tertiary-container'] = hsl(h + 60, clamp(s * 0.5, 26, 62), 90);
    v['--on-tertiary-container'] = hsl(h + 60, clamp(s * 0.5, 26, 52), 18);
    v['--error'] = '#ba1a1a';
    v['--error-container'] = '#ffdad6';
    v['--on-error-container'] = '#410002';
    v['--background'] = hsl(h, clamp(s * 0.25, 4, 22), 99);
    v['--on-background'] = hsl(h, 12, 12);
    v['--surface'] = v['--background'];
    v['--on-surface'] = v['--on-background'];
    v['--surface-variant'] = hsl(h, clamp(s * 0.2, 8, 26), 90);
    v['--on-surface-variant'] = hsl(h, 10, 30);
    v['--surface-container-lowest'] = '#ffffff';
    v['--surface-container-low'] = hsl(h, clamp(s * 0.2, 5, 18), 97);
    v['--surface-container'] = hsl(h, clamp(s * 0.2, 5, 18), 94);
    v['--surface-container-high'] = hsl(h, clamp(s * 0.2, 5, 18), 91);
    v['--surface-container-highest'] = hsl(h, clamp(s * 0.2, 5, 18), 88);
    v['--outline'] = hsl(h, 8, 48);
    v['--outline-variant'] = hsl(h, 10, 80);
    v['--inverse-surface'] = hsl(h, 10, 18);
    v['--inverse-on-surface'] = hsl(h, clamp(s * 0.2, 5, 20), 95);
    v['--success'] = '#146c2e';
    v['--success-container'] = '#c4eed0';
    v['--on-success-container'] = '#072711';
  } else {
    v['--primary'] = hsl(h, clamp(s, 42, 80), 78);
    v['--on-primary'] = hsl(h, clamp(s, 40, 80), 18);
    v['--primary-container'] = hsl(h, clamp(s, 35, 60), 32);
    v['--on-primary-container'] = hsl(h, clamp(s, 45, 90), 90);
    v['--secondary'] = hsl(h, clamp(s * 0.3, 12, 38), 80);
    v['--secondary-container'] = hsl(h, clamp(s * 0.35, 15, 42), 30);
    v['--on-secondary-container'] = hsl(h, clamp(s * 0.4, 15, 42), 90);
    v['--tertiary'] = hsl(h + 60, clamp(s * 0.45, 18, 48), 80);
    v['--tertiary-container'] = hsl(h + 60, clamp(s * 0.45, 20, 50), 30);
    v['--on-tertiary-container'] = hsl(h + 60, clamp(s * 0.5, 25, 52), 90);
    v['--error'] = '#ffb4ab';
    v['--error-container'] = '#93000a';
    v['--on-error-container'] = '#ffdad6';
    v['--background'] = hsl(h, clamp(s * 0.25, 4, 18), 10);
    v['--on-background'] = hsl(h, clamp(s * 0.2, 5, 22), 90);
    v['--surface'] = v['--background'];
    v['--on-surface'] = v['--on-background'];
    v['--surface-variant'] = hsl(h, clamp(s * 0.2, 8, 22), 28);
    v['--on-surface-variant'] = hsl(h, clamp(s * 0.15, 6, 20), 80);
    v['--surface-container-lowest'] = hsl(h, clamp(s * 0.2, 4, 16), 7);
    v['--surface-container-low'] = hsl(h, clamp(s * 0.2, 4, 16), 11);
    v['--surface-container'] = hsl(h, clamp(s * 0.2, 4, 16), 14);
    v['--surface-container-high'] = hsl(h, clamp(s * 0.2, 4, 16), 18);
    v['--surface-container-highest'] = hsl(h, clamp(s * 0.2, 4, 16), 22);
    v['--outline'] = hsl(h, 8, 58);
    v['--outline-variant'] = hsl(h, 10, 30);
    v['--inverse-surface'] = hsl(h, clamp(s * 0.2, 5, 22), 90);
    v['--inverse-on-surface'] = hsl(h, 10, 18);
    v['--success'] = '#7fe0a0';
    v['--success-container'] = '#0c3d1f';
    v['--on-success-container'] = '#c4eed0';
  }
  return v;
}

function applyAccent(accentId, mode = 'light') {
  const theme = THEMES.find((t) => t.id === accentId) || THEMES[0];
  const root = document.documentElement;
  const palette = makePalette(theme.seed, mode);
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(key, value);
  }
  root.dataset.accent = theme.id;
  return theme;
}

window.Theme = { THEMES, applyAccent, makePalette };
