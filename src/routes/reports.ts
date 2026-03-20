/**
 * Reports Route — Shows a collapsible audit log of every pipeline run.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchRunRow, type RunJobLogRow } from '../db';

const router = Router();

function extractCountry(location: string | null): string {
  if (!location) return 'Remote / Unknown';
  const parts = location.split(',');
  const last = parts[parts.length - 1].trim();
  if (!last || last.toLowerCase() === 'remote') return 'Remote / Unknown';
  return last;
}

interface JobLogWithInternalId extends RunJobLogRow {
  internal_job_id: number | null;
}

interface CountryGroup {
  country: string;
  jobs: JobLogWithInternalId[];
}

interface RunWithLogs extends SearchRunRow {
  countryGroups: CountryGroup[];
  blacklistedCount: number;
  filteredCount: number;
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  const runs = db
    .prepare(`SELECT * FROM search_runs WHERE profile_id = ? ORDER BY ran_at DESC LIMIT 30`)
    .all(profileId) as SearchRunRow[];

  const runsWithLogs: RunWithLogs[] = runs.map((run) => {
    const logs = db
      .prepare(
        `SELECT rjl.*, j.id as internal_job_id
         FROM run_job_logs rjl
         LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id
         WHERE rjl.run_id = ?
         ORDER BY rjl.company ASC, rjl.logged_at ASC`,
      )
      .all(run.id) as JobLogWithInternalId[];

    const blacklistedCount = logs.filter((l) => l.ai_verdict === 'BLACKLISTED').length;
    const filteredCount = logs.filter((l) => l.ai_verdict === 'FILTERED').length;

    // Group by country, sort alphabetically with Remote/Unknown last
    const countryMap = new Map<string, JobLogWithInternalId[]>();
    for (const log of logs) {
      const country = extractCountry(log.location);
      if (!countryMap.has(country)) countryMap.set(country, []);
      countryMap.get(country)!.push(log);
    }

    const countryGroups: CountryGroup[] = Array.from(countryMap.entries())
      .sort(([a], [b]) => {
        if (a === 'Remote / Unknown') return 1;
        if (b === 'Remote / Unknown') return -1;
        return a.localeCompare(b);
      })
      .map(([country, jobs]) => ({ country, jobs }));

    return { ...run, countryGroups, blacklistedCount, filteredCount };
  });

  res.render('reports', { runs: runsWithLogs, title: 'Run Logs' });
});

export { router as reportsRouter };
