// Records: personal / club / region / federation / continental bests
// per (gender, height, dive_code, position).
//
// Factory exposes:
//   * checkAndApplyRecords({ eventId, competitorId, roundNumber })
//     called (via announceRecords below) whenever a score lands:
//     socket submit_score and the Control Room's manual entry. Atomic: SELECT … FOR UPDATE on each scope's
//     existing row, archive the old holder to *_history, upsert the
//     new best, return an array describing every record this dive
//     set so the caller can fan it out as `record_broken`.
//   * router: Express router with the read endpoint
//     GET /api/records?scope=…&scope_id=… or ?event_id=…
//
// Only individual events set records, and each mark goes in the
// Women's or Men's book (migration 094). A Mixed event files the
// dive under the diver's profile gender and skips it when that's
// unknown. record_gender() in SQL is the one place that rule lives.
//
// Each scope lives in its own table (records_personal /
// records_club / records_region / records_federation /
// records_continental) with proper FKs (migrations 019, 037, 091).
// The `scope` string discriminator on the wire is preserved so
// existing clients keep working unchanged.

const express = require("express");
const { perDiveSelect } = require("./scoring-sql");

// Per-scope SQL configuration. The shape difference is small
// enough that a config table beats three near-duplicate paths.
//   personal:   user_id IS the holder (no separate holder_id col).
//   club / fed: scope-id column + a holder_id column for the user.
const RECORD_TABLES = {
  personal: {
    table: "records_personal",
    history: "records_personal_history",
    scopeCol: "user_id",
    hasHolder: false,
  },
  club: {
    table: "records_club",
    history: "records_club_history",
    scopeCol: "club_id",
    hasHolder: true,
  },
  federation: {
    table: "records_federation",
    history: "records_federation_history",
    scopeCol: "org_id",
    hasHolder: true,
  },
  // Continental records: keyed off the diver's home federation's
  // `continent` column (organisations.continent set per migration
  // 037). Federations without a continent set just skip the
  // continental check entirely. The scope-id type here is text,
  // not uuid, same handling as the rest of the config.
  continental: {
    table: "records_continental",
    history: "records_continental_history",
    scopeCol: "continent",
    hasHolder: true,
  },
  // State / provincial records (migration 091), keyed off the region the
  // diver was entered from (the competitor_dive_lists snapshot, migration
  // 090), falling back to their club's current region for older entries.
  region: {
    table: "records_region",
    history: "records_region_history",
    scopeCol: "region_id",
    hasHolder: true,
  },
};

