/**
 * Nail Studio Pro — fonte única dos ícones e miniaturas (SVG).
 * Usado para montar o arquivo Figma "Nail Studio Pro — Ícones e Miniaturas"
 * e para gerar assets/ (node design/icons.js --write).
 */
'use strict';

function star(cx, cy, r, k = 0.16) {
  const f = n => Math.round(n * 100) / 100;
  return `M${f(cx)} ${f(cy - r)}Q${f(cx + k * r)} ${f(cy - k * r)} ${f(cx + r)} ${f(cy)}Q${f(cx + k * r)} ${f(cy + k * r)} ${f(cx)} ${f(cy + r)}Q${f(cx - k * r)} ${f(cy + k * r)} ${f(cx - r)} ${f(cy)}Q${f(cx - k * r)} ${f(cy - k * r)} ${f(cx)} ${f(cy - r)}Z`;
}

// Glifos 48×48, traço branco 3px (C = cor de acento usada em pequenos detalhes)
const S = 'stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';
const GLYPHS = {
  alongamentos: `
    <path d="M16 45V25a8 8 0 0 1 16 0v20" ${S}/>
    <path d="M19 24.5V13c0-5 2.4-8.8 5-10.5 2.6 1.7 5 5.5 5 10.5v11.5c0 1.4-1.6 2.2-5 2.2s-5-.8-5-2.2z" fill="#FFFFFF"/>
    <path d="M22.2 9.5v8" stroke="C" stroke-width="2" stroke-linecap="round" opacity=".55"/>
    <path d="${star(39, 10, 5)}" fill="#FFFFFF"/>`,
  manicure: `
    <rect x="19" y="3" width="10" height="14" rx="3" fill="#FFFFFF"/>
    <rect x="16.5" y="17" width="15" height="5" rx="1.8" ${S}/>
    <rect x="10.5" y="22" width="27" height="23" rx="8" ${S}/>
    <path d="M14 31.5h20v4.5a6 6 0 0 1-6 6h-8a6 6 0 0 1-6-6z" fill="#FFFFFF"/>
    <path d="M16.5 25.5v3" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>`,
  blindagem: `
    <path d="M24 3.5 39.5 9.5V22c0 10.6-6.6 18.6-15.5 22.5C15.1 40.6 8.5 32.6 8.5 22V9.5z" ${S}/>
    <path d="M24 14s-7.5 8.2-7.5 13.3a7.5 7.5 0 0 0 15 0C31.5 22.2 24 14 24 14z" fill="#FFFFFF"/>
    <path d="M21 27.5a3 3 0 0 0 3 3" stroke="C" stroke-width="2" stroke-linecap="round" opacity=".6"/>`,
  nailart: `
    <path d="M39 5 25.5 20.5" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M24.6 20.2c-3.2-2.8-9.4-1.2-10.5 5-.8 4.4-4.3 6.6-6.8 7.6 6.6 3.4 15.2 2.3 18.3-3.4 1.6-3 1.6-6.4-1-9.2z" fill="#FFFFFF"/>
    <circle cx="35" cy="30" r="3.2" fill="#FFFFFF"/>
    <circle cx="41" cy="38.5" r="2.6" fill="#FFFFFF"/>
    <circle cx="30" cy="41.5" r="2.6" fill="#FFFFFF"/>`,
  spa: `
    <path d="M24 8.5c5.6 6.4 5.6 16.4 0 25.5-5.6-9.1-5.6-19.1 0-25.5z" fill="#FFFFFF"/>
    <path d="M24 34c-8.4-.6-14.6-6.6-15.5-15 6.6 0 13 4.4 15.5 15z" ${S}/>
    <path d="M24 34c8.4-.6 14.6-6.6 15.5-15-6.6 0-13 4.4-15.5 15z" ${S}/>
    <path d="M9 41.5c5-3 9.5 2.6 15 0s10-3 15 0" ${S}/>`,
  geral: `
    <path d="${star(21, 22, 16)}" fill="#FFFFFF"/>
    <path d="${star(38.5, 37.5, 7)}" fill="#FFFFFF"/>
    <circle cx="39" cy="10" r="2.6" fill="#FFFFFF"/>`
};

// Paletas por categoria: [cor forte, cor clara, fundo claro 1, fundo claro 2]
const PALETTES = {
  alongamentos: ['#FF1675', '#FF7AA8', '#FFE4EF', '#FFF1F6'],
  manicure: ['#E11D48', '#FB7185', '#FFE4E6', '#FFF5F5'],
  blindagem: ['#8B5CF6', '#C084FC', '#EDE9FE', '#FAF5FF'],
  nailart: ['#F59E0B', '#FB923C', '#FEF3C7', '#FFF7ED'],
  spa: ['#10B981', '#5EEAD4', '#D1FAE5', '#F0FDFA'],
  geral: ['#EC4899', '#F59E0B', '#FCE7F3', '#FFF7ED']
};

const LABELS = {
  alongamentos: 'Alongamentos', manicure: 'Manicure & Pedicure', blindagem: 'Blindagem & Gel',
  nailart: 'Nail Art', spa: 'Spa dos Pés & Mãos', geral: 'Outros / Geral'
};

