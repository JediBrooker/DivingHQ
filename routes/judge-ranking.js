// Judge Ranking Analysis — "what would the standings have been if
// every judge had scored unanimously like one specific judge?"
//
//   GET /api/events/:id/judge-ranking-analysis        JSON payload
//   GET /api/events/:id/judge-ranking-analysis.csv    CSV export
//   GET /api/events/:id/judge-ranking-analysis.pdf    PDF export
//
// For each judge J on the panel and each diver D in the event the
// endpoint computes:
//
//     judge_total[J][D] = SUM over rounds R of ( J's score(D, R) × dive DD )
//     rank[J][D]        = RANK() OVER (PARTITION BY J ORDER BY judge_total DESC)
//
// alongside the diver's ACTUAL (panel-trimmed, World Aquatics tie-
// break aware) total + rank. The frontend renders the result as a
// "diver × judge" matrix so a viewer can see at a glance which
// judge's scoring pattern would have re-shuffled the podium.
//
// Per-dive judge rank is also computed (rank within a single round,
// for each judge) so the score-chip tooltip on the scoreboard can
// say "J3 ranked this diver 2nd of 12 in round 1".
//
// Permission: PUBLIC read. Every input (per-judge per-dive score)
// is already visible on the existing scoreboard / archive / judge
// profile pages. Re-aggregating into a hypothetical ranking surfaces
// no new private data — it just visualises a pattern that was
// already in plain sight.
//
// Event-type handling: all three types (individual / synchro_pair
// / team) are supported. The math is identical at heart — for
// each judge J and each "competing entity" E (a diver, a pair, or
// a team), compute SUM over rounds of J's contribution × DD ×
// scaling, then rank entities by that total per judge. The
// scaling factor follows the World Aquatics dive-points formula:
//
//   individual    → ×1.0
//   synchro_pair  → ×0.6  (per Article 13 synchro rule)
//   team          → ×1.0  (with per-dive partner-bonus folded in
//                          via the existing has_partner branch
//                          for synchro dives within team events)
//
// Synchro pairs are stored as one cdl row per (event, lead diver,
// round) with partner_id set — all 9/11 judges score under the
// lead's competitor_id, role-tagged by judge_number. So the
// aggregation key for synchro is still competitor_id (the lead);
// we expose partner_id + partner_name on the row for display.
//
// Team events store one cdl row per team member, all sharing the
// team_id. We aggregate by team_id so a team's hypothetical total
// = SUM of every team member's J-contribution. Per_dive_ranks
// remain keyed by competitor_id (chip tooltips on the scoreboard
// still tag individual divers).
//
// SQL discipline (audit-fix bar from commit cde3e40):
//   * Per-judge per-competitor scores are pre-aggregated in a
//     dedicated CTE before any join onto cdl / dive_directory, so
//     a missing-dd row never explodes into a Cartesian fan-out.
//   * COALESCE(dd, 1.0) treats a missing DD as a neutral multiplier
//     rather than zeroing the whole dive — same approach as the
//     existing CSV export.

const express = require("express");
const PDFDocument = require("pdfkit");

