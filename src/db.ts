/**
 * Database layer — uses Node.js built-in `node:sqlite` (available Node 22.5+, unflagged Node 23.4+).
 * No native compilation required.
 */

// node:sqlite types not fully in @types/node yet, so we declare what we need.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { open?: boolean }) => NodeSQLiteDatabase;
};

import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

// Minimal type surface for node:sqlite
interface NodeSQLiteStatement {
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface NodeSQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSQLiteStatement;
  close(): void;
}

// ---- Type-safe wrapper ----

export type PreparedStatement<T = unknown> = {
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
};

export type Database = {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): PreparedStatement<T>;
  transaction<T>(fn: () => T): T;
};

function wrapDatabase(raw: NodeSQLiteDatabase): Database {
  return {
    exec: (sql) => raw.exec(sql),
    prepare: <T>(sql: string) => raw.prepare(sql) as unknown as PreparedStatement<T>,
    transaction: <T>(fn: () => T): T => {
      raw.prepare('BEGIN').run();
      try {
        const result = fn();
        raw.prepare('COMMIT').run();
        return result;
      } catch (err) {
        raw.prepare('ROLLBACK').run();
        throw err;
      }
    },
  };
}

// ---- Seed data ----

export const DEFAULT_DEDUP_SYSTEM_PROMPT = `You are a job posting deduplication engine. Your task is to determine whether a NEW job posting is effectively the same position as any of the EXISTING postings from the same company. Two postings are duplicates if they describe the same role even if the text has been slightly reworded, reformatted, or reposted with a new ID.`;

export const DEFAULT_AI_SYSTEM_PROMPT = `You are evaluating LinkedIn job postings for a senior product professional with 8+ years of experience. Assess how well each job matches this ideal profile:

IDEAL CANDIDATE:
- Senior IC or leadership PM roles (Senior PM, Lead PM, Group PM, Head of Product, Director/VP of Product)
- Experience with B2B SaaS, marketplace, fintech, or consumer tech products
- Comfortable in fast-paced, high-growth environments
- Values strong team culture, real ownership, and strategic influence

SCORING GUIDE (0–100):
90–100: Exceptional match — senior/leadership role, strong domain fit, top-tier company, compelling scope
80–89: Strong match — good seniority level, relevant domain, clear ownership and impact
71–79: Solid match — reasonable fit but some gaps (seniority, domain, or location)
51–70: Weak match — missing key elements; worth noting but not compelling
0–50: No match — junior level, unrelated field, or clearly unsuitable

SCORING CRITERIA:
- Role seniority and title (40% weight): Is this IC senior/lead or people-manager level?
- Domain and product type (30% weight): Relevant industry and product complexity?
- Scope and impact (20% weight): Team size, user base, strategic vs. feature PM?
- Company quality (10% weight): Stage, brand, growth trajectory?

IMPORTANT: Evaluate only what is stated. If information is missing, be conservative.`;

const DEFAULT_LOCATIONS = JSON.stringify([
  'London',
  'Berlin',
  'Cyprus',
  'Netherlands',
  'Spain',
  'Armenia',
]);

const DEFAULT_KEYWORDS = JSON.stringify([
  'Product Manager',
  'Product Lead',
  'Head of Product',
  'Product Director',
  'Group Product Manager',
]);

// ---- Singleton ----

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const raw = new DatabaseSync(path.resolve(config.dbPath));
  _db = wrapDatabase(raw);

  // WAL mode and foreign keys (node:sqlite uses PRAGMA via exec)
  _db.exec(`PRAGMA journal_mode = WAL`);
  _db.exec(`PRAGMA foreign_keys = ON`);

  initSchema(_db);
  runMigrations(_db);
  seedSettings(_db);
  ensureProfileIndexes(_db);

  return _db;
}

