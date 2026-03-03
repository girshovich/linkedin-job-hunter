/**
 * Jobs Match Route — All curated (STRONG_MATCH, non-duplicate) jobs grouped by country.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobRow } from '../db';

const router = Router();

// Regional aggregates — keep verbatim instead of treating as city/country
const AGGREGATES = new Set([
  'emea', 'european union', 'european economic area', 'eea',
  'eu', 'worldwide', 'global', 'international', 'apac', 'latam',
  'mena', 'dach', 'benelux', 'cee', 'anz',
]);

// Sub-national regions / metro areas LinkedIn uses that are not country names
const REGION_TO_COUNTRY: Record<string, string> = {
  'greater london metropolitan area':     'United Kingdom',
  'greater london':                        'United Kingdom',
  'greater manchester':                    'United Kingdom',
  'greater barcelona metropolitan area':   'Spain',
  'greater madrid metropolitan area':      'Spain',
  'basque country':                        'Spain',
  'catalonia':                             'Spain',
  'community of madrid':                   'Spain',
  'ile-de-france':                         'France',
  'grand paris':                           'France',
  'greater paris metropolitan area':       'France',
  'north holland':                         'Netherlands',
  'greater amsterdam metropolitan area':   'Netherlands',
  'greater berlin metropolitan area':      'Germany',
  'bavaria':                               'Germany',
  'flanders':                              'Belgium',
  'wallonia':                              'Belgium',
  'lombardy':                              'Italy',
  'greater milan metropolitan area':       'Italy',
  'greater warsaw metropolitan area':      'Poland',
  'masovian voivodeship':                  'Poland',
};

function extractCountry(location: string | null): string {
  if (!location) return 'Remote / Unknown';
  const trimmed = location.trim();
  if (!trimmed || trimmed.toLowerCase() === 'remote') return 'Remote / Unknown';

  // Whole string is an aggregate
  if (AGGREGATES.has(trimmed.toLowerCase())) return trimmed;

  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return trimmed;

  // Last segment is an aggregate
  if (AGGREGATES.has(last.toLowerCase())) return last;

  // Single-part location: check if it's a known sub-national region/metro area
  if (parts.length === 1) {
    return REGION_TO_COUNTRY[last.toLowerCase()] ?? last;
  }

  // Multi-part: last segment is typically the country (LinkedIn format: City, Region, Country)
  return last;
}

interface LocationGroup {
  location: string;
  jobs: JobRow[];
}

interface DateGroup {
  label: string;
  jobs: JobRow[];
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();

  // Active tab from ?group=<id|'others'>
  const groupParam = String(req.query.group || 'all');
  const activeOthers = groupParam === 'others';
  const activeGroupId = !activeOthers && groupParam !== 'all'
    ? parseInt(groupParam, 10) : null;

  // Tabs: groups that have at least one STRONG_MATCH job
  const tabGroups = db.prepare(`
    SELECT sg.id, sg.group_name, COUNT(j.id) as job_count
    FROM search_groups sg
    INNER JOIN jobs j ON j.group_id = sg.id
    WHERE j.ai_verdict = 'STRONG_MATCH' AND j.is_duplicate = 0
    GROUP BY sg.id ORDER BY sg.id ASC
  `).all() as Array<{ id: number; group_name: string; job_count: number }>;

  // "Others" tab: orphaned jobs whose group has been deleted
  const orphanCount = (db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
    AND (group_id IS NULL OR group_id NOT IN (SELECT id FROM search_groups))
  `).get() as { c: number }).c;

  const jobs = (activeGroupId
    ? db.prepare(
        `SELECT * FROM jobs
         WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 AND group_id = ?
         ORDER BY DATE(fetched_at) DESC, ai_score DESC`,
      ).all(activeGroupId)
    : activeOthers
    ? db.prepare(
        `SELECT * FROM jobs
         WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
         AND (group_id IS NULL OR group_id NOT IN (SELECT id FROM search_groups))
         ORDER BY DATE(fetched_at) DESC, ai_score DESC`,
      ).all()
    : db.prepare(
        `SELECT * FROM jobs
         WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
         ORDER BY DATE(fetched_at) DESC, ai_score DESC`,
      ).all()
  ) as JobRow[];

  // Location grouping
  const countryMap = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const country = extractCountry(job.location);
    if (!countryMap.has(country)) countryMap.set(country, []);
    countryMap.get(country)!.push(job);
  }

  const locationGroups: LocationGroup[] = Array.from(countryMap.entries())
    .sort(([a], [b]) => {
      if (a === 'Remote / Unknown') return 1;
      if (b === 'Remote / Unknown') return -1;
      return a.localeCompare(b);
    })
    .map(([location, groupJobs]) => ({ location, jobs: groupJobs }));

  // Date grouping — newest date first, jobs within each date sorted by score (preserved from query)
  const dateMap = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const key = job.fetched_at ? String(job.fetched_at).slice(0, 10) : 'Unknown';
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key)!.push(job);
  }

  const dateGroups: DateGroup[] = Array.from(dateMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupJobs]) => ({
      label: key === 'Unknown' ? 'Unknown Date' : new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      jobs: groupJobs,
    }));

  res.render('jobs', { locationGroups, dateGroups, tabGroups, activeGroupId, activeOthers, orphanCount, total: jobs.length, title: 'Jobs Match' });
});

export { router as jobsRouter };
