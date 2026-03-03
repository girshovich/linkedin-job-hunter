/**
 * Dashboard Routes — Home page, job history, and job detail.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobRow, type SearchRunRow, type SearchGroupRow, type SettingsRow } from '../db';

const router = Router();

// Home — today's curated jobs, last run stats, "Run Now" button
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const lastRun = db
    .prepare(`SELECT * FROM search_runs ORDER BY ran_at DESC LIMIT 1`)
    .get() as SearchRunRow | undefined;

  // Jobs from the last pipeline run
  const lastRunAt = lastRun?.ran_at ?? null;

  // Live counts — recalculate from jobs table so manual verdict changes are reflected
  const liveLastRunStats = lastRunAt
    ? (db.prepare(`
        SELECT
          SUM(CASE WHEN ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
          SUM(CASE WHEN is_duplicate = 1 THEN 1 ELSE 0 END) as duplicate
        FROM jobs WHERE fetched_at >= ?
      `).get(lastRunAt) as { strong: number; duplicate: number } | undefined)
    : undefined;

  const lastRunJobs = lastRunAt
    ? (db
        .prepare(
          `SELECT * FROM jobs
           WHERE fetched_at >= ? AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'
           ORDER BY ai_score DESC`,
        )
        .all(lastRunAt) as JobRow[])
    : [];

  const newCount = db
    .prepare(`SELECT COUNT(*) as c FROM jobs WHERE seen = 0 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`)
    .get() as { c: number };

  const seenCount = db
    .prepare(`SELECT COUNT(*) as c FROM jobs WHERE seen = 1 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`)
    .get() as { c: number };

  // Location breakdown (last run)
  const allTimeStats = db.prepare(`
    SELECT
      COALESCE(SUM(jobs_fetched), 0)      as total_fetched,
      COALESCE(SUM(jobs_scored), 0)       as total_scored,
      COALESCE(SUM(jobs_strong_match), 0) as total_strong,
      COALESCE(SUM(jobs_weak_match), 0)   as total_weak,
      COALESCE(SUM(jobs_no_match), 0)     as total_no_match,
      COALESCE(SUM(jobs_duplicate), 0)    as total_duplicate
    FROM search_runs WHERE status != 'running'
  `).get() as {
    total_fetched: number; total_scored: number; total_strong: number;
    total_weak: number; total_no_match: number; total_duplicate: number;
  };

  const locationBreakdown = lastRunAt
    ? (db
        .prepare(
          `SELECT location, COUNT(*) as count FROM jobs
           WHERE fetched_at >= ? AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH' AND location IS NOT NULL
           GROUP BY location ORDER BY count DESC LIMIT 10`,
        )
        .all(lastRunAt) as Array<{ location: string; count: number }>)
    : [];

  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | undefined;
  const groupCount = (db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }).c;
  const appliedCount = (db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE applied = 1 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`).get() as { c: number }).c;

  // Onboarding checklist steps
  const checklist = {
    hasGroups:   groupCount > 0,
    hasRun:      !!lastRun,
    hasEmail:    !!(settings?.resend_api_key && settings?.email_recipient),
    hasSchedule: !!(settings?.cron_schedule),
  };
  const checklistDone = Object.values(checklist).every(Boolean);

  res.render('home', {
    lastRun,
    liveStrong:    liveLastRunStats?.strong    ?? lastRun?.jobs_strong_match ?? 0,
    liveDuplicate: liveLastRunStats?.duplicate ?? lastRun?.jobs_duplicate    ?? 0,
    lastRunJobs,
    newCount: newCount.c,
    seenCount: seenCount.c,
    allTimeStats,
    locationBreakdown,
    appliedCount,
    checklist,
    checklistDone,
    title: 'Start',
  });
});

// Job History — paginated, filterable — queries jobs table (one row per unique linkedin_job_id)
router.get('/history', (req: Request, res: Response) => {
  const db = getDb();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = 25;
  const offset = (page - 1) * limit;

  // Filters
  const verdict = String(req.query.verdict || '');
  const company = String(req.query.company || '');
  const scoreMin = req.query.score_min !== undefined && req.query.score_min !== ''
    ? parseInt(String(req.query.score_min), 10) : null;
  const scoreMax = req.query.score_max !== undefined && req.query.score_max !== ''
    ? parseInt(String(req.query.score_max), 10) : null;
  const dateFrom = String(req.query.date_from || '');
  const dateTo   = String(req.query.date_to   || '');
  // group: undefined = all, 'null' = ungrouped jobs, number = specific group
  const groupParam = req.query.group;
  const groupId: number | null | undefined =
    groupParam === undefined || groupParam === ''
      ? undefined
      : groupParam === 'null'
        ? null
        : parseInt(String(groupParam), 10);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // DUPLICATE filter maps to is_duplicate=1; other verdicts filter by ai_verdict
  if (verdict === 'DUPLICATE') {
    conditions.push('j.is_duplicate = 1');
  } else if (verdict && ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH'].includes(verdict)) {
    conditions.push('j.ai_verdict = ?');
    params.push(verdict);
  }
  if (company) {
    conditions.push('j.company LIKE ?');
    params.push(`%${company}%`);
  }
  if (scoreMin !== null) { conditions.push('j.ai_score >= ?'); params.push(scoreMin); }
  if (scoreMax !== null) { conditions.push('j.ai_score <= ?'); params.push(scoreMax); }
  if (dateFrom) { conditions.push('j.fetched_at >= ?'); params.push(dateFrom); }
  if (dateTo)   { conditions.push('j.fetched_at <= ?'); params.push(dateTo + 'T23:59:59Z'); }
  if (groupId === null) {
    conditions.push('j.group_id IS NULL');
  } else if (groupId !== undefined && !isNaN(groupId)) {
    conditions.push('j.group_id = ?');
    params.push(groupId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM jobs j ${where}`).get(...params) as { c: number }
  ).c;

  const jobs = db
    .prepare(`
      SELECT * FROM jobs j
      ${where}
      ORDER BY j.fetched_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as JobRow[];

  const totalPages = Math.ceil(total / limit);
  const groups = db.prepare('SELECT id, group_name FROM search_groups ORDER BY id ASC').all() as Pick<SearchGroupRow, 'id' | 'group_name'>[];

  res.render('history', {
    jobs,
    page,
    totalPages,
    total,
    groups,
    filters: { verdict, company, scoreMin, scoreMax, dateFrom, dateTo, groupId },
    title: 'Jobs All',
  });
});

// Job Detail
router.get('/job/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!job) {
    res.status(404).render('404', { title: 'Not Found' });
    return;
  }

  // Duplicate chain
  let original: JobRow | undefined;
  if (job.duplicate_of_job_id) {
    original = db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(job.duplicate_of_job_id) as JobRow | undefined;
  }

  const duplicatesOfThis = db
    .prepare('SELECT * FROM jobs WHERE duplicate_of_job_id = ? ORDER BY fetched_at DESC')
    .all(job.id) as JobRow[];

  const from = String(req.query.from || 'history');
  const backUrl   = from === 'jobs' ? '/jobs' : from === 'home' ? '/' : '/history';
  const backLabel = 'Back';

  // Prev/Next navigation — order matches the source page
  let prevId: number | null = null;
  let nextId: number | null = null;
  if (from === 'jobs') {
    // Jobs Match sorts: fetched_at DESC, ai_score DESC (all strong matches, all time)
    const allIds = db.prepare(`
      SELECT id FROM jobs
      WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
      ORDER BY DATE(fetched_at) DESC, ai_score DESC
    `).all() as Array<{ id: number }>;
    const idx = allIds.findIndex((r) => r.id === id);
    if (idx > 0) prevId = allIds[idx - 1].id;
    if (idx >= 0 && idx < allIds.length - 1) nextId = allIds[idx + 1].id;
  } else if (from === 'home') {
    // Home sorts: ai_score DESC within the last run (same day)
    const day = job.fetched_at ? String(job.fetched_at).slice(0, 10) : null;
    if (day) {
      const sameDayIds = db.prepare(`
        SELECT id FROM jobs
        WHERE ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0
          AND strftime('%Y-%m-%d', fetched_at) = ?
        ORDER BY ai_score DESC
      `).all(day) as Array<{ id: number }>;
      const idx = sameDayIds.findIndex((r) => r.id === id);
      if (idx > 0) prevId = sameDayIds[idx - 1].id;
      if (idx >= 0 && idx < sameDayIds.length - 1) nextId = sameDayIds[idx + 1].id;
    }
  }

  res.render('job-detail', { job, original, duplicatesOfThis, title: job.title, backUrl, backLabel, prevId, nextId, from });
});

export { router as dashboardRouter };
