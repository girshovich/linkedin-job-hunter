/**
 * Valig LinkedIn jobs scraper provider.
 * Actor: valig/linkedin-jobs-scraper
 * Makes one call per keyword × location, runs all in parallel.
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow } from '../types';

const ACTOR_ID = 'valig/linkedin-jobs-scraper';
const LIMIT_PER_CALL = 1000;
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5_000;

interface ValigJob {
  id?: string;
  url?: string;
  title?: string;
  location?: string;
  companyName?: string;
  applyUrl?: string;
  postedDate?: string; // "YYYY-MM-DD"
  description?: string;
  descriptionHtml?: string;
}

function getDatePosted(dateRange: DateRange): string {
  if (dateRange === '24h') return 'r86400';
  if (dateRange === '7d') return 'r604800';
  return 'r2592000';
}

function mapToJobPosting(item: ValigJob): JobPosting {
  const jobId = String(item.id || '');
  const url = item.url || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '');
  const applyUrl = (item.applyUrl && item.applyUrl !== url) ? item.applyUrl : null;
  const postedDate = item.postedDate || null;
  const description = item.descriptionHtml || item.description || '';

  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: item.companyName || 'Unknown Company',
    location: item.location || '',
    workMode: '',
    url,
    applyUrl,
    postedDate,
    postedDateConfidence: postedDate ? 'HIGH' : 'LOW',
    description: description.substring(0, 20_000),
    provider: 'valig',
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WORK_MODE_MAP: Record<string, string> = {
  onsite: '1',
  hybrid: '2',
  remote: '3',
};

function mapWorkModes(workModes: string[]): string[] {
  return workModes.map((m) => WORK_MODE_MAP[m]).filter(Boolean);
}

async function runSingleCall(
  client: ApifyClient,
  keyword: string,
  location: string,
  datePosted: string,
  remote: string[],
): Promise<{ items: ValigJob[]; costUsd: number | null }> {
  const actorInput: Record<string, unknown> = {
    title: `"${keyword}"`,
    location,
    datePosted,
    limit: LIMIT_PER_CALL,
  };
  if (remote.length > 0) actorInput.remote = remote;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const run = await client.actor(ACTOR_ID).call(actorInput, { waitSecs: 900 });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const costUsd = 0.001 + items.length * 0.0004;
      return { items: items as ValigJob[], costUsd };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const isTransient = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      if (isTransient && attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(`[valig] "${keyword}"@"${location}" attempt ${attempt} failed (${code}), retrying…`);
        await sleep(FETCH_RETRY_DELAY_MS);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

export async function fetchWithValig(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const datePosted = getDatePosted(dateRange);
  const remote = mapWorkModes(filters.workModes);

  const calls: Array<{ keyword: string; location: string }> = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      calls.push({ keyword, location });
    }
  }

  console.log(`[valig] ${calls.length} actor call(s) — ${filters.keywords.length} keywords × ${filters.locations.length} locations`);

  const results = await Promise.all(
    calls.map(({ keyword, location }) => runSingleCall(client, keyword, location, datePosted, remote)),
  );

  let totalCost = 0;
  let hasCost = false;
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];

  for (const { items, costUsd } of results) {
    if (costUsd != null) { totalCost += costUsd; hasCost = true; }
    for (const item of items) {
      const job = mapToJobPosting(item);
      if (job.jobId && !seen.has(job.jobId) && filterByTimeWindow(job, dateRange)) {
        seen.add(job.jobId);
        jobs.push(job);
      }
    }
  }

  console.log(`[valig] Total unique jobs after time-window filter: ${jobs.length}`);

  return { jobs, apifyCostUsd: hasCost ? totalCost : null };
}
