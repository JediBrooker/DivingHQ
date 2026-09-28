// PDF + CSV exports: printable artefacts for officials and
// federations. Six public endpoints (the same data the live
// scoreboard and archive show). The ones with scores in them follow
// the scoreboard's visibility rule (lib/event-visibility): public once
// an event is Live or Completed, host and participating orgs before.
//
//   GET /api/meets/:id/program.pdf                       meet program (PDF)
//   GET /api/meets/:id/program.csv                       meet program (CSV)
//                                                        Both accept ?include=
//                                                        (dive_lists / judges /
//                                                        timing) + ?seconds_per_dive=
//                                                        (30 / 45 / 60).
//   GET /api/events/:id/start-list.pdf                   pin-to-deck pre-meet
//   GET /api/events/:id/divers/:diverId/score-sheet.pdf  per-diver recap
//   GET /api/events/:id/results.csv                      one row per dive
//   GET /api/events/:id/results.pdf                      final standings + dives
//
// Each handler streams the bytes straight back via doc.pipe(res)
// (or res.write for CSV) so a 500-row meet doesn't buffer in
// memory before sending. Documents come from lib/pdf-document,
// which draws each script in its own Noto font when the box has
// it (lib/pdf-fonts) and folds the rest to what Helvetica can
// print. The handlers just ask for Helvetica.
//
// Mounted via:
//   app.use(require('./routes/pdf')({ pool }))

const express = require("express");
// createPdfDocument prints names in any script it can (see the module
// header); pdfTranslate falls back to English headers when it can't.
const { createPdfDocument, pdfTranslate } = require("../lib/pdf-document");
const {
  perDiveSelect, teamStandingsCte, compStandingsCte, standingsPerDiveCte,
} = require("../lib/scoring-sql");
const { PUBLIC_CLUB_JOIN } = require("../lib/club-approvals");
// RFC 4180 quoting plus the spreadsheet formula-injection guard, see
// lib/csv.js.
const { csvRow, slugify } = require("../lib/csv");
const { ensureEventVisible } = require("../lib/event-visibility");
const { uuidParams } = require("../lib/uuid-params");

// The trim that marks judges' scores kept or dropped lives in the SPA
// (src/composables/useScoreTrim.js, ESM) and AGENTS.md wants one copy of
// it, so the score sheet imports that rather than keeping its own. Loaded
// on first use and cached.
let scoreTrim;
function loadScoreTrim() {
  if (!scoreTrim) scoreTrim = import("../src/composables/useScoreTrim.js");
  return scoreTrim;
}

