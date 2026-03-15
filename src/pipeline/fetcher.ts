/**
 * Fetcher — scraping provider orchestrator.
 * Re-exports shared types; routes fetch requests to the active provider.
 */

export type { JobPosting, SearchFilters, DateRange, FetchResult } from './types';
import type { SearchFilters, DateRange, FetchResult } from './types';
import { fetchWithHarvestApi } from './providers/harvestapi';
import { fetchWithValig } from './providers/valig';

export async function fetchJobs(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange = '24h',
  provider = 'harvestapi',
): Promise<FetchResult> {
  if (provider === 'valig') {
    return fetchWithValig(filters, apifyToken, dateRange);
  }
  return fetchWithHarvestApi(filters, apifyToken, dateRange);
}
