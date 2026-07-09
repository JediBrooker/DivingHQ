#!/usr/bin/env node
//
// DivingHQ seed generator.
//
//   node scripts/generate-seed.js
//
// Deterministic (fixed PRNG seed → identical output every run, so the emitted
// SQL and the credentials spreadsheet always agree). Emits two committed
// artifacts:
//
//   - seed_test_data.sql          portable, idempotent, single transaction.
//                                 Layered on top of init.sql like the old seed.
//   - docs/seed-credentials.csv   every persona's login (→ xlsx spreadsheet).
//
// Why a generator instead of hand-written SQL? Realistic profiles, three event
// types (incl. 11-judge synchro role bands), the controlled "out of whack"
// judge outliers, the cross-federation meet and the prelim→final progression
// are just way easier to keep correct as code than as 800 lines of INSERTs.
//
// Heads up, a few things that matter:
//   * dive_directory ids are random (gen_random_uuid in init.sql), so the seed
//     never hardcodes a dive_id, it resolves them at load time by the natural
//     key (dive_code, height, position) via INSERT … SELECT … JOIN dive_directory.
//   * Dates are emitted as now()-relative SQL so "3 years ago" and "live right
//     now" stay correct whenever the file is loaded.
//   * Generated rows use the id namespace 5eedNNNN-… so the idempotent cleanup
//     finds a prior run without ever touching the bootstrap admin from init.sql.
//
// Schema target: v58 (init.sql v53 + migrations 001-058).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(0x0d1f1ec5);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const randFloat = (lo, hi) => lo + rng() * (hi - lo);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Stable per-string hash so each user gets a latent skill that doesn't depend on PRNG draw order.
function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// id namespace
// ---------------------------------------------------------------------------
const NS = {
  org: "5eed0001", club: "5eed0002", board: "5eed0003", user: "5eed0004",
  team: "5eed0005", meet: "5eed0006", session: "5eed0007", event: "5eed0008",
  block: "5eed0009", ccr: "5eed000a", rolereq: "5eed000b", audit: "5eed000c",
  notif: "5eed000d", scoreaudit: "5eed000f", roleaudit: "5eed0010",
};
const counters = {};
function uid(ns) {
  counters[ns] = (counters[ns] || 0) + 1;
  return `${ns}-0000-0000-0000-${String(counters[ns]).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// SQL literal helpers
// ---------------------------------------------------------------------------
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const bool = (b) => (b ? "true" : "false");
const agoTs = (days, minutes = 0) =>
  `(now() - interval '${days} days'${minutes ? ` + interval '${minutes} minutes'` : ""})`;
const aheadTs = (days, minutes = 0) =>
  `(now() + interval '${days} days'${minutes ? ` + interval '${minutes} minutes'` : ""})`;
const agoDate = (days) => `(now() - interval '${days} days')::date`;
const aheadDate = (days) => `(now() + interval '${days} days')::date`;
const snap = (raw) => Math.max(0, Math.min(10, Math.round(raw * 2) / 2));

// deterministic base64url blob of n bytes (for made-up web-push keys)
function b64bytes(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(rng() * 256);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// minimal solid-colour PNG encoder (real, valid PNG via zlib), hacky but it
// works, for made-up sponsor logos. Two-band design (brand colour over a
// darker footer) so the thumbnails don't look like flat blocks.
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makeLogoPng(w, h, top, bottom) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    const [r, g, b] = y > h * 0.72 ? bottom : top;
    for (let x = 0; x < w; x++) { const p = off + 1 + x * 3; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
const PASSWORD_PLAIN = "password123";
const PASSWORD_HASH = "$2b$12$wuMDqANijStjgHfsWYwJuuAdXc3tagXOn3/BnhizZsCY.8IHj3Evy"; // bcrypt('password123', 12)

const MALE_FIRST = ["Liam","Noah","Oliver","James","William","Lucas","Henry","Jack","Thomas","Ethan","Mason","Logan","Daniel","Samuel","Hugo","Felix","Oscar","Leo","Max","Archie","Kai","Ryan","Aaron","Marcus","Dylan"];
const FEMALE_FIRST = ["Olivia","Amelia","Isla","Ava","Mia","Grace","Sophie","Chloe","Ella","Lily","Charlotte","Emily","Zoe","Ruby","Hannah","Maya","Freya","Ivy","Eliza","Sienna","Aria","Holly","Nina","Tara","Lara"];
const SURNAMES = ["Smith","Jones","Williams","Taylor","Brown","Wilson","Nguyen","Tran","Lee","Chen","Patel","Singh","Kelly","Murphy","O'Brien","Walker","Roberts","Clarke","Hughes","Evans","Campbell","Mitchell","Anderson","Thompson","Wright","Robinson","Ward","Foster","Hayes","Reid"];
const FOREIGN_NAT = ["USA","CAN","NZL","IRL","RSA","SGP","JPN","FRA"];
const LOCALES = ["en","en","en","en","en","fr","es","de"];

// Dive lists per board height, each (code, height, position) verifed present
// in init.sql's dive_directory. dd is for the latent-score model only.
const DIVE_LISTS = {
  "1m":  [["103","B",1.7],["203","B",2.3],["303","C",2.1],["403","B",2.4],["105","B",2.6],["301","B",1.7]],
  "3m":  [["105","B",2.4],["205","B",3.0],["305","C",2.8],["405","B",3.0],["5253","B",3.4],["107","B",3.1]],
  "10m": [["107","B",3.0],["207","C",3.3],["307","C",3.4],["407","C",3.2],["5253","B",3.2],["626","C",3.3]],
};
const HEIGHT_NUM = { "1m": "1.0", "3m": "3.0", "5m": "5.0", "7.5m": "7.5", "10m": "10.0" };

// ---------------------------------------------------------------------------
// Organisations / clubs / boards
// ---------------------------------------------------------------------------
const ORGS = [
  { key: "aus", name: "Diving Australia", cc: "AUS", continent: "oceania", slug: "seed-aus",
    emailDomain: "divingaustralia.org.au", sponsor: "Speedo", sponsorUrl: "https://www.speedo.com",
    clubs: [
      { name: "Sydney Olympic Divers", code: "SYD" }, { name: "Brisbane Aquatic Centre", code: "BNE" },
      { name: "Melbourne Springboard Club", code: "MEL" }, { name: "Perth Diving Academy", code: "PER" },
    ] },
  { key: "gbr", name: "British Aquatic Sports", cc: "GBR", continent: "europe", slug: "seed-gbr",
    emailDomain: "britishaquatic.org.uk", sponsor: "Arena", sponsorUrl: "https://www.arenawaterinstinct.com",
    clubs: [
      { name: "London Aquatics Club", code: "LDN" }, { name: "Leeds Diving", code: "LDS" },
      { name: "Plymouth Lions", code: "PLY" }, { name: "Edinburgh Dive Club", code: "EDI" },
    ] },
];
const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000002";

for (const org of ORGS) {
  org.id = uid(NS.org);
  org.clubs.forEach((c) => { c.id = uid(NS.club); c.orgKey = org.key; });
  org.boards = {};
  for (const h of ["1m", "3m", "10m"]) {
    org.boards[h] = { id: uid(NS.board), height: h,
      pool: h === "10m" ? "Platform Pool" : "Springboard Pool",
      label: `${h} ${h === "10m" ? "Platform" : "Springboard"}`,
      order: h === "1m" ? 1 : h === "3m" ? 2 : 3 };
  }
}
const orgByKey = Object.fromEntries(ORGS.map((o) => [o.key, o]));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const users = [];
const creds = []; // spreadsheet rows
function makeUser({ username, gender, role, org, club, persona, ageLo, ageHi, nat, suspended, notes }) {
  const first = gender === "female" ? pick(FEMALE_FIRST) : pick(MALE_FIRST);
  const last = pick(SURNAMES);
  const REF_YEAR = 2026;
  const age = randInt(ageLo, ageHi);
  const dob = `${REF_YEAR - age}-${String(randInt(1, 12)).padStart(2, "0")}-${String(randInt(1, 28)).padStart(2, "0")}`;
  const u = {
    id: uid(NS.user), username, full_name: `${first} ${last}`, gender, role, persona,
    orgKey: org.key, orgId: org.id, orgName: org.name,
    clubId: club ? club.id : null, clubName: club ? club.name : null,
    nationality: nat || org.cc, locale: pick(LOCALES), dob,
    email: `${username}@${org.emailDomain}`, suspended: !!suspended, notes: notes || "",
  };
  u.skill = hash01(u.username) * 2.5 - 1.2;
  users.push(u);
  return u;
}

const judges = [];
for (const org of ORGS) {
  const cc = org.key;
  const clubAt = (i) => org.clubs[i % org.clubs.length];
  org.people = { divers: [], coaches: [], spectators: [] };
  org.admin = makeUser({ username: `${cc}.admin`, gender: pick(["male", "female"]), role: "org_admin",
    org, club: clubAt(0), persona: "Org Admin", ageLo: 35, ageHi: 58, notes: `Federation administrator for ${org.name}` });
  org.manager = makeUser({ username: `${cc}.manager`, gender: pick(["male", "female"]), role: "meet_manager",
    org, club: clubAt(1), persona: "Meet Manager", ageLo: 30, ageHi: 55 });
  org.referee = makeUser({ username: `${cc}.referee`, gender: pick(["male", "female"]), role: "referee",
    org, club: clubAt(2), persona: "Referee", ageLo: 35, ageHi: 60 });
  for (let i = 1; i <= 20; i++) {
    const gender = i <= 10 ? "male" : "female";
    const suspended = cc === "aus" && i === 20;
    const d = makeUser({ username: `${cc}.diver.${String(i).padStart(2, "0")}`, gender, role: "diver",
      org, club: clubAt(i), persona: "Diver", ageLo: 14, ageHi: 27,
      nat: i % 7 === 0 ? pick(FOREIGN_NAT) : org.cc,
      suspended, notes: suspended ? "SUSPENDED account — use to test reactivation" : "" });
    org.people.divers.push(d);
  }
  for (let i = 1; i <= 2; i++) org.people.coaches.push(makeUser({ username: `${cc}.coach.${String(i).padStart(2, "0")}`,
    gender: pick(["male", "female"]), role: "coach", org, club: clubAt(i), persona: "Coach", ageLo: 30, ageHi: 58 }));
  for (let i = 1; i <= 2; i++) org.people.spectators.push(makeUser({ username: `${cc}.fan.${String(i).padStart(2, "0")}`,
    gender: pick(["male", "female"]), role: "spectator", org, club: clubAt(i), persona: "Spectator", ageLo: 25, ageHi: 62 }));
}
for (let i = 1; i <= 11; i++) {
  const home = ORGS[i % 2];
  const isOutlier = i === 3;
  const j = makeUser({ username: `judge.${String(i).padStart(2, "0")}`, gender: pick(["male", "female"]),
    role: "judge", org: home, club: home.clubs[i % home.clubs.length], persona: "Judge", ageLo: 30, ageHi: 62,
    notes: isOutlier ? "Scores erratically (harsh low-baller) — showcases Judge Analysis outliers" : "" });
  j.judgeNo = i; j.isOutlier = isOutlier; j.homeOrgName = home.name;
  judges.push(j);
}

// ---------------------------------------------------------------------------
// Meets + events
// ---------------------------------------------------------------------------
const MEETS = [
  { key: "h1", orgKey: "aus", daysAgo: 1100, durDays: 3, crossFed: false,
    name: "2023 Australian National Diving Championships", venue: "Sydney Olympic Park Aquatic Centre",
    desc: "Three days of senior springboard and platform competition across individual, synchro and team events.",
    events: [
      { disc: "ind", gender: "Male", height: "3m", judges: 7, rounds: 6, status: "Completed", name: "Men's 3m Springboard" },
      { disc: "ind", gender: "Female", height: "10m", judges: 7, rounds: 6, status: "Completed", name: "Women's 10m Platform" },
      { disc: "syn", gender: "Mixed", height: "3m", judges: 11, rounds: 5, status: "Completed", name: "Mixed 3m Synchro" },
      { disc: "syn", gender: "Female", height: "10m", judges: 11, rounds: 5, status: "Completed", name: "Women's 10m Synchro" },
      { disc: "team", gender: "Mixed", height: "3m", judges: 5, rounds: 5, status: "Completed", name: "Open Team Event" },
    ] },
  { key: "h2", orgKey: "gbr", daysAgo: 730, durDays: 3, crossFed: false,
    name: "2024 British Diving Championships", venue: "London Aquatics Centre",
    desc: "The national championships, featuring a preliminary→final progression in the men's 3m springboard.",
    events: [
      { disc: "ind", gender: "Male", height: "3m", judges: 5, rounds: 6, status: "Completed", name: "Men's 3m Springboard — Preliminary", key: "h2_prelim", format: "preliminary", field: 10 },
      { disc: "ind", gender: "Male", height: "3m", judges: 7, rounds: 6, status: "Completed", name: "Men's 3m Springboard — Final", format: "final", parentKey: "h2_prelim", advance: 8, field: 8 },
      { disc: "ind", gender: "Female", height: "1m", judges: 5, rounds: 6, status: "Completed", name: "Women's 1m Springboard" },
      { disc: "syn", gender: "Male", height: "10m", judges: 11, rounds: 5, status: "Completed", name: "Men's 10m Synchro" },
      { disc: "team", gender: "Mixed", height: "10m", judges: 5, rounds: 5, status: "Completed", name: "Mixed Team Event" },
    ] },
  { key: "h3", orgKey: "aus", daysAgo: 365, durDays: 3, crossFed: true,
    name: "2025 Pacific–Atlantic Invitational", venue: "Gold Coast Aquatic Centre",
    desc: "A cross-federation invitational — Australian and British divers compete side by side.",
    events: [
      { disc: "ind", gender: "Male", height: "10m", judges: 7, rounds: 6, status: "Completed", name: "Men's 10m Platform", field: 12 },
      { disc: "ind", gender: "Female", height: "3m", judges: 7, rounds: 6, status: "Completed", name: "Women's 3m Springboard", field: 12 },
      { disc: "syn", gender: "Mixed", height: "3m", judges: 11, rounds: 5, status: "Completed", name: "Mixed 3m Synchro", pairs: 6 },
      { disc: "syn", gender: "Male", height: "3m", judges: 11, rounds: 5, status: "Completed", name: "Men's 3m Synchro", pairs: 6 },
      { disc: "team", gender: "Mixed", height: "10m", judges: 5, rounds: 5, status: "Completed", name: "Open Team Event", teamsCross: true },
    ] },
  { key: "caus", orgKey: "aus", daysAgo: 1, durDays: 4, crossFed: false,
    name: "2026 Australian Grand Prix", venue: "Brisbane Aquatic Centre",
    desc: "Live competition in progress — see the scoreboard and control room in action.",
    events: [
      { disc: "ind", gender: "Male", height: "3m", judges: 7, rounds: 6, status: "Live", name: "Men's 3m Springboard" },
      { disc: "syn", gender: "Mixed", height: "3m", judges: 11, rounds: 5, status: "Live", name: "Mixed 3m Synchro" },
      { disc: "team", gender: "Mixed", height: "3m", judges: 5, rounds: 5, status: "Live", name: "Open Team Event" },
      { disc: "ind", gender: "Female", height: "10m", judges: 7, rounds: 6, status: "Upcoming", name: "Women's 10m Platform" },
      { disc: "syn", gender: "Female", height: "10m", judges: 11, rounds: 5, status: "Upcoming", name: "Women's 10m Synchro" },
    ] },
  { key: "cgbr", orgKey: "gbr", daysAgo: 1, durDays: 4, crossFed: false,
    name: "2026 British Grand Prix", venue: "Plymouth Life Centre",
    desc: "Live competition in progress — see the scoreboard and control room in action.",
    events: [
      { disc: "ind", gender: "Male", height: "10m", judges: 7, rounds: 6, status: "Live", name: "Men's 10m Platform" },
      { disc: "syn", gender: "Male", height: "10m", judges: 11, rounds: 5, status: "Live", name: "Men's 10m Synchro" },
      { disc: "team", gender: "Mixed", height: "3m", judges: 5, rounds: 5, status: "Live", name: "Mixed Team Event" },
      { disc: "ind", gender: "Male", height: "3m", judges: 5, rounds: 6, status: "Upcoming", name: "Men's 3m Springboard" },
      { disc: "syn", gender: "Mixed", height: "3m", judges: 11, rounds: 5, status: "Upcoming", name: "Mixed 3m Synchro" },
    ] },
];

// ---------------------------------------------------------------------------
// Build model, PASS 1: events, panels, entities, dive lists (no scores yet)
// ---------------------------------------------------------------------------
const M = {
  events: [], teams: [], teamMembers: [], eventJudges: [], eventManagers: [],
  participatingOrgs: [], eventTeams: [], cdls: [], scores: [], attendance: [],
  liveState: [], sessions: [], blocks: [],
  roles: [], roleAudit: [], coachLinks: [], coachPrefs: [],
  ccr: [], roleReq: [], audit: [], scoreAudit: [], notif: [],
  sponsorLogos: [], pushSubs: [],
};
const eventKeyToId = {};
const allEvents = []; // {cfg, rec} pairs for pass 2

function diversForGender(orgKeys, gender) {
  let pool = [];
  for (const k of orgKeys) {
    let dv = orgByKey[k].people.divers.filter((d) => !d.suspended);
    if (gender === "Male") dv = dv.filter((d) => d.gender === "male");
    else if (gender === "Female") dv = dv.filter((d) => d.gender === "female");
    pool = pool.concat(dv);
  }
  return pool;
}

for (const meet of MEETS) {
  meet.id = uid(NS.meet);
  const hostOrg = orgByKey[meet.orgKey];
  const orgKeys = meet.crossFed ? ORGS.map((o) => o.key) : [meet.orgKey];

  for (const ev of meet.events) {
    const eid = uid(NS.event);
    ev.id = eid;
    if (ev.key) eventKeyToId[ev.key] = eid;
    const board = hostOrg.boards[ev.height];
    const eventType = ev.disc === "ind" ? "individual" : ev.disc === "syn" ? "synchro_pair" : "team";
    ev.eventType = eventType;
    const completed = ev.status === "Completed";
    const live = ev.status === "Live";

    const createdAt = agoTs(meet.daysAgo);
    const scheduledAt = ev.status === "Upcoming"
      ? aheadTs(2, 600 + M.events.length * 30)
      : agoTs(meet.daysAgo, 540 + M.events.length * 30);
    const entriesClose = ev.status === "Upcoming" ? aheadTs(1) : agoTs(meet.daysAgo + 2);

    const rec = {
      id: eid, orgId: hostOrg.id, meetId: meet.id, name: ev.name, gender: ev.gender,
      ageGroup: "Senior", height: ev.height, numJudges: ev.judges, rounds: ev.rounds,
      eventType, format: ev.format || "final", parentId: ev.parentKey ? eventKeyToId[ev.parentKey] : null,
      advance: ev.advance || 12, scheduledAt, entriesClose, status: ev.status, createdAt, boardId: board.id,
    };
    M.events.push(rec);
    M.eventManagers.push({ eventId: eid, userId: hostOrg.manager.id, addedBy: hostOrg.admin.id, at: createdAt });
    if (meet.crossFed) for (const k of orgKeys) M.participatingOrgs.push({ eventId: eid, orgId: orgByKey[k].id, addedBy: hostOrg.admin.id, at: createdAt });

    // judges: random panel of N (synchro uses all 11). For completed
    // individual events we make sure the recurring outlier judge (judge.03)
    // is on the panel, so its erratic pattern actually shows up somewhere.
    const panel = shuffled(eventType === "synchro_pair" ? judges.slice() : shuffled(judges).slice(0, ev.judges));
    if (eventType === "individual" && ev.status === "Completed" && (ev.judges === 5 || ev.judges === 7)) {
      const ol = judges.find((j) => j.isOutlier);
      if (ol && !panel.some((j) => j.id === ol.id)) panel[panel.length - 1] = ol;
    }
    panel.forEach((j, idx) => M.eventJudges.push({ eventId: eid, judgeId: j.id, judgeNo: idx + 1 }));
    ev.panel = panel;

    // entities + dive lists
    const list = DIVE_LISTS[ev.height].slice(0, ev.rounds);
    const heightNum = HEIGHT_NUM[ev.height];
    ev.entities = [];

    if (eventType === "individual") {
      const field = ev.field || (meet.crossFed ? 12 : 8);
      shuffled(diversForGender(orgKeys, ev.gender)).slice(0, field)
        .forEach((d, i) => ev.entities.push({ competitorId: d.id, comp: d, displayOrder: i + 1 }));
    } else if (eventType === "synchro_pair") {
      const nPairs = ev.pairs || 4;
      let pairs = [];
      if (ev.gender === "Mixed") {
        for (const k of orgKeys) {
          const males = shuffled(orgByKey[k].people.divers.filter((d) => d.gender === "male" && !d.suspended));
          const females = shuffled(orgByKey[k].people.divers.filter((d) => d.gender === "female" && !d.suspended));
          const n = Math.min(males.length, females.length, meet.crossFed ? nPairs / orgKeys.length : nPairs);
          for (let i = 0; i < n; i++) pairs.push([males[i], females[i]]);
        }
      } else {
        for (const k of orgKeys) {
          const dv = shuffled(diversForGender([k], ev.gender));
          const n = Math.min(Math.floor(dv.length / 2), meet.crossFed ? nPairs / orgKeys.length : nPairs);
          for (let i = 0; i < n; i++) pairs.push([dv[2 * i], dv[2 * i + 1]]);
        }
      }
      pairs.slice(0, nPairs).forEach((p, i) => ev.entities.push({ competitorId: p[0].id, comp: p[0], partnerId: p[1].id, displayOrder: i + 1 }));
    } else {
      const teamOrgKeys = ev.teamsCross
        ? [meet.orgKey, meet.orgKey, ORGS.find((o) => o.key !== meet.orgKey).key]
        : [meet.orgKey, meet.orgKey, meet.orgKey];
      const cursor = {};
      teamOrgKeys.forEach((k, ti) => {
        if (!cursor[k]) cursor[k] = { pool: shuffled(orgByKey[k].people.divers.filter((d) => !d.suspended)), idx: 0 };
        const src = cursor[k];
        const members = src.pool.slice(src.idx, src.idx + 4); src.idx += 4;
        const team = { id: uid(NS.team), orgId: orgByKey[k].id,
          name: `${orgByKey[k].cc} ${["Alpha", "Bravo", "Charlie", "Delta"][ti]}`,
          code: `${orgByKey[k].cc}-${["A", "B", "C", "D"][ti]}` };
        M.teams.push(team);
        M.eventTeams.push({ eventId: eid, teamId: team.id, at: createdAt });
        members.forEach((m) => M.teamMembers.push({ teamId: team.id, userId: m.id, at: createdAt }));
        members.forEach((m, mi) => ev.entities.push({ competitorId: m.id, comp: m, teamId: team.id, displayOrder: ti * 4 + mi + 1 }));
      });
    }

    // CDLs + attendance + live state (scores are deferred to pass 2).
    const scoredRounds = completed ? ev.rounds : live ? Math.ceil(ev.rounds / 2) : 0;
    ev.scoredRounds = scoredRounds;
    let withdrawIdx = -1, lateIdx = -1;
    if (live && eventType === "individual" && ev.entities.length >= 3) { withdrawIdx = ev.entities.length - 1; lateIdx = 0; }

    ev.entities.forEach((ent, entIdx) => {
      ent.withdrawn = entIdx === withdrawIdx;
      ent.late = entIdx === lateIdx;
      for (let r = 1; r <= ev.rounds; r++) {
        const [code, pos] = list[r - 1];
        M.cdls.push({
          eventId: eid, competitorId: ent.competitorId, partnerId: ent.partnerId || null,
          teamId: ent.teamId || null, code, height: heightNum, pos, round: r, displayOrder: ent.displayOrder,
          confirmedAt: createdAt, createdAt,
          withdrawnAt: ent.withdrawn ? agoTs(meet.daysAgo, 480) : null,
          withdrawnBy: ent.withdrawn ? hostOrg.manager.id : null,
          withdrawnReason: ent.withdrawn ? "Withdrew before round 1 — minor injury" : null,
          late: ent.late,
        });
      }
      if (completed || live) M.attendance.push({ eventId: eid, competitorId: ent.competitorId,
        status: ent.withdrawn ? "absent" : ent.late ? "late" : "present", at: createdAt, by: hostOrg.manager.id });
    });

    if (live) {
      const lead = ev.entities.find((e, i) => i !== withdrawIdx) || ev.entities[0];
      const nextRound = Math.min(scoredRounds + 1, ev.rounds);
      const [code] = list[nextRound - 1];
      M.liveState.push({ eventId: eid, updatedAt: agoTs(0, 0),
        payload: JSON.stringify({ competitor_id: lead.competitorId, round_number: nextRound, full_name: lead.comp.full_name, dive_code: code, height: ev.height }) });
    }

    ev.list = list; ev.heightNum = heightNum; ev.meet = meet; ev.completed = completed; ev.live = live;
    allEvents.push(ev);
  }
}

// ---------------------------------------------------------------------------
// Decide outlier cells: per completed meet, judge.03 plus one other judge
// each throw 2-3 way-off scores on 5/7-judge INDIVIDUAL events (the only
// panels the deviation/drop-rate analytics actually compute on).
// ---------------------------------------------------------------------------
const outlierCells = new Map(); // key -> signed delta
for (const meet of MEETS) {
  const indEvents = meet.events.filter((e) => e.eventType === "individual" && e.status === "Completed" && (e.judges === 5 || e.judges === 7));
  if (!indEvents.length) continue;
  const outJudges = new Set();
  for (const e of indEvents) for (const j of e.panel) if (j.isOutlier) outJudges.add(j.id);
  const others = [];
  for (const e of indEvents) for (const j of e.panel) if (!j.isOutlier) others.push(j.id);
  if (others.length) outJudges.add(pick(others));
  for (const judgeId of outJudges) {
    const cells = [];
    for (const e of indEvents) {
      if (!e.panel.some((j) => j.id === judgeId)) continue;
      for (const ent of e.entities) for (let r = 1; r <= e.rounds; r++) cells.push(`${e.id}|${ent.competitorId}|${r}|${judgeId}`);
    }
    const j = judges.find((x) => x.id === judgeId);
    // judge.03 (recurring, harsh low-baller) throws ~3 per meet, the secondary
    // judge throws ~2. a handful across ~150 dives reads as clearly elevated
    // but still realistic.
    shuffled(cells).slice(0, j && j.isOutlier ? 3 : 2).forEach((c) => outlierCells.set(c, j && j.isOutlier ? -1 : 1));
  }
}

// ---------------------------------------------------------------------------
// Build model, PASS 2: scores
// ---------------------------------------------------------------------------
function judgeScore(comp, dd, round, judge, isOut) {
  const base = 7.0 + comp.skill - (dd - 2.5) * 0.25 - round * 0.03;
  const expected = Math.max(3.5, Math.min(9.0, base + (rng() - 0.5) * 1.0));
  if (isOut) {
    const delta = judge.isOutlier ? -randFloat(2.4, 3.0) : randFloat(2.4, 3.0);
    return snap(expected + delta);
  }
  return snap(expected + (rng() - 0.5) * 0.8);
}
for (const ev of allEvents) {
  if (ev.scoredRounds === 0) continue;
  const useOutlier = ev.completed && ev.eventType === "individual";
  for (const ent of ev.entities) {
    if (ent.withdrawn) continue;
    for (let r = 1; r <= ev.scoredRounds; r++) {
      const [code, pos, dd] = ev.list[r - 1];
      for (const j of ev.panel) {
        const isOut = useOutlier && outlierCells.has(`${ev.id}|${ent.competitorId}|${r}|${j.id}`);
        M.scores.push({ eventId: ev.id, competitorId: ent.competitorId, judgeId: j.id,
          code, height: ev.heightNum, pos, round: r, score: judgeScore(ent.comp, dd, r, j, isOut),
          createdAt: agoTs(ev.meet.daysAgo, 540 + r * 8 + j.judgeNo) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Roles, role audit, coach links, alert prefs
// ---------------------------------------------------------------------------
function grant(userId, orgId, role, ts) {
  M.roles.push({ userId, orgId, role, grantedBy: ADMIN_USER_ID, at: ts });
  if (role !== "spectator")
    M.roleAudit.push({ id: uid(NS.roleaudit), userId, orgId, role, action: "granted", actor: ADMIN_USER_ID, note: "Seed bootstrap", at: ts });
}
for (const org of ORGS) {
  const ts = agoTs(1180);
  grant(org.admin.id, org.id, "org_admin", ts); grant(org.admin.id, org.id, "spectator", ts);
  grant(org.manager.id, org.id, "meet_manager", ts); grant(org.manager.id, org.id, "spectator", ts);
  grant(org.referee.id, org.id, "referee", ts); grant(org.referee.id, org.id, "spectator", ts);
  for (const d of org.people.divers) { grant(d.id, org.id, "diver", ts); grant(d.id, org.id, "spectator", ts); }
  for (const c of org.people.coaches) { grant(c.id, org.id, "coach", ts); grant(c.id, org.id, "spectator", ts); }
  for (const s of org.people.spectators) grant(s.id, org.id, "spectator", ts);
}
// judges get the judge role in BOTH orgs, plus spectator in their home org
for (const j of judges) {
  const ts = agoTs(1180);
  for (const org of ORGS) grant(j.id, org.id, "judge", ts);
  grant(j.id, j.orgId, "spectator", ts);
}
// coach → diver links (5 divers each) + alert prefs
for (const org of ORGS) {
  const ts = agoTs(900);
  org.people.coaches.forEach((c, ci) => {
    M.coachPrefs.push({ coachId: c.id, at: ts });
    org.people.divers.slice(ci * 5, ci * 5 + 5).forEach((d) =>
      M.coachLinks.push({ coachId: c.id, diverId: d.id, orgId: org.id, note: "Squad member", at: ts }));
  });
}

// ---------------------------------------------------------------------------
// In-flight workflow rows
// ---------------------------------------------------------------------------
const aus = orgByKey.aus, gbr = orgByKey.gbr;
// pending club change (within GBR)
{
  const u = gbr.people.divers[4]; // gbr.diver.05
  const toClub = gbr.clubs.find((c) => c.id !== u.clubId) || gbr.clubs[0];
  u.notes = "Has a pending club-change request awaiting org-admin approval";
  M.ccr.push({ id: uid(NS.ccr), userId: u.id, kind: "club_change", fromOrg: gbr.id, fromClub: u.clubId,
    toOrg: gbr.id, toClub: toClub.id, status: "pending", requestedBy: u.id, note: "Relocating cities — requesting transfer to " + toClub.name, at: agoTs(9) });
}
// cross-federation transfer mid-handshake (AUS → GBR), source approved, target pending
{
  const u = aus.people.divers[6]; // aus.diver.07
  const toClub = gbr.clubs[0];
  u.notes = "Has an in-flight cross-federation transfer (source approved, target pending)";
  M.ccr.push({ id: uid(NS.ccr), userId: u.id, kind: "org_transfer", fromOrg: aus.id, fromClub: u.clubId,
    toOrg: gbr.id, toClub: toClub.id, status: "pending", requestedBy: u.id,
    sourceApprovedBy: aus.admin.id, sourceApprovedAt: agoTs(4), note: "International transfer to " + gbr.name, at: agoTs(12) });
}
// pending role request (spectator → judge)
{
  const u = aus.people.spectators[0]; // aus.fan.01
  u.notes = "Has a pending role request (judge) awaiting approval";
  M.roleReq.push({ id: uid(NS.rolereq), userId: u.id, orgId: aus.id, role: "judge", status: "pending", note: "Qualified FINA judge — requesting judge access", at: agoTs(6) });
}

// audit log: a spread of recent admin/officiating actions
const auditSeed = [];
allEvents.filter((e) => e.completed).slice(0, 4).forEach((e) =>
  auditSeed.push({ org: e.orgId, actor: orgByKey[e.meet.orgKey].manager.id, etype: "event", action: "finalised",
    eid: e.id, ename: e.name, at: agoTs(e.meet.daysAgo - 1), meta: JSON.stringify({ rounds: e.rounds }) }));
auditSeed.push({ org: aus.id, actor: aus.admin.id, etype: "user", action: "suspended",
  eid: aus.people.divers[19].id, ename: aus.people.divers[19].full_name, at: agoTs(20), meta: JSON.stringify({ reason: "Code of conduct review" }) });
auditSeed.push({ org: gbr.id, actor: gbr.people.divers[4].id, etype: "club_change_request", action: "created",
  eid: null, ename: gbr.people.divers[4].full_name, at: agoTs(9), meta: JSON.stringify({ kind: "club_change" }) });
auditSeed.push({ org: aus.id, actor: ADMIN_USER_ID, etype: "organisation", action: "approved",
  eid: aus.id, ename: aus.name, at: agoTs(1190), meta: JSON.stringify({}) });
for (const a of auditSeed) M.audit.push({ id: uid(NS.audit), ...a });

// score audit: a couple of referee corrections on a completed event
{
  const e = allEvents.find((x) => x.completed && x.eventType === "individual");
  if (e) {
    const ref = orgByKey[e.meet.orgKey].referee;
    const ent = e.entities[0]; const j = e.panel[0];
    M.scoreAudit.push({ id: uid(NS.scoreaudit), eventId: e.id, competitorId: ent.competitorId, judgeId: j.id,
      round: 2, action: "update", oldScore: 5.0, newScore: 6.5, actor: ref.id, reason: "Judge keypad misfire — corrected on review", at: agoTs(e.meet.daysAgo, 700) });
    const ent2 = e.entities[1]; const j2 = e.panel[1];
    M.scoreAudit.push({ id: uid(NS.scoreaudit), eventId: e.id, competitorId: ent2.competitorId, judgeId: j2.id,
      round: 3, action: "update", oldScore: 8.5, newScore: 7.0, actor: ref.id, reason: "Transposed digits — referee correction", at: agoTs(e.meet.daysAgo, 720) });
  }
}

// notifications, varied and recent
const notifSeed = [
  { user: aus.people.coaches[0].id, cat: "coach_alert", title: "Your diver is up next", body: "is on deck in the Men's 3m Springboard.", status: "acknowledged", at: agoTs(1) },
  { user: gbr.people.divers[4].id, cat: "club_change", title: "Club change submitted", body: "Your club-change request is awaiting approval.", status: "sent", at: agoTs(9) },
  { user: aus.people.spectators[0].id, cat: "role_request", title: "Role request received", body: "Your request for judge access is under review.", status: "sent", at: agoTs(6) },
  { user: aus.people.divers[0].id, cat: "record", title: "New personal best!", body: "You set a new PB at the Australian Grand Prix.", status: "acknowledged", at: agoTs(1) },
  { user: gbr.people.divers[0].id, cat: "event", title: "Entries closing soon", body: "Men's 3m Springboard entries close tomorrow.", status: "sent", at: agoTs(0) },
];
for (const n of notifSeed) M.notif.push({ id: uid(NS.notif), ...n });

// sessions + schedule blocks for the two current meets
for (const meet of MEETS.filter((m) => m.daysAgo <= 1)) {
  const org = orgByKey[meet.orgKey];
  const sid = uid(NS.session);
  M.sessions.push({ id: sid, meetId: meet.id, name: "Finals Session", date: agoDate(0), pool: "Competition Pool", referee: org.referee.id, at: agoTs(2) });
  const board3 = org.boards["3m"].id, board10 = org.boards["10m"].id;
  M.blocks.push({ id: uid(NS.block), sessionId: sid, type: "warmup", label: "Warm-up", starts: agoTs(0, -120), ends: agoTs(0, -30), boards: [board3, board10], at: agoTs(2) });
  meet.events.filter((e) => e.status === "Live").forEach((e, i) => {
    M.blocks.push({ id: uid(NS.block), sessionId: sid, type: "event_start", label: e.name, starts: agoTs(0, i * 60), ends: agoTs(0, i * 60 + 55), boards: [org.boards[e.height].id], eventId: e.id, at: agoTs(2) });
  });
}

// sponsor logos: two made-up sponsors per meet (real PNGs), so the public
// meet page / scoreboard logo rotation actually has something to show.
const SPONSOR_BRANDS = {
  aus: [
    { name: "Speedo", top: [0, 79, 159], bottom: [0, 40, 90], url: "https://www.speedo.com" },
    { name: "Aussie AquaTech", top: [0, 132, 61], bottom: [255, 205, 0], url: "https://aquatech.example.com" },
  ],
  gbr: [
    { name: "Arena", top: [183, 28, 28], bottom: [40, 40, 40], url: "https://www.arenawaterinstinct.com" },
    { name: "Albion PoolPro", top: [16, 42, 94], bottom: [200, 16, 46], url: "https://poolpro.example.com" },
  ],
};
for (const meet of MEETS) {
  const brands = SPONSOR_BRANDS[meet.orgKey];
  brands.forEach((b, i) => {
    const png = makeLogoPng(320, 120, b.top, b.bottom);
    M.sponsorLogos.push({
      meetId: meet.id, slot: i + 1, mime: "image/png", bytes: png,
      b64: png.toString("base64"), alt: `${b.name} — official sponsor`, link: b.url, at: agoTs(meet.daysAgo + 25),
    });
  });
}

// web-push subscriptions: made-up endpoints/keys for a spread of users so the
// push/notification features (and the coach "your diver is up next" alert) have
// real subscriber rows to work with. endpoints are unique, table enforces it anyway.
const UA = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
const PUSH_HOSTS = [
  "https://fcm.googleapis.com/fcm/send/",
  "https://updates.push.services.mozilla.com/wpush/v2/",
  "https://wns2-par02p.notify.windows.com/w/?token=",
];
const pushUsers = [
  ...orgByKey.aus.people.coaches, ...orgByKey.gbr.people.coaches,
  orgByKey.aus.people.divers[0], orgByKey.aus.people.divers[1], orgByKey.gbr.people.divers[0],
  judges[0], judges[2], judges[6],
];
pushUsers.forEach((u, i) => {
  M.pushSubs.push({
    userId: u.id,
    endpoint: `${PUSH_HOSTS[i % PUSH_HOSTS.length]}${b64bytes(48)}`,
    p256dh: b64bytes(65), auth: b64bytes(16), ua: UA[i % UA.length],
    createdAt: agoTs(randInt(40, 220)), lastUsedAt: agoTs(randInt(0, 5)),
    revokedAt: i === pushUsers.length - 1 ? agoTs(2) : null, // one revoked, for realism
  });
});

// credentials spreadsheet rows
function credRow(u, fed, home) {
  creds.push({ persona: u.persona, username: u.username, password: PASSWORD_PLAIN,
    federation: fed || u.orgName, home_org: home || u.orgName, full_name: u.full_name, email: u.email, notes: u.notes });
}
creds.push({ persona: "System Administrator", username: "admin", password: "admin",
  federation: "Platform (all)", home_org: "Administration", full_name: "System Administrator", email: "admin@divinghq.local", notes: "Super-admin from init.sql — cross-org access" });
for (const org of ORGS) {
  credRow(org.admin); credRow(org.manager); credRow(org.referee);
  org.people.divers.forEach((d) => credRow(d));
  org.people.coaches.forEach((c) => credRow(c));
  org.people.spectators.forEach((s) => credRow(s));
}
for (const j of judges) credRow(j, "Both (AUS + GBR)", j.homeOrgName);

// ===========================================================================
// EMIT SQL
// ===========================================================================
function insert(table, cols, rows) {
  if (!rows.length) return "";
  const head = `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n`;
  return head + rows.map((r) => `  (${r.join(", ")})`).join(",\n") + ";\n";
}
const out = [];
out.push(`-- =============================================================
-- DivingHQ — TEST DATA SEED   (generated by scripts/generate-seed.js)
--
-- DO NOT EDIT BY HAND. Re-run:  node scripts/generate-seed.js
--
-- Layered on top of init.sql. A small, realistic demo dataset:
--   - 2 federations (${ORGS.map((o) => o.cc).join(", ")}) + their clubs and boards
--   - ${users.length} users with full profiles and VERIFIED emails (log in immediately)
--   - 11 judges shared across both federations (cover 11-judge synchro panels)
--   - ${MEETS.length} meets / ${M.events.length} events spanning 3 years: completed, live and upcoming
--   - realistic judge scoring with a few deliberate "out of whack" judges so
--     the Judge Analysis screens have something to show
--   - records / PBs, and in-flight admin queues (club change, transfer, role req)
--
-- Every login: password "${PASSWORD_PLAIN}"  (super-admin: admin / admin)
-- See docs/seed-credentials.csv for the full persona list.
--
-- Run:  psql -d divinghq -f seed_test_data.sql
--
-- Idempotent: a re-run first removes everything from a prior run (orgs with
-- slug 'seed-%' and rows in the 5eed… id namespace) and the legacy 'bulk-%'
-- seed, without ever touching the 'admin' org/user from init.sql.
-- =============================================================
BEGIN;

SET client_min_messages = warning;

-- ---- cleanup: prior run of THIS seed, plus the legacy bulk seed ----
DELETE FROM audit_log            WHERE id::text LIKE '5eed%';
DELETE FROM score_audit_log      WHERE id::text LIKE '5eed%';
DELETE FROM role_audit_log       WHERE id::text LIKE '5eed%';
DELETE FROM records_continental  WHERE continent IN (${ORGS.map((o) => q(o.continent)).join(", ")});
DELETE FROM users          WHERE org_id IN (SELECT id FROM organisations WHERE slug LIKE 'seed-%' OR slug LIKE 'bulk-%');
DELETE FROM organisations  WHERE slug LIKE 'seed-%' OR slug LIKE 'bulk-%';
`);

// organisations
out.push("\n-- ---- organisations ----");
out.push(insert("organisations", ["id", "name", "country_code", "slug", "status", "continent", "created_at"],
  ORGS.map((o) => [q(o.id), q(o.name), q(o.cc), q(o.slug), q("active"), q(o.continent), agoTs(1200)])));

// clubs
out.push("-- ---- clubs ----");
out.push(insert("clubs", ["id", "org_id", "name", "short_code", "created_at"],
  ORGS.flatMap((o) => o.clubs.map((c) => [q(c.id), q(o.id), q(c.name), q(c.code), agoTs(1195)]))));

// boards
out.push("-- ---- boards ----");
out.push(insert("boards", ["id", "org_id", "pool_name", "height", "label", "display_order", "created_at"],
  ORGS.flatMap((o) => Object.values(o.boards).map((b) => [q(b.id), q(o.id), q(b.pool), q(b.height), q(b.label), b.order, agoTs(1195)]))));

// users
out.push("-- ---- users (full profiles, emails pre-verified) ----");
out.push(insert("users",
  ["id", "username", "password", "full_name", "email", "org_id", "club_id", "is_system_admin",
   "email_verified_at", "created_at", "date_of_birth", "gender", "nationality", "locale", "suspended_at"],
  users.map((u) => [q(u.id), q(u.username), q(PASSWORD_HASH), q(u.full_name), q(u.email), q(u.orgId),
    u.clubId ? q(u.clubId) : "NULL", "false", agoTs(1170), agoTs(1175), q(u.dob), q(u.gender),
    q(u.nationality), q(u.locale), u.suspended ? agoTs(20) : "NULL"])));

// roles
out.push("-- ---- user_org_roles ----");
out.push(insert("user_org_roles", ["user_id", "org_id", "role", "granted_by", "granted_at"],
  M.roles.map((r) => [q(r.userId), q(r.orgId), q(r.role), q(r.grantedBy), r.at])));
out.push("-- ---- role_audit_log ----");
out.push(insert("role_audit_log", ["id", "user_id", "org_id", "role", "action", "actor_id", "note", "created_at"],
  M.roleAudit.map((r) => [q(r.id), q(r.userId), q(r.orgId), q(r.role), q(r.action), q(r.actor), q(r.note), r.at])));

// coach links + prefs
out.push("-- ---- coach_diver_links + coach_alert_preferences ----");
out.push(insert("coach_diver_links", ["coach_id", "diver_id", "org_id", "note", "created_at"],
  M.coachLinks.map((l) => [q(l.coachId), q(l.diverId), q(l.orgId), q(l.note), l.at])));
out.push(insert("coach_alert_preferences", ["coach_id", "enabled", "dives_ahead", "updated_at"],
  M.coachPrefs.map((p) => [q(p.coachId), "true", "2", p.at])));

// teams + members
out.push("-- ---- teams + team_members ----");
out.push(insert("teams", ["id", "org_id", "name", "short_code", "created_at"],
  M.teams.map((t) => [q(t.id), q(t.orgId), q(t.name), q(t.code), agoTs(800)])));
out.push(insert("team_members", ["team_id", "user_id", "added_at"],
  M.teamMembers.map((m) => [q(m.teamId), q(m.userId), m.at])));

// meets
out.push("-- ---- meets ----");
out.push(insert("meets",
  ["id", "org_id", "name", "venue", "start_date", "end_date", "description", "sponsor_name", "sponsor_logo_url", "sponsor_link_url", "sponsor_rotation_seconds", "created_at"],
  MEETS.map((m) => { const o = orgByKey[m.orgKey]; return [q(m.id), q(o.id), q(m.name), q(m.venue),
    agoDate(m.daysAgo), agoDate(m.daysAgo - m.durDays), q(m.desc), q(o.sponsor),
    q(`https://logos.divinghq.local/${o.key}-${o.sponsor.toLowerCase()}.png`), q(o.sponsorUrl), "8", agoTs(m.daysAgo + 30)]; })));

// events (parents first via array order, parent_event_id gets set inline
// since the prelim is emitted before the final in MEETS order)
out.push("-- ---- events ----");
out.push(insert("events",
  ["id", "org_id", "meet_id", "name", "gender", "age_group", "height", "number_of_judges", "total_rounds",
   "event_type", "event_format", "parent_event_id", "advance_count", "scheduled_at", "entries_close_at",
   "status", "created_at", "board_id", "is_mixed_height", "enforce_referee_signoff", "is_rehearsal"],
  M.events.map((e) => [q(e.id), q(e.orgId), q(e.meetId), q(e.name), q(e.gender), q(e.ageGroup), q(e.height),
    e.numJudges, e.rounds, q(e.eventType), q(e.format), e.parentId ? q(e.parentId) : "NULL", e.advance,
    e.scheduledAt, e.entriesClose, q(e.status), e.createdAt, q(e.boardId), "false", "false", "false"])));

// event managers / judges / participating orgs / teams
out.push("-- ---- event_managers / event_judges / event_participating_orgs / event_teams ----");
out.push(insert("event_managers", ["event_id", "user_id", "added_by", "added_at"],
  M.eventManagers.map((x) => [q(x.eventId), q(x.userId), q(x.addedBy), x.at])));
out.push(insert("event_judges", ["event_id", "judge_id", "judge_number"],
  M.eventJudges.map((x) => [q(x.eventId), q(x.judgeId), x.judgeNo])));
out.push(insert("event_participating_orgs", ["event_id", "org_id", "added_by", "added_at"],
  M.participatingOrgs.map((x) => [q(x.eventId), q(x.orgId), q(x.addedBy), x.at])));
out.push(insert("event_teams", ["event_id", "team_id", "added_at"],
  M.eventTeams.map((x) => [q(x.eventId), q(x.teamId), x.at])));

// competitor_dive_lists: dive_id resolved by natural key via JOIN
out.push("-- ---- competitor_dive_lists (dive_id resolved from dive_directory by natural key) ----");
{
  const byEvent = new Map();
  for (const c of M.cdls) { if (!byEvent.has(c.eventId)) byEvent.set(c.eventId, []); byEvent.get(c.eventId).push(c); }
  for (const [, rows] of byEvent) {
    const values = rows.map((c) => `(${[q(c.eventId), q(c.competitorId), c.partnerId ? q(c.partnerId) : "NULL",
      c.teamId ? q(c.teamId) : "NULL", q(c.code), c.height, q(c.pos), c.round, c.displayOrder,
      c.confirmedAt, c.createdAt, c.withdrawnAt || "NULL", c.withdrawnBy ? q(c.withdrawnBy) : "NULL",
      c.withdrawnReason ? q(c.withdrawnReason) : "NULL", bool(c.late)].join(", ")})`).join(",\n  ");
    out.push(
`INSERT INTO competitor_dive_lists
  (event_id, competitor_id, partner_id, team_id, dive_id, round_number, display_order, is_reserve, confirmed_at, created_at, withdrawn_at, withdrawn_by_user_id, withdrawn_reason, late_arrival_flag)
SELECT v.event_id::uuid, v.competitor_id::uuid, v.partner_id::uuid, v.team_id::uuid, d.id,
       v.round_number, v.display_order, false, v.confirmed_at::timestamptz, v.created_at::timestamptz,
       v.withdrawn_at::timestamptz, v.withdrawn_by::uuid, v.withdrawn_reason, v.late_arrival_flag
FROM ( VALUES
  ${values}
) AS v(event_id, competitor_id, partner_id, team_id, code, height, pos, round_number, display_order, confirmed_at, created_at, withdrawn_at, withdrawn_by, withdrawn_reason, late_arrival_flag)
JOIN dive_directory d ON d.dive_code = v.code AND d.height = v.height AND d.position = v.pos::dive_position;\n`);
  }
}

// scores: dive_id resolved by natural key via JOIN
out.push("-- ---- scores (dive_id resolved from dive_directory by natural key) ----");
{
  const byEvent = new Map();
  for (const s of M.scores) { if (!byEvent.has(s.eventId)) byEvent.set(s.eventId, []); byEvent.get(s.eventId).push(s); }
  for (const [, rows] of byEvent) {
    const values = rows.map((s) => `(${[q(s.eventId), q(s.competitorId), q(s.judgeId), q(s.code), s.height, q(s.pos),
      s.round, s.score.toFixed(1), s.createdAt].join(", ")})`).join(",\n  ");
    out.push(
`INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score, status, score_source, created_at)
SELECT v.event_id::uuid, v.competitor_id::uuid, v.judge_id::uuid, d.id, v.round_number, v.score, 'active', 'judge_direct', v.created_at
FROM ( VALUES
  ${values}
) AS v(event_id, competitor_id, judge_id, code, height, pos, round_number, score, created_at)
JOIN dive_directory d ON d.dive_code = v.code AND d.height = v.height AND d.position = v.pos::dive_position;\n`);
  }
}

// attendance / live state
out.push("-- ---- event_attendance / event_live_state ----");
out.push(insert("event_attendance", ["event_id", "competitor_id", "status", "set_at", "set_by"],
  M.attendance.map((a) => [q(a.eventId), q(a.competitorId), q(a.status), a.at, q(a.by)])));
out.push(insert("event_live_state", ["event_id", "active_diver_payload", "updated_at"],
  M.liveState.map((l) => [q(l.eventId), `${q(l.payload)}::jsonb`, l.updatedAt])));

// sessions / schedule blocks
out.push("-- ---- sessions / schedule_blocks ----");
out.push(insert("sessions", ["id", "meet_id", "name", "session_date", "pool", "referee_user_id", "created_at", "updated_at"],
  M.sessions.map((s) => [q(s.id), q(s.meetId), q(s.name), s.date, q(s.pool), q(s.referee), s.at, s.at])));
out.push(insert("schedule_blocks", ["id", "session_id", "block_type", "label", "starts_at", "ends_at", "board_ids", "event_id", "created_at", "updated_at"],
  M.blocks.map((b) => [q(b.id), q(b.sessionId), q(b.type), q(b.label), b.starts, b.ends,
    `ARRAY[${b.boards.map((x) => q(x)).join(", ")}]::uuid[]`, b.eventId ? q(b.eventId) : "NULL", b.at, b.at])));

// in-flight rows
out.push("-- ---- in-flight: club_change_requests / role_requests ----");
out.push(insert("club_change_requests",
  ["id", "user_id", "kind", "from_org_id", "from_club_id", "to_org_id", "to_club_id", "status", "source_approved_by", "source_approved_at", "requested_by", "note", "created_at"],
  M.ccr.map((c) => [q(c.id), q(c.userId), q(c.kind), q(c.fromOrg), c.fromClub ? q(c.fromClub) : "NULL", q(c.toOrg),
    c.toClub ? q(c.toClub) : "NULL", q(c.status), c.sourceApprovedBy ? q(c.sourceApprovedBy) : "NULL",
    c.sourceApprovedAt || "NULL", q(c.requestedBy), q(c.note), c.at])));
out.push(insert("role_requests", ["id", "user_id", "org_id", "requested_role", "status", "note", "created_at"],
  M.roleReq.map((r) => [q(r.id), q(r.userId), q(r.orgId), q(r.role), q(r.status), q(r.note), r.at])));

out.push("-- ---- audit_log / score_audit_log / notifications ----");
out.push(insert("audit_log", ["id", "org_id", "actor_id", "entity_type", "entity_id", "entity_name", "action", "metadata", "created_at"],
  M.audit.map((a) => [q(a.id), q(a.org), q(a.actor), q(a.etype), a.eid ? q(a.eid) : "NULL", q(a.ename), q(a.action), `${q(a.meta)}::jsonb`, a.at])));
out.push(insert("score_audit_log", ["id", "event_id", "competitor_id", "judge_id", "round_number", "action", "old_score", "new_score", "actor_user_id", "reason", "created_at"],
  M.scoreAudit.map((s) => [q(s.id), q(s.eventId), q(s.competitorId), q(s.judgeId), s.round, q(s.action), s.oldScore.toFixed(1), s.newScore.toFixed(1), q(s.actor), q(s.reason), s.at])));
out.push(insert("notifications", ["id", "user_id", "category", "title", "body", "data", "status", "created_at", "sent_at"],
  M.notif.map((n) => [q(n.id), q(n.user), q(n.cat), q(n.title), q(n.body), `'{}'::jsonb`, q(n.status), n.at, n.at])));

// sponsor logos (real PNG bytes, base64-decoded at load) + web-push subscriptions
out.push("-- ---- meet_sponsor_logos (made-up logos, real PNG bytes) / push_subscriptions ----");
out.push(insert("meet_sponsor_logos",
  ["meet_id", "slot_number", "mime_type", "byte_size", "image_bytes", "alt_text", "link_url", "created_at", "updated_at"],
  M.sponsorLogos.map((l) => [q(l.meetId), l.slot, q(l.mime), l.bytes.length, `decode('${l.b64}', 'base64')`, q(l.alt), q(l.link), l.at, l.at])));
out.push(insert("push_subscriptions",
  ["user_id", "endpoint", "p256dh_key", "auth_key", "user_agent", "created_at", "last_used_at", "revoked_at"],
  M.pushSubs.map((p) => [q(p.userId), q(p.endpoint), q(p.p256dh), q(p.auth), q(p.ua), p.createdAt, p.lastUsedAt, p.revokedAt || "NULL"])));

// records: derived from completed individual events using the app's own
// World-Aquatics-correct calc_dive_points(), so the values are realistic.
out.push(`-- ---- records (derived from completed individual scores via calc_dive_points) ----
CREATE TEMP TABLE seed_record_candidates ON COMMIT DROP AS
SELECT cdl.competitor_id AS user_id, u.org_id, u.club_id, o.continent,
       e.height, d.dive_code, d.position,
       public.calc_dive_points(arr.scores, e.number_of_judges, d.dd) AS points,
       e.id AS event_id, e.created_at AS set_at
FROM ( SELECT event_id, competitor_id, round_number, array_agg(score) AS scores
       FROM scores GROUP BY event_id, competitor_id, round_number ) arr
JOIN events e  ON e.id = arr.event_id AND e.event_type = 'individual' AND e.status = 'Completed'
JOIN competitor_dive_lists cdl ON cdl.event_id = arr.event_id AND cdl.competitor_id = arr.competitor_id
                              AND cdl.round_number = arr.round_number AND cdl.withdrawn_at IS NULL
JOIN dive_directory d ON d.id = cdl.dive_id
JOIN users u ON u.id = cdl.competitor_id
JOIN organisations o ON o.id = u.org_id
WHERE u.org_id IN (SELECT id FROM organisations WHERE slug LIKE 'seed-%');

INSERT INTO records_personal (user_id, height, dive_code, position, score, event_id, set_at)
SELECT DISTINCT ON (user_id, height, dive_code, position)
       user_id, height, dive_code, position, points, event_id, set_at
FROM seed_record_candidates
ORDER BY user_id, height, dive_code, position, points DESC
ON CONFLICT (user_id, height, dive_code, position) DO NOTHING;

INSERT INTO records_federation (org_id, holder_id, height, dive_code, position, score, event_id, set_at)
SELECT DISTINCT ON (org_id, height, dive_code, position)
       org_id, user_id, height, dive_code, position, points, event_id, set_at
FROM seed_record_candidates
ORDER BY org_id, height, dive_code, position, points DESC
ON CONFLICT (org_id, height, dive_code, position) DO NOTHING;

INSERT INTO records_club (club_id, holder_id, height, dive_code, position, score, event_id, set_at)
SELECT DISTINCT ON (club_id, height, dive_code, position)
       club_id, user_id, height, dive_code, position, points, event_id, set_at
FROM seed_record_candidates WHERE club_id IS NOT NULL
ORDER BY club_id, height, dive_code, position, points DESC
ON CONFLICT (club_id, height, dive_code, position) DO NOTHING;

INSERT INTO records_continental (continent, holder_id, height, dive_code, position, score, event_id, set_at)
SELECT DISTINCT ON (continent, height, dive_code, position)
       continent, user_id, height, dive_code, position, points, event_id, set_at
FROM seed_record_candidates WHERE continent IS NOT NULL
ORDER BY continent, height, dive_code, position, points DESC
ON CONFLICT (continent, height, dive_code, position) DO NOTHING;

COMMIT;

-- =============================================================
-- DONE.  ${users.length} users, ${MEETS.length} meets, ${M.events.length} events, ${M.scores.length} judge scores.
-- Log in at /login — every seeded account uses password "${PASSWORD_PLAIN}".
-- Super-admin: admin / admin.  Full list: docs/seed-credentials.csv
-- =============================================================
`);

// ---------------------------------------------------------------------------
// Write artifacts
// ---------------------------------------------------------------------------
const root = path.join(__dirname, "..");
fs.writeFileSync(path.join(root, "seed_test_data.sql"), out.join("\n"));

const csvHead = ["persona", "username", "password", "federation", "home_org", "full_name", "email", "notes"];
const csv = [csvHead.join(",")].concat(creds.map((r) =>
  csvHead.map((k) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(","))).join("\n") + "\n";
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "seed-credentials.csv"), csv);

console.log(`[seed] wrote seed_test_data.sql`);
console.log(`[seed]   ${users.length} users, ${MEETS.length} meets, ${M.events.length} events, ${M.cdls.length} dive-list rows, ${M.scores.length} scores`);
console.log(`[seed]   ${outlierCells.size} outlier judge-cells; ${M.sponsorLogos.length} sponsor logos; ${M.pushSubs.length} push subscriptions`);
console.log(`[seed] wrote docs/seed-credentials.csv (${creds.length} logins)`);