module.exports = function createPdfRouter({ pool, optionalAuth }) {
  if (!pool) throw new Error("createPdfRouter requires { pool }");
  const router = express.Router();
  // Malformed path ids fall through to a 404 (lib/uuid-params).
  uuidParams(router, "id", "diverId");
  // Anything with scores in it (results, score sheets) follows the
  // scoreboard's visibility rule, which needs to know who's asking. The
  // program and the start list stay open to everyone.
  const maybeAuth = optionalAuth || ((_req, _res, next) => next());

  // Final standings by what the event ranks: the team in a team event,
  // otherwise the diver (a synchro pair sits under its lead). One row per
  // unit: unit_id, total, rank (WA Art 4.1.5 shared places), field_size.
  // Same scores as the scoreboard (standingsScoreScope, in its UNION
  // form). $1 = the event. results.csv and the score sheet read it; both
  // used to rank team members against each other rather than rank the
  // teams.
  const UNIT_STANDINGS_SQL = `WITH ${standingsPerDiveCte({
      select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
    })},
    units AS (
      SELECT CASE WHEN ev.event_type = 'team' THEN pd.team_id ELSE pd.competitor_id END AS unit_id,
             SUM(pd.dive_points) AS total
        FROM per_dive pd
        JOIN events ev ON ev.id = $1
       WHERE ev.event_type <> 'team' OR pd.team_id IS NOT NULL
       GROUP BY 1
    )
    SELECT unit_id, total::numeric(8,2) AS total,
           RANK() OVER (ORDER BY total DESC)::int AS rank,
           COUNT(*) OVER ()::int AS field_size
      FROM units`;

  // ===============================================================
  // Meet program export options: parses the ?include= + ?seconds_per_dive
  // query params and pre-fetches the enrichment payloads each event needs.
  // Shared by program.pdf and program.csv so the two surfaces are
  // guaranteed to render the same data.
  //
  // Recognised include tokens:
  //   • dive_lists   : per-event roster + every diver's per-round
  //                    dive list (code, position, dd, height for
  //                    mixed-board events).
  //   • judges       : panel for each event (number, name, country,
  //                    role-tag for synchro panels).
  //   • timing       : estimated event duration. Pairs with
  //                    seconds_per_dive (30 / 45 / 60 default 45).
  //                    Computed as competitor_count * total_rounds *
  //                    seconds_per_dive (a synchro pair counts once).
  //
  // Unknown tokens are silently dropped, same posture as the rest
  // of the public read endpoints. The default (no include= param)
  // is the legacy schedule-only program.
  // ===============================================================
  const VALID_INCLUDE_TOKENS = new Set(["dive_lists", "judges", "timing"]);
  const VALID_TIMING_SECONDS = new Set([30, 45, 60]);

  function parseProgramOptions(query) {
    const raw = String(query.include || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const include = new Set(raw.filter((t) => VALID_INCLUDE_TOKENS.has(t)));
    let secondsPerDive = parseInt(query.seconds_per_dive, 10);
    if (!VALID_TIMING_SECONDS.has(secondsPerDive)) secondsPerDive = 45;
    return { include, secondsPerDive };
  }

  // Load every per-event enrichment payload the operator asked for.
  // Returns a map keyed by event_id so the renderer can look up the
  // right slice when it walks the schedule. Each slice is null when
  // its include token wasn't requested, so the renderer can do a
  // simple presence check before printing the section.
  async function loadProgramEnrichments(events, include) {
    const eventIds = events.map((e) => e.id);
    const empty = { diveLists: null, judges: null };
    if (!eventIds.length || (!include.has("dive_lists") && !include.has("judges"))) {
      return new Map(eventIds.map((id) => [id, empty]));
    }

    const tasks = [];
    if (include.has("dive_lists")) {
      tasks.push(pool.query(
        `SELECT cdl.event_id,
                u.id AS competitor_id, u.full_name,
                /* Migration 090: the meet's representation code. */
                event_rep_code(cdl.event_id, u.id, o.country_code) AS country_code,
                cl.short_code AS club_code, cl.name AS club_name,
                pu.full_name  AS partner_name,
                tm.name       AS team_name,
                cdl.round_number, cdl.display_order, cdl.withdrawn_at,
                cdl.is_reserve, cdl.reserve_position,
                d.dive_code, d.position, d.dd, d.description,
                d.height AS dive_height
           FROM competitor_dive_lists cdl
           JOIN users u ON u.id = cdl.competitor_id
           JOIN organisations o ON o.id = u.org_id
           ${PUBLIC_CLUB_JOIN}
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN teams tm ON tm.id = cdl.team_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
          WHERE cdl.event_id = ANY($1::uuid[])
          ORDER BY cdl.event_id,
                   cdl.is_reserve ASC,
                   cdl.display_order ASC NULLS LAST,
                   u.full_name ASC,
                   cdl.round_number ASC`,
        [eventIds],
      ));
    } else { tasks.push(null); }

    if (include.has("judges")) {
      tasks.push(pool.query(
        `SELECT ej.event_id, ej.judge_number,
                u.full_name, o.country_code,
                cl.short_code AS club_code, cl.name AS club_name
           FROM event_judges ej
           JOIN users u ON u.id = ej.judge_id
           JOIN organisations o ON o.id = u.org_id
           ${PUBLIC_CLUB_JOIN}
          WHERE ej.event_id = ANY($1::uuid[])
          ORDER BY ej.event_id, ej.judge_number ASC NULLS LAST`,
        [eventIds],
      ));
    } else { tasks.push(null); }

    const [diveListsRes, judgesRes] = await Promise.all(
      tasks.map((t) => t || Promise.resolve(null)),
    );

    // Group dive-list rows into { competitor_id → { meta, divesByRound } }
    // per event. The grouped shape is what both PDF + CSV renderers
    // consume; flattening happens at render time.
    const byEvent = new Map();
    for (const id of eventIds) byEvent.set(id, { diveLists: null, judges: null });

    if (diveListsRes) {
      for (const row of diveListsRes.rows) {
        const slot = byEvent.get(row.event_id);
        if (!slot.diveLists) slot.diveLists = new Map();
        if (!slot.diveLists.has(row.competitor_id)) {
          slot.diveLists.set(row.competitor_id, {
            competitor_id:    row.competitor_id,
            full_name:        row.full_name,
            country_code:     row.country_code,
            club_code:        row.club_code,
            club_name:        row.club_name,
            partner_name:     row.partner_name,
            team_name:        row.team_name,
            display_order:    row.display_order,
            withdrawn:        row.withdrawn_at != null,
            is_reserve:       row.is_reserve,
            reserve_position: row.reserve_position,
            dives:            [],
          });
        }
        slot.diveLists.get(row.competitor_id).dives.push({
          round_number: row.round_number,
          dive_code:    row.dive_code,
          position:     row.position,
          dd:           row.dd,
          description:  row.description,
          // dive_height comes from dive_directory, useful when the
          // event spans multiple boards (e.g. 1m + 3m), null for
          // single-board events where height is implied by the event.
          height:       row.dive_height
            ? `${Number(row.dive_height).toFixed(0)}m`
            : null,
        });
      }
      // Convert Maps → ordered arrays for the renderer.
      for (const ev of events) {
        const slot = byEvent.get(ev.id);
        if (slot.diveLists) {
          slot.diveLists = [...slot.diveLists.values()]
            .sort((a, b) => {
              // Active divers first, in display order; reserves at
              // the back ordered by reserve_position.
              if (a.is_reserve !== b.is_reserve) return a.is_reserve ? 1 : -1;
              if (a.is_reserve) {
                return (a.reserve_position ?? 999) - (b.reserve_position ?? 999);
              }
              return (a.display_order ?? Infinity) - (b.display_order ?? Infinity);
            });
        }
      }
    }
    if (judgesRes) {
      for (const row of judgesRes.rows) {
        const slot = byEvent.get(row.event_id);
        if (!slot.judges) slot.judges = [];
        slot.judges.push({
          judge_number: row.judge_number,
          full_name:    row.full_name,
          country_code: row.country_code,
          club_code:    row.club_code,
          club_name:    row.club_name,
        });
      }
    }
    return byEvent;
  }

  // Compute the timing estimate for a single event. The unit cost
  // covers one "dive event": for individuals that's one diver
  // performing one dive; for synchro a pair performs one combined
  // dive; for team events each team-member's per-round dive is
  // counted (their roster shape is one row per member per round).
  // competitor_count already counts a synchro pair once (see
  // loadProgram), so there's no halving here any more: most rosters
  // store one row per pair, and halving those made a 20-dive event
  // read as 10.
  // The result is { minutes, seconds, totalDives, label } so the
  // renderer can pick whichever format fits its line budget.
  function estimateEventDuration(event, secondsPerDive) {
    const competitors = event.competitor_count || 0;
    const rounds      = event.total_rounds || 0;
    const totalDives = competitors * rounds;
    const totalSeconds = totalDives * secondsPerDive;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    let label;
    if (totalDives === 0) {
      label = "—";
    } else if (hh > 0) {
      label = `${hh}h ${mm.toString().padStart(2, "0")}m`;
    } else {
      label = `${mm}m ${seconds.toString().padStart(2, "0")}s`;
    }
    return { totalDives, totalSeconds, minutes, seconds, label };
  }

  // The meet header and its schedule, for program.pdf and program.csv.
  // meetCols is the meet side of the SELECT (always a literal from this
  // file: the PDF wants m.*, the CSV just id and name). meet comes back
  // undefined when there's no such meet. Events are in schedule order
  // with a live competitor count.
  async function loadProgram(meetId, meetCols) {
    const [meetRes, eventsRes] = await Promise.all([
      pool.query(
        `SELECT ${meetCols}, o.name AS org_name, o.country_code
         FROM meets m
         JOIN organisations o ON o.id = m.org_id
         WHERE m.id = $1`,
        [meetId],
      ),
      pool.query(
        `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                e.total_rounds, e.number_of_judges, e.event_type,
                e.event_format, e.parent_event_id, e.scheduled_at,
                e.dd_limit_rounds, e.dd_limit_value, e.status,
                COALESCE(stat.competitor_count, 0)::int AS competitor_count
         FROM events e
         /* Who's diving: reserves and withdrawn rows aren't. A synchro
            pair counts once whether the roster holds one row for it
            (import, manual add: the lead with partner_id set) or one
            each way round (the consent flow's mirror rows), keyed on
            the pair's two ids in a fixed order. */
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT CASE
                    WHEN e.event_type = 'synchro_pair' AND cdl.partner_id IS NOT NULL
                      THEN LEAST(cdl.competitor_id::text, cdl.partner_id::text) || '+' ||
                           GREATEST(cdl.competitor_id::text, cdl.partner_id::text)
                    ELSE cdl.competitor_id::text
                  END) AS competitor_count
           FROM competitor_dive_lists cdl
           WHERE cdl.event_id = e.id AND cdl.withdrawn_at IS NULL
             AND cdl.is_reserve = FALSE
         ) stat ON true
         WHERE e.meet_id = $1
         ORDER BY
           e.scheduled_at NULLS LAST,
           CASE e.event_format WHEN 'preliminary' THEN 0 ELSE 1 END,
           e.created_at ASC`,
        [meetId],
      ),
    ]);
    return { meet: meetRes.rows[0], events: eventsRes.rows };
  }

  // -------------------------------------------------------------
  // Public meet program PDF: full schedule, every event in the
  // bundle, competitor count per event, sponsor strip on the
  // cover. No auth required (public meet pages already expose
  // this data via /meet/:id).
  //
  // Optional query params:
  //   ?include=dive_lists,judges,timing   : extra per-event sections
  //   ?seconds_per_dive=30|45|60          : paired with timing
  // -------------------------------------------------------------
  router.get("/api/meets/:id/program.pdf", async (req, res) => {
    try {
      const { include, secondsPerDive } = parseProgramOptions(req.query);
      const { meet, events } = await loadProgram(req.params.id, "m.*");
      if (!meet) {
        return res.status(404).json({ error: "Meet not found" });
      }

      // Pre-fetch every per-event enrichment the operator asked
      // for so the schedule loop can stream sections inline. The
      // single batched query per enrichment is cheaper than
      // running one-per-event inside the loop.
      const enrichments = await loadProgramEnrichments(events, include);

      const slug = slugify(meet.name, "meet");
      const doc = createPdfDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_program.pdf"`);
      doc.pipe(res);

      // ---------- Cover ----------
      doc.font("Helvetica-Bold").fontSize(11)
        .fillColor("#06b6d4")
        .text((meet.org_name || "").toUpperCase() +
              (meet.country_code ? `  ·  ${meet.country_code}` : ""),
              { align: "center" });
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(28).fillColor("#0f172a")
        .text(meet.name, { align: "center" });
      doc.moveDown(0.3);

      if (meet.start_date || meet.end_date) {
        const fmt = (d) => d
          ? new Date(d).toLocaleDateString(undefined, {
              year: "numeric", month: "long", day: "numeric",
            })
          : "";
        const range = meet.start_date && meet.end_date && meet.start_date !== meet.end_date
          ? `${fmt(meet.start_date)} – ${fmt(meet.end_date)}`
          : fmt(meet.start_date || meet.end_date);
        doc.font("Helvetica").fontSize(13).fillColor("#334155")
          .text(range, { align: "center" });
      }
      if (meet.venue) {
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(12).fillColor("#64748b")
          .text(meet.venue, { align: "center" });
      }
      if (meet.description) {
        doc.moveDown(0.6);
        doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569")
          .text(meet.description, { align: "center", width: 480 });
      }
      if (meet.sponsor_name) {
        doc.moveDown(1.5);
        doc.font("Helvetica").fontSize(9).fillColor("#94a3b8")
          .text("POWERED BY", { align: "center", characterSpacing: 3 });
        doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a")
          .text(meet.sponsor_name, { align: "center" });
      }

      doc.moveDown(2);

      // ---------- Schedule list ----------
      doc.font("Helvetica-Bold").fontSize(11)
        .fillColor("#06b6d4")
        .text(pdfTranslate(req, "pdf.program.header_event_schedule").toUpperCase(), { characterSpacing: 3 });
      doc.moveDown(0.4);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.6);

      if (!events.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No events scheduled for this meet yet.");
      }

      let meetTotalSeconds = 0;
      for (const ev of events) {
        // Page break if we're running off the page
        if (doc.y > 720) doc.addPage();

        const time = ev.scheduled_at
          ? new Date(ev.scheduled_at).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })
          : "TBA";

        doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
          .text(ev.name, { continued: false });
        doc.font("Helvetica").fontSize(10).fillColor("#64748b");

        const tags = [];
        if (ev.event_type === "synchro_pair") tags.push("SYNCHRO");
        else if (ev.event_type === "team")    tags.push("TEAM");
        if (ev.event_format === "preliminary") tags.push("PRELIM");
        else if (ev.parent_event_id)           tags.push("FINAL");
        if (ev.age_group) tags.push(ev.age_group);
        tags.push(ev.gender);
        if (ev.height) tags.push(ev.height);
        tags.push(`${ev.total_rounds} rounds`);
        tags.push(`${ev.number_of_judges} judges`);
        if (ev.dd_limit_rounds && ev.dd_limit_value) {
          tags.push(`DD ≤ ${ev.dd_limit_value} for first ${ev.dd_limit_rounds}`);
        }

        doc.text(tags.join("  ·  "));

        doc.font("Helvetica").fontSize(10).fillColor("#475569");
        const meta = [];
        meta.push(time);
        if (ev.competitor_count) {
          // A synchro event's count is pairs (see loadProgram).
          const unit = ev.event_type === "synchro_pair"
            ? (ev.competitor_count === 1 ? "pair" : "pairs")
            : (ev.competitor_count === 1 ? "diver" : "divers");
          meta.push(`${ev.competitor_count} ${unit}`);
        }
        meta.push(ev.status);
        // Timing estimate sits in the meta line so it reads next to
        // the diver count, the natural place for "X divers · ~Y min".
        if (include.has("timing")) {
          const est = estimateEventDuration(ev, secondsPerDive);
          meetTotalSeconds += est.totalSeconds;
          if (est.totalDives > 0) {
            meta.push(`~${est.label} @ ${secondsPerDive}s/dive`);
          }
        }
        doc.text(meta.join("  ·  "));

        const ext = enrichments.get(ev.id) || { diveLists: null, judges: null };

        // Judge panel block: public-facing, so we omit clubs (only
        // the chip-tap on the live scoreboard surfaces them). Name +
        // country code per row is enough for a printed program.
        if (include.has("judges") && ext.judges && ext.judges.length) {
          doc.moveDown(0.5);
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#06b6d4")
            .text(pdfTranslate(req, "pdf.program.header_judge_panel").toUpperCase(), { characterSpacing: 2 });
          doc.font("Helvetica").fontSize(9).fillColor("#334155");
          for (const j of ext.judges) {
            if (doc.y > 760) doc.addPage();
            const num = j.judge_number != null ? `J${j.judge_number}` : "J?";
            const country = j.country_code ? `  ${j.country_code}` : "";
            doc.text(`  ${num}   ${j.full_name || "(unnamed)"}${country}`);
          }
        }

        // Dive lists: every diver in start-order, their dives by
        // round. Withdrawn divers are marked but still listed so a
        // printed program matches the live scoreboard's start list.
        // Reserves print last under a "RESERVES" sub-header.
        if (include.has("dive_lists") && ext.diveLists && ext.diveLists.length) {
          doc.moveDown(0.5);
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#06b6d4")
            .text(pdfTranslate(req, "pdf.program.header_dive_lists").toUpperCase(), { characterSpacing: 2 });
          let inReserves = false;
          for (const diver of ext.diveLists) {
            if (doc.y > 740) doc.addPage();
            if (diver.is_reserve && !inReserves) {
              doc.moveDown(0.3);
              doc.font("Helvetica-Bold").fontSize(8).fillColor("#94a3b8")
                .text(pdfTranslate(req, "pdf.program.header_reserves").toUpperCase(), { characterSpacing: 2 });
              inReserves = true;
            }
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
            const orderTag = !diver.is_reserve && diver.display_order != null
              ? `  ${diver.display_order}.  `
              : (diver.is_reserve && diver.reserve_position != null
                  ? `  R${diver.reserve_position}.  `
                  : "  ");
            let header = `${orderTag}${diver.full_name || "(unnamed)"}`;
            if (diver.partner_name) header += `  &  ${diver.partner_name}`;
            if (diver.team_name)    header += `  ·  ${diver.team_name}`;
            if (diver.club_code)    header += `  ·  ${diver.club_code}`;
            if (diver.country_code) header += `  ·  ${diver.country_code}`;
            if (diver.withdrawn)    header += "  ·  WITHDRAWN";
            doc.text(header);
            doc.font("Helvetica").fontSize(9).fillColor("#475569");
            for (const dv of diver.dives) {
              if (!dv.dive_code) continue;
              const ddText = dv.dd != null ? `DD ${Number(dv.dd).toFixed(1)}` : "DD —";
              const heightText = dv.height ? `  (${dv.height})` : "";
              const desc = dv.description ? `  ·  ${dv.description}` : "";
              doc.text(
                `      R${dv.round_number}  ${dv.dive_code} ${dv.position || ""}  ${ddText}${heightText}${desc}`,
                { width: 495 },
              );
            }
            doc.moveDown(0.15);
          }
        }

        doc.moveDown(0.7);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(50, doc.y - 4).lineTo(545, doc.y - 4).stroke();
      }

      // Total meet-duration summary, only when timing was requested
      // and the meet has at least one event with divers loaded.
      if (include.has("timing") && meetTotalSeconds > 0) {
        if (doc.y > 720) doc.addPage();
        doc.moveDown(0.5);
        const totalMinutes = Math.floor(meetTotalSeconds / 60);
        const hh = Math.floor(totalMinutes / 60);
        const mm = totalMinutes % 60;
        const label = hh > 0
          ? `${hh}h ${mm.toString().padStart(2, "0")}m`
          : `${mm} min`;
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
          .text("ESTIMATED TOTAL MEET DURATION", { characterSpacing: 3 });
        doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a")
          .text(label);
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b")
          .text(`Calculated at ${secondsPerDive} seconds per dive. Excludes warm-ups, between-event resets, and ceremonies.`);
      }

      doc.moveDown(1);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(
          `Generated ${new Date().toLocaleString()} via DivingHQ.`,
          { align: "center" },
        );

      doc.end();
    } catch (err) {
      console.error("[Meet Program PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // Meet program CSV: same data as the PDF, in a flat shape
  // friendly to spreadsheets. One row per event when no extras
  // are requested; one row per event-judge / per-diver-dive when
  // the corresponding include token is set. The `section` column
  // tells consumers which kind of row they're looking at.
  //
  // Optional query params (same as the PDF):
  //   ?include=dive_lists,judges,timing
  //   ?seconds_per_dive=30|45|60
  // -------------------------------------------------------------
  router.get("/api/meets/:id/program.csv", async (req, res) => {
    try {
      const { include, secondsPerDive } = parseProgramOptions(req.query);
      const { meet, events } = await loadProgram(req.params.id, "m.id, m.name");
      if (!meet) {
        return res.status(404).json({ error: "Meet not found" });
      }
      const enrichments = await loadProgramEnrichments(events, include);

      const slug = slugify(meet.name, "meet");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}_program.csv"`,
      );

      // Column header: a superset across all section types so a
      // spreadsheet user can sort/filter by `section` and see the
      // rows that matter to them. Empty cells are left blank.
      const header = [
        "section",
        "event_name", "event_format", "event_type",
        "age_group", "gender", "height",
        "total_rounds", "number_of_judges", "scheduled_at",
        "competitor_count", "status",
        "estimated_duration_seconds", "estimated_duration_label",
        // judge-row columns
        "judge_number", "judge_name", "judge_country",
        // diver/dive-row columns
        "diver_name", "diver_country", "diver_club",
        "diver_partner", "diver_team",
        "start_order", "is_reserve", "reserve_position", "withdrawn",
        "round_number", "dive_code", "dive_position", "dive_dd",
        "dive_height", "dive_description",
      ];
      res.write(csvRow(header));

      for (const ev of events) {
        const ext = enrichments.get(ev.id) || { diveLists: null, judges: null };
        const est = include.has("timing")
          ? estimateEventDuration(ev, secondsPerDive)
          : null;
        // Event-summary row: always written so a consumer can
        // pivot on (section='event'). Repeats event metadata so
        // the dive-list / judge rows below don't have to.
        res.write(csvRow([
          "event",
          ev.name, ev.event_format || "", ev.event_type || "individual",
          ev.age_group || "", ev.gender || "", ev.height || "",
          ev.total_rounds, ev.number_of_judges,
          ev.scheduled_at ? new Date(ev.scheduled_at).toISOString() : "",
          ev.competitor_count, ev.status || "",
          est ? est.totalSeconds : "", est ? est.label : "",
          "", "", "",
          "", "", "", "", "", "", "", "", "",
          "", "", "", "", "", "",
        ]));

        if (include.has("judges") && ext.judges) {
          for (const j of ext.judges) {
            res.write(csvRow([
              "judge",
              ev.name, ev.event_format || "", ev.event_type || "individual",
              ev.age_group || "", ev.gender || "", ev.height || "",
              ev.total_rounds, ev.number_of_judges,
              ev.scheduled_at ? new Date(ev.scheduled_at).toISOString() : "",
              ev.competitor_count, ev.status || "",
              "", "",
              j.judge_number ?? "",
              j.full_name || "",
              j.country_code || "",
              "", "", "", "", "", "", "", "", "",
              "", "", "", "", "", "",
            ]));
          }
        }

        if (include.has("dive_lists") && ext.diveLists) {
          for (const diver of ext.diveLists) {
            for (const dv of diver.dives) {
              res.write(csvRow([
                "dive",
                ev.name, ev.event_format || "", ev.event_type || "individual",
                ev.age_group || "", ev.gender || "", ev.height || "",
                ev.total_rounds, ev.number_of_judges,
                ev.scheduled_at ? new Date(ev.scheduled_at).toISOString() : "",
                ev.competitor_count, ev.status || "",
                "", "",
                "", "", "",
                diver.full_name || "",
                diver.country_code || "",
                diver.club_code || diver.club_name || "",
                diver.partner_name || "",
                diver.team_name || "",
                diver.display_order ?? "",
                diver.is_reserve ? "true" : "false",
                diver.reserve_position ?? "",
                diver.withdrawn ? "true" : "false",
                dv.round_number ?? "",
                dv.dive_code || "",
                dv.position || "",
                dv.dd != null ? Number(dv.dd).toFixed(1) : "",
                dv.height || "",
                dv.description || "",
              ]));
            }
          }
        }
      }

      res.end();
    } catch (err) {
      console.error("[Meet Program CSV Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // START LIST PDF: pinned-to-wall pre-meet sheet showing every
  // diver in start-order with their per-round dives. Operators
  // print this and pin it to the deck so divers know when they're
  // up. Reuses the program PDF's PDFKit setup but the body is a
  // per-diver dive-list table sorted by display_order then name.
  // -------------------------------------------------------------
  router.get("/api/events/:id/start-list.pdf", async (req, res) => {
    try {
      const [evRes, rosterRes] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                  e.total_rounds, e.number_of_judges, e.event_type,
                  e.event_format, e.scheduled_at,
                  o.name AS org_name, o.country_code
           FROM events e
           JOIN organisations o ON o.id = e.org_id
           WHERE e.id = $1`,
          [req.params.id],
        ),
        pool.query(
          `SELECT u.id AS competitor_id, u.full_name,
                  event_rep_code($1, u.id, o.country_code) AS country_code,
                  cl.name AS club_name, cl.short_code AS club_code,
                  pu.full_name AS partner_name,
                  tm.name AS team_name,
                  cdl.round_number, cdl.display_order, cdl.withdrawn_at,
                  cdl.is_reserve, cdl.reserve_position,
                  d.dive_code, d.position, d.dd
           FROM users u
           JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
           JOIN organisations o ON u.org_id = o.id
           ${PUBLIC_CLUB_JOIN}
           LEFT JOIN users pu  ON pu.id = cdl.partner_id
           LEFT JOIN teams tm  ON tm.id = cdl.team_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.event_id = $1
           ORDER BY cdl.is_reserve ASC, cdl.reserve_position ASC NULLS LAST,
                    cdl.display_order ASC NULLS LAST,
                    u.full_name ASC, cdl.round_number ASC`,
          [req.params.id],
        ),
      ]);
      if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = evRes.rows[0];

      // Reshape: one row per diver with an array of N dives
      // indexed by round (1-based). Reflects the layout PDFKit
      // will render.
      const byDiver = new Map();
      for (const r of rosterRes.rows) {
        if (!byDiver.has(r.competitor_id)) {
          byDiver.set(r.competitor_id, {
            full_name: r.full_name,
            country_code: r.country_code,
            club_name: r.club_name,
            club_code: r.club_code,
            partner_name: r.partner_name,
            team_name: r.team_name,
            withdrawn: !!r.withdrawn_at,
            is_reserve: !!r.is_reserve,
            reserve_position: r.reserve_position,
            dives: Array.from({ length: event.total_rounds }, () => null),
          });
        }
        const diver = byDiver.get(r.competitor_id);
        if (r.round_number >= 1 && r.round_number <= event.total_rounds) {
          diver.dives[r.round_number - 1] = {
            code: r.dive_code,
            position: r.position,
            dd: r.dd,
          };
        }
      }
      const divers = [...byDiver.values()];

      const slug = slugify(event.name, "event");
      const doc = createPdfDocument({ margin: 40, size: "A4", layout: "landscape" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_start_list.pdf"`);
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
        .text((event.org_name || "").toUpperCase()
          + (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 });
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      doc.font("Helvetica").fontSize(10).fillColor("#475569");
      const tags = [];
      if (event.event_type === "synchro_pair") tags.push("SYNCHRO");
      else if (event.event_type === "team")    tags.push("TEAM");
      if (event.event_format && event.event_format !== "final") {
        tags.push(event.event_format.toUpperCase());
      }
      if (event.age_group) tags.push(event.age_group);
      tags.push(event.gender);
      if (event.height) tags.push(event.height);
      tags.push(`${event.total_rounds} rounds · ${event.number_of_judges} judges`);
      doc.text(tags.join("  ·  "), { align: "center" });
      doc.moveDown(0.6);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(40, doc.y).lineTo(802, doc.y).stroke();
      doc.moveDown(0.4);

      if (!divers.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No divers entered for this event yet.", { align: "center" });
        doc.end();
        return;
      }

      // ---------- Table header ----------
      // Column layout: # | Name + Club | R1 .. Rn
      const startX  = 40;
      const numCol  = 20;
      const nameCol = 200;
      const totalRounds = event.total_rounds;
      const roundColWidth = Math.max(50, Math.floor((802 - startX - numCol - nameCol - 10) / totalRounds));

      function drawTableHeader() {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#06b6d4");
        let x = startX;
        doc.text("#", x, doc.y, { width: numCol, align: "center" });
        x += numCol;
        doc.text("DIVER", x, doc.y, { width: nameCol });
        x += nameCol;
        const headerY = doc.y;
        for (let r = 1; r <= totalRounds; r++) {
          doc.text(`R${r}`, x, headerY, { width: roundColWidth, align: "center" });
          x += roundColWidth;
        }
        doc.moveDown(0.4);
        doc.lineWidth(0.5).strokeColor("#cbd5e1")
          .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fillColor("#0f172a");
      }
      drawTableHeader();

      // Reserves (WA 4.1.12) come last under their own header, labelled
      // R1, R2… like the program PDF. They used to be numbered on as the
      // next divers in the running order, as if they were competing.
      let number = 0;
      let inReserves = false;
      divers.forEach((d) => {
        // Page break
        if (doc.y > 540) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
          drawTableHeader();
        }
        if (d.is_reserve && !inReserves) {
          inReserves = true;
          doc.moveDown(0.3);
          doc.font("Helvetica-Bold").fontSize(8).fillColor("#94a3b8")
            .text(pdfTranslate(req, "pdf.program.header_reserves").toUpperCase(), startX, doc.y, { characterSpacing: 2 });
          doc.moveDown(0.3);
        }
        const label = d.is_reserve ? `R${d.reserve_position ?? ""}` : String(++number);
        const rowY = doc.y;
        let x = startX;
        // Number column
        doc.font("Helvetica").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        doc.text(label, x, rowY, { width: numCol, align: "center" });
        x += numCol;
        // Name + meta column
        doc.font("Helvetica-Bold").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        const nameLine = d.full_name + (d.country_code ? `  ${d.country_code}` : "")
          + (d.partner_name ? `  &  ${d.partner_name}` : "")
          + (d.withdrawn ? "  (WITHDRAWN)" : "");
        doc.text(nameLine, x, rowY, { width: nameCol });
        // Club / team subline
        const subline = d.team_name
          ? d.team_name
          : (d.club_name ? d.club_name + (d.club_code ? `  (${d.club_code})` : "") : "");
        if (subline) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b");
          doc.text(subline, x, doc.y, { width: nameCol });
        }
        x += nameCol;
        // Round columns
        const cellTopY = rowY;
        doc.font("Helvetica").fontSize(9).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        for (let r = 0; r < totalRounds; r++) {
          const dive = d.dives[r];
          const cellText = dive
            ? `${dive.code || ""}${dive.position || ""}\nDD ${Number(dive.dd ?? 0).toFixed(1)}`
            : "—";
          doc.text(cellText, x, cellTopY, { width: roundColWidth, align: "center" });
          x += roundColWidth;
        }
        doc.moveDown(0.4);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
        doc.moveDown(0.2);
      });

      doc.moveDown(1);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(`Generated ${new Date().toLocaleString()} via DivingHQ.`, { align: "center" });

      doc.end();
    } catch (err) {
      console.error("[Start List PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PER-DIVER SCORE SHEET PDF: every diver wants their own
  // report after a meet. Reuses the dive-with-judges shape we
  // already build for Recent Form: per-round dive metadata + each
  // judge's raw score (with the dropped scores marked under World Aquatics
  // trim rules, the same way the live scoreboard renders them).
  // -------------------------------------------------------------
  router.get("/api/events/:id/divers/:diverId/score-sheet.pdf", maybeAuth, async (req, res) => {
    try {
      const eventId = req.params.id;
      const diverId = req.params.diverId;
      if (!(await ensureEventVisible(pool, req, res, eventId))) return;

      // Whose rows carry this diver's dives. Their own, unless they're the
      // partner on a synchro pair stored once under the lead, where the
      // scores sit under the lead's id (see diverDivesWhere in
      // db/queries.js). The sheet used to say "No dives recorded" for the
      // partner. partner_id is who to name alongside them.
      const pair = (await pool.query(
        `SELECT COALESCE(own.id, lead.competitor_id, $2::uuid) AS scored_as,
                COALESCE(lead.competitor_id, mine.partner_id) AS partner_id
           FROM (SELECT 1) one
           LEFT JOIN LATERAL (
             SELECT $2::uuid AS id WHERE EXISTS (
               SELECT 1 FROM scores WHERE event_id = $1 AND competitor_id = $2)
           ) own ON true
           LEFT JOIN LATERAL (
             SELECT l.competitor_id FROM competitor_dive_lists l
              WHERE l.event_id = $1 AND l.partner_id = $2 AND own.id IS NULL
                AND EXISTS (SELECT 1 FROM scores sc WHERE sc.event_id = $1 AND sc.competitor_id = l.competitor_id)
              LIMIT 1
           ) lead ON true
           LEFT JOIN LATERAL (
             SELECT m.partner_id FROM competitor_dive_lists m
              WHERE m.event_id = $1 AND m.competitor_id = $2 AND m.partner_id IS NOT NULL
              LIMIT 1
           ) mine ON true`,
        [eventId, diverId],
      )).rows[0];
      const scoredAs = pair.scored_as;

      const [evRes, diverRes, divesRes, totalRes, partnerRes] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                  e.total_rounds, e.number_of_judges, e.event_type,
                  e.created_at,
                  o.name AS org_name, o.country_code
           FROM events e
           JOIN organisations o ON o.id = e.org_id
           WHERE e.id = $1`,
          [eventId],
        ),
        pool.query(
          `SELECT u.id, u.full_name,
                  event_rep_code($2, u.id, o.country_code) AS country_code,
                  cl.name AS club_name, cl.short_code AS club_code
           FROM users u
           JOIN organisations o ON o.id = u.org_id
           ${PUBLIC_CLUB_JOIN}
           WHERE u.id = $1`,
          [diverId, eventId],
        ),
        pool.query(
          `${perDiveSelect({
            select: [
              "s.round_number",
              "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
              "e.number_of_judges", "e.event_type::text AS event_type",
            ],
            pointsAlias: "dive_total",
            selectExtra: [
              `array_agg(json_build_object(
                    'judge_number', ej.judge_number,
                    'score',        s.score
                  ) ORDER BY ej.judge_number) AS judges_json`,
            ],
            where: "s.event_id = $1 AND s.competitor_id = $2",
            groupBy: [
              "s.round_number",
              "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
            ],
          })}
           ORDER BY s.round_number ASC`,
          [eventId, scoredAs],
        ),
        // Final placing, from the same standings as the scoreboard: a
        // team member's headline is their team's total and place.
        pool.query(
          `SELECT st.total, st.rank AS rnk, st.field_size
             FROM (${UNIT_STANDINGS_SQL}) st
            WHERE st.unit_id = COALESCE(
                    (SELECT l.team_id FROM competitor_dive_lists l
                      JOIN events ev ON ev.id = l.event_id AND ev.event_type = 'team'
                     WHERE l.event_id = $1 AND l.competitor_id = $2 AND l.team_id IS NOT NULL
                     LIMIT 1),
                    $2)`,
          [eventId, scoredAs],
        ),
        pair.partner_id
          ? pool.query("SELECT full_name FROM users WHERE id = $1", [pair.partner_id])
          : Promise.resolve({ rows: [] }),
      ]);
      if (!evRes.rows.length)    return res.status(404).json({ error: "Event not found" });
      if (!diverRes.rows.length) return res.status(404).json({ error: "Diver not found" });
      const event = evRes.rows[0];
      const diver = diverRes.rows[0];
      const partnerName = partnerRes.rows[0]?.full_name || null;
      const dives = divesRes.rows;
      const totals = totalRes.rows[0] || {};

      // World Aquatics trim marks, from the scoreboard's own helper (see
      // loadScoreTrim) so a synchro panel is trimmed within its
      // execution and sync sub-panels here too. The printed dive_total
      // comes from calc_event_dive_points either way; this is only the
      // brackets, and they used to disagree with both.
      const { annotateJudgeRows } = await loadScoreTrim();

      const slug = slugify(diver.full_name, "diver");
      const doc = createPdfDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_score_sheet.pdf"`);
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
        .text(event.org_name.toUpperCase()
          + (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 });
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
        .text(diver.full_name + (diver.country_code ? `  ${diver.country_code}` : ""), { align: "center" });
      if (partnerName) {
        doc.font("Helvetica").fontSize(12).fillColor("#334155")
          .text(`&  ${partnerName}`, { align: "center" });
      }
      if (diver.club_name) {
        doc.font("Helvetica").fontSize(11).fillColor("#475569")
          .text(diver.club_name + (diver.club_code ? `  (${diver.club_code})` : ""), { align: "center" });
      }
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      const meta = [
        event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`,
        event.created_at ? new Date(event.created_at).toLocaleDateString() : "",
      ].filter(Boolean).join("  ·  ");
      doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(meta, { align: "center" });
      doc.moveDown(0.8);

      // ---------- Headline result tile ----------
      if (totals.rnk) {
        const rank = Number(totals.rnk);
        const total = Number(totals.total).toFixed(2);
        const fieldSize = Number(totals.field_size);
        const ord = (n) => {
          const s = ["th", "st", "nd", "rd"], v = n % 100;
          return n + (s[(v - 20) % 10] || s[v] || s[0]);
        };
        doc.font("Helvetica-Bold").fontSize(28).fillColor(
          rank === 1 ? "#ca8a04" : rank === 2 ? "#475569" : rank === 3 ? "#92400e" : "#0f172a",
        ).text(`${ord(rank)} of ${fieldSize}`, { align: "center" });
        doc.font("Helvetica").fontSize(12).fillColor("#475569")
          .text(`Total: ${total}`, { align: "center" });
        doc.moveDown(0.8);
      }

      if (!dives.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No dives recorded for this diver yet.");
        doc.end();
        return;
      }

      // ---------- Per-dive breakdown ----------
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
        .text("DIVE-BY-DIVE BREAKDOWN", { characterSpacing: 2 });
      doc.moveDown(0.4);

      for (const d of dives) {
        if (doc.y > 720) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a")
          .text(`Round ${d.round_number}  ·  ${d.dive_code || "—"}${d.position || ""}`,
            { continued: true });
        doc.font("Helvetica").fontSize(10).fillColor("#475569")
          .text(`   DD ${Number(d.dd ?? 0).toFixed(1)}   Total ${Number(d.dive_total).toFixed(2)}`,
            { align: "right" });
        if (d.description) {
          doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b")
            .text(d.description);
        }
        doc.moveDown(0.2);

        const annotated = annotateJudgeRows(d.judges_json || [], d.number_of_judges, d.event_type);
        const lineParts = annotated.map((j) =>
          j.dropped
            ? `[${Number(j.score).toFixed(1)}]`     // brackets = dropped
            : Number(j.score).toFixed(1),
        );
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a")
          .text("Judges: " + lineParts.join("  "), { indent: 10 });
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
          .text("(dropped scores shown in brackets)", { indent: 10 });

        doc.moveDown(0.6);
      }

      doc.moveDown(0.4);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(`Generated ${new Date().toLocaleString()} via DivingHQ.`, { align: "center" });
      doc.end();
    } catch (err) {
      console.error("[Score Sheet PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CSV EXPORT: federation operators copy results into the
  // federation's central record-keeping system. Same data as the
  // results PDF, formatted as a single CSV with one row per dive
  // so downstream pivot tables work cleanly.
  // -------------------------------------------------------------
  router.get("/api/events/:id/results.csv", maybeAuth, async (req, res) => {
    try {
      if (!(await ensureEventVisible(pool, req, res, req.params.id))) return;
      const [evRes, divesRes, totalsRes] = await Promise.all([
        pool.query(
          "SELECT e.name, e.gender, e.height, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = $1",
          [req.params.id],
        ),
        pool.query(
          // Dive-by-dive scope: d.dd is a grouping column, so it
          // feeds the UDF directly (no MAX() wrapper).
          `${perDiveSelect({
            select: [
              "u.id AS competitor_id", "u.full_name AS diver_name",
              "event_rep_code($1, u.id, o.country_code) AS country_code",
              "cl.name AS club_name", "cl.short_code AS club_code",
              "pu.full_name AS partner_name", "cdl.team_id", "tm.name AS team_name",
              "s.round_number", "d.dive_code", "d.position", "d.dd",
            ],
            dd:          "d.dd",
            pointsAlias: "dive_total",
            selectExtra: [
              "STRING_AGG(s.score::text, ' ' ORDER BY ej.judge_number) AS judge_scores",
            ],
            extraJoins: [
              "JOIN users u  ON u.id = s.competitor_id",
              "JOIN organisations o ON o.id = u.org_id",
              PUBLIC_CLUB_JOIN,
              "LEFT JOIN users pu ON pu.id = cdl.partner_id",
              "LEFT JOIN teams tm ON tm.id = cdl.team_id",
            ],
            where: "s.event_id = $1",
            groupBy: [
              "u.id", "u.full_name", "o.country_code", "cl.name", "cl.short_code",
              "pu.full_name", "cdl.team_id", "tm.name",
              "s.round_number", "d.dive_code", "d.position", "d.dd",
            ],
          })}
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.id],
        ),
        // Final placings, fetched alongside so the CSV's per-dive rows
        // can carry both the dive total and the final rank. Keyed by id
        // (not name) so two same-named divers don't collide. A team
        // member's rows carry their team's total and place.
        pool.query(UNIT_STANDINGS_SQL, [req.params.id]),
      ]);
      if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = evRes.rows[0];
      const slug = slugify(event.name, "event");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.csv"`);

      const placingById = new Map(
        totalsRes.rows.map((r) => [r.unit_id, { total: r.total, rank: r.rank }]),
      );
      const isTeam = event.event_type === "team";

      res.write(csvRow([
        "diver_name", "country", "club_name", "club_code",
        "partner_name", "team_name",
        "round", "dive_code", "position", "dd",
        "judge_scores", "dive_total",
        "final_total", "final_rank",
      ]));
      for (const r of divesRes.rows) {
        const placing = placingById.get(isTeam ? r.team_id : r.competitor_id) || {};
        res.write(csvRow([
          r.diver_name, r.country_code,
          r.club_name, r.club_code,
          r.partner_name, r.team_name,
          r.round_number, r.dive_code, r.position, r.dd,
          r.judge_scores, r.dive_total,
          placing.total, placing.rank,
        ]));
      }
      res.end();
    } catch (err) {
      console.error("[Results CSV Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // RESULTS PDF: final standings + dive-by-dive grouped by
  // diver. Synchro events regroup the judge chips into A / B /
  // Sync sub-panels so the printed page matches the on-screen
  // layout the audience saw. Team events rank and group by team,
  // same as the scoreboard and recap.
  // -------------------------------------------------------------
  router.get("/api/events/:id/results.pdf", maybeAuth, async (req, res) => {
    try {
      if (!(await ensureEventVisible(pool, req, res, req.params.id))) return;
      const [ev, standings, dives] = await Promise.all([
        pool.query(
          "SELECT e.name, e.gender, e.height, e.total_rounds, e.number_of_judges, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON e.org_id = o.id WHERE e.id = $1",
          [req.params.id],
        ),
        pool.query(
          `WITH ${standingsPerDiveCte({
             select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
           })},
           /* Team events print one line per team, like the scoreboard:
              team name, the code its divers share, team short code
              underneath. This used to list every member separately. */
           ${teamStandingsCte()},
           /* Same per-diver standings as the scoreboard (grouped by
              u.id, so two Sarah Williamses stay two lines). The PDF
              only prints the columns merged picks out below. */
           ${compStandingsCte()},
           merged AS (
             SELECT team_id, full_name, country_code, club_name, partner_name, total
             FROM team_standings
             UNION ALL
             SELECT NULL::uuid, full_name, country_code, club_name, partner_name, total
             FROM comp_standings
           )
           /* World Aquatics Art 4.1.5: equal totals share a place.
              RANK() over total gives the shared placing; rows ordered
              by total then name for a stable display order. */
           SELECT team_id, full_name, country_code, club_name, partner_name, total,
                  RANK() OVER (ORDER BY total DESC) AS rank
           FROM merged
           ORDER BY total DESC, full_name ASC`,
          [req.params.id],
        ),
        pool.query(
          /* Group by u.id (not u.full_name). The PDF renders "Dive
             Results" grouped by diver, without the id, two divers
             with the same name merged into a single section with
             inflated dive totals. STRING_AGG also now orders by
             judge_number, not judge_id (UUID), so the chip order on
             the page matches the panel order. */
          // Dive-by-dive scope: d.dd is a grouping column, so it
          // feeds the UDF directly (no MAX() wrapper).
          `${perDiveSelect({
            select: [
              "u.id AS competitor_id", "u.full_name", "cl.name AS club_name",
              // Only printed for team events, next to each member's dive.
              "event_rep_code($1, u.id, o.country_code) AS country_code",
              "pu.full_name AS partner_name",
              "cdl.team_id", "tm.name AS team_name",
              "s.round_number", "d.dive_code", "d.position", "d.dd",
            ],
            dd:          "d.dd",
            pointsAlias: "total_dive_score",
            selectExtra: [
              "STRING_AGG(s.score::text, ', ' ORDER BY ej.judge_number) AS judge_scores",
            ],
            extraJoins: [
              "JOIN users u ON s.competitor_id = u.id",
              "JOIN organisations o ON o.id = u.org_id",
              PUBLIC_CLUB_JOIN,
              "LEFT JOIN users pu ON pu.id = cdl.partner_id",
              "LEFT JOIN teams tm ON tm.id = cdl.team_id",
            ],
            where: "s.event_id = $1",
            groupBy: [
              "u.id", "u.full_name", "cl.name", "o.country_code", "pu.full_name",
              "cdl.team_id", "tm.name",
              "s.round_number", "d.dive_code", "d.position", "d.dd",
            ],
          })}
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.id],
        ),
      ]);

      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = ev.rows[0];
      const slug = event.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

      const doc = createPdfDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.pdf"`);
      doc.pipe(res);

      // Header
      doc.fontSize(20).font("Helvetica-Bold").text("DIVINGHQ", { align: "center" });
      doc.fontSize(10).font("Helvetica").text(event.org_name, { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(16).font("Helvetica-Bold").text(event.name, { align: "center" });
      const meta = [event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`].filter(Boolean).join("  ·  ");
      doc.fontSize(9).font("Helvetica").fillColor("#666").text(meta, { align: "center" });
      doc.fillColor("#000").moveDown(1);

      // Standings
      doc.fontSize(13).font("Helvetica-Bold").text("Final Standings");
      doc.moveDown(0.3);
      standings.rows.forEach((row) => {
        const rank = row.rank;
        const total = Number(row.total).toFixed(2);
        doc.fontSize(10).font(rank <= 3 ? "Helvetica-Bold" : "Helvetica")
          .text(`${rank}.  ${row.full_name}${row.country_code ? "  " + row.country_code : ""}`, 50, doc.y, { continued: true, width: 350 })
          .font("Helvetica-Bold").text(total, { align: "right" });
        if (row.club_name) {
          doc.fontSize(8).font("Helvetica").fillColor("#666")
            .text(`     ${row.club_name}`, 50);
          doc.fillColor("#000");
        }
      });
      doc.moveDown(1);

      // Dive-by-dive breakdown
      doc.fontSize(13).font("Helvetica-Bold").text("Dive Results");
      doc.moveDown(0.3);

      // Group rows by competitor_id (not full_name) so two divers
      // with the same name don't collapse into one section. The
      // section header still shows full_name for readability.
      //
      // Team events group by team instead, sections in team-name order
      // and dives in round order, with the diver named on each line.
      // Keyed by team_id for the same reason as above, two teams can
      // share a name.
      const isTeam = event.event_type === "team";
      const teamRow = new Map(
        standings.rows.filter((r) => r.team_id).map((r) => [r.team_id, r]),
      );
      const byDiver = new Map();
      dives.rows.forEach((row) => {
        const key = isTeam ? `team:${row.team_id || "none"}` : row.competitor_id;
        if (!byDiver.has(key)) {
          const team = teamRow.get(row.team_id);
          byDiver.set(key, isTeam
            ? {
                name: row.team_name || "Unattached",
                code: team?.country_code || null,
                club: team?.club_name || null,
                rows: [],
              }
            : {
                name: row.full_name,
                code: null,
                club: row.club_name || null,
                rows: [],
              });
        }
        byDiver.get(key).rows.push(row);
      });
      if (isTeam) {
        for (const group of byDiver.values()) {
          group.rows.sort((a, b) => a.round_number - b.round_number
            || String(a.full_name).localeCompare(String(b.full_name)));
        }
      }
      const sections = [...byDiver.values()];
      if (isTeam) sections.sort((a, b) => a.name.localeCompare(b.name));

      // For synchro events, regroup judge scores into A / B / Sync
      // blocks so the PDF reflects the same grouping the web UI does.
      const isSynchro = event.event_type === "synchro_pair";
      const numJudges = event.number_of_judges;
      const formatSynchroScores = (scoresStr) => {
        const parts = (scoresStr || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (numJudges === 9 && parts.length === 9) {
          return `A: ${parts.slice(0, 2).join(",")}  B: ${parts.slice(2, 4).join(",")}  Sync: ${parts.slice(4, 9).join(",")}`;
        }
        if (numJudges === 11 && parts.length === 11) {
          return `A: ${parts.slice(0, 3).join(",")}  B: ${parts.slice(3, 6).join(",")}  Sync: ${parts.slice(6, 11).join(",")}`;
        }
        return scoresStr;
      };

      for (const group of sections) {
        if (doc.y > 680) doc.addPage();
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000")
          .text(group.code ? `${group.name}  ${group.code}` : group.name);
        if (group.club) {
          doc.fontSize(9).font("Helvetica").fillColor("#666").text(group.club);
          doc.fillColor("#000");
        }
        group.rows.forEach((r) => {
          const code = [r.dive_code, r.position].filter(Boolean).join(" ");
          const dd = r.dd ? `DD ${Number(r.dd).toFixed(1)}` : "";
          const scores = isSynchro
            ? formatSynchroScores(r.judge_scores)
            : (r.judge_scores || "");
          const total = Number(r.total_dive_score).toFixed(2);
          // On a team sheet each line needs its diver. Their own code only
          // earns a place when it isn't the team's (a mixed team reading
          // as the country shows each member's state), and it goes right
          // after their name so it can't be read as the partner's.
          let who = "";
          if (isTeam) {
            const own = r.country_code && r.country_code !== group.code ? ` (${r.country_code})` : "";
            const partner = r.partner_name ? ` & ${r.partner_name}` : "";
            who = `${r.full_name}${own}${partner}  `;
          }
          doc.fontSize(9).font("Helvetica")
            .text(`  R${r.round_number}  ${who}${code}  ${dd}    Judges: ${scores}    Total: ${total}`);
        });
        doc.moveDown(0.5);
      }

      doc.end();
    } catch (err) {
      console.error("[PDF Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  return router;
};