module.exports = function createRecords({ pool, verifyToken }) {
  if (!pool) throw new Error("createRecords requires { pool, verifyToken }");

  // Returns an array of {scope, scope_id, scope_name, scope_code,
  // gender, height, dive_code, position, score, holder_id,
  // holder_name, prev_score, prev_holder_name, event_id,
  // round_number, official} describing every record this dive set.
  // Empty array = nothing broken.
  async function checkAndApplyRecords({ eventId, competitorId, roundNumber }) {
    // Wrap the whole flow in a single transaction. Two concurrent
    // score completions on the same (scope, gender, height,
    // dive_code, position) used to be able to both read the prior
    // row, both archive it, and both upsert. Now we acquire a row
    // lock with SELECT … FOR UPDATE on each scope's existing record
    // before deciding to write, so the second caller re-reads our
    // just-committed row and either no-ops or archives our value
    // cleanly.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Single-dive scope: one (event, competitor, round) row.
      // d.dd feeds the UDF directly (it's a grouping column here,
      // so no MAX() wrapper).
      const ctx = await client.query(
        perDiveSelect({
          select: [
            "u.id  AS user_id",
            "u.club_id",
            "u.org_id",
            "o.continent",
            "cl.name AS club_name",
            "cl.short_code AS club_code",
            "o.name  AS org_name",
            "o.country_code",
            "o.claim_state AS org_claim_state",
            "rg.id   AS region_id",
            "rg.name AS region_name",
            "rg.short_code AS region_code",
            "rg.claim_state AS region_claim_state",
            "u.full_name AS holder_name",
            // Migration 094: which book (Women's / Men's) the dive
            // belongs in. NULL = a Mixed event and no profile gender,
            // so there's no fair book to put it in.
            "record_gender(e.gender, u.gender) AS gender",
            "e.height", "e.event_type", "e.number_of_judges", "e.is_rehearsal",
            "d.dive_code", "d.position", "d.dd", "d.description",
          ],
          dd:          "d.dd",
          pointsAlias: "dive_total",
          selectExtra: ["COUNT(s.score)::int AS judges_in"],
          extraJoins: [
            "JOIN users u  ON u.id = s.competitor_id",
            "LEFT JOIN clubs cl ON cl.id = u.club_id",
            "JOIN organisations o ON o.id = u.org_id",
            "LEFT JOIN regions rg ON rg.id = COALESCE(cdl.rep_region_id, cl.region_id)",
          ],
          where: "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
          groupBy: [
            "u.id", "u.club_id", "u.org_id", "o.continent", "cl.name", "cl.short_code",
            "o.name", "o.country_code", "o.claim_state", "u.full_name", "u.gender",
            "rg.id", "rg.name", "rg.short_code", "rg.claim_state",
            "e.gender", "e.height", "e.is_rehearsal",
            "d.dive_code", "d.position", "d.dd", "d.description",
          ],
        }),
        [eventId, competitorId, roundNumber],
      );
      if (!ctx.rows.length) {
        await client.query("ROLLBACK");
        return [];
      }
      const c = ctx.rows[0];

      if (c.is_rehearsal) {
        await client.query("ROLLBACK");
        return [];
      }

      // Records are an individual-dive thing. A synchro dive is two
      // people's work credited to the lead competitor, and a team
      // round is somebody's leg of a relay, so neither says anything
      // about what one diver can score.
      if (c.event_type !== "individual" || !c.gender) {
        await client.query("ROLLBACK");
        return [];
      }

      if (c.judges_in < c.number_of_judges
          || !c.dive_code || !c.position || !c.height
          || c.dive_total == null) {
        await client.query("ROLLBACK");
        return [];
      }

      const score = Number(c.dive_total);
      const broken = [];

      const scopes = [
        { scope: "personal", scope_id: c.user_id, scope_name: c.holder_name, scope_code: null, official: true },
        ...(c.club_id ? [{
          scope: "club", scope_id: c.club_id, scope_name: c.club_name,
          scope_code: c.club_code || c.club_name, official: true,
        }] : []),
        ...(c.region_id ? [{
          scope: "region", scope_id: c.region_id, scope_name: c.region_name,
          scope_code: c.region_code || c.region_name,
          official: c.region_claim_state === "claimed",
        }] : []),
        {
          scope: "federation", scope_id: c.org_id, scope_name: c.org_name,
          scope_code: c.country_code || c.org_name,
          official: c.org_claim_state === "claimed",
        },
        // Continental: only when the federation has been
        // classified by sysadmin (organisations.continent IS NOT
        // NULL). A junior at a Pacific Junior Champs whose home
        // federation is Oceania-classified gets their dive checked
        // against the Oceania record book. scope_code stays the raw
        // continent key, the SPA names it in the viewer's language.
        ...(c.continent
          ? [{
              scope: "continental",
              scope_id: c.continent,
              scope_name: c.continent.charAt(0).toUpperCase() + c.continent.slice(1),
              scope_code: c.continent,
              official: true,
            }]
          : []),
      ];

      for (const s of scopes) {
        const cfg = RECORD_TABLES[s.scope];
        const holderCol = cfg.hasHolder ? "holder_id" : cfg.scopeCol;
        // FOR UPDATE locks the row so concurrent record-checks for
        // the same key serialise through this point. A not-yet-existing
        // row can't be locked though, so two first-time checks can
        // both pass this read and race into the upsert below. The
        // upsert's score-guard (table.score < EXCLUDED.score) is the
        // backstop for that case, just in case both slip through.
        const existing = await client.query(
          `SELECT id, score, ${holderCol} AS holder_id,
                  (SELECT full_name FROM users WHERE id = ${cfg.table}.${holderCol}) AS holder_name
           FROM ${cfg.table}
           WHERE ${cfg.scopeCol} = $1
             AND gender = $2::event_gender
             AND height = $3::board_height
             AND dive_code = $4 AND position = $5::dive_position
           FOR UPDATE`,
          [s.scope_id, c.gender, c.height, c.dive_code, c.position]);
        const prev = existing.rows[0];

        if (prev && score <= Number(prev.score)) continue;

        if (prev) {
          const cols = `${cfg.scopeCol}, ${cfg.hasHolder ? "holder_id, " : ""}gender, height, dive_code, position,
                        score, prev_score, event_id, set_at`;
          await client.query(
            `INSERT INTO ${cfg.history} (${cols})
             SELECT ${cols} FROM ${cfg.table} WHERE id = $1`,
            [prev.id]);
        }

        // DO UPDATE only fires when the incoming score actually
        // beats the stored one. When a concurrent transaction won
        // the both-saw-no-row race above and committed a higher
        // (or equal) score first, the WHERE guard makes this a
        // zero-row no-op instead of overwriting the better record.
        const prevScore = prev ? Number(prev.score) : null;
        const upsertSql = cfg.hasHolder
          ? `INSERT INTO ${cfg.table}
               (${cfg.scopeCol}, holder_id, gender, height, dive_code, position,
                score, prev_score, event_id, set_at)
             VALUES ($1, $2, $3::event_gender, $4::board_height, $5, $6::dive_position, $7, $8, $9, now())
             ON CONFLICT (${cfg.scopeCol}, gender, height, dive_code, position)
             DO UPDATE SET holder_id  = EXCLUDED.holder_id,
                           score      = EXCLUDED.score,
                           prev_score = ${cfg.table}.score,
                           event_id   = EXCLUDED.event_id,
                           set_at     = now()
             WHERE ${cfg.table}.score < EXCLUDED.score
             RETURNING id`
          : `INSERT INTO ${cfg.table}
               (${cfg.scopeCol}, gender, height, dive_code, position,
                score, prev_score, event_id, set_at)
             VALUES ($1, $2::event_gender, $3::board_height, $4, $5::dive_position, $6, $7, $8, now())
             ON CONFLICT (${cfg.scopeCol}, gender, height, dive_code, position)
             DO UPDATE SET score      = EXCLUDED.score,
                           prev_score = ${cfg.table}.score,
                           event_id   = EXCLUDED.event_id,
                           set_at     = now()
             WHERE ${cfg.table}.score < EXCLUDED.score
             RETURNING id`;
        const upsertParams = cfg.hasHolder
          ? [s.scope_id, c.user_id, c.gender, c.height, c.dive_code, c.position, score, prevScore, eventId]
          : [s.scope_id,            c.gender, c.height, c.dive_code, c.position, score, prevScore, eventId];
        const upserted = await client.query(upsertSql, upsertParams);
        // Zero rows = the guarded conflict-update was skipped: a
        // concurrent first-time check committed an equal-or-better
        // record between our FOR UPDATE read and this write. Thier
        // record stands, this dive broke nothing in this scope.
        if (upserted.rowCount === 0) continue;

        broken.push({
          scope:        s.scope,
          scope_id:     s.scope_id,
          scope_name:   s.scope_name,
          scope_code:   s.scope_code,
          official:     s.official,
          gender:       c.gender,
          height:       c.height,
          dive_code:    c.dive_code,
          position:     c.position,
          score,
          holder_id:    c.user_id,
          holder_name:  c.holder_name,
          prev_score:   prevScore,
          prev_holder_name: prev ? prev.holder_name : null,
          event_id:     eventId,
          round_number: Number(roundNumber),
        });
      }
      await client.query("COMMIT");
      return broken;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Records Check Error]", err.message);
      return [];
    } finally {
      client.release();
    }
  }

  // Public read endpoint. Wire format intentionally mirrors the
  // pre-migration-019 polymorphic shape: every row carries a
  // string `scope` discriminator and a generic `scope_id` (mapped
  // from user_id / club_id / org_id depending on the source
  // table). Existing clients (ScoreboardView, profile pages) keep
  // working without changes.
  const router = express.Router();
  router.get("/api/records", verifyToken, async (req, res) => {
    try {
      const scope    = req.query.scope || null;
      const scopeId  = req.query.scope_id || null;
      const eventId  = req.query.event_id || null;
      if (!scopeId && !eventId) {
        return res.status(400).json({ error: "Pass scope+scope_id or event_id" });
      }
      const VALID_RECORD_SCOPES = new Set(["personal", "club", "region", "federation", "continental"]);
      if (scope != null && !VALID_RECORD_SCOPES.has(scope)) {
        return res.status(400).json({
          error: `Invalid scope. Valid: ${[...VALID_RECORD_SCOPES].join(", ")}.`,
        });
      }
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const CONTINENT_RE = /^(africa|americas|asia|europe|oceania)$/;
      // Continental scope_id is a continent string, not a UUID, so
      // we accept both forms but validate strictly. Other scopes
      // require UUIDs as before.
      if (scopeId) {
        if (scope === "continental") {
          if (!CONTINENT_RE.test(scopeId)) {
            return res.status(400).json({
              error: "scope_id for 'continental' must be one of: africa, americas, asia, europe, oceania",
            });
          }
        } else if (!UUID_RE.test(scopeId)) {
          return res.status(400).json({ error: "scope_id must be a UUID" });
        }
      }
      if (eventId && !UUID_RE.test(eventId)) {
        return res.status(400).json({ error: "event_id must be a UUID" });
      }
      // scope_id is cast to text in every branch's PROJECTION so
      // the UNION can mix UUID-keyed scopes (personal / club /
      // federation) with the text-keyed continental scope. The
      // FILTERS compare natively per branch: uuid-keyed branches
      // bind $4 (the scope_id re-bound as uuid, NULL when it
      // isn't one) so their uuid indexes stay usable; only the
      // continental branch compares $2 as text. Validation above
      // guarantees a non-uuid scope_id only occurs with
      // scope = 'continental', where the uuid branches are
      // already excluded by the $1 scope predicate.
      const scopeIdUuid = scopeId && UUID_RE.test(scopeId) ? scopeId : null;
      const r = await pool.query(
        `SELECT id, scope, scope_id, height, dive_code, position, score, set_at,
                holder_id, holder_name, event_id, event_name, official
         FROM (
           SELECT rp.id,
                  'personal'::text       AS scope,
                  rp.user_id::text       AS scope_id,
                  rp.height::text        AS height,
                  rp.dive_code,
                  rp.position::text      AS position,
                  rp.score,
                  rp.set_at,
                  rp.user_id             AS holder_id,
                  h.full_name            AS holder_name,
                  rp.event_id,
                  e.name                 AS event_name,
                  TRUE                   AS official
           FROM records_personal rp
           LEFT JOIN users  h ON h.id = rp.user_id
           LEFT JOIN events e ON e.id = rp.event_id
           WHERE ($1::text IS NULL OR $1 = 'personal')
             AND ($4::uuid IS NULL OR rp.user_id = $4::uuid)
             AND ($3::uuid IS NULL OR rp.event_id = $3::uuid)

           UNION ALL

           SELECT rc.id,
                  'club'::text           AS scope,
                  rc.club_id::text       AS scope_id,
                  rc.height::text        AS height,
                  rc.dive_code,
                  rc.position::text      AS position,
                  rc.score,
                  rc.set_at,
                  rc.holder_id,
                  h.full_name            AS holder_name,
                  rc.event_id,
                  e.name                 AS event_name,
                  TRUE                   AS official
           FROM records_club rc
           LEFT JOIN users  h ON h.id = rc.holder_id
           LEFT JOIN events e ON e.id = rc.event_id
           WHERE ($1::text IS NULL OR $1 = 'club')
             AND ($4::uuid IS NULL OR rc.club_id = $4::uuid)
             AND ($3::uuid IS NULL OR rc.event_id = $3::uuid)

           UNION ALL

           SELECT rr.id,
                  'region'::text         AS scope,
                  rr.region_id::text     AS scope_id,
                  rr.height::text        AS height,
                  rr.dive_code,
                  rr.position::text      AS position,
                  rr.score,
                  rr.set_at,
                  rr.holder_id,
                  h.full_name            AS holder_name,
                  rr.event_id,
                  e.name                 AS event_name,
                  -- Same idea one level down: unofficial until a state
                  -- body has claimed the region.
                  rgn.claim_state = 'claimed' AS official
           FROM records_region rr
           JOIN regions rgn ON rgn.id = rr.region_id
           LEFT JOIN users  h ON h.id = rr.holder_id
           LEFT JOIN events e ON e.id = rr.event_id
           WHERE ($1::text IS NULL OR $1 = 'region')
             AND ($4::uuid IS NULL OR rr.region_id = $4::uuid)
             AND ($3::uuid IS NULL OR rr.event_id = $3::uuid)

           UNION ALL

           SELECT rf.id,
                  'federation'::text     AS scope,
                  rf.org_id::text        AS scope_id,
                  rf.height::text        AS height,
                  rf.dive_code,
                  rf.position::text      AS position,
                  rf.score,
                  rf.set_at,
                  rf.holder_id,
                  h.full_name            AS holder_name,
                  rf.event_id,
                  e.name                 AS event_name,
                  /* Phase 4: a country the clubs started has no
                     federation to ratify its national records yet, so
                     they read as unofficial until it's claimed. */
                  (SELECT fo.claim_state = 'claimed' FROM organisations fo WHERE fo.id = rf.org_id) AS official
           FROM records_federation rf
           LEFT JOIN users  h ON h.id = rf.holder_id
           LEFT JOIN events e ON e.id = rf.event_id
           WHERE ($1::text IS NULL OR $1 = 'federation')
             AND ($4::uuid IS NULL OR rf.org_id = $4::uuid)
             AND ($3::uuid IS NULL OR rf.event_id = $3::uuid)

           UNION ALL

           SELECT rk.id,
                  'continental'::text    AS scope,
                  rk.continent           AS scope_id,
                  rk.height::text        AS height,
                  rk.dive_code,
                  rk.position::text      AS position,
                  rk.score,
                  rk.set_at,
                  rk.holder_id,
                  h.full_name            AS holder_name,
                  rk.event_id,
                  e.name                 AS event_name,
                  TRUE                   AS official
           FROM records_continental rk
           LEFT JOIN users  h ON h.id = rk.holder_id
           LEFT JOIN events e ON e.id = rk.event_id
           WHERE ($1::text IS NULL OR $1 = 'continental')
             AND ($2::text IS NULL OR rk.continent = $2)
             AND ($3::uuid IS NULL OR rk.event_id = $3::uuid)
         ) all_records
         ORDER BY height, dive_code, position`,
        [scope, scopeId, eventId, scopeIdUuid],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Records List Error]", err.message);
      res.status(500).json([]);
    }
  });

  return { checkAndApplyRecords, router };
};

// Check a dive that may just have completed and tell the event room
// about anything it set. Both ways a score reaches the database (a
// judge's socket submit_score, the Control Room's manual entry) finish
// through here, so the two can't drift apart on what gets announced.
// Never throws: a records hiccup mustn't fail the score that caused it.
async function announceRecords({ checkAndApplyRecords, io, eventId, competitorId, roundNumber }) {
  try {
    const broken = await checkAndApplyRecords({ eventId, competitorId, roundNumber });
    for (const b of broken) io.to(`event:${eventId}`).emit("record_broken", b);
    return broken;
  } catch (err) {
    console.error("[Records broadcast]", err.message);
    return [];
  }
}

// scripts/rebuild-records.js replays the books with the same table map.
module.exports.RECORD_TABLES = RECORD_TABLES;
module.exports.announceRecords = announceRecords;
