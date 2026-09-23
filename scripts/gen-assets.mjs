#!/usr/bin/env node
/*
 * Regenerates the README's source-derived images.
 *
 * Both are built from the same data the desktop renders from - the pixel grids in
 * Icon.tsx and the paths in AirflowLogo.tsx - so the documentation cannot drift from
 * the product. Screenshots still have to be taken by hand; see docs/img/README.md.
 */
import { readFileSync, writeFileSync } from "node:fs";

const ICON_SRC = "ui/src/os/components/Icon.tsx";
const LOGO_SRC = "ui/src/os/components/AirflowLogo.tsx";

function iconSheet() {
  const src = readFileSync(ICON_SRC, "utf8");

  const palette = {};
  const block = src.slice(src.indexOf("const PALETTE"), src.indexOf("};", src.indexOf("const PALETTE")));
  for (const m of block.matchAll(/^\s*"?([.a-zA-Z])"?:\s*"([^"]*)"/gm)) palette[m[1]] = m[2];

  const grids = {};
  for (const m of src.matchAll(/^ {2}"?([a-zA-Z-]+)"?: \[\n((?:\s*"[^"]*",\n)+)\s*\],/gm)) {
    grids[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((r) => r[1]);
  }
  const names = Object.keys(grids);
  if (names.length === 0) throw new Error("no icon grids parsed");

  const SCALE = 3, PAD = 10, COLS = 6, TILE = 16 * SCALE, CELL_W = 96, CELL_H = TILE + 26;
  const rows = Math.ceil(names.length / COLS);
  const W = COLS * CELL_W + PAD * 2, H = rows * CELL_H + PAD * 2 + 8;

  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" font-family="'MS Sans Serif',Tahoma,Verdana,sans-serif">\n`;
  out += `<rect width="${W}" height="${H}" fill="#c0c0c0"/>\n`;
  names.forEach((name, i) => {
    const cx = PAD + (i % COLS) * CELL_W + (CELL_W - TILE) / 2;
    const cy = PAD + Math.floor(i / COLS) * CELL_H;
    out += `<g transform="translate(${cx} ${cy})">`;
    grids[name].forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        let w = 1;
        while (x + w < row.length && row[x + w] === ch) w += 1;
        if (palette[ch]) {
          out += `<rect x="${x * SCALE}" y="${y * SCALE}" width="${w * SCALE}" height="${SCALE}" fill="${palette[ch]}"/>`;
        }
        x += w;
      }
    });
    out += `<text x="${TILE / 2}" y="${TILE + 12}" font-size="9" text-anchor="middle" fill="#000">${name}</text></g>\n`;
  });
  writeFileSync("docs/img/icons.svg", `${out}</svg>\n`);
  return names.length;
}

const LOGO_FONT = "'MS Sans Serif', 'Microsoft Sans Serif', Tahoma, Geneva, Verdana, sans-serif";

// The eight logo paths, straight out of AirflowLogo.tsx.
function logoPaths() {
  const src = readFileSync(LOGO_SRC, "utf8");
  // Key order inside each entry is whatever the formatter last chose, so parse fields
  // individually rather than assuming a shape.
  const paths = [];
  for (const [, entry] of src.matchAll(/^ {2}\{ (.+) \},$/gm)) {
    const d = /d: "([^"]+)"/.exec(entry)?.[1];
    const fill = /fill: "(#[0-9a-fA-F]+)"/.exec(entry)?.[1];
    if (!d || !fill) continue;
    const eo = entry.includes("evenOdd: true") ? ' fill-rule="evenodd" clip-rule="evenodd"' : "";
    paths.push(`<path d="${d}" fill="${fill}"${eo}/>`);
  }
  if (paths.length !== 8) throw new Error(`expected 8 logo paths, parsed ${paths.length}`);
  return paths;
}

// The pinwheel turning like the boot splash does. SMIL rather than CSS because GitHub
// serves README images through a proxy and renders them in <img>, where scripts are
// dropped but declarative animation survives. Same 3.4s period as .aos-splash-logo.
function spinningLogo(paths, indent = "") {
  return [
    `${indent}<g>`,
    `${indent}<animateTransform attributeName="transform" type="rotate" from="0 87.5 87.5" to="360 87.5 87.5" dur="3.4s" repeatCount="indefinite"/>`,
    ...paths.map((p) => indent + p),
    `${indent}</g>`,
  ].join("\n");
}