// CSV escaping + spreadsheet-formula-injection guard. Identical to
// the helpers in routes/pdf.js — kept inline rather than extracted
// into a shared module so this file stays self-contained until the
// pattern crops up a third time.
function csvCell(s) {
  if (s == null) return "";
  let text = String(s);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  if (dangerous) text = "'" + text;
  if (/[",\n\r]/.test(text) || dangerous) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
function csvRow(cells) { return cells.map(csvCell).join(",") + "\n"; }

// Filename slug — matches the existing PDF/CSV exports.
function slugify(s) {
  return String(s || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Build the analysis payload. Extracted so the JSON, CSV, and PDF
// endpoints can share a single source of truth — adding a column
// in one place ripples through all three exports automatically.
async function buildAnalysis(pool, eventId) {
  const evRes = await pool.query(
    `SELECT e.id, e.name, e.gender, e.height, e.event_type::text AS event_type,
            e.total_rounds, e.number_of_judges, e.status::text AS status,
            e.created_at,
            o.name AS org_name, o.country_code
       FROM events e
       JOIN organisations o ON o.id = e.org_id
      WHERE e.id = $1`,
    [eventId],
  );
  if (!evRes.rows.length) return { notFound: true };
  const event = evRes.rows[0];

  // Synchro contributions scale ×0.6 per WA Article 13. Team
  // events fold the synchro-bonus into has_partner at the
  // calc_event_dive_points level; the judge-ranking aggregate
  // applies ×0.6 only when the event itself is a pure synchro
  // pair (matching how calc_event_dive_points dispatches).
  const synchroScale = event.event_type === "synchro_pair" ? 0.6 : 1.0;
  const isTeam = event.event_type === "team";

  // Panel for this event — judge_number + identity. Used both as
  // the column headers in the rendered table and to join back onto
  // the per-judge totals below.
  const panelRes = await pool.query(
    `SELECT ej.judge_id, ej.judge_number,
            u.full_name,
            o.country_code,
            o.name        AS org_name,
            cl.name       AS club_name,
            cl.short_code AS club_code
       FROM event_judges ej
       JOIN users u         ON u.id = ej.judge_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN clubs cl   ON cl.id = u.club_id
      WHERE ej.event_id = $1
      ORDER BY ej.judge_number ASC`,
    [eventId],
  );
  const judges = panelRes.rows;

  // ----------------------------------------------------------------
  // "Unanimous like J" scaling multiplier.
  //
  // judge_total[J][rankee] is ONE judge's contribution: SUM over
  // rounds of (J's score × DD × synchroScale). The hypothetical the
  // matrix wants to show is the FULL event total *if every kept
  // judge had scored exactly like J* — i.e. judge_total × (number of
  // judges the World-Aquatics trim keeps). calc_event_dive_points
  // applies that trim (a 5- or 7-judge individual panel keeps the
  // middle 3; synchro keeps its own subset × 0.6), so we probe it
  // once with a unanimous all-1.0 panel and DD 1.0:
  //
  //   probe = calc_event_dive_points(panel, [1.0…], n_judges, 1.0, type, false)
  //
  // For individual/team that returns the kept count (e.g. 3) with
  // synchroScale = 1.0 → multiplier 3. For synchro it returns
  // keptCount × 0.6 and synchroScale = 0.6, so the / synchroScale
  // cancels the 0.6 already baked into judge_total, leaving the pure
  // kept-judge count. A NULL/0 probe (or a query error) falls back to
  // multiplier 1 → totals shown unscaled rather than zeroed.
  let unanimousMultiplier = 1;
  try {
    const jnums = judges.map((j) => j.judge_number);
    const unanimousOnes = jnums.map(() => 1.0);
    const probeRes = await pool.query(
      `SELECT calc_event_dive_points($1::int[], $2::numeric[], $3::int, 1.0::numeric, $4, false) AS m`,
      [jnums, unanimousOnes, event.number_of_judges, event.event_type],
    );
    const probe = Number(probeRes.rows[0]?.m);
    unanimousMultiplier =
      Number.isFinite(probe) && probe > 0 ? probe / synchroScale : 1;
  } catch (err) {
    console.error("[Judge Ranking unanimous-multiplier probe failed]", err.message);
    unanimousMultiplier = 1;
  }

  // Pre-aggregate per (judge, competitor) judge_total and per
  // (judge, competitor, round) per-round dive points in a single
  // CTE pipeline. The cdl join is by (event_id, competitor_id,
  // round_number) so a missing dive list row drops the dive_dd to
  // NULL → COALESCE keeps the row alive with a neutral 1.0
  // multiplier rather than zeroing it (same fallback the existing
  // CSV export uses for DD = NULL rows).
  // Aggregation key: competitor_id for individual + synchro
  // (synchro pairs hang all 9/11 judges' scores off the lead),
  // team_id for team events. Pre-aggregate per-(judge, rankee)
  // before any rank window so a missing-dd row never explodes
  // into a Cartesian fan-out.
  const totalsRes = await pool.query(
    `WITH per_dive AS (
       SELECT s.competitor_id,
              cdl.team_id,
              s.judge_id,
              s.round_number,
              s.score,
              COALESCE(d.dd, 1.0) AS dd,
              (s.score * COALESCE(d.dd, 1.0) * $2::numeric)::numeric AS judge_dive_points
         FROM scores s
         LEFT JOIN competitor_dive_lists cdl
           ON  cdl.event_id      = s.event_id
           AND cdl.competitor_id = s.competitor_id
           AND cdl.round_number  = s.round_number
         LEFT JOIN dive_directory d
           ON d.id = COALESCE(s.dive_id, cdl.dive_id)
        WHERE s.event_id = $1
     ),
     /* Per-judge per-rankee totals. For team events the rankee
        is team_id; for individual + synchro it's competitor_id. */
     per_judge_total AS (
       SELECT
         CASE WHEN $3::boolean THEN NULL ELSE competitor_id END AS competitor_id,
         CASE WHEN $3::boolean THEN team_id ELSE NULL END        AS team_id,
         judge_id,
         SUM(judge_dive_points)::numeric(10,3) AS judge_total
         FROM per_dive
        WHERE ($3::boolean = FALSE OR team_id IS NOT NULL)
        GROUP BY 1, 2, judge_id
     ),
     per_judge_ranked AS (
       SELECT competitor_id, team_id, judge_id, judge_total,
              RANK() OVER (PARTITION BY judge_id ORDER BY judge_total DESC)::int AS rank
         FROM per_judge_total
     ),
     /* Per-dive ranks stay keyed by competitor_id even on team
        events — the score-chip tooltip on the scoreboard tags
        individual divers regardless of how the totals aggregate. */
     per_dive_ranked AS (
       SELECT competitor_id, judge_id, round_number, judge_dive_points,
              RANK() OVER (
                PARTITION BY judge_id, round_number
                ORDER BY judge_dive_points DESC
              )::int AS rank,
              COUNT(*) OVER (PARTITION BY judge_id, round_number)::int AS total_in_round
         FROM per_dive
     )
     SELECT 'judge'::text AS kind,
            competitor_id, team_id, judge_id,
            NULL::int       AS round_number,
            judge_total     AS judge_total_or_points,
            rank,
            NULL::int       AS total_in_round
       FROM per_judge_ranked
     UNION ALL
     SELECT 'dive'::text,
            competitor_id, NULL::uuid AS team_id, judge_id,
            round_number,
            judge_dive_points,
            rank,
            total_in_round
       FROM per_dive_ranked`,
    [eventId, synchroScale, isTeam],
  );

  // Pre-aggregate the actual standings using the same WA tie-break
  // the scoreboard / archive uses: total DESC, then per-dive
  // descending-sorted array DESC. calc_event_dive_points handles
  // the panel-trim + scaling for the official total.
  // Actual standings. The WHEN branches keep the row shape stable
  // across event types: lead competitor (with optional partner)
  // for individual + synchro, team id with team name for team
  // events. dives_desc preserves the WA tie-break ordering.
  const standingsRes = isTeam
    ? await pool.query(
        `WITH per_dive AS (
           SELECT cdl.team_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej
               ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON  cdl.event_id      = s.event_id
               AND cdl.competitor_id = s.competitor_id
               AND cdl.round_number  = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
            WHERE s.event_id = $1
            GROUP BY cdl.team_id, s.competitor_id, s.round_number,
                     e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT team_id,
                  SUM(dive_points)::numeric(10,2) AS total,
                  array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
             FROM per_dive
            WHERE team_id IS NOT NULL
            GROUP BY team_id
         )
         SELECT NULL::uuid AS competitor_id,
                t.team_id,
                tm.name AS full_name,
                NULL::char(3) AS country_code,
                tm.short_code AS club_name,
                NULL::uuid AS partner_id,
                NULL::varchar AS partner_name,
                t.total AS actual_total,
                RANK() OVER (ORDER BY t.total DESC, t.dives_desc DESC)::int AS actual_rank
           FROM totals t
           JOIN teams tm ON tm.id = t.team_id
          ORDER BY actual_rank ASC, tm.name ASC`,
        [eventId],
      )
    : await pool.query(
        `WITH per_dive AS (
           SELECT s.competitor_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej
               ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON  cdl.event_id      = s.event_id
               AND cdl.competitor_id = s.competitor_id
               AND cdl.round_number  = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
            WHERE s.event_id = $1
            GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT competitor_id,
                  SUM(dive_points)::numeric(10,2) AS total,
                  array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
             FROM per_dive
            GROUP BY competitor_id
         )
         SELECT u.id AS competitor_id,
                NULL::uuid AS team_id,
                u.full_name,
                o.country_code,
                cl.name AS club_name,
                /* Synchro partner — first non-null partner_id across
                   the diver's rounds (constant for a given pair). */
                pp.partner_id,
                pu.full_name AS partner_name,
                t.total AS actual_total,
                RANK() OVER (ORDER BY t.total DESC, t.dives_desc DESC)::int AS actual_rank
           FROM totals t
           JOIN users u ON u.id = t.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN LATERAL (
             SELECT DISTINCT cdl.partner_id
               FROM competitor_dive_lists cdl
              WHERE cdl.event_id = $1
                AND cdl.competitor_id = t.competitor_id
                AND cdl.partner_id IS NOT NULL
              LIMIT 1
           ) pp ON TRUE
           LEFT JOIN users pu ON pu.id = pp.partner_id
          ORDER BY actual_rank ASC, u.full_name ASC`,
        [eventId],
      );

  // Index the per-(judge, competitor) and per-(judge, competitor,
  // round) rows for O(1) lookup while building the per-diver
  // arrays.
  // judgeTotals key: rankee-id (competitor_id for individual +
  // synchro, team_id for team) prefixed with judge_id. perDiveRanks
  // always keyed by competitor_id since chip tooltips tag the
  // individual diver who performed the dive, regardless of event
  // type.
  const judgeTotals = new Map();        // key = `${judge_id}:${rankeeId}`
  const perDiveRanks = {};              // key = `${judge_id}:${competitor_id}:${round_number}`
  for (const row of totalsRes.rows) {
    if (row.kind === "judge") {
      const rankeeId = isTeam ? row.team_id : row.competitor_id;
      if (!rankeeId) continue;
      judgeTotals.set(`${row.judge_id}:${rankeeId}`, {
        judge_total: Number(row.judge_total_or_points),
        rank: row.rank,
      });
    } else {
      perDiveRanks[`${row.judge_id}:${row.competitor_id}:${row.round_number}`] = {
        rank: row.rank,
        judge_dive_points: Number(row.judge_total_or_points),
        total_in_round: row.total_in_round,
      };
    }
  }

  // `divers` is kept as the API field name for backward compat
  // (the frontend already consumes it). Each row is a "competing
  // entity": diver / pair / team. Extra fields surface the
  // event-specific identity (partner_name for synchro, team_id
  // for team).
  const divers = standingsRes.rows.map((row) => {
    const rankeeId = isTeam ? row.team_id : row.competitor_id;
    return {
      competitor_id: row.competitor_id,
      team_id: row.team_id,
      full_name: row.full_name,
      country_code: row.country_code,
      club_name: row.club_name,
      partner_id: row.partner_id || null,
      partner_name: row.partner_name || null,
      actual_rank: row.actual_rank,
      actual_total: Number(row.actual_total),
      per_judge: judges.map((j) => {
        const hit = judgeTotals.get(`${j.judge_id}:${rankeeId}`);
        return {
          judge_id: j.judge_id,
          judge_number: j.judge_number,
          // Scale the single judge's contribution up to the full
          // "if every kept judge scored like J" event total. rank is
          // left untouched — a positive monotonic scale can't reorder
          // the per-judge ranking. This single source feeds JSON, CSV
          // and PDF exports alike.
          judge_total: hit ? hit.judge_total * unanimousMultiplier : 0,
          rank: hit ? hit.rank : null,
        };
      }),
    };
  });

  return {
    event: {
      id: event.id,
      name: event.name,
      gender: event.gender,
      height: event.height,
      event_type: event.event_type,
      total_rounds: event.total_rounds,
      number_of_judges: event.number_of_judges,
      status: event.status,
      created_at: event.created_at,
      org_name: event.org_name,
      country_code: event.country_code,
    },
    judges,
    divers,
    per_dive_ranks: perDiveRanks,
  };
}

module.exports = function createJudgeRankingRouter({ pool }) {
  if (!pool) throw new Error("createJudgeRankingRouter requires { pool }");
  const router = express.Router();

  // -------------------------------------------------------------
  // JSON payload — drives the in-page JudgeRankingTable + the
  // scoreboard's chip-tooltip enhancement (per_dive_ranks).
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      res.json(result);
    } catch (err) {
      console.error("[Judge Ranking Analysis Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CSV export — one row per diver, with the Actual column +
  // per-judge (rank, total) columns. Federation operators paste
  // this into central record-keeping systems; the formula-injection
  // guard (csvCell) is essential.
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis.csv", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      const { event, judges, divers } = result;
      const slug = slugify(event.name);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}_judge_ranking.csv"`,
      );

      const header = ["diver", "country", "club", "actual_rank", "actual_total"];
      for (const j of judges) {
        header.push(`J${j.judge_number}_rank`, `J${j.judge_number}_total`);
      }
      res.write(csvRow(header));

      for (const d of divers) {
        const cells = [
          d.full_name,
          d.country_code,
          d.club_name,
          d.actual_rank,
          Number(d.actual_total).toFixed(2),
        ];
        for (const pj of d.per_judge) {
          cells.push(
            pj.rank == null ? "" : pj.rank,
            pj.judge_total == null ? "" : Number(pj.judge_total).toFixed(2),
          );
        }
        res.write(csvRow(cells));
      }
      res.end();
    } catch (err) {
      console.error("[Judge Ranking CSV Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PDF export — landscape A4 table, mirrors the on-screen layout.
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis.pdf", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      const { event, judges, divers } = result;
      const slug = slugify(event.name);

      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}_judge_ranking.pdf"`,
      );
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
        .text(
          (event.org_name || "").toUpperCase() +
            (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 },
        );
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      doc.font("Helvetica").fontSize(10).fillColor("#475569")
        .text("Judge Ranking Analysis", { align: "center" });
      const meta = [
        event.gender, event.height,
        `${event.total_rounds} rounds`, `${event.number_of_judges} judges`,
      ].filter(Boolean).join("  ·  ");
      doc.font("Helvetica").fontSize(9).fillColor("#64748b")
        .text(meta, { align: "center" });
      doc.moveDown(0.4);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(40, doc.y).lineTo(802, doc.y).stroke();
      doc.moveDown(0.5);

      if (!divers.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No scored dives for this event yet.", { align: "center" });
        doc.end();
        return;
      }

      // ---------- Table ----------
      // Column layout: Diver (200) | Actual (60) | J1..JN evenly.
      const startX = 40;
      const nameCol = 200;
      const actualCol = 80;
      const remaining = 802 - startX - nameCol - actualCol - 10;
      const judgeColWidth = Math.max(38, Math.floor(remaining / Math.max(judges.length, 1)));

      function drawHeader() {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#06b6d4");
        let x = startX;
        const headerY = doc.y;
        doc.text("DIVER", x, headerY, { width: nameCol });
        x += nameCol;
        doc.text("ACTUAL", x, headerY, { width: actualCol, align: "center" });
        x += actualCol;
        for (const j of judges) {
          doc.text(`J${j.judge_number}`, x, headerY, {
            width: judgeColWidth, align: "center",
          });
          x += judgeColWidth;
        }
        doc.moveDown(0.5);
        doc.lineWidth(0.5).strokeColor("#cbd5e1")
          .moveTo(startX, doc.y)
          .lineTo(startX + nameCol + actualCol + judgeColWidth * judges.length, doc.y)
          .stroke();
        doc.moveDown(0.3);
        doc.fillColor("#0f172a");
      }
      drawHeader();

      for (const d of divers) {
        if (doc.y > 540) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
          drawHeader();
        }
        const rowY = doc.y;
        let x = startX;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
        const nameLine = d.full_name + (d.country_code ? `  ${d.country_code}` : "");
        doc.text(nameLine, x, rowY, { width: nameCol });
        if (d.club_name) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(d.club_name, x, doc.y, { width: nameCol });
        }
        x += nameCol;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a")
          .text(`${d.actual_rank} (${Number(d.actual_total).toFixed(1)})`,
            x, rowY, { width: actualCol, align: "center" });
        x += actualCol;
        for (const pj of d.per_judge) {
          // Highlight outliers — judges whose rank differs from
          // actual by 2+ positions. Same threshold the frontend
          // applies for the cyan accent.
          const isOutlier = pj.rank != null
            && Math.abs(pj.rank - d.actual_rank) >= 2;
          doc.font(isOutlier ? "Helvetica-Bold" : "Helvetica")
            .fontSize(10)
            .fillColor(isOutlier ? "#06b6d4" : "#0f172a")
            .text(pj.rank == null ? "—" : String(pj.rank),
              x, rowY, { width: judgeColWidth, align: "center" });
          x += judgeColWidth;
        }
        doc.moveDown(0.5);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(startX, doc.y)
          .lineTo(startX + nameCol + actualCol + judgeColWidth * judges.length, doc.y)
          .stroke();
        doc.moveDown(0.2);
      }

      doc.moveDown(0.8);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(
          `Generated ${new Date().toLocaleString()} via DivingHQ.  ` +
          "Each judge column shows the rank this diver would hold if every " +
          "judge had scored unanimously like that judge.",
          { align: "center" },
        );

      doc.end();
    } catch (err) {
      console.error("[Judge Ranking PDF Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  return router;
};