function runMigrations(db: Database): void {
  // v6→v7: rename search_geocodes → search_locations, convert [{geocode,label}] → [string]
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    const hasGeocodes = cols.some((c) => c.name === 'search_geocodes');
    const hasLocations = cols.some((c) => c.name === 'search_locations');

    if (hasGeocodes && !hasLocations) {
      db.exec(`ALTER TABLE settings RENAME COLUMN search_geocodes TO search_locations`);
      // Convert stored JSON from [{geocode, label}] to ["label", ...]
      const row = db.prepare(`SELECT search_locations FROM settings WHERE id = 1`).get() as
        { search_locations: string } | undefined;
      if (row) {
        try {
          const parsed: Array<{ geocode?: string; label?: string } | string> =
            JSON.parse(row.search_locations);
          const strings = parsed.map((e) =>
            typeof e === 'string' ? e : (e.label || e.geocode || ''),
          ).filter(Boolean);
          db.prepare(`UPDATE settings SET search_locations = ? WHERE id = 1`).run(
            JSON.stringify(strings),
          );
        } catch {
          // If parse fails, set sensible default
          db.prepare(`UPDATE settings SET search_locations = ? WHERE id = 1`).run(DEFAULT_LOCATIONS);
        }
      }
      console.log('[db] Migration applied: search_geocodes → search_locations');
    }
  } catch (err) {
    console.warn('[db] Migration check failed (non-fatal):', (err as Error).message);
  }

  // v6→v7: add trigger column to search_runs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_runs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'trigger')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'scheduled'`);
      console.log('[db] Migration applied: search_runs.trigger column added');
    }
  } catch (err) {
    console.warn('[db] Migration (trigger column) failed (non-fatal):', (err as Error).message);
  }

  // v8: add score threshold columns to search_groups if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'score_no_match_max')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_no_match_max INTEGER NOT NULL DEFAULT 50`);
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_weak_match_max INTEGER NOT NULL DEFAULT 70`);
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_strong_match_min INTEGER NOT NULL DEFAULT 71`);
      console.log('[db] Migration applied: search_groups score threshold columns added');
    }
  } catch (err) {
    console.warn('[db] Migration (group score thresholds) failed (non-fatal):', (err as Error).message);
  }

  // v8: add group_id to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'group_id')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN group_id INTEGER REFERENCES search_groups(id)`);
      console.log('[db] Migration applied: jobs.group_id column added');
    }
  } catch (err) {
    console.warn('[db] Migration (group_id column) failed (non-fatal):', (err as Error).message);
  }

  // v9: add dedup_system_prompt to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'dedup_system_prompt')) {
      db.exec(`ALTER TABLE settings ADD COLUMN dedup_system_prompt TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE settings SET dedup_system_prompt = ? WHERE id = 1`).run(DEFAULT_DEDUP_SYSTEM_PROMPT);
      console.log('[db] Migration applied: settings.dedup_system_prompt column added');
    }
  } catch (err) {
    console.warn('[db] Migration (dedup_system_prompt) failed (non-fatal):', (err as Error).message);
  }

  // v9: add ai_summary to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'ai_summary')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ai_summary TEXT`);
      console.log('[db] Migration applied: jobs.ai_summary column added');
    }
  } catch (err) {
    console.warn('[db] Migration (ai_summary column) failed (non-fatal):', (err as Error).message);
  }

  // v10: add rejection_category to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'rejection_category')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN rejection_category TEXT`);
      console.log('[db] Migration applied: jobs.rejection_category column added');
    }
  } catch (err) {
    console.warn('[db] Migration (rejection_category column) failed (non-fatal):', (err as Error).message);
  }

  // v11: add group_name, is_active, title_filter to search_groups if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'group_name')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN group_name TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.group_name column added');
    }
    if (!cols.some((c) => c.name === 'is_active')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
      console.log('[db] Migration applied: search_groups.is_active column added');
    }
    if (!cols.some((c) => c.name === 'title_filter')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN title_filter TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.title_filter column added');
    }
  } catch (err) {
    console.warn('[db] Migration (search_groups v11 columns) failed (non-fatal):', (err as Error).message);
  }

  // v11: add summary_prompt to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'summary_prompt')) {
      db.exec(`ALTER TABLE settings ADD COLUMN summary_prompt TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE settings SET summary_prompt = ? WHERE id = 1`).run(
        'Analyze the job description and write a 1-line summary of what product this role owns:',
      );
      console.log('[db] Migration applied: settings.summary_prompt column added');
    }
  } catch (err) {
    console.warn('[db] Migration (summary_prompt column) failed (non-fatal):', (err as Error).message);
  }

  // v13: add timezone to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'timezone')) {
      db.exec(`ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
      console.log('[db] Migration applied: settings.timezone column added');
    }
  } catch (err) {
    console.warn('[db] Migration (timezone) failed (non-fatal):', (err as Error).message);
  }

  // v12: add API keys to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'apify_api_token')) {
      db.exec(`ALTER TABLE settings ADD COLUMN apify_api_token TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN openai_api_key TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN resend_api_key TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN email_from TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 1`);
      // Seed from env so existing users don't lose their keys
      db.prepare(
        `UPDATE settings SET apify_api_token = ?, openai_api_key = ?, resend_api_key = ?, email_from = ? WHERE id = 1`,
      ).run(
        process.env.APIFY_API_TOKEN || '',
        process.env.OPENAI_API_KEY || '',
        process.env.RESEND_API_KEY || '',
        process.env.EMAIL_FROM || '',
      );
      console.log('[db] Migration applied: settings API key columns added, seeded from env.');
    }
  } catch (err) {
    console.warn('[db] Migration (API keys) failed (non-fatal):', (err as Error).message);
  }

  // v14: add applied and user_notes to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'applied')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN applied INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Migration applied: jobs.applied column added');
    }
    if (!cols.some((c) => c.name === 'user_notes')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN user_notes TEXT`);
      console.log('[db] Migration applied: jobs.user_notes column added');
    }
  } catch (err) {
    console.warn('[db] Migration (applied/user_notes) failed (non-fatal):', (err as Error).message);
  }

  // v15: add apply_url to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'apply_url')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN apply_url TEXT`);
      console.log('[db] Migration applied: jobs.apply_url column added');
    }
  } catch (err) {
    console.warn('[db] Migration (apply_url column) failed (non-fatal):', (err as Error).message);
  }

  // v21: add scraping_provider to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'scraping_provider')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scraping_provider TEXT NOT NULL DEFAULT 'harvestapi'`);
      console.log('[db] Migration v21: settings.scraping_provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v21 (scraping_provider) failed (non-fatal):', (err as Error).message);
  }

  // v21: add provider to jobs
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'provider')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'harvestapi'`);
      console.log('[db] Migration v21: jobs.provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v21 (jobs.provider) failed (non-fatal):', (err as Error).message);
  }

  // v22: add scraping_provider to search_runs
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'scraping_provider')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN scraping_provider TEXT`);
      console.log('[db] Migration v22: search_runs.scraping_provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v22 (search_runs.scraping_provider) failed (non-fatal):', (err as Error).message);
  }

  // v16: add structured prompt fields to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_description')) {
      db.exec(`ALTER TABLE settings ADD COLUMN profile_description TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.profile_description column added');
    }
    if (!cols.some((c) => c.name === 'scoring_criteria')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scoring_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.scoring_criteria column added');
    }
    if (!cols.some((c) => c.name === 'scoring_guide')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scoring_guide TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.scoring_guide column added');
    }
    if (!cols.some((c) => c.name === 'no_match_criteria')) {
      db.exec(`ALTER TABLE settings ADD COLUMN no_match_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.no_match_criteria column added');
    }
  } catch (err) {
    console.warn('[db] Migration (structured prompt settings fields) failed (non-fatal):', (err as Error).message);
  }

  // v16: add per-group prompt fields to search_groups
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'industries_list')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN industries_list TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.industries_list column added');
    }
    if (!cols.some((c) => c.name === 'other_expectations')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN other_expectations TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.other_expectations column added');
    }
    if (!cols.some((c) => c.name === 'profile_description')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN profile_description TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.profile_description column added');
    }
    if (!cols.some((c) => c.name === 'scoring_criteria')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN scoring_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.scoring_criteria column added');
    }
    if (!cols.some((c) => c.name === 'scoring_guide')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN scoring_guide TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.scoring_guide column added');
    }
    if (!cols.some((c) => c.name === 'no_match_criteria')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN no_match_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.no_match_criteria column added');
    }
  } catch (err) {
    console.warn('[db] Migration (search_groups prompt fields) failed (non-fatal):', (err as Error).message);
  }

  // v20: add cost columns to search_runs
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cost_openai_usd')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN cost_openai_usd REAL`);
      db.exec(`ALTER TABLE search_runs ADD COLUMN cost_apify_usd REAL`);
      console.log('[db] Migration v20: search_runs cost columns added');
    }
  } catch (err) {
    console.warn('[db] Migration v20 (cost columns) failed (non-fatal):', (err as Error).message);
  }

  // v19: add schedule_group_ids to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schedule_group_ids')) {
      db.exec(`ALTER TABLE settings ADD COLUMN schedule_group_ids TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.schedule_group_ids column added');
    }
  } catch (err) {
    console.warn('[db] Migration (schedule_group_ids) failed (non-fatal):', (err as Error).message);
  }

  // v18: add schedule_date_range to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schedule_date_range')) {
      db.exec(`ALTER TABLE settings ADD COLUMN schedule_date_range TEXT NOT NULL DEFAULT '24h'`);
      console.log('[db] Migration applied: settings.schedule_date_range column added');
    }
  } catch (err) {
    console.warn('[db] Migration (schedule_date_range) failed (non-fatal):', (err as Error).message);
  }

  // v17: multi-profile — add profile_id to all major tables

  // settings: recreate without CHECK(id=1) constraint, add profile_id, seed Arina's row
  try {
    const cols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      // Create new table without CHECK constraint
      db.exec(`
        CREATE TABLE settings_v17 (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id             INTEGER NOT NULL DEFAULT 1,
          search_keywords        TEXT    NOT NULL DEFAULT '',
          search_locations       TEXT    NOT NULL DEFAULT '',
          search_work_modes      TEXT    NOT NULL DEFAULT '',
          search_job_type        TEXT    NOT NULL DEFAULT 'fullTime',
          cron_schedule          TEXT    NOT NULL DEFAULT '0 7 * * *',
          ai_system_prompt       TEXT    NOT NULL DEFAULT '',
          ai_model               TEXT    NOT NULL DEFAULT 'gpt-5.4',
          dedup_system_prompt    TEXT    NOT NULL DEFAULT '',
          score_no_match_max     INTEGER NOT NULL DEFAULT 50,
          score_weak_match_max   INTEGER NOT NULL DEFAULT 70,
          score_strong_match_min INTEGER NOT NULL DEFAULT 71,
          email_recipient        TEXT    NOT NULL DEFAULT '',
          email_send_time        TEXT    NOT NULL DEFAULT '07:00',
          summary_prompt         TEXT    NOT NULL DEFAULT '',
          apify_api_token        TEXT    NOT NULL DEFAULT '',
          openai_api_key         TEXT    NOT NULL DEFAULT '',
          resend_api_key         TEXT    NOT NULL DEFAULT '',
          email_from             TEXT    NOT NULL DEFAULT '',
          email_enabled          INTEGER NOT NULL DEFAULT 1,
          timezone               TEXT    NOT NULL DEFAULT 'UTC',
          profile_description    TEXT    NOT NULL DEFAULT '',
          scoring_criteria       TEXT    NOT NULL DEFAULT '',
          scoring_guide          TEXT    NOT NULL DEFAULT '',
          no_match_criteria      TEXT    NOT NULL DEFAULT '',
          updated_at             TEXT    NOT NULL DEFAULT ''
        )
      `);
      db.exec(`
        INSERT INTO settings_v17
          SELECT id, 1,
            COALESCE(search_keywords,''), COALESCE(search_locations,''),
            COALESCE(search_work_modes,''), COALESCE(search_job_type,'fullTime'),
            COALESCE(cron_schedule,'0 7 * * *'), COALESCE(ai_system_prompt,''),
            COALESCE(ai_model,'gpt-5.4'), COALESCE(dedup_system_prompt,''),
            COALESCE(score_no_match_max,50), COALESCE(score_weak_match_max,70),
            COALESCE(score_strong_match_min,71),
            COALESCE(email_recipient,''), COALESCE(email_send_time,'07:00'),
            COALESCE(summary_prompt,''), COALESCE(apify_api_token,''),
            COALESCE(openai_api_key,''), COALESCE(resend_api_key,''),
            COALESCE(email_from,''), COALESCE(email_enabled,1),
            COALESCE(timezone,'UTC'), COALESCE(profile_description,''),
            COALESCE(scoring_criteria,''), COALESCE(scoring_guide,''),
            COALESCE(no_match_criteria,''), COALESCE(updated_at,'')
          FROM settings WHERE id = 1
      `);
      db.exec(`DROP TABLE settings`);
      db.exec(`ALTER TABLE settings_v17 RENAME TO settings`);
      // Seed Arina's row: clone API keys but clear email_recipient and profile prompts
      db.exec(`
        INSERT INTO settings
          SELECT NULL, 2,
            search_keywords, search_locations, search_work_modes, search_job_type,
            cron_schedule, ai_system_prompt, ai_model, dedup_system_prompt,
            score_no_match_max, score_weak_match_max, score_strong_match_min,
            '', email_send_time, summary_prompt,
            apify_api_token, openai_api_key, resend_api_key, email_from,
            email_enabled, timezone,
            '', '', '', '', updated_at
          FROM settings WHERE profile_id = 1
      `);
      console.log('[db] Migration v17: settings recreated with profile_id, Arina row seeded');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (settings) failed (non-fatal):', (err as Error).message);
  }

  // search_groups: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(search_groups)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      // Assign "Head of marketing" group to Arina
      db.prepare(`UPDATE search_groups SET profile_id = 2 WHERE group_name = 'Head of marketing'`).run();
      console.log('[db] Migration v17: search_groups.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (search_groups.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // jobs: add profile_id, populate from group
  try {
    const cols = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      // Jobs whose group belongs to Arina → set profile_id=2
      db.exec(`
        UPDATE jobs SET profile_id = 2
        WHERE group_id IN (SELECT id FROM search_groups WHERE profile_id = 2)
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_profile_id ON jobs(profile_id)`);
      console.log('[db] Migration v17: jobs.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (jobs.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // search_runs: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_profile ON search_runs(profile_id)`);
      console.log('[db] Migration v17: search_runs.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (search_runs.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // blacklisted_companies: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(blacklisted_companies)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE blacklisted_companies ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_profile ON blacklisted_companies(profile_id)`);
      console.log('[db] Migration v17: blacklisted_companies.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (blacklisted_companies.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // v23: add original_ai_verdict to jobs (tracks AI's first verdict before user overrides)
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'original_ai_verdict')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN original_ai_verdict TEXT`);
      // Backfill: treat current ai_verdict as the original for pre-existing rows
      db.exec(`UPDATE jobs SET original_ai_verdict = ai_verdict WHERE original_ai_verdict IS NULL`);
      console.log('[db] Migration v23: jobs.original_ai_verdict column added and backfilled');
    }
  } catch (err) {
    console.warn('[db] Migration v23 (original_ai_verdict) failed (non-fatal):', (err as Error).message);
  }

  // v8: seed default search group from settings row if groups table is empty
  try {
    const groupCount = (
      db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }
    ).c;
    if (groupCount === 0) {
      const settings = db
        .prepare('SELECT * FROM settings WHERE id = 1')
        .get() as SettingsRow | undefined;
      if (settings) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO search_groups (locations, keywords, job_type, work_modes, ai_system_prompt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          settings.search_locations,
          settings.search_keywords,
          settings.search_job_type,
          settings.search_work_modes,
          settings.ai_system_prompt,
          now,
          now,
        );
        console.log('[db] Migration applied: default search group seeded from settings.');
      }
    }
  } catch (err) {
    console.warn('[db] Migration (seed default group) failed (non-fatal):', (err as Error).message);
  }
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_groups (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id              INTEGER NOT NULL DEFAULT 1,
      locations               TEXT    NOT NULL,
      keywords                TEXT    NOT NULL,
      job_type                TEXT    NOT NULL DEFAULT 'fullTime',
      work_modes              TEXT    NOT NULL,
      ai_system_prompt        TEXT    NOT NULL,
      score_no_match_max      INTEGER NOT NULL DEFAULT 50,
      score_weak_match_max    INTEGER NOT NULL DEFAULT 70,
      score_strong_match_min  INTEGER NOT NULL DEFAULT 71,
      created_at              TEXT    NOT NULL,
      updated_at              TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id            INTEGER NOT NULL DEFAULT 1,
      linkedin_job_id       TEXT    UNIQUE NOT NULL,
      title                 TEXT    NOT NULL,
      company               TEXT    NOT NULL,
      location              TEXT,
      work_mode             TEXT,
      description           TEXT    NOT NULL,
      url                   TEXT,
      posted_date           TEXT,
      fetched_at            TEXT    NOT NULL,
      ai_score              INTEGER NOT NULL,
      ai_rationale          TEXT,
      ai_summary            TEXT,
      ai_verdict            TEXT    NOT NULL,
      is_duplicate          INTEGER NOT NULL DEFAULT 0,
      duplicate_of_job_id   INTEGER,
      seen                  INTEGER NOT NULL DEFAULT 0,
      seen_at               TEXT,
      group_id              INTEGER REFERENCES search_groups(id),
      provider              TEXT    NOT NULL DEFAULT 'harvestapi',
      original_ai_verdict   TEXT,
      FOREIGN KEY (duplicate_of_job_id) REFERENCES jobs(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_linkedin_id ON jobs(linkedin_job_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_company       ON jobs(company);
    CREATE INDEX IF NOT EXISTS idx_jobs_seen          ON jobs(seen);
    CREATE INDEX IF NOT EXISTS idx_jobs_verdict       ON jobs(ai_verdict);
    CREATE INDEX IF NOT EXISTS idx_jobs_fetched_at    ON jobs(fetched_at);

    CREATE TABLE IF NOT EXISTS search_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id          INTEGER NOT NULL DEFAULT 1,
      ran_at              TEXT    NOT NULL,
      jobs_fetched        INTEGER NOT NULL DEFAULT 0,
      jobs_scored         INTEGER NOT NULL DEFAULT 0,
      jobs_strong_match   INTEGER NOT NULL DEFAULT 0,
      jobs_weak_match     INTEGER NOT NULL DEFAULT 0,
      jobs_no_match       INTEGER NOT NULL DEFAULT 0,
      jobs_duplicate      INTEGER NOT NULL DEFAULT 0,
      status              TEXT    NOT NULL DEFAULT 'success',
      error_log           TEXT,
      duration_ms         INTEGER,
      trigger             TEXT    NOT NULL DEFAULT 'scheduled'
    );

    CREATE INDEX IF NOT EXISTS idx_runs_ran_at ON search_runs(ran_at);

    CREATE TABLE IF NOT EXISTS run_job_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER NOT NULL,
      group_id            INTEGER,
      linkedin_job_id     TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      company             TEXT    NOT NULL,
      location            TEXT,
      url                 TEXT,
      ai_score            INTEGER,
      ai_verdict          TEXT    NOT NULL,
      ai_rationale        TEXT,
      rejection_category  TEXT,
      logged_at           TEXT    NOT NULL,
      FOREIGN KEY (run_id)   REFERENCES search_runs(id),
      FOREIGN KEY (group_id) REFERENCES search_groups(id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_job_logs_run_id ON run_job_logs(run_id);

    CREATE TABLE IF NOT EXISTS blacklisted_companies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL DEFAULT 1,
      company_name TEXT    NOT NULL,
      notes        TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL,
      UNIQUE (profile_id, company_name)
    );


    CREATE TABLE IF NOT EXISTS settings (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id             INTEGER NOT NULL DEFAULT 1,
      search_keywords        TEXT    NOT NULL DEFAULT '',
      search_locations       TEXT    NOT NULL DEFAULT '',
      search_work_modes      TEXT    NOT NULL DEFAULT '',
      search_job_type        TEXT    NOT NULL DEFAULT 'fullTime',
      cron_schedule          TEXT    NOT NULL DEFAULT '0 7 * * *',
      ai_system_prompt       TEXT    NOT NULL DEFAULT '',
      ai_model               TEXT    NOT NULL DEFAULT 'gpt-5.4',
      dedup_system_prompt    TEXT    NOT NULL DEFAULT '',
      score_no_match_max     INTEGER NOT NULL DEFAULT 50,
      score_weak_match_max   INTEGER NOT NULL DEFAULT 70,
      score_strong_match_min INTEGER NOT NULL DEFAULT 71,
      email_recipient        TEXT    NOT NULL DEFAULT '',
      email_send_time        TEXT    NOT NULL DEFAULT '07:00',
      summary_prompt         TEXT    NOT NULL DEFAULT '',
      apify_api_token        TEXT    NOT NULL DEFAULT '',
      openai_api_key         TEXT    NOT NULL DEFAULT '',
      resend_api_key         TEXT    NOT NULL DEFAULT '',
      email_from             TEXT    NOT NULL DEFAULT '',
      email_enabled          INTEGER NOT NULL DEFAULT 1,
      timezone               TEXT    NOT NULL DEFAULT 'UTC',
      profile_description    TEXT    NOT NULL DEFAULT '',
      scoring_criteria       TEXT    NOT NULL DEFAULT '',
      scoring_guide          TEXT    NOT NULL DEFAULT '',
      no_match_criteria      TEXT    NOT NULL DEFAULT '',
      scraping_provider      TEXT    NOT NULL DEFAULT 'harvestapi',
      updated_at             TEXT    NOT NULL DEFAULT ''
    );
  `);
}

