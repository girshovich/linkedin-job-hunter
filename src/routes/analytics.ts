/**
 * Analytics Route — per-group stats, per-country breakdown, weekly trend.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchGroupRow } from '../db';

const router = Router();

// Same country-extraction logic as jobs.ts
const AGGREGATES = new Set([
  'emea', 'european union', 'european economic area', 'eea',
  'eu', 'worldwide', 'global', 'international', 'apac', 'latam',
  'mena', 'dach', 'benelux', 'cee', 'anz',
]);
const REGION_TO_COUNTRY: Record<string, string> = {
  'greater london metropolitan area': 'United Kingdom',
  'greater london': 'United Kingdom',
  'greater manchester': 'United Kingdom',
  'greater barcelona metropolitan area': 'Spain',
  'greater madrid metropolitan area': 'Spain',
  'basque country': 'Spain',
  'catalonia': 'Spain',
  'community of madrid': 'Spain',
  'ile-de-france': 'France',
  'grand paris': 'France',
  'greater paris metropolitan area': 'France',
  'north holland': 'Netherlands',
  'greater amsterdam metropolitan area': 'Netherlands',
  'greater berlin metropolitan area': 'Germany',
  'bavaria': 'Germany',
  'flanders': 'Belgium',
  'wallonia': 'Belgium',
  'lombardy': 'Italy',
  'greater milan metropolitan area': 'Italy',
  'greater warsaw metropolitan area': 'Poland',
  'masovian voivodeship': 'Poland',
};

function extractCountry(location: string | null): string {
  if (!location) return 'Unknown';
  const trimmed = location.trim();
  if (!trimmed || trimmed.toLowerCase() === 'remote') return 'Remote';
  if (AGGREGATES.has(trimmed.toLowerCase())) return trimmed;
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return trimmed;
  if (AGGREGATES.has(last.toLowerCase())) return last;
  if (parts.length === 1) return REGION_TO_COUNTRY[last.toLowerCase()] ?? last;
  return last;
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  // Overall totals
  const totals = db.prepare<{ total: number; strong: number; applied: number }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
      SUM(CASE WHEN applied = 1 AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 THEN 1 ELSE 0 END) as applied
    FROM jobs WHERE profile_id = ?
  `).get(profileId) as { total: number; strong: number; applied: number };

  // Status breakdown (all verdicts as counts)
  interface StatusRow { status: string; count: number }
  const statusBreakdown = db.prepare<StatusRow>(`
    SELECT
      CASE WHEN is_duplicate = 1 THEN 'DUPLICATE'
           ELSE COALESCE(ai_verdict, 'UNKNOWN') END as status,
      COUNT(*) as count
    FROM jobs WHERE profile_id = ?
    GROUP BY status
    ORDER BY count DESC
  `).all(profileId) as StatusRow[];

  // Per-group stats (for this profile only)
  const groups = db.prepare<SearchGroupRow>('SELECT id, group_name FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as Pick<SearchGroupRow, 'id' | 'group_name'>[];

  interface GroupStat {
    group_id: number | null;
    total: number;
    strong: number;
    applied: number;
  }
  const groupRows = db.prepare<GroupStat>(`
    SELECT
      group_id,
      COUNT(*) as total,
      SUM(CASE WHEN ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
      SUM(CASE WHEN applied = 1 AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 THEN 1 ELSE 0 END) as applied
    FROM jobs WHERE profile_id = ?
    GROUP BY group_id
  `).all(profileId) as GroupStat[];

  const groupStatMap = new Map<number | null, GroupStat>();
  for (const row of groupRows) groupStatMap.set(row.group_id, row);

  const groupStats = groups.map((g) => {
    const s = groupStatMap.get(g.id) ?? { total: 0, strong: 0, applied: 0 };
    return { id: g.id, name: g.group_name || `Role ${g.id}`, ...s };
  });

  // Per-country stats (strong matches only, non-duplicate)
  interface JobLocationRow { location: string | null; applied: number }
  const allStrongJobs = db.prepare<JobLocationRow>(
    `SELECT location, applied FROM jobs WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0`,
  ).all(profileId) as JobLocationRow[];

  const countryMap = new Map<string, { strong: number; applied: number }>();
  for (const job of allStrongJobs) {
    const country = extractCountry(job.location);
    if (!countryMap.has(country)) countryMap.set(country, { strong: 0, applied: 0 });
    const entry = countryMap.get(country)!;
    entry.strong++;
    if (job.applied) entry.applied++;
  }
  const countryStats = Array.from(countryMap.entries())
    .map(([country, s]) => ({ country, ...s }))
    .sort((a, b) => b.strong - a.strong);

  // Daily trend — last 14 days, verdict breakdown per group (filtered client-side)
  interface DayVerdictRow { day: string; group_id: number | null; verdict: string; count: number }
  const dailyGroupRaw = db.prepare<DayVerdictRow>(`
    SELECT
      strftime('%Y-%m-%d', fetched_at) as day,
      group_id,
      CASE WHEN is_duplicate = 1 THEN 'DUPLICATE' ELSE ai_verdict END as verdict,
      COUNT(*) as count
    FROM jobs
    WHERE profile_id = ? AND date(fetched_at) >= date('now', '-13 days')
    GROUP BY day, group_id, verdict
    ORDER BY day
  `).all(profileId) as DayVerdictRow[];

  // Monthly trend — last 12 months, verdict breakdown per group (filtered client-side)
  interface MonthVerdictRow { month: string; group_id: number | null; verdict: string; count: number }
  const monthlyRaw = db.prepare<MonthVerdictRow>(`
    SELECT
      strftime('%Y-%m', fetched_at) as month,
      group_id,
      CASE WHEN is_duplicate = 1 THEN 'DUPLICATE' ELSE ai_verdict END as verdict,
      COUNT(*) as count
    FROM jobs
    WHERE profile_id = ? AND strftime('%Y-%m', fetched_at) >= strftime('%Y-%m', 'now', '-11 months')
    GROUP BY month, group_id, verdict
    ORDER BY month
  `).all(profileId) as MonthVerdictRow[];

  // Strong match quality — last 14 days
  interface StrongQualityRow { day: string; category: string; count: number }
  const strongQualityRaw = db.prepare<StrongQualityRow>(`
    SELECT
      strftime('%Y-%m-%d', fetched_at) as day,
      CASE
        WHEN ai_verdict = 'STRONG_MATCH' AND (original_ai_verdict = 'STRONG_MATCH' OR original_ai_verdict IS NULL) THEN 'kept'
        WHEN ai_verdict = 'STRONG_MATCH' AND original_ai_verdict != 'STRONG_MATCH' THEN 'promoted'
        WHEN ai_verdict != 'STRONG_MATCH' AND original_ai_verdict = 'STRONG_MATCH' THEN 'demoted'
        ELSE NULL
      END as category,
      COUNT(*) as count
    FROM jobs
    WHERE profile_id = ?
      AND is_duplicate = 0
      AND (ai_verdict = 'STRONG_MATCH' OR original_ai_verdict = 'STRONG_MATCH')
      AND date(fetched_at) >= date('now', '-13 days')
    GROUP BY day, category
    HAVING category IS NOT NULL
    ORDER BY day
  `).all(profileId) as StrongQualityRow[];

  res.render('analytics', {
    totals,
    statusBreakdown,
    groupStats,
    countryStats,
    dailyGroupRaw,
    monthlyRaw,
    strongQualityRaw,
    groups,
    title: 'Stats',
  });
});

export { router as analyticsRouter };
