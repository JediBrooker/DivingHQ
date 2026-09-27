// The 'Administration' org that init.sql seeds to hold the sysadmin.
//
// It's status 'active' (the sysadmin has to be able to log in), which
// means any query that lists "active orgs" picks it up too. Nobody from
// the public should ever register into it, so the public-facing lists
// and the register handler filter it out by this id. The reset scripts
// under scripts/ hardcode the same uuid as BOOTSTRAP_ORG.
const ADMIN_ORG_ID = "00000000-0000-0000-0000-000000000001";

module.exports = { ADMIN_ORG_ID };
