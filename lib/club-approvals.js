// Federation approval of new clubs (migration 096,
// docs/club-first-onboarding.md §20).
//
// Where a real federation runs the country (claim_state 'claimed'), a club
// somebody founds at signup starts out pending. It stays out of every club
// picker, can't host a meet, can't be paid for and can't be given an admin
// until the federation's org admin (or DivingHQ) approves it. The founder
// can sign in and dive meanwhile, they just don't run anything yet.
//
// Rules in one place, same idea as lib/claims.js and lib/role-requests.js:
//
//   needsApproval    claimed org, and "join automatically" is off. An
//                    unclaimed country has nobody to ask, so its clubs join
//                    straight away (and the founder runs theirs).
//   submitForUser    the founder verified their email, so tell the
//                    federation. Until then the club sits unseen, same rule
//                    claims use: a throwaway address never reaches anyone.
//   approve          optionally fixing the name, code and region first, and
//                    by default making the founder the club's admin.
//   reject           deletes the club (the audit log keeps the history) and
//                    can move its members into a club that already exists.
//   activateAllPending
//                    a revoked claim hands the country back to its clubs,
//                    so anything still waiting joins the way it would have.
//
// Only an org admin of the club's own org, or the sysadmin, decides. The
// routes put requireOrgAdmin in front, but that lets any org's admin
// through, so the org match is checked again here.
//
// Every notice goes out in-app and by email through lib/notices.js, in
// English like the other admin notices.

const { recordAudit } = require("./audit");
const notices = require("./notices");
const { supportContact } = require("./support");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Letters in any script, digits and dashes. Eight is what signup allows for
// a new club's code and about what fits in a scoreboard chip. The club
// setup route checks codes against the same thing.
const CLUB_CODE_RE = /^[\p{L}\p{N}-]{1,8}$/u;
const NAME_MAX = 80;
const REASON_MAX = 1000;

// A pending club the federation gets to see: the founder has verified
// their email (or there's no founder on record any more). The e2e suite
// verifies by writing email_verified_at directly, and an admin can verify
// someone by hand, so this reads the column rather than trusting
// submitted_at, which only says the notice went out. `c` is whatever the
// caller aliased clubs as.
function visiblePendingSql(c = "c") {
  return `(${c}.created_by IS NULL OR EXISTS (
    SELECT 1 FROM users vf WHERE vf.id = ${c}.created_by AND vf.email_verified_at IS NOT NULL))`;
}

class ClubApprovalError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One rule for a club's code wherever it's set (signup, club setup, the
// approve dialog, the federation's Clubs screen): trimmed, upper case, up
// to eight letters, digits or dashes. Blank means no code. Anything else is
// refused, not trimmed to fit, so "MELBOURNE" doesn't quietly become
// "MELBOURN".
function normaliseClubCode(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ClubApprovalError(400, "short_code must be a string or null");
  const code = raw.trim().toUpperCase();
  if (!code) return null;
  if (!CLUB_CODE_RE.test(code)) {
    throw new ClubApprovalError(400, "Use up to 8 letters, numbers or dashes", "bad_short_code");
  }
  return code;
}

// Refuse a code another approved club in the org already shows: two clubs
// with one label makes the label useless. Waiting clubs don't count, two
// founders from one real club often pick the same code and one of them is
// getting rejected (approval checks again). Check-then-write, so the
// per-org advisory lock serialises every path that sets a code; run it in
// the transaction that does the write. Not a unique index because live
// data already holds duplicates from before any check existed.
async function assertCodeFree(client, orgId, code, exceptId = null) {
  if (!code) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`club-short-code:${orgId}`]);
  const clash = await client.query(
    `SELECT 1 FROM clubs
      WHERE org_id = $1 AND status = 'active' AND upper(short_code) = upper($2)
        AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [orgId, code, exceptId],
  );
  if (clash.rows.length) {
    throw new ClubApprovalError(409, "Another club already uses that code", "short_code_taken");
  }
}

function needsApproval(org) {
  return !!org && org.claim_state === "claimed" && !org.auto_approve_clubs;
}

function canDecide(user, orgId) {
  if (!user) return false;
  if (user.is_system_admin) return true;
  return (user.org_roles || []).includes("org_admin") && user.org_id === orgId;
}

// Who decides new clubs for an org: its live org admins. A claimed org
// that has somehow lost all of them would leave founders waiting on
// nobody, so the sysadmins hear instead.
async function reviewerIds(db, orgId) {
  const r = await db.query(
    `SELECT DISTINCT r.user_id
       FROM user_org_roles r JOIN users u ON u.id = r.user_id
      WHERE r.org_id = $1 AND r.role = 'org_admin'
        AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [orgId],
  );
  if (r.rows.length) return r.rows.map((row) => row.user_id);
  const sys = await db.query(
    "SELECT id FROM users WHERE is_system_admin = true AND deleted_at IS NULL",
  );
  return sys.rows.map((row) => row.id);
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function deliver(deps, notes) {
  return notices.deliver(deps || {}, notes, { path: "/clubs", tag: "club approvals" });
}