function glyph(key) { return GLYPHS[key].replace(/"C"/g, `"${PALETTES[key][0]}"`); }

/** Ícone de categoria: azulejo arredondado com gradiente (96×96). */
function categoryTile(key, size = 96) {
  const [c1, c2] = PALETTES[key];
  return `<svg width="${size}" height="${size}" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g-${key}" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="96" height="96" rx="28" fill="url(#g-${key})"/>
  <circle cx="80" cy="16" r="12" fill="#FFFFFF" fill-opacity="0.16"/>
  <g transform="translate(22 22) scale(1.083)">${glyph(key)}</g>
</svg>`;
}

/** Miniatura de serviço (600×600) para quando não houver foto. */
function thumbnail(key) {
  const [c1, c2, l1, l2] = PALETTES[key];
  return `<svg width="600" height="600" viewBox="0 0 600 600" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-${key}" x1="0" y1="0" x2="600" y2="600" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${l1}"/><stop offset="1" stop-color="${l2}"/></linearGradient>
    <linearGradient id="tile-${key}" x1="172" y1="172" x2="428" y2="428" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg-${key})"/>
  <circle cx="500" cy="96" r="170" fill="${c2}" fill-opacity="0.18"/>
  <circle cx="70" cy="540" r="210" fill="${c1}" fill-opacity="0.10"/>
  <circle cx="300" cy="300" r="176" fill="#FFFFFF" fill-opacity="0.6"/>
  <circle cx="300" cy="312" r="130" fill="${c1}" fill-opacity="0.18"/>
  <circle cx="300" cy="300" r="130" fill="url(#tile-${key})"/>
  <g transform="translate(204 204) scale(4)">${glyph(key)}</g>
  <path d="${star(118, 150, 26)}" fill="${c1}" fill-opacity="0.75"/>
  <path d="${star(486, 452, 20)}" fill="${c2}"/>
  <path d="${star(452, 190, 12)}" fill="${c1}" fill-opacity="0.5"/>
  <circle cx="150" cy="430" r="9" fill="${c2}" fill-opacity="0.8"/>
  <circle cx="520" cy="300" r="6" fill="${c1}" fill-opacity="0.6"/>
</svg>`;
}

/** Ícone do aplicativo (1024×1024, sangria total — seguro para "maskable" e Android adaptativo). */
function appIcon() {
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="app-bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF1675"/><stop offset="0.55" stop-color="#FF5C97"/><stop offset="1" stop-color="#F59E0B"/></linearGradient>
    <linearGradient id="app-polish" x1="356" y1="540" x2="668" y2="776" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF1675"/><stop offset="1" stop-color="#B8004B"/></linearGradient>
    <linearGradient id="app-cap" x1="440" y1="196" x2="584" y2="432" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5A1238"/><stop offset="1" stop-color="#240C18"/></linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#app-bg)"/>
  <circle cx="870" cy="160" r="270" fill="#FFFFFF" fill-opacity="0.10"/>
  <circle cx="110" cy="940" r="310" fill="#FFFFFF" fill-opacity="0.08"/>
  <ellipse cx="512" cy="826" rx="214" ry="30" fill="#240C18" fill-opacity="0.16"/>
  <rect x="440" y="196" width="144" height="236" rx="44" fill="url(#app-cap)"/>
  <rect x="463" y="224" width="22" height="168" rx="11" fill="#FFFFFF" fill-opacity="0.22"/>
  <rect x="414" y="420" width="196" height="64" rx="20" fill="#FFFFFF"/>
  <rect x="322" y="468" width="380" height="342" rx="106" fill="#FFFFFF"/>
  <rect x="356" y="540" width="312" height="236" rx="82" fill="url(#app-polish)"/>
  <rect x="390" y="566" width="32" height="124" rx="16" fill="#FFFFFF" fill-opacity="0.5"/>
  <path d="${star(748, 300, 92)}" fill="#FFFFFF"/>
  <path d="${star(276, 330, 48)}" fill="#FFFFFF" fill-opacity="0.92"/>
  <circle cx="790" cy="470" r="14" fill="#FFFFFF" fill-opacity="0.85"/>
</svg>`;
}

/** Só o glifo branco do app (primeiro plano do ícone adaptativo Android, 108dp → 1024). */
function appForeground() {
  return appIcon()
    .replace(/<rect width="1024" height="1024" fill="url\(#app-bg\)"\/>/, '')
    .replace(/<circle cx="870"[^>]*\/>/, '')
    .replace(/<circle cx="110"[^>]*\/>/, '');
}

module.exports = { GLYPHS, PALETTES, LABELS, glyph, categoryTile, thumbnail, appIcon, appForeground, star };

if (require.main === module) {
  const out = {
    appIcon: appIcon(),
    tiles: Object.fromEntries(Object.keys(GLYPHS).map(k => [k, categoryTile(k)])),
    thumbs: Object.fromEntries(Object.keys(GLYPHS).map(k => [k, thumbnail(k)])),
    labels: LABELS
  };
  process.stdout.write(JSON.stringify(out));
}
