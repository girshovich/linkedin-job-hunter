/**
 * Jobs Match Route — STRONG_MATCH jobs grouped by date, paginated by 10 distinct run-dates.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobRow } from '../db';

const router = Router();
const PAGE_DATES = 10; // number of distinct run-dates shown per page

// Per-profile cache of distinct fetch dates — only changes after a pipeline run.
// Invalidated by invalidateJobsDatesCache(), called from runner.ts on run completion.
const datesCache = new Map<number, Array<{ d: string }>>();
export function invalidateJobsDatesCache(profileId: number): void {
  datesCache.delete(profileId);
}

interface DateGroup {
  label: string;
  jobs: JobRow[];
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  // Active tab from ?group=<id|'others'>
  const groupParam = String(req.query.group || 'all');
  const activeOthers = groupParam === 'others';
  const activeGroupId = !activeOthers && groupParam !== 'all'
    ? parseInt(groupParam, 10) : null;

  // All distinct dates that have STRONG_MATCH jobs for this profile, newest first.
  // Result is cached per-profile and invalidated by invalidateJobsDatesCache() after each run.
  let allDates = datesCache.get(profileId);
  if (!allDates) {
    allDates = db.prepare(`
      SELECT DISTINCT DATE(fetched_at) as d
      FROM jobs
      WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
        AND fetched_at IS NOT NULL
      ORDER BY d DESC
    `).all(profileId) as Array<{ d: string }>;
    datesCache.set(profileId, allDates);
  }

  const totalPages = Math.max(1, Math.ceil(allDates.length / PAGE_DATES));
  const page = Math.max(1, Math.min(parseInt(String(req.query.page || '1'), 10), totalPages));

  // The slice of dates for this page
  const pageDates = allDates.slice((page - 1) * PAGE_DATES, page * PAGE_DATES).map((r) => r.d);
  const pageNewest = pageDates[0] ?? null;
  const pageOldest = pageDates[pageDates.length - 1] ?? null;

  // Tabs: groups that have at least one STRONG_MATCH job (all-time counts)
  const tabGroups = db.prepare(`
    SELECT sg.id, sg.group_name, COUNT(j.id) as job_count
    FROM search_groups sg
    INNER JOIN jobs j ON j.group_id = sg.id
    WHERE sg.profile_id = ? AND j.ai_verdict = 'STRONG_MATCH' AND j.is_duplicate = 0
    GROUP BY sg.id ORDER BY sg.id ASC
  `).all(profileId) as Array<{ id: number; group_name: string; job_count: number }>;

  // "Others" tab: jobs whose group was deleted (all-time count)
  const orphanCount = (db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
    AND (group_id IS NULL OR group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))
  `).get(profileId, profileId) as { c: number }).c;

  // Only the columns the jobs.ejs template actually reads — skips description,
  // ai_rationale, cv_assessment and other large/unused fields (~5 KB saved per job).
  const COLS = `id, title, company, location, url, ai_score, ai_verdict,
                is_duplicate, ai_summary, fetched_at, applied, user_notes`;

  // Fetch jobs for the current page's dates
  let jobs: JobRow[] = [];
  if (pageDates.length > 0) {
    const ph = pageDates.map(() => '?').join(',');
    jobs = (activeGroupId
      ? db.prepare(
          `SELECT ${COLS} FROM jobs
           WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
             AND group_id = ? AND DATE(fetched_at) IN (${ph})
           ORDER BY fetched_at DESC, ai_score DESC, id DESC`,
        ).all(profileId, activeGroupId, ...pageDates)
      : activeOthers
      ? db.prepare(
          `SELECT ${COLS} FROM jobs
           WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
             AND (group_id IS NULL OR group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))
             AND DATE(fetched_at) IN (${ph})
           ORDER BY fetched_at DESC, ai_score DESC, id DESC`,
        ).all(profileId, profileId, ...pageDates)
      : db.prepare(
          `SELECT ${COLS} FROM jobs
           WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
             AND DATE(fetched_at) IN (${ph})
           ORDER BY fetched_at DESC, ai_score DESC, id DESC`,
        ).all(profileId, ...pageDates)
    ) as JobRow[];
  }

  // Group jobs by date (newest first, score-sorted within each date)
  const dateMap = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const key = job.fetched_at ? String(job.fetched_at).slice(0, 10) : 'Unknown';
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key)!.push(job);
  }
  const dateGroups: DateGroup[] = Array.from(dateMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupJobs]) => ({
      label: key === 'Unknown' ? 'Unknown Date'
        : new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      jobs: groupJobs,
    }));

  // All-time total (shown in header)
  const totalAll = (db.prepare(
    `SELECT COUNT(*) as c FROM jobs WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0`,
  ).get(profileId) as { c: number }).c;

  const companyNoteRows = db.prepare('SELECT company, note FROM company_notes WHERE profile_id = ?').all(profileId) as Array<{ company: string; note: string }>;
  const companyNotes: Record<string, string> = {};
  for (const r of companyNoteRows) { if (r.note) companyNotes[r.company] = r.note; }

  res.render('jobs', {
    dateGroups,
    tabGroups, activeGroupId, activeOthers, orphanCount,
    total: totalAll,
    page, totalPages, pageNewest, pageOldest,
    title: 'Jobs Match',
    companyNotes,
  });
});

export { router as jobsRouter };