// The founder, if they're still around to hear about it.
async function liveFounder(db, userId) {
  if (!userId) return null;
  const r = await db.query(
    "SELECT id, full_name, username, email, club_id FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId],
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------

async function pendingNote(db, club) {
  const info = (await db.query(
    `SELECT o.name AS org_name, rg.name AS region_name,
            f.full_name, f.username, f.email
       FROM organisations o
       LEFT JOIN regions rg ON rg.id = $2
       LEFT JOIN users f ON f.id = $3
      WHERE o.id = $1`,
    [club.org_id, club.region_id || null, club.created_by || null],
  )).rows[0] || {};
  const who = info.full_name || "Someone";
  const lines = [
    `${who}${info.username ? ` (@${info.username}${info.email ? `, ${info.email}` : ""})` : ""} has started a new club on DivingHQ and asked to join ${info.org_name || "your federation"}.`,
    "",
    `Club: ${club.name}`,
    `Code: ${club.short_code || "none given"}`,
  ];
  if (info.region_name) lines.push(`Region: ${info.region_name}`);
  lines.push(
    "",
    "Until you decide, the club is hidden from everyone else's club lists and can't host meets. "
      + "On the Clubs page you can approve it (fixing the name, code or region first if they need it, "
      + `and making ${who} its admin) or reject it, which can move its members into a club you already have.`,
    "",
    "If you'd rather new clubs joined straight away, switch \"New clubs from signup\" to join automatically on the same page.",
  );
  return {
    userIds: await reviewerIds(db, club.org_id),
    category: "club_pending",
    title: `New club waiting for approval: ${club.name}`,
    body: `Started by ${who}. Approve or reject it on Clubs.`,
    action_url: "/clubs",
    data: { club_id: club.id, org_id: club.org_id },
    email: { subject: `New club waiting for your approval: ${club.name}`, body: lines.join("\n") },
  };
}

// Called once the founder's email is verified (verify-email, and a
// password reset, which proves the inbox as well). Stamping submitted_at
// in the same statement that picks the clubs is what keeps a double click
// from sending the federation two notices. Returns how many went out.
async function submitForUser(pool, userId, deps = {}) {
  if (!userId) return 0;
  const r = await pool.query(
    `UPDATE clubs c SET submitted_at = now()
       FROM users u
      WHERE c.created_by = $1 AND u.id = c.created_by
        AND u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL
        AND c.status = 'pending' AND c.submitted_at IS NULL
      RETURNING c.id, c.org_id, c.name, c.short_code, c.region_id, c.created_by`,
    [userId],
  );
  if (!r.rows.length) return 0;
  const notes = [];
  for (const club of r.rows) notes.push(await pendingNote(pool, club));
  await deliver(deps, notes);
  return r.rows.length;
}

// With "join automatically" on, the club is live as soon as it's created
// and nobody approves anything, so the federation just gets a heads-up in
// the app (no email) and can appoint an admin from Clubs if it wants one.
async function announceAutoJoin(pool, { clubId }, deps = {}) {
  const c = (await pool.query(
    `SELECT c.id, c.org_id, c.name, f.full_name
       FROM clubs c LEFT JOIN users f ON f.id = c.created_by
      WHERE c.id = $1`,
    [clubId],
  )).rows[0];
  if (!c) return;
  await deliver(deps, [{
    userIds: await reviewerIds(pool, c.org_id),
    category: "club_created",
    title: `New club joined: ${c.name}`,
    body: `Started by ${c.full_name || "someone"}. New clubs join automatically, so it's already live. `
      + "Appoint its admins from Clubs.",
    action_url: "/clubs",
    data: { club_id: c.id, org_id: c.org_id },
    email: false,
  }]);
}

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------

// Pending clubs waiting on this user, for the dashboard. The sysadmin
// sees every org's; an org admin their own; nobody else any.
async function countForUser(db, user) {
  if (!user) return 0;
  const isSys = !!user.is_system_admin;
  if (!isSys && !(user.org_roles || []).includes("org_admin")) return 0;
  const r = await db.query(
    `SELECT count(*)::int AS n FROM clubs c
      WHERE c.status = 'pending' AND ($1::boolean OR c.org_id = $2)
        AND ${visiblePendingSql("c")}`,
    [isSys, user.org_id || null],
  );
  return r.rows[0].n;
}

// The club this founder started that's still waiting, for the dashboard
// and My profile: { id, name, org_name } or null. Rides on the session
// body like club_admin_of, never the JWT, since approval can land at any
// time.
async function pendingClubFor(db, userId) {
  if (!userId) return null;
  const r = await db.query(
    `SELECT c.id, c.name, o.name AS org_name
       FROM clubs c JOIN organisations o ON o.id = c.org_id
      WHERE c.created_by = $1 AND c.status = 'pending'
      ORDER BY c.created_at DESC
      LIMIT 1`,
    [userId],
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------

// Lock the club for the rest of the transaction, so two admins deciding at
// once can't both win: the second one waits here, then finds it isn't
// pending any more.
async function lockPending(client, clubId, user) {
  if (!UUID_RE.test(String(clubId || ""))) throw new ClubApprovalError(404, "Club not found");
  const r = await client.query(
    `SELECT c.id, c.org_id, c.name, c.short_code, c.region_id, c.status, c.created_by,
            o.name AS org_name
       FROM clubs c JOIN organisations o ON o.id = c.org_id
      WHERE c.id = $1
      FOR UPDATE OF c`,
    [clubId],
  );
  const club = r.rows[0];
  if (!club) {
    // A reject deletes the row, so whoever was queued behind it on the
    // lock finds nothing at all and used to get a 404, which reads like a
    // bad link rather than "someone else just decided this". Only for
    // people who could have decided it themselves; anyone else still
    // just gets not found.
    const gone = (await client.query(
      `SELECT org_id FROM audit_log
        WHERE entity_type = 'club' AND entity_id = $1 AND action = 'club.rejected'
        LIMIT 1`,
      [clubId],
    )).rows[0];
    if (gone && canDecide(user, gone.org_id)) {
      throw new ClubApprovalError(409, "This club has already been decided", "club_not_pending");
    }
    throw new ClubApprovalError(404, "Club not found");
  }
  if (!canDecide(user, club.org_id)) {
    throw new ClubApprovalError(403, "Only this club's federation can decide on it");
  }
  if (club.status !== "pending") {
    throw new ClubApprovalError(409, "This club has already been decided", "club_not_pending");
  }
  return club;
}

// edits: name, short_code, region_id, each only when the caller sent it
// (undefined leaves it alone, null clears the code or the region).
async function approve(pool, { clubId, user, name, shortCode, regionId, makeFounderAdmin = true, audit = {} }, deps = {}) {
  const out = await withTx(pool, async (client) => {
    const club = await lockPending(client, clubId, user);
    const edits = {};

    let newName = club.name;
    if (name !== undefined && name !== null) {
      const n = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
      if (!n) throw new ClubApprovalError(400, "Club name is required");
      if (n !== club.name) {
        edits.name = { from: club.name, to: n };
        newName = n;
      }
    }

    let newCode = club.short_code || null;
    if (shortCode !== undefined) {
      const code = normaliseClubCode(shortCode);
      if (code !== newCode) {
        edits.short_code = { from: newCode, to: code };
        newCode = code;
      }
    }
    // Same clash rule and lock as club setup, so an approval can't race a
    // setup save of the same code.
    await assertCodeFree(client, club.org_id, newCode, club.id);

    let newRegion = club.region_id || null;
    if (regionId !== undefined) {
      if (regionId !== null && !UUID_RE.test(String(regionId))) {
        throw new ClubApprovalError(400, "region_id must be a region id or null");
      }
      const rid = regionId === null ? null : String(regionId).toLowerCase();
      if (rid) {
        const rg = await client.query("SELECT 1 FROM regions WHERE id = $1 AND org_id = $2", [rid, club.org_id]);
        if (!rg.rows.length) throw new ClubApprovalError(400, "That region isn't in this club's organisation");
      }
      if (rid !== newRegion) {
        edits.region_id = { from: newRegion, to: rid };
        newRegion = rid;
      }
    }

    await client.query(
      `UPDATE clubs SET status = 'active', approved_at = now(), name = $2, short_code = $3, region_id = $4
        WHERE id = $1`,
      [club.id, newName, newCode, newRegion],
    );

    // Only while the founder is still in the club and still around. One
    // who has left, been suspended or deleted their account doesn't get to
    // run it just because they started it.
    const founder = await liveFounder(client, club.created_by);
    let founderAdmin = false;
    if (makeFounderAdmin !== false && founder) {
      const ins = await client.query(
        `INSERT INTO club_admins (club_id, user_id, org_id)
         SELECT $1, u.id, $3 FROM users u
          WHERE u.id = $2 AND u.club_id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL
         ON CONFLICT (club_id, user_id) DO NOTHING
         RETURNING id`,
        [club.id, founder.id, club.org_id],
      );
      founderAdmin = ins.rows.length > 0;
    }

    await recordAudit(client, {
      ...audit,
      actor_id: user.id,
      org_id: club.org_id,
      entity_type: "club",
      entity_id: club.id,
      entity_name: newName,
      action: "club.approved",
      metadata: { edits, founder_id: club.created_by || null, founder_admin: founderAdmin },
    });

    const notes = [];
    if (founder) {
      const next = founderAdmin
        ? `You're its admin: sign out and back in, then open My club to invite your members and set up your first meet.`
        : `${club.org_name} appoints club admins, so they'll set that up with you.`;
      const renamed = edits.name ? ` They listed it as ${newName}.` : "";
      notes.push({
        userIds: [founder.id],
        category: "club_decision",
        title: `${club.org_name} approved ${newName}`,
        body: founderAdmin ? "You're its admin. Sign in again and open My club." : `${club.org_name} appoints its admins.`,
        action_url: founderAdmin ? "/club" : "/dashboard",
        data: { club_id: club.id },
        email: {
          subject: `${newName} is on DivingHQ`,
          body: `${club.org_name} has approved the club you started, so it's live on DivingHQ now and your members can pick it when they sign up.${renamed}\n\n${next}`,
        },
      });
    }
    return {
      notes,
      result: {
        id: club.id, name: newName, short_code: newCode, region_id: newRegion,
        status: "active", founder_admin: founderAdmin,
      },
    };
  });
  await deliver(deps, out.notes);
  return out.result;
}

async function reject(pool, { clubId, user, reason, moveMembersTo, audit = {} }, deps = {}) {
  if (reason != null && typeof reason !== "string") throw new ClubApprovalError(400, "reason must be text");
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, REASON_MAX) : null;
  const moveTo = moveMembersTo == null || moveMembersTo === "" ? null : String(moveMembersTo).toLowerCase();
  if (moveTo && !UUID_RE.test(moveTo)) throw new ClubApprovalError(400, "move_members_to must be a club id");

  const out = await withTx(pool, async (client) => {
    const club = await lockPending(client, clubId, user);
    let target = null;
    if (moveTo) {
      target = (await client.query(
        "SELECT id, name FROM clubs WHERE id = $1 AND org_id = $2 AND status = 'active'",
        [moveTo, club.org_id],
      )).rows[0];
      if (!target) {
        throw new ClubApprovalError(400, "Move them to an approved club in the same organisation", "bad_move_target");
      }
    }
    const members = (await client.query(
      "SELECT count(*)::int AS n FROM users WHERE club_id = $1 AND deleted_at IS NULL", [club.id],
    )).rows[0].n;
    if (target) {
      await client.query("UPDATE users SET club_id = $2 WHERE club_id = $1", [club.id, target.id]);
    }
    // Everything else pointing at the club is SET NULL or goes with it,
    // apart from payments, which RESTRICT. A pending club can't be paid
    // for, so this shouldn't happen, but a 409 beats a 500 if it does.
    try {
      await client.query("DELETE FROM clubs WHERE id = $1", [club.id]);
    } catch (err) {
      if (err.code === "23503") {
        throw new ClubApprovalError(
          409,
          `This club has payments on record, so it can't be deleted. Contact ${supportContact()}.`,
          "club_has_payments",
        );
      }
      throw err;
    }
    await recordAudit(client, {
      ...audit,
      actor_id: user.id,
      org_id: club.org_id,
      entity_type: "club",
      entity_id: club.id,
      entity_name: club.name,
      action: "club.rejected",
      note: why,
      metadata: {
        name: club.name,
        short_code: club.short_code || null,
        founder_id: club.created_by || null,
        reason: why,
        moved_to: target ? target.id : null,
        members,
      },
    });

    const founder = await liveFounder(client, club.created_by);
    const notes = [];
    if (founder) {
      const where = target
        ? `We've put you in ${target.name} instead, so you're a member there now.`
        : `Your account is still active, just without a club. If your club is already on DivingHQ, ask to join it from your profile (Change club).`;
      notes.push({
        userIds: [founder.id],
        category: "club_decision",
        title: `${club.org_name} didn't approve ${club.name}`,
        body: why || (target ? `You're now in ${target.name}.` : "Your account is still active."),
        action_url: "/profile",
        data: { club_id: club.id, moved_to: target ? target.id : null },
        email: {
          subject: `${club.name} wasn't approved`,
          body: `${club.org_name} decided not to add ${club.name} to DivingHQ.`
            + (why ? `\n\nThe reason they gave: ${why}` : "")
            + `\n\n${where}\n\nIf you think this is a mistake, reply to this email or contact ${supportContact()}.`,
        },
      });
    }
    return { notes, result: { id: club.id, moved_to: target ? target.id : null, members } };
  });
  await deliver(deps, out.notes);
  return out.result;
}

// A revoked national claim hands the country back to its clubs
// (lib/claims.js unwindOrgClaim), and an unclaimed country approves
// nothing, so whatever was still waiting becomes a club the way it would
// have been there: active, with its founder as admin. Runs inside the
// revoke's transaction; the notes go out after it commits.
async function activateAllPending(client, orgId, { actorId = null } = {}) {
  const clubs = (await client.query(
    `UPDATE clubs SET status = 'active', approved_at = now()
      WHERE org_id = $1 AND status = 'pending'
      RETURNING id, name, created_by`,
    [orgId],
  )).rows;
  const notes = [];
  for (const c of clubs) {
    const founder = await liveFounder(client, c.created_by);
    let founderAdmin = false;
    if (founder && founder.club_id === c.id) {
      // Same bar approve() sets: a suspended founder doesn't get the seat.
      const ins = await client.query(
        `INSERT INTO club_admins (club_id, user_id, org_id)
         SELECT $1, u.id, $3 FROM users u
          WHERE u.id = $2 AND u.suspended_at IS NULL
         ON CONFLICT (club_id, user_id) DO NOTHING RETURNING id`,
        [c.id, founder.id, orgId],
      );
      founderAdmin = ins.rows.length > 0;
    }
    await recordAudit(client, {
      actor_id: actorId,
      org_id: orgId,
      entity_type: "club",
      entity_id: c.id,
      entity_name: c.name,
      action: "club.approved",
      metadata: { via: "claim_revoked", founder_id: c.created_by || null, founder_admin: founderAdmin },
    });
    if (founder) {
      notes.push({
        userIds: [founder.id],
        category: "club_decision",
        title: `${c.name} is active on DivingHQ`,
        body: founderAdmin ? "You're its admin. Sign in again and open My club." : "Your club no longer needs a federation's approval.",
        action_url: founderAdmin ? "/club" : "/dashboard",
        data: { club_id: c.id },
        email: {
          subject: `${c.name} is active on DivingHQ`,
          body: "The federation your club was waiting on no longer runs the country on DivingHQ, so clubs there "
            + `join without anyone's approval. ${c.name} is live now`
            + (founderAdmin
              ? ", and you're its admin: sign out and back in, then open My club."
              : "."),
        },
      });
    }
  }
  return { clubs, notes };
}

// ---------------------------------------------------------------------
// The federation's setting
// ---------------------------------------------------------------------

async function getSettings(db, orgId) {
  if (!UUID_RE.test(String(orgId || ""))) return null;
  const r = await db.query(
    "SELECT id, claim_state, auto_approve_clubs FROM organisations WHERE id = $1", [orgId],
  );
  return r.rows[0] || null;
}

async function setAutoApprove(db, { orgId, user, value, audit = {} }) {
  if (typeof value !== "boolean") throw new ClubApprovalError(400, "auto_approve_clubs must be true or false");
  const org = await getSettings(db, orgId);
  if (!org) throw new ClubApprovalError(404, "Organisation not found");
  if (!canDecide(user, org.id)) throw new ClubApprovalError(403, "Only this organisation's admins can change that");
  if (org.claim_state !== "claimed") {
    throw new ClubApprovalError(
      409,
      "Clubs in a country without a federation on DivingHQ always join straight away",
      "org_unclaimed",
    );
  }
  if (org.auto_approve_clubs !== value) {
    await db.query("UPDATE organisations SET auto_approve_clubs = $2 WHERE id = $1", [org.id, value]);
    await recordAudit(db, {
      ...audit,
      actor_id: user.id,
      org_id: org.id,
      entity_type: "org",
      entity_id: org.id,
      action: "org.club_settings_changed",
      metadata: { auto_approve_clubs: { from: org.auto_approve_clubs, to: value } },
    });
  }
  // Clubs already waiting stay waiting: switching this on isn't a way to
  // approve a queue nobody has looked at.
  return { auto_approve_clubs: value, claim_state: org.claim_state };
}

module.exports = {
  ClubApprovalError,
  CLUB_CODE_RE,
  normaliseClubCode,
  assertCodeFree,
  visiblePendingSql,
  needsApproval,
  canDecide,
  reviewerIds,
  submitForUser,
  announceAutoJoin,
  countForUser,
  pendingClubFor,
  approve,
  reject,
  activateAllPending,
  deliver,
  getSettings,
  setAutoApprove,
};