function pinwheel() {
  const paths = logoPaths();
  // The logo fills its 175x175 canvas to the corners, and a corner swings out to
  // 87.5*sqrt(2) ~ 124 from the centre mid-turn, so the viewBox is padded to the
  // rotation circle: nothing clips at any angle.
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="-37 -37 249 249">
${spinningLogo(paths)}
</svg>
`;
  writeFileSync("docs/img/pinwheel.svg", out);
  return paths.length;
}

// The boot splash as one picture: the sky, the clouds, the dither, the pinwheel and the
// wordmark, laid out the way BootSplash.tsx and the .aos-splash-* rules lay them out.
// Text stays text (system fonts are available inside <img>; only web fonts are not),
// with the same fallback chain the desktop uses, so it degrades exactly as the UI does.
function splash() {
  const W = 720;
  const H = 300;
  const paths = logoPaths();
  const logo = 190; // AirflowLogo size on the splash
  const gap = 26; // .aos-splash-plate gap
  const words = 372; // measured width of "Airflow OS" at 62px bold, with slack
  const plateW = logo + gap + words;
  const x0 = Math.round((W - plateW) / 2);
  const cy = Math.round(H * 0.46); // translate(-50%, -58%) puts the plate a little high
  const logoX = x0;
  const logoY = cy - logo / 2;
  const textX = x0 + logo + gap;

  // .aos-splash-words: white, with a hard 2px black shadow at 38% - drawn as a second run.
  const text = (y, size, spacing, content) =>
    [
      `<text x="${textX + 2}" y="${y + 2}" font-family="${LOGO_FONT}" font-weight="bold" font-size="${size}" letter-spacing="${spacing}" fill="rgb(0 0 0 / 38%)">${content}</text>`,
      `<text x="${textX}" y="${y}" font-family="${LOGO_FONT}" font-weight="bold" font-size="${size}" letter-spacing="${spacing}" fill="#fff">${content}</text>`,
    ].join("\n");

  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Airflow OS">
<title>Airflow OS</title>
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0a3d91"/><stop offset=".45" stop-color="#1a6fc4"/>
    <stop offset=".78" stop-color="#6fb4e8"/><stop offset="1" stop-color="#b9dcf5"/>
  </linearGradient>
  <radialGradient id="c1"><stop offset="0" stop-color="#fff" stop-opacity=".78"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="c2"><stop offset="0" stop-color="#fff" stop-opacity=".62"/><stop offset=".72" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="c3"><stop offset="0" stop-color="#fff" stop-opacity=".46"/><stop offset=".74" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="c4"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".76" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <pattern id="dither" width="4" height="4" patternUnits="userSpaceOnUse">
    <rect width="2" height="2" fill="#000"/><rect x="2" y="2" width="2" height="2" fill="#000"/>
  </pattern>
  <linearGradient id="sweep" x1="0" x2="1"><stop offset="0" stop-color="#0a3d91"/><stop offset=".5" stop-color="#2f8fdd"/><stop offset="1" stop-color="#0a3d91"/></linearGradient>
  <clipPath id="trough"><rect x="${(W - 216) / 2 + 2}" y="${H - 44}" width="212" height="10"/></clipPath>
  <filter id="drop" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="2" dy="3" stdDeviation="3" flood-opacity=".35"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<ellipse cx="${W * 0.22}" cy="${H * 0.74}" rx="${W * 0.44}" ry="${H * 0.18}" fill="url(#c1)"/>
<ellipse cx="${W * 0.62}" cy="${H * 0.84}" rx="${W * 0.3}" ry="${H * 0.13}" fill="url(#c2)"/>
<ellipse cx="${W * 0.86}" cy="${H * 0.68}" rx="${W * 0.26}" ry="${H * 0.11}" fill="url(#c3)"/>
<ellipse cx="${W * 0.08}" cy="${H * 0.34}" rx="${W * 0.34}" ry="${H * 0.14}" fill="url(#c4)"/>
<rect width="${W}" height="${H}" fill="url(#dither)" opacity=".07"/>
<g transform="translate(${logoX} ${logoY}) scale(${logo / 175})" filter="url(#drop)">
${spinningLogo(paths, "  ")}
</g>
${text(cy - 22, 22, 3, "Apache")}
${text(cy + 40, 62, -1, "Airflow OS")}
<rect x="${(W - 216) / 2}" y="${H - 46}" width="216" height="14" fill="#b9c3cc"/>
<path d="M${(W - 216) / 2} ${H - 32}v-14h216" fill="none" stroke="#808080" stroke-width="1"/>
<path d="M${(W - 216) / 2 + 216} ${H - 46}v14h-216" fill="none" stroke="#fff" stroke-width="1"/>
<g clip-path="url(#trough)">
  <rect x="${(W - 216) / 2 + 2}" y="${H - 44}" width="89" height="10" fill="url(#sweep)">
    <animate attributeName="x" from="${(W - 216) / 2 + 2 - 94}" to="${(W - 216) / 2 + 2 + 214}" dur="1.5s" repeatCount="indefinite" calcMode="spline" keySplines=".42 0 .58 1"/>
  </rect>
</g>
</svg>
`;
  writeFileSync("docs/img/splash.svg", out);
  return paths.length;
}

console.log(`docs/img/icons.svg    ${iconSheet()} icons`);
console.log(`docs/img/pinwheel.svg ${pinwheel()} paths`);
console.log(`docs/img/splash.svg   ${splash()} paths`);
