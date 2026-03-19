/**
 * HarvestAPI LinkedIn scraper provider.
 * Actor: harvestapi/linkedin-job-search
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { parsePostedDate, filterByTimeWindow } from '../types';

interface HarvestJobLocation {
  linkedinText?: string;
  parsed?: { city?: string; state?: string; country?: string };
}

interface HarvestJob {
  id?: string;
  jobId?: string;
  title?: string;
  companyName?: string;
  company?: { name?: string } | string;
  location?: HarvestJobLocation | string;
  workplaceType?: string;
  descriptionText?: string;
  description?: string;
  descriptionHtml?: string;
  linkedinUrl?: string;
  applyUrl?: string;
  applyMethod?: { companyApplyUrl?: string; easyApplyUrl?: string };
  url?: string;
  postedDate?: string;
  listedAt?: string | number;
}

function normalizeWorkMode(raw: string | undefined): string {
  const val = (raw || '').toLowerCase().replace(/[_\s-]/g, '');
  if (val.includes('remote')) return 'remote';
  if (val.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function getCompanyName(item: HarvestJob): string {
  if (item.companyName) return item.companyName;
  if (typeof item.company === 'string') return item.company;
  if (item.company?.name) return item.company.name;
  return 'Unknown Company';
}

function getLocationText(loc: HarvestJobLocation | string | undefined): string {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  return loc.linkedinText || loc.parsed?.city || '';
}

function mapToJobPosting(item: HarvestJob): JobPosting {
  const jobId = String(item.id || item.jobId || '');
  const rawDate = item.postedDate ?? item.listedAt;
  const parsedDate = parsePostedDate(rawDate);
  const description = item.descriptionHtml || item.descriptionText || item.description || '';
  const url = item.linkedinUrl || item.url
    || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '');
  const rawApplyUrl = item.applyMethod?.companyApplyUrl || item.applyUrl || null;
  const applyUrl = (rawApplyUrl && rawApplyUrl !== url) ? rawApplyUrl : null;

  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: getCompanyName(item),
    location: getLocationText(item.location),
    workMode: normalizeWorkMode(item.workplaceType),
    url,
    applyUrl,
    postedDate: parsedDate.date,
    postedDateConfidence: parsedDate.confidence,
    description: description.substring(0, 20_000),
    provider: 'harvestapi',
  };
}

const WORK_MODE_MAP: Record<string, string> = {
  onsite: 'office',
  hybrid: 'hybrid',
  remote: 'remote',
};

function mapWorkModes(workModes: string[]): string[] {
  return workModes.map((m) => WORK_MODE_MAP[m]).filter(Boolean);
}

function getPostedLimit(dateRange: DateRange): string {
  if (dateRange === '24h') return '24h';
  if (dateRange === '7d') return 'week';
  return '1 month';
}

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithHarvestApi(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });

  const workplaceType = mapWorkModes(filters.workModes);

  const actorInput: Record<string, unknown> = {
    jobTitles: filters.keywords,
    locations: filters.locations,
    postedLimit: getPostedLimit(dateRange),
    sortBy: 'date',
    maxItems: 100,
    ...(workplaceType.length > 0 && { workplaceType }),
  };

  const keywordsStr = filters.keywords.map((k) => `"${k}"`).join(', ');
  console.log(`[harvestapi] Starting actor run — ${filters.keywords.length} keywords × ${filters.locations.length} locations: ${keywordsStr}`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const run = await client.actor('harvestapi/linkedin-job-search').call(actorInput, { waitSecs: 900 });

      console.log(`[harvestapi] Actor run complete (${run.id}), fetching dataset items…`);

      const apifyCostUsd = typeof (run as unknown as Record<string, unknown>).usageTotalUsd === 'number'
        ? (run as unknown as Record<string, unknown>).usageTotalUsd as number
        : null;

      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      console.log(`[harvestapi] Raw items from actor: ${items.length}`);

      const jobs = (items as HarvestJob[])
        .map(mapToJobPosting)
        .filter((j) => j.jobId)
        .filter((j) => filterByTimeWindow(j, dateRange));

      console.log(`[harvestapi] Jobs after time-window filter: ${jobs.length}`);

      return { jobs, apifyCostUsd };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const isTransient = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      if (isTransient && attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(`[harvestapi] Attempt ${attempt} failed (${code}), retrying in ${FETCH_RETRY_DELAY_MS / 1000}s…`);
        await sleep(FETCH_RETRY_DELAY_MS);
      } else {
        break;
      }
    }
  }

  throw lastErr;
}
