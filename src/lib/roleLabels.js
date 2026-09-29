// The one line under someone's name saying what they do here: the sidebar
// footer and the dashboard header.
//
// It used to be org_roles alone. A club admin in a country with no
// federation yet holds no org role, only a club_admins row, so the line
// said "Spectator" for the person running the meet. And since every
// signup gets 'spectator', a referee read "Referee · Spectator".
// Club and region admin come off the session fields (club_admin_of /
// region_admin_of), which the server builds for the SPA and never trusts
// back. 'spectator' only shows when there's nothing else to say.

const ORG_ROLE_KEYS = {
  org_admin: 'user_manager.role_org_admin',
  meet_manager: 'user_manager.role_meet_manager',
  referee: 'user_manager.role_referee',
  judge: 'user_manager.role_judge',
  coach: 'user_manager.role_coach',
  diver: 'user_manager.role_diver',
}

// `t` is vue-i18n's (or a stand-in in tests). Returns the labels in the
// order the server listed the roles, club and region admin after them.
// A role we don't have a name for shows as it is rather than vanishing.
export function roleLabels(user, t) {
  const roles = Array.isArray(user?.org_roles) ? user.org_roles : []
  const out = []
  for (const r of roles) {
    if (r === 'spectator') continue
    out.push(ORG_ROLE_KEYS[r] ? t(ORG_ROLE_KEYS[r]) : r)
  }
  if (Array.isArray(user?.club_admin_of) && user.club_admin_of.length) {
    out.push(t('guide.role.club_admin.name'))
  }
  if (Array.isArray(user?.region_admin_of) && user.region_admin_of.length) {
    out.push(t('guide.role.region_admin.name'))
  }
  if (!out.length && roles.includes('spectator')) out.push(t('user_manager.role_spectator'))
  return out
}
