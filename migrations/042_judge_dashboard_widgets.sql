-- 042_judge_dashboard_widgets.sql
--
-- Judge Analysis dashboard preferences: adds a per-user array of
-- widget IDs the judge wants surfaced on their /judge-profile page.
-- Mirrors the existing diver dashboard_widgets column (see migration
-- 015) but lives in its own slot so a user with both 'diver' and
-- 'judge' roles can keep two independent layouts.
--
-- Judge Analysis (analytics on a judge's own scoring history)
-- supports the WA-judging programme practice of post-event
-- self-evaluation against the panel-kept mean. See PART FOUR
-- Articles 7.9 (judge awards), 10 (judging dives), and 8.4.9
-- (Referee may remove a judge whose judgement is unsatisfactory,
-- and writes a report to the Jury of Appeal). Giving judges a
-- self-service "how am I tracking" view both supports their
-- individual development and gives meet officials evidence-based
-- feedback they can lean on. The numeric reference is the
-- panel-kept mean (post World Aquatics trim), computed from
-- calc_event_dive_points's intermediate trim. Same trim rules,
-- just exposed as a comparison point rather than a leaderboard
-- input.
--
-- Default catalogue picks the four most universally useful widgets
-- (bias_summary + deviation_distribution + height + recent_meets)
-- so a fresh judge has something to look at on their first visit.
-- The frontend WIDGET_CATALOG and the whitelist in
-- routes/judge-analytics.js are the source of truth for IDs, so a
-- typo here just gets normalised away on first save anyway.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS judge_dashboard_widgets jsonb
    DEFAULT '["bias_summary","deviation_distribution","height_breakdown","recent_meets"]'::jsonb;

COMMIT;
