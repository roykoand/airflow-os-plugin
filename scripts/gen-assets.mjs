#!/usr/bin/env node
/*
 * Regenerates the README's two source-derived images.
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

function pinwheel() {
  const src = readFileSync(LOGO_SRC, "utf8");
  // Key order inside each entry is whatever the formatter last chose, so parse fields
  // individually rather than assuming a shape.
  let out = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 175 175">\n';
  let count = 0;
  for (const [, entry] of src.matchAll(/^ {2}\{ (.+) \},$/gm)) {
    const d = /d: "([^"]+)"/.exec(entry)?.[1];
    const fill = /fill: "(#[0-9a-fA-F]+)"/.exec(entry)?.[1];
    if (!d || !fill) continue;
    const eo = entry.includes("evenOdd: true") ? ' fill-rule="evenodd" clip-rule="evenodd"' : "";
    out += `<path d="${d}" fill="${fill}"${eo}/>\n`;
    count += 1;
  }
  if (count !== 8) throw new Error(`expected 8 logo paths, parsed ${count}`);
  writeFileSync("docs/img/pinwheel.svg", `${out}</svg>\n`);
  return count;
}

console.log(`docs/img/icons.svg    ${iconSheet()} icons`);
console.log(`docs/img/pinwheel.svg ${pinwheel()} paths`);
