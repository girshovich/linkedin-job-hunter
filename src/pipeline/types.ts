/**
 * Shared types and utilities for scraping providers.
 */

export interface JobPosting {
  jobId: string;
  title: string;
  company: string;
  location: string;
  workMode: string;
  url: string;
  applyUrl: string | null;
  postedDate: string | null;
  postedDateConfidence: 'HIGH' | 'LOW';
  description: string;
  provider: string; // 'harvestapi' | 'valig'
}

export interface SearchFilters {
  keywords: string[];
  locations: string[];
  workModes: string[];
  jobType: string;
}

export type DateRange = '24h' | '7d' | 'month';

export interface FetchResult {
  jobs: JobPosting[];
  apifyCostUsd: number | null;
}

export function parsePostedDate(raw: string | number | undefined): { date: string | null; confidence: 'HIGH' | 'LOW' } {
  if (!raw) return { date: null, confidence: 'LOW' };
  const ts = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!isNaN(ts) && ts > 1_000_000_000) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    return { date: new Date(ms).toISOString().split('T')[0], confidence: 'HIGH' };
  }
  const d = new Date(String(raw));
  if (!isNaN(d.getTime())) {
    return { date: d.toISOString().split('T')[0], confidence: 'HIGH' };
  }
  return { date: null, confidence: 'LOW' };
}

export function filterByTimeWindow(job: JobPosting, dateRange: DateRange = '24h'): boolean {
  if (!job.postedDate) {
    console.warn(`[fetcher] Job ${job.jobId}: missing postedDate, accepting with LOW confidence`);
    return true;
  }
  const posted = new Date(job.postedDate);
  const bufferHours = dateRange === '24h' ? 48 : dateRange === '7d' ? 8 * 24 : 35 * 24;
  const cutoff = new Date();
  cutoff.setUTCHours(cutoff.getUTCHours() - bufferHours);
  return posted >= cutoff;
}
