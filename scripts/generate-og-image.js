#!/usr/bin/env node
// Renders public/og-image.png, the 1200x630 card that WhatsApp, Facebook,
// Slack, X and friends show when someone shares a divinghq.app link
// (index.html points og:image and twitter:image at it).
//
//   node scripts/generate-og-image.js
//
// The PNG is committed, so this only needs running again when the brand or
// the line on the card changes. It draws the same arc-and-dot mark as
// public/logo-mark.svg. Text goes through librsvg, which uses whatever
// system fonts are installed, so glance at the result before committing it:
// the font stack below falls back to Helvetica or Arial when IBM Plex Sans
// isn't on the machine.
const path = require("node:path");
const sharp = require("sharp");

const OUT = path.join(__dirname, "..", "public", "og-image.png");
const BRAND = "#0b6191";
const INK = "#0f172a";
const MUTED = "#475569";
const FONT = "'IBM Plex Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f5f8fb"/>
  <rect x="0" y="600" width="1200" height="30" fill="${BRAND}"/>
  <g transform="translate(90 135) scale(0.7)">
    <rect width="512" height="512" rx="96" fill="#ffffff"/>
    <rect x="1" y="1" width="510" height="510" rx="95" fill="none" stroke="#e2e8f0" stroke-width="2"/>
    <path d="M 120 380 Q 256 80 392 380" stroke="${BRAND}" stroke-width="22" fill="none" stroke-linecap="round" opacity="0.14"/>
    <path d="M 120 380 Q 256 80 392 380" stroke="${BRAND}" stroke-width="12" fill="none" stroke-linecap="round"/>
    <circle cx="256" cy="138" r="22" fill="${BRAND}"/>
    <circle cx="392" cy="380" r="10" fill="${BRAND}"/>
    <circle cx="392" cy="380" r="22" fill="none" stroke="${BRAND}" stroke-width="2" opacity="0.4"/>
    <circle cx="392" cy="380" r="34" fill="none" stroke="${BRAND}" stroke-width="2" opacity="0.2"/>
  </g>
  <text x="520" y="285" font-family="${FONT}" font-size="104" font-weight="700" letter-spacing="-3" fill="${INK}">DIVING<tspan fill="${BRAND}">HQ</tspan></text>
  <text font-family="${FONT}" font-size="36" fill="${MUTED}">
    <tspan x="524" y="360">Diving competition software for</tspan>
    <tspan x="524" y="408">clubs, states and federations.</tspan>
  </text>
  <text x="524" y="480" font-family="${FONT}" font-size="26" font-weight="600" fill="${BRAND}">Dive lists · Live judging · Scoreboard · Results</text>
</svg>`;

sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(OUT)
  .then((info) => console.log(`[og-image] wrote ${path.relative(process.cwd(), OUT)} (${info.width}x${info.height}, ${info.size} bytes)`))
  .catch((err) => {
    console.error("[og-image] failed:", err.message);
    process.exit(1);
  });