// Create profile_id indexes after migrations have added the columns (safe with IF NOT EXISTS)
function ensureProfileIndexes(db: Database): void {
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_profile_id ON jobs(profile_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_profile ON search_runs(profile_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_profile ON blacklisted_companies(profile_id)`); } catch (_) {}
}

function seedSettings(db: Database): void {
  const now = new Date().toISOString();

  // Seed Mikhail's settings (profile_id=1)
  const existing1 = db.prepare('SELECT id FROM settings WHERE profile_id = 1').get();
  if (!existing1) {
    db.prepare(`
      INSERT INTO settings (
        profile_id, search_keywords, search_locations, search_work_modes,
        search_job_type, cron_schedule, ai_system_prompt, ai_model,
        dedup_system_prompt,
        score_no_match_max, score_weak_match_max, score_strong_match_min,
        email_recipient, email_send_time, updated_at
      ) VALUES (
        1, ?, ?, ?,
        'fullTime', '0 7 * * *', ?, 'gpt-5.4',
        ?,
        50, 70, 71,
        '', '07:00', ?
      )
    `).run(
      DEFAULT_KEYWORDS,
      DEFAULT_LOCATIONS,
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      DEFAULT_DEDUP_SYSTEM_PROMPT,
      now,
    );
    console.log('[db] Settings seeded for Mikhail (profile_id=1).');
  }

  // Seed Arina's settings (profile_id=2)
  const existing2 = db.prepare('SELECT id FROM settings WHERE profile_id = 2').get();
  if (!existing2) {
    db.prepare(`
      INSERT INTO settings (
        profile_id, search_keywords, search_locations, search_work_modes,
        search_job_type, cron_schedule, ai_system_prompt, ai_model,
        dedup_system_prompt,
        score_no_match_max, score_weak_match_max, score_strong_match_min,
        email_recipient, email_send_time, updated_at
      ) VALUES (
        2, ?, ?, ?,
        'fullTime', '0 7 * * *', ?, 'gpt-5.4',
        ?,
        50, 70, 71,
        '', '07:00', ?
      )
    `).run(
      DEFAULT_KEYWORDS,
      DEFAULT_LOCATIONS,
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      DEFAULT_DEDUP_SYSTEM_PROMPT,
      now,
    );
    console.log('[db] Settings seeded for Arina (profile_id=2).');
  }

  // Also seed the first search group for brand-new installs (under Mikhail)
  const groupCount = (
    db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }
  ).c;
  if (groupCount === 0) {
    db.prepare(`
      INSERT INTO search_groups (profile_id, locations, keywords, job_type, work_modes, ai_system_prompt, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_LOCATIONS,
      DEFAULT_KEYWORDS,
      'fullTime',
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      now,
      now,
    );
  }
}

// ---- Row types ----

export interface JobRow {
  id: number;
  profile_id: number;
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  description: string;
  url: string | null;
  posted_date: string | null;
  fetched_at: string;
  ai_score: number;
  ai_rationale: string | null;
  ai_summary: string | null;
  ai_verdict: string;
  rejection_category: string | null;
  is_duplicate: number;
  duplicate_of_job_id: number | null;
  seen: number;
  seen_at: string | null;
  group_id: number | null;
  applied: number;
  user_notes: string | null;
  apply_url: string | null;
  provider: string;
  original_ai_verdict: string | null;
}

export interface SearchRunRow {
  id: number;
  profile_id: number;
  ran_at: string;
  jobs_fetched: number;
  jobs_scored: number;
  jobs_strong_match: number;
  jobs_weak_match: number;
  jobs_no_match: number;
  jobs_duplicate: number;
  status: string;
  error_log: string | null;
  duration_ms: number | null;
  trigger: string;
  cost_openai_usd: number | null;
  cost_apify_usd: number | null;
  scraping_provider: string | null;
}

export interface SettingsRow {
  id: number;
  profile_id: number;
  search_keywords: string;
  search_locations: string;
  search_work_modes: string;
  search_job_type: string;
  cron_schedule: string;
  ai_system_prompt: string;
  ai_model: string;
  dedup_system_prompt: string;
  summary_prompt: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
  email_recipient: string;
  email_send_time: string;
  apify_api_token: string;
  openai_api_key: string;
  resend_api_key: string;
  email_from: string;
  email_enabled: number;  // 1 = send email, 0 = skip
  timezone: string;       // IANA timezone, e.g. 'Europe/London'
  profile_description: string;
  scoring_criteria: string;
  scoring_guide: string;
  no_match_criteria: string;
  schedule_date_range: string;  // '24h' | '7d' | 'month'
  schedule_group_ids: string;   // JSON number[] | '' for all active
  scraping_provider: string;    // 'harvestapi' | 'valig'
  updated_at: string;
}

export interface RunJobLogRow {
  id: number;
  run_id: number;
  group_id: number | null;
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  ai_score: number | null;
  ai_verdict: string;
  ai_rationale: string | null;
  rejection_category: string | null;
  logged_at: string;
}

export interface BlacklistedCompanyRow {
  id: number;
  profile_id: number;
  company_name: string;
  notes: string;
  created_at: string;
}

export interface SearchGroupRow {
  id: number;
  profile_id: number;
  group_name: string;
  locations: string;         // JSON string[]
  keywords: string;          // JSON string[]
  job_type: string;
  work_modes: string;        // JSON string[]
  ai_system_prompt: string;
  title_filter: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
  profile_description: string;
  industries_list: string;
  other_expectations: string;
  scoring_criteria: string;
  scoring_guide: string;
  no_match_criteria: string;
  is_active: number;         // 1 = active, 0 = inactive
  created_at: string;
  updated_at: string;
}
