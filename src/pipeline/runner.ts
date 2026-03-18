/**
 * Pipeline Runner — Orchestrates the full daily job-hunting pipeline.
 * Sequence: for each group → fetch → blacklist filter → provider dedup → AI score
 *           → semantic dedup → store. Then: send email → update run log.
 * All evaluated jobs (blacklisted + scored) are logged to run_job_logs per run.
 */

import { getDb, type SettingsRow, type SearchGroupRow, type BlacklistedCompanyRow } from '../db';
import { config } from '../config';
import { fetchJobs, type JobPosting, type DateRange } from './fetcher';
import { filterNewJobs } from './deduplicator';
import { scoreJobs, dedupAndSummarise, buildScoringSystemPrompt, type ScoredJob, type ExistingJob } from './aiScorer';
import { sendDailyReport, type RunStats } from './emailReport';

// Price per 1M tokens in USD — sorted longest key first so prefix matching is unambiguous
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini':   { input: 0.15,  output: 0.60  },
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'o1-mini':       { input: 3.00,  output: 12.00 },
  'o1':            { input: 15.00, output: 60.00 },
  'o3-mini':       { input: 1.10,  output: 4.40  },
  'gpt-3.5-turbo': { input: 0.50,  output: 1.50  },
};

function calcOpenAiCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(OPENAI_PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  if (!key) return null;
  const p = OPENAI_PRICING[key];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function matchesTitleFilter(title: string, filter: string): boolean {
  const titleWords = new Set(title.toLowerCase().split(/\W+/).filter(Boolean));
  return filter
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .some((line) => line.split(/\W+/).filter(Boolean).every((w) => titleWords.has(w)));
}

const isRunningMap = new Map<number, boolean>();
const lastRunResultMap = new Map<number, PipelineResult | null>();

interface StageInfo { text: string; pct: number; totalSections: number; }
const runStageMap = new Map<number, StageInfo>();

function setStage(profileId: number, text: string, pct: number, totalSections: number): void {
  runStageMap.set(profileId, { text, pct, totalSections });
}

export function getIsRunning(profileId: number = 1): boolean {
  return isRunningMap.get(profileId) ?? false;
}

export function getRunStatus(profileId: number = 1) {
  return {
    isRunning: isRunningMap.get(profileId) ?? false,
    lastRun: lastRunResultMap.get(profileId) ?? null,
    stage: runStageMap.get(profileId) ?? null,
  };
}

export interface RunOptions {
  groupIds?: number[];    // if provided, only run these groups (by id)
  dateRange?: DateRange;  // defaults to '24h'
}

export interface PipelineResult {
  ranAt: string;
  durationMs: number;
  jobsFetched: number;
  jobsScored: number;
  jobsStrongMatch: number;
  jobsWeakMatch: number;
  jobsNoMatch: number;
  jobsDuplicate: number;
  status: 'success' | 'partial_error' | 'failed' | 'running';
  errorLog: string | null;
  trigger: 'scheduled' | 'manual';
}

export async function runPipeline(trigger: 'scheduled' | 'manual' = 'scheduled', profileId: number = 1, options: RunOptions = {}): Promise<PipelineResult> {
  if (isRunningMap.get(profileId)) {
    console.log(`[runner] Pipeline already running for profile ${profileId}; skipping trigger.`);
    return {
      ranAt: new Date().toISOString(),
      durationMs: 0,
      jobsFetched: 0,
      jobsScored: 0,
      jobsStrongMatch: 0,
      jobsWeakMatch: 0,
      jobsNoMatch: 0,
      jobsDuplicate: 0,
      status: 'failed',
      errorLog: 'Pipeline already running',
      trigger,
    };
  }

  isRunningMap.set(profileId, true);
  const startedAt = Date.now();
  const ranAt = new Date().toISOString();
  const errors: string[] = [];
  let runId: number | null = null;

  let jobsFetched = 0;
  let jobsScored = 0;
  let jobsStrongMatch = 0;
  let jobsWeakMatch = 0;
  let jobsNoMatch = 0;
  let jobsDuplicate = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalApifyCostUsd = 0;
  let apifyRunCount = 0;

  try {
    const db = getDb();

    // Load settings for this profile
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    if (!settings) throw new Error(`Settings not found for profile ${profileId}`);

    // Resolve API keys: DB value takes priority, env vars are fallback
    const apifyToken = settings.apify_api_token || config.apifyApiToken;
    const scrapingProvider = settings.scraping_provider || 'harvestapi';
    const openAiKey = settings.openai_api_key || config.openAiKey;
    const resendApiKey = settings.resend_api_key || config.resendApiKey;
    const emailFrom = settings.email_from || config.emailFrom;

    // Load all search groups for this profile
    const groups = db.prepare('SELECT * FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as SearchGroupRow[];
    if (groups.length === 0) throw new Error('No roles configured. Add at least one role in Settings.');

    // Load blacklist for this profile
    const blacklist = db
      .prepare('SELECT * FROM blacklisted_companies WHERE profile_id = ? ORDER BY company_name ASC')
      .all(profileId) as BlacklistedCompanyRow[];
    const blacklistNames = new Set(blacklist.map((b) => b.company_name.toLowerCase().trim()));

    const { groupIds, dateRange = '24h' } = options;

    console.log(`[runner] Starting pipeline (${trigger}) — ${groups.length} group(s), ${blacklist.length} blacklisted company(ies)`);

    // Pre-compute active groups for progress tracking
    const activeGroups = groups.filter((g) =>
      g.is_active && (!groupIds || groupIds.length === 0 || groupIds.includes(g.id))
    );
    const totalSections = activeGroups.length + 2; // Starting + one per active group + AI Scoring
    const sw = 100 / totalSections;
    let activeGroupIdx = 0;
    let hasScoringStageSet = false;
    setStage(profileId, 'Starting', 0, totalSections);

    // Insert search_runs row NOW to get a stable run_id for job logs
    runId = db.prepare(
      `INSERT INTO search_runs (profile_id, ran_at, status, trigger, scraping_provider) VALUES (?, ?, 'running', ?, ?)`
    ).run(profileId, ranAt, trigger, scrapingProvider).lastInsertRowid as number;

    console.log(`[runner] Run ID: ${runId}`);

    // Prepared statements (shared across groups)
    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO jobs (
        profile_id, linkedin_job_id, title, company, location, work_mode, description,
        url, posted_date, fetched_at, ai_score, ai_rationale, ai_summary, ai_verdict,
        is_duplicate, duplicate_of_job_id, seen, seen_at, group_id, rejection_category,
        apply_url, provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertJobLog = db.prepare(`
      INSERT INTO run_job_logs (
        run_id, group_id, linkedin_job_id, title, company, location, url,
        ai_score, ai_verdict, ai_rationale, rejection_category, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // In-memory dedup set — prevents re-scoring the same linkedin_job_id within a single run
    // (NO_MATCH jobs are never written to DB, so filterNewJobs alone can't catch within-run dupes)
    const seenInRunJobIds = new Set<string>();

    // Tracks strong matches already claimed this run by company+title (lowercased+trimmed).
    // Catches jobs that LinkedIn lists under multiple different IDs for the same posting —
    // they bypass linkedin_job_id dedup but would be missed by semantic dedup because
    // the first copy isn't stored yet when the second one's Call 2 query runs.
    // Persists across groups so cross-group same-run duplicates are also caught.
    const seenStrongInRun = new Set<string>();

    // In-run semantic dedup context: maps lowercase+trimmed company name → accepted STRONG_MATCH
    // jobs from this run (not yet in DB). Prepended to DB results for dedupAndSummarise so the
    // LLM can compare new jobs against same-company STRONG_MATCHes already accepted this run,
    // even when they have different titles (not caught by seenStrongInRun).
    const strongMatchesInRun = new Map<string, ExistingJob[]>();

    // --- Per-group loop ---
    for (const group of groups) {
      if (!group.is_active) {
        console.log(`[runner] Group ${group.id} is inactive, skipping.`);
        continue;
      }
      if (groupIds && groupIds.length > 0 && !groupIds.includes(group.id)) {
        console.log(`[runner] Group ${group.id} not in selected groupIds, skipping.`);
        continue;
      }

      const keywords: string[] = JSON.parse(group.keywords);
      const locations: string[] = JSON.parse(group.locations);
      const workModes: string[] = JSON.parse(group.work_modes);

      console.log(
        `[runner] Group ${group.id} [${locations.join(', ')}]: ${keywords.length} keywords × ${locations.length} locations`,
      );

      // 1. Fetch
      setStage(profileId, 'Fetching Jobs', Math.round((1 + activeGroupIdx) * sw), totalSections);
      let allFetched: JobPosting[] = [];
      try {
        const fetchResult = await fetchJobs({
          keywords,
          locations,
          workModes,
          jobType: group.job_type,
        }, apifyToken, dateRange, scrapingProvider);
        allFetched = fetchResult.jobs;
        if (fetchResult.apifyCostUsd != null) {
          totalApifyCostUsd += fetchResult.apifyCostUsd;
          apifyRunCount++;
        }
      } catch (err) {
        const msg = `Group ${group.id} fetch error: ${(err as Error).message}`;
        console.error('[runner]', msg);
        errors.push(msg);
        continue;
      }

      jobsFetched += allFetched.length;
      console.log(`[runner] Group ${group.id}: fetched ${allFetched.length} jobs`);

      // 2. Title filter
      if (group.title_filter && group.title_filter.trim()) {
        const titleFiltered = allFetched.filter((j) => !matchesTitleFilter(j.title, group.title_filter));
        allFetched = allFetched.filter((j) => matchesTitleFilter(j.title, group.title_filter));
        console.log(`[runner] Group ${group.id}: title filter removed ${titleFiltered.length} jobs (${allFetched.length} remain)`);

        if (titleFiltered.length > 0) {
          const loggedAt = new Date().toISOString();
          db.transaction(() => {
            for (const job of titleFiltered) {
              insertJobLog.run(
                runId, group.id, job.jobId, job.title, job.company,
                job.location || null, job.url || null,
                null, 'FILTERED', null, null, loggedAt,
              );
            }
          });
        }
      }

      // 3. Blacklist filter — capture filtered jobs before removing them
      const blacklistedJobs = allFetched.filter((j) => blacklistNames.has(j.company.toLowerCase().trim()));
      allFetched = allFetched.filter((j) => !blacklistNames.has(j.company.toLowerCase().trim()));
      if (blacklistedJobs.length > 0) {
        console.log(`[runner] Group ${group.id}: removed ${blacklistedJobs.length} blacklisted job(s)`);
      }

      // 3a. Within-run dedup — deduplicate within this batch first, then against earlier groups
      // The LinkedIn API can return the same jobId multiple times within one group's results
      const seenInBatch = new Set<string>();
      const batchDupes: typeof allFetched = [];
      const batchUnique: typeof allFetched = [];
      for (const j of allFetched) {
        if (seenInBatch.has(j.jobId)) batchDupes.push(j);
        else { seenInBatch.add(j.jobId); batchUnique.push(j); }
      }
      allFetched = batchUnique;

      const withinRunDupes = [
        ...batchDupes,
        ...allFetched.filter((j) => seenInRunJobIds.has(j.jobId)),
      ];
      allFetched = allFetched.filter((j) => !seenInRunJobIds.has(j.jobId));
      for (const j of allFetched) seenInRunJobIds.add(j.jobId);
      if (withinRunDupes.length > 0) {
        console.log(`[runner] Group ${group.id}: ${withinRunDupes.length} within-run duplicate(s) skipped`);
        jobsDuplicate += withinRunDupes.length;
        const loggedAt = new Date().toISOString();
        db.transaction(() => {
          for (const job of withinRunDupes) {
            insertJobLog.run(
              runId, group.id, job.jobId, job.title, job.company,
              job.location || null, job.url || null,
              null, 'DUPLICATE', null, null, loggedAt,
            );
          }
        });
      }

      // 3b. Provider-level dedup — filter jobs already stored in DB from previous runs
      const { newJobs, providerDupes } = filterNewJobs(allFetched);
      console.log(`[runner] Group ${group.id}: ${newJobs.length} new after provider dedup`);

      if (providerDupes.length > 0) {
        jobsDuplicate += providerDupes.length;
        const loggedAt = new Date().toISOString();
        db.transaction(() => {
          for (const job of providerDupes) {
            insertJobLog.run(
              runId, group.id, job.jobId, job.title, job.company,
              job.location || null, job.url || null,
              null, 'DUPLICATE', null, null, loggedAt,
            );
          }
        });
      }

      // 4. Score all new jobs (Call 1: scoring)
      const scoringSettings: SettingsRow = {
        ...settings,
        ai_system_prompt: buildScoringSystemPrompt(group, settings),
        score_no_match_max: group.score_no_match_max,
        score_weak_match_max: group.score_weak_match_max,
        score_strong_match_min: group.score_strong_match_min,
      };

      let scoredJobs: ScoredJob[] = [];
      if (newJobs.length > 0) {
        if (!hasScoringStageSet) {
          setStage(profileId, 'AI Scoring', Math.round((totalSections - 1) * sw), totalSections);
          hasScoringStageSet = true;
        }
        const scoreResult = await scoreJobs(newJobs, scoringSettings, openAiKey);
        scoredJobs = scoreResult.jobs;
        jobsScored += scoredJobs.length;
        totalInputTokens += scoreResult.tokenUsage.inputTokens;
        totalOutputTokens += scoreResult.tokenUsage.outputTokens;
      }

      // 4b. Dedup + summary for strong matches (Call 2: dedup + summary)
      const jobResults: Array<{
        scored: ScoredJob;
        isDuplicate: boolean;
        duplicateOfId: number | null;
        summary: string | null;
      }> = [];

      for (const scored of scoredJobs) {
        let isDuplicate = false;
        let duplicateOfId: number | null = null;
        let summary: string | null = null;

        if (scored.verdict === 'STRONG_MATCH') {
          const runKey = `${scored.job.company.toLowerCase().trim()}|||${scored.job.title.toLowerCase().trim()}`;
          const companyKey = scored.job.company.toLowerCase().trim();

          if (seenStrongInRun.has(runKey)) {
            // Exact company+title match already accepted this run — instant duplicate, no AI call.
            isDuplicate = true;
            console.log(`[runner] In-run duplicate: "${scored.job.title}" at "${scored.job.company}" (different LinkedIn ID, same posting)`);
          } else {
            // Combine in-run accepted STRONG_MATCHes (not yet in DB) with DB entries.
            const inRunEntries = strongMatchesInRun.get(companyKey) ?? [];
            const dbEntries = db.prepare(`
              SELECT id, title, description FROM jobs
              WHERE lower(company) = lower(?) AND lower(title) = lower(?)
                AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'
              ORDER BY fetched_at DESC LIMIT 5
            `).all(scored.job.company, scored.job.title) as ExistingJob[];
            const existingJobs = [...inRunEntries, ...dbEntries];

            if (existingJobs.length > 0) {
              // Call 2: dedup check only — summary was already generated in Call 1
              const dedup = await dedupAndSummarise(scored, existingJobs, settings, openAiKey);
              isDuplicate = dedup.isDuplicate;
              duplicateOfId = dedup.duplicateOfId && dedup.duplicateOfId > 0 ? dedup.duplicateOfId : null;
              totalInputTokens += dedup.tokenUsage.inputTokens;
              totalOutputTokens += dedup.tokenUsage.outputTokens;
              if (isDuplicate) {
                console.log(`[runner] Semantic duplicate: "${scored.job.title}" at "${scored.job.company}" → original ID ${duplicateOfId}`);
              }
            }
            // existingJobs.length === 0 → not a duplicate; skip Call 2 entirely

            if (!isDuplicate) {
              seenStrongInRun.add(runKey);
              // Register in in-run map so subsequent same-company jobs can be compared against it.
              const entry: ExistingJob = { id: 0, title: scored.job.title, description: scored.job.description || '' };
              strongMatchesInRun.set(companyKey, [...(strongMatchesInRun.get(companyKey) ?? []), entry]);
              summary = scored.summary;  // from Call 1
            }
          }
        }

        if (isDuplicate) jobsDuplicate++;
        else if (scored.verdict === 'STRONG_MATCH') jobsStrongMatch++;
        else if (scored.verdict === 'WEAK_MATCH') jobsWeakMatch++;
        else jobsNoMatch++;

        jobResults.push({ scored, isDuplicate, duplicateOfId, summary });
      }

      console.log(
        `[runner] Group ${group.id}: scored ${scoredJobs.length} — Strong=${jobsStrongMatch} Weak=${jobsWeakMatch} NoMatch=${jobsNoMatch} Dupes=${jobsDuplicate} (cumulative)`,
      );

      // 5. Log all jobs from this group to run_job_logs
      const loggedAt = new Date().toISOString();
      db.transaction(() => {
        for (const job of blacklistedJobs) {
          insertJobLog.run(
            runId, group.id, job.jobId, job.title, job.company,
            job.location || null, job.url || null,
            null, 'BLACKLISTED', null, null, loggedAt,
          );
        }
        for (const { scored, isDuplicate } of jobResults) {
          const logVerdict = isDuplicate ? 'DUPLICATE' : scored.verdict;
          insertJobLog.run(
            runId, group.id, scored.job.jobId, scored.job.title, scored.job.company,
            scored.job.location || null, scored.job.url || null,
            scored.score, logVerdict, scored.rationale || null,
            scored.rejectionCategory || null, loggedAt,
          );
        }
      });

      // Store blacklisted jobs in jobs table (INSERT OR IGNORE — first encounter wins)
      if (blacklistedJobs.length > 0) {
        const now = new Date().toISOString();
        db.transaction(() => {
          for (const job of blacklistedJobs) {
            insertJob.run(
              profileId, job.jobId, job.title, job.company,
              job.location || null, job.workMode || null, job.description || '',
              job.url || null, job.postedDate || null, now,
              0, null, null, 'BLACKLISTED',
              0, null, 0, null,
              group.id, null,
              job.applyUrl || null, job.provider || 'harvestapi',
            );
          }
        });
        console.log(`[runner] Group ${group.id}: stored ${blacklistedJobs.length} blacklisted job(s).`);
      }

      // 6. Store all scored jobs (strong/weak/no-match/duplicate) in one pass
      if (jobResults.length > 0) {
        const now = new Date().toISOString();
        db.transaction(() => {
          for (const { scored, isDuplicate, duplicateOfId, summary } of jobResults) {
            const { job } = scored;
            insertJob.run(
              profileId, job.jobId, job.title, job.company,
              job.location || null, job.workMode || null, job.description || '',
              job.url || null, job.postedDate || null, now,
              scored.score, scored.rationale || null,
              summary || null,
              scored.verdict,
              isDuplicate ? 1 : 0, duplicateOfId || null,
              isDuplicate ? 1 : 0, isDuplicate ? now : null,
              group.id, scored.rejectionCategory || null,
              job.applyUrl || null, job.provider || 'harvestapi',
            );
          }
        });
        console.log(`[runner] Group ${group.id}: stored ${jobResults.length} jobs.`);
      }

      activeGroupIdx++;
    }

    // 7. Send email report
    const emailStats: RunStats = {
      jobsFetched,
      jobsScored,
      strongMatch: jobsStrongMatch,
      weakMatch: jobsWeakMatch,
      noMatch: jobsNoMatch,
      duplicates: jobsDuplicate,
    };

    if (settings.email_enabled !== 0) {
      try {
        await sendDailyReport(emailStats, settings.email_recipient, resendApiKey, emailFrom);
      } catch (err) {
        const msg = `Email send error: ${(err as Error).message}`;
        console.error('[runner]', msg);
        errors.push(msg);
      }
    } else {
      console.log('[runner] Email sending is disabled in settings. Skipping email report.');
    }

    // 8. Update the run row with final stats
    const durationMs = Date.now() - startedAt;
    const status = errors.length === 0 ? 'success' : 'partial_error';

    const costOpenAiUsd = calcOpenAiCost(settings.ai_model, totalInputTokens, totalOutputTokens);
    const costApifyUsd = apifyRunCount > 0 ? totalApifyCostUsd : null;

    db.prepare(`
      UPDATE search_runs SET
        jobs_fetched = ?, jobs_scored = ?, jobs_strong_match = ?,
        jobs_weak_match = ?, jobs_no_match = ?, jobs_duplicate = ?,
        status = ?, error_log = ?, duration_ms = ?,
        cost_openai_usd = ?, cost_apify_usd = ?
      WHERE id = ?
    `).run(
      jobsFetched, jobsScored, jobsStrongMatch,
      jobsWeakMatch, jobsNoMatch, jobsDuplicate,
      status, errors.length > 0 ? errors.join('\n') : null, durationMs,
      costOpenAiUsd, costApifyUsd,
      runId,
    );

    console.log(`[runner] Pipeline complete in ${durationMs}ms — Status: ${status} (${trigger})`);

    const result: PipelineResult = {
      ranAt, durationMs, jobsFetched, jobsScored,
      jobsStrongMatch, jobsWeakMatch, jobsNoMatch, jobsDuplicate,
      status, errorLog: errors.length > 0 ? errors.join('\n') : null, trigger,
    };
    lastRunResultMap.set(profileId, result);
    return result;

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorMsg = (err as Error).message;
    console.error('[runner] Fatal pipeline error:', errorMsg);

    try {
      const db = getDb();
      if (runId !== null) {
        db.prepare(
          `UPDATE search_runs SET status = 'failed', error_log = ?, duration_ms = ? WHERE id = ?`
        ).run(errorMsg, durationMs, runId);
      } else {
        // run_id was never created (e.g. DB unavailable at start); fall back to insert
        db.prepare(`
          INSERT INTO search_runs (profile_id, ran_at, jobs_fetched, jobs_scored, jobs_strong_match,
            jobs_weak_match, jobs_no_match, jobs_duplicate, status, error_log, duration_ms, trigger)
          VALUES (?, ?, 0, 0, 0, 0, 0, 0, 'failed', ?, ?, ?)
        `).run(profileId, ranAt, errorMsg, durationMs, trigger);
      }
    } catch (_) { /* ignore DB logging failure */ }

    const result: PipelineResult = {
      ranAt, durationMs, jobsFetched: 0, jobsScored: 0,
      jobsStrongMatch: 0, jobsWeakMatch: 0, jobsNoMatch: 0, jobsDuplicate: 0,
      status: 'failed', errorLog: errorMsg, trigger,
    };
    lastRunResultMap.set(profileId, result);
    return result;

  } finally {
    isRunningMap.set(profileId, false);
    runStageMap.delete(profileId);
  }
}
