// Migrations the previous release's code can't run against.
//
// deploy.sh migrates first and restarts PM2 only after the test suite has
// passed, so for that whole stretch the OLD process is serving against the
// NEW schema. That's fine for the usual additive migration (a new column
// the old code never reads). It is not fine for one that drops or reshapes
// something the old code writes through, and the old code won't say so:
// it just fails, logs, and carries on.
//
// List those here, with the reason. deploy.sh asks the runner
// (`npm run migrate -- --check-breaking`) before migrating and stops unless
// the operator has put the site in maintenance mode and passed
// --allow-breaking. A rollback past one of these doesn't work either,
// there's no down migration, so the failure message says roll forward.
//
// Not a place for every migration that touches data. Only ones where the
// code that's running right now would break.

const BREAKS_PREVIOUS_CODE = {
  94:
    "Replaces the records_* unique keys with ones that include gender. The previous "
    + "lib/records.js upserts with ON CONFLICT on the old four columns, so every record "
    + "it tries to write fails (logged as [Records Check Error]) until the restart. "
    + "Afterwards, `node scripts/rebuild-records.js --verbose` (a dry run) shows any "
    + "records set in that window as 'added'.",
};

// Which of these pending versions need the careful path, with why.
function breakingAmong(versions) {
  return versions
    .filter((v) => Object.prototype.hasOwnProperty.call(BREAKS_PREVIOUS_CODE, v))
    .map((v) => ({ version: v, reason: BREAKS_PREVIOUS_CODE[v] }));
}

module.exports = { BREAKS_PREVIOUS_CODE, breakingAmong };
