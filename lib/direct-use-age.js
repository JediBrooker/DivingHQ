// Direct account use is 13+. Competition eligibility is a separate concern:
// adult-managed junior records must remain available to authorised officials.
const MINIMUM_DIRECT_USE_AGE = 13;
const AGE_RESTRICTION = {
  error: "DivingHQ accounts are for people aged 13 and older. Contact support@divinghq.app if your date of birth needs correcting.",
  code: "minimum_age",
};

// Callers select PostgreSQL DATE values as YYYY-MM-DD text. Compare calendar
// dates in UTC, not elapsed milliseconds (which drifts at birthdays/leap years).
// A missing DOB isn't evidence of age; signup uses an explicit declaration.
function isKnownUnderMinimumAge(dateOfBirth, now = new Date()) {
  if (typeof dateOfBirth !== "string" || !dateOfBirth) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return false;
  const parsed = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOfBirth) return false;
  const year = now.getUTCFullYear() - MINIMUM_DIRECT_USE_AGE;
  const cutoff = `${year}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return dateOfBirth > cutoff;
}

function requireAgeDeclaration(req, res, next) {
  if (req.body?.age_13_or_older !== true) {
    return res.status(400).json({
      error: "Confirm that you are 13 or older to create an account. If your app has no age confirmation, update it or register at https://divinghq.app/register.",
      code: "age_confirmation_required",
    });
  }
  next();
}

module.exports = { MINIMUM_DIRECT_USE_AGE, AGE_RESTRICTION, isKnownUnderMinimumAge, requireAgeDeclaration };
