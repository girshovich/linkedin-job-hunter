/**
 * API Routes — Manual run trigger, test email, status, group CRUD.
 */

import { Router, type Request, type Response } from 'express';
import { runPipeline, getIsRunning, getRunStatus } from '../pipeline/runner';
import { sendTestEmail } from '../pipeline/emailReport';
import { fetchJobs } from '../pipeline/fetcher';
import { startSchedule, stopSchedule, getScheduleStatus } from '../pipeline/scheduler';
import { getDb, type SettingsRow, type SearchGroupRow, type BlacklistedCompanyRow } from '../db';
import { config } from '../config';
import { checkOpenAiBalance } from '../utils/openaiBalance';

const router = Router();

// Pre-flight check — validates everything required to run the pipeline
router.get('/preflight', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow;
    const activeGroups = db
      .prepare('SELECT * FROM search_groups WHERE is_active = 1 ORDER BY id ASC')
      .all() as SearchGroupRow[];

    const errors: string[] = [];

    const openAiKey = settings?.openai_api_key?.trim() || config.openAiKey?.trim();
    const apifyKey  = settings?.apify_api_token?.trim() || config.apifyApiToken?.trim();

    if (!openAiKey)  errors.push('OpenAI API key is not set — add it in Settings → API Keys.');
    if (!apifyKey)   errors.push('Apify API token is not set — add it in Settings → API Keys.');

    if (activeGroups.length === 0) {
      errors.push('No active Roles configured — add at least one Role in Settings.');
    } else {
      for (const g of activeGroups) {
        if (!g.ai_system_prompt?.trim()) {
          const name = g.group_name ? `"${g.group_name}"` : `#${g.id}`;
          errors.push(`Role ${name} has no AI scoring prompt — edit the Role in Settings.`);
        }
      }
    }

    if (!settings?.dedup_system_prompt?.trim())
      errors.push('Deduplication prompt is empty — fill it in Settings → AI Settings.');
    if (!settings?.summary_prompt?.trim())
      errors.push('Summary prompt is empty — fill it in Settings → AI Settings.');

    res.json({ ok: errors.length === 0, errors });
  } catch (err) {
    res.json({ ok: false, errors: ['Failed to check configuration: ' + (err as Error).message] });
  }
});

// Trigger a manual pipeline run
router.post('/run', async (_req: Request, res: Response) => {
  if (getIsRunning()) {
    res.status(409).json({ success: false, error: 'Pipeline is already running.' });
    return;
  }

  // Respond immediately, run in background
  res.json({ success: true, message: 'Pipeline started. Check dashboard for results.' });

  runPipeline('manual').catch((err) => {
    console.error('[api] Manual pipeline run failed:', err);
  });
});

// Pipeline status (used by Run Now polling)
router.get('/status', (_req: Request, res: Response) => {
  const { isRunning, lastRun } = getRunStatus();

  // Also fetch the latest DB run for the dashboard card
  const db = getDb();
  const lastDbRun = db
    .prepare('SELECT * FROM search_runs ORDER BY ran_at DESC LIMIT 1')
    .get();

  res.json({
    isRunning,
    lastRun: lastRun || lastDbRun || null,
  });
});

// Send test email
router.post('/test-email', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow;
    const resendApiKey = settings.resend_api_key || config.resendApiKey;
    const emailFrom = settings.email_from || config.emailFrom;
    await sendTestEmail(settings.email_recipient, resendApiKey, emailFrom);
    res.json({ success: true, message: `Test email sent to ${settings.email_recipient}` });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ---- API Key Tests ----

router.post('/test/apify', async (req: Request, res: Response) => {
  const token = String((req.body as Record<string, unknown>).token || '').trim();
  if (!token) {
    res.status(400).json({ success: false, error: 'No token provided.' });
    return;
  }
  try {
    const response = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Apify API error ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json() as { data?: { username?: string } };
    const username = data?.data?.username || 'unknown';
    res.json({ success: true, message: `Connected as ${username}` });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

router.post('/test/openai', async (req: Request, res: Response) => {
  const key = String((req.body as Record<string, unknown>).token || '').trim();
  if (!key) {
    res.status(400).json({ success: false, error: 'No API key provided.' });
    return;
  }
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: key });
    await client.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: 'Say ok' }],
      max_output_tokens: 16,
    });
    res.json({ success: true, message: 'OpenAI key is valid.' });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

router.post('/test/resend', async (req: Request, res: Response) => {
  const key = String((req.body as Record<string, unknown>).token || '').trim();
  if (!key) {
    res.status(400).json({ success: false, error: 'No API key provided.' });
    return;
  }
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(key);
    const { data, error } = await resend.domains.list();
    if (error) {
      // A "restricted to send emails only" error means auth passed — key is valid, just limited scope
      if (error.message?.toLowerCase().includes('restricted')) {
        res.json({ success: true, message: 'Resend key is valid (email-only permissions).' });
        return;
      }
      throw new Error(error.message);
    }
    const count = (data as { data?: unknown[] })?.data?.length ?? 0;
    res.json({ success: true, message: `Resend key is valid. ${count} domain(s) configured.` });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// Fetch-only preview — runs the Apify actor for all groups, returns raw job list, no scoring/storage
router.post('/fetch-preview', async (_req: Request, res: Response) => {
  if (getIsRunning()) {
    res.status(409).json({ success: false, error: 'Pipeline is already running.' });
    return;
  }

  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow;
    const apifyToken = settings.apify_api_token || config.apifyApiToken;
    const groups = db.prepare('SELECT * FROM search_groups ORDER BY id ASC').all() as SearchGroupRow[];
    if (groups.length === 0) {
      res.json({ success: true, count: 0, jobs: [] });
      return;
    }

    const allJobs: Array<{ title: string; company: string; url: string }> = [];

    for (const group of groups) {
      if (!group.is_active) continue;

      const keywords: string[] = JSON.parse(group.keywords);
      const locations: string[] = JSON.parse(group.locations);
      const workModes: string[] = JSON.parse(group.work_modes);

      const jobs = await fetchJobs({ keywords, locations, workModes, jobType: group.job_type }, apifyToken);
      for (const j of jobs) {
        allJobs.push({ title: j.title, company: j.company, url: j.url });
      }
    }

    res.json({ success: true, count: allJobs.length, jobs: allJobs });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// Stats summary for dashboard polling
router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();

  const totalJobs = (db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
  const newJobs = (
    db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE seen = 0 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`).get() as { c: number }
  ).c;
  const lastRun = db.prepare('SELECT * FROM search_runs ORDER BY ran_at DESC LIMIT 1').get();

  res.json({ totalJobs, newJobs, lastRun, isRunning: getIsRunning() });
});

// ---- Cron Schedule ----

router.get('/schedule/status', (_req: Request, res: Response) => {
  const db = getDb();
  const settings = db.prepare('SELECT email_send_time, timezone FROM settings WHERE id = 1').get() as Pick<SettingsRow, 'email_send_time' | 'timezone'> | undefined;
  res.json({
    success: true,
    ...getScheduleStatus(),
    email_send_time: settings?.email_send_time || '07:00',
    timezone: settings?.timezone || 'Asia/Yerevan',
  });
});

router.post('/schedule/start', async (req: Request, res: Response) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;

  // If time/tz provided in body, save to DB first
  const emailSendTime = String(b.email_send_time || '').trim() || null;
  const timezone = String(b.timezone || '').trim() || null;

  if (emailSendTime || timezone) {
    const updates: string[] = [];
    const params: unknown[] = [];
    if (emailSendTime) {
      const [hStr, mStr] = emailSendTime.split(':');
      const cronSchedule = `${parseInt(mStr || '0', 10)} ${parseInt(hStr || '7', 10)} * * *`;
      updates.push('email_send_time = ?', 'cron_schedule = ?');
      params.push(emailSendTime, cronSchedule);
    }
    if (timezone) {
      updates.push('timezone = ?');
      params.push(timezone);
    }
    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    db.prepare(`UPDATE settings SET ${updates.join(', ')} WHERE id = 1`).run(...params);
  }

  const settings = db.prepare('SELECT email_send_time, timezone FROM settings WHERE id = 1').get() as Pick<SettingsRow, 'email_send_time' | 'timezone'> | undefined;
  const [hStr, mStr] = (settings?.email_send_time || '07:00').split(':');
  const expression = `${parseInt(mStr, 10)} ${parseInt(hStr, 10)} * * *`;
  const tz = settings?.timezone || 'Asia/Yerevan';
  startSchedule(expression, tz);
  res.json({ success: true, expression, timezone: tz });
});

router.post('/schedule/stop', (_req: Request, res: Response) => {
  stopSchedule();
  res.json({ success: true });
});

// ---- Search Groups CRUD ----

interface GroupBody {
  group_name: string;
  locations: string[];
  keywords: string[];
  job_type: string;
  work_modes: string[];
  ai_system_prompt: string;
  title_filter: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
}

function parseGroupBody(body: unknown): GroupBody {
  const b = body as Record<string, unknown>;

  const locations = (Array.isArray(b.locations) ? b.locations : [])
    .map((l: unknown) => String(l).trim())
    .filter(Boolean);

  const keywords = (Array.isArray(b.keywords) ? b.keywords : [])
    .map((k: unknown) => String(k).trim())
    .filter(Boolean);

  const workModes = (Array.isArray(b.work_modes) ? b.work_modes : [])
    .map((w: unknown) => String(w).trim())
    .filter(Boolean);

  const noMatchMax   = parseInt(String(b.score_no_match_max   ?? 50), 10);
  const weakMatchMax = parseInt(String(b.score_weak_match_max ?? 70), 10);
  const strongMin    = parseInt(String(b.score_strong_match_min ?? 71), 10);

  if (locations.length === 0) throw new Error('At least one location is required.');
  if (keywords.length === 0)  throw new Error('At least one keyword is required.');
  if (workModes.length === 0) throw new Error('At least one work mode is required.');
  if (
    isNaN(noMatchMax) || isNaN(weakMatchMax) || isNaN(strongMin) ||
    noMatchMax < 0 || noMatchMax > 99 ||
    weakMatchMax <= noMatchMax || weakMatchMax > 99 ||
    strongMin !== weakMatchMax + 1
  ) {
    throw new Error(
      'Invalid score thresholds. Ensure: 0 ≤ no_match_max < weak_match_max, and strong_match_min = weak_match_max + 1',
    );
  }

  return {
    group_name: String(b.group_name || '').trim().slice(0, 50),
    locations,
    keywords,
    job_type: String(b.job_type || 'fullTime'),
    work_modes: workModes,
    ai_system_prompt: String(b.ai_system_prompt || ''),
    title_filter: String(b.title_filter || '').trim(),
    score_no_match_max: noMatchMax,
    score_weak_match_max: weakMatchMax,
    score_strong_match_min: strongMin,
  };
}

// GET /api/groups — list all groups
router.get('/groups', (_req: Request, res: Response) => {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM search_groups ORDER BY id ASC').all() as SearchGroupRow[];
  res.json({ success: true, groups });
});

// POST /api/groups — create a group
router.post('/groups', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const count = (db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }).c;
    if (count >= 15) {
      res.status(409).json({ success: false, error: 'Maximum of 15 roles reached.' });
      return;
    }
    const body = parseGroupBody(req.body);
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO search_groups (group_name, locations, keywords, job_type, work_modes, ai_system_prompt, title_filter, score_no_match_max, score_weak_match_max, score_strong_match_min, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.group_name,
      JSON.stringify(body.locations),
      JSON.stringify(body.keywords),
      body.job_type,
      JSON.stringify(body.work_modes),
      body.ai_system_prompt,
      body.title_filter,
      body.score_no_match_max,
      body.score_weak_match_max,
      body.score_strong_match_min,
      now, now,
    );

    const created = db
      .prepare('SELECT * FROM search_groups WHERE id = ?')
      .get(result.lastInsertRowid) as SearchGroupRow;

    res.status(201).json({ success: true, group: created });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// PUT /api/groups/:id — update a group
router.put('/groups/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id.' });
      return;
    }

    const body = parseGroupBody(req.body);
    const db = getDb();

    const existing = db.prepare('SELECT id FROM search_groups WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Group not found.' });
      return;
    }

    db.prepare(`
      UPDATE search_groups
      SET group_name = ?, locations = ?, keywords = ?, job_type = ?, work_modes = ?, ai_system_prompt = ?,
          title_filter = ?, score_no_match_max = ?, score_weak_match_max = ?, score_strong_match_min = ?, updated_at = ?
      WHERE id = ?
    `).run(
      body.group_name,
      JSON.stringify(body.locations),
      JSON.stringify(body.keywords),
      body.job_type,
      JSON.stringify(body.work_modes),
      body.ai_system_prompt,
      body.title_filter,
      body.score_no_match_max,
      body.score_weak_match_max,
      body.score_strong_match_min,
      new Date().toISOString(),
      id,
    );

    const updated = db
      .prepare('SELECT * FROM search_groups WHERE id = ?')
      .get(id) as SearchGroupRow;

    res.json({ success: true, group: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// PATCH /api/groups/:id — toggle is_active only
router.patch('/groups/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid group id.' });
    return;
  }

  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const isActive = b.is_active === true || b.is_active === 1;

  const existing = db.prepare('SELECT * FROM search_groups WHERE id = ?').get(id) as import('../db').SearchGroupRow | undefined;
  if (!existing) {
    res.status(404).json({ success: false, error: 'Group not found.' });
    return;
  }

  // When activating, check no other active group shares a location
  if (isActive) {
    const myLocations: string[] = JSON.parse(existing.locations);
    const otherActive = db
      .prepare('SELECT * FROM search_groups WHERE is_active = 1 AND id != ?')
      .all(id) as import('../db').SearchGroupRow[];

    for (const other of otherActive) {
      const otherLocations: string[] = JSON.parse(other.locations);
      const conflict = myLocations.find((loc) => otherLocations.includes(loc));
      if (conflict) {
        const label = other.group_name ? `"${other.group_name}"` : `Group ${other.id}`;
        res.status(409).json({
          success: false,
          error: `Another active group (${label}) already uses location "${conflict}". Deactivate it first.`,
        });
        return;
      }
    }
  }

  db.prepare('UPDATE search_groups SET is_active = ?, updated_at = ? WHERE id = ?').run(
    isActive ? 1 : 0,
    new Date().toISOString(),
    id,
  );

  const updated = db.prepare('SELECT * FROM search_groups WHERE id = ?').get(id) as import('../db').SearchGroupRow;
  res.json({ success: true, group: updated });
});

// DELETE /api/groups/:id — delete a group (blocked if it's the last one)
router.delete('/groups/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid group id.' });
    return;
  }

  const db = getDb();

  const count = (
    db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }
  ).c;
  if (count <= 1) {
    res.status(409).json({ success: false, error: 'Cannot delete the last role.' });
    return;
  }

  try {
    db.transaction(() => {
      // Orphan any referencing rows (data is preserved, group_id → null)
      db.prepare('UPDATE jobs SET group_id = NULL WHERE group_id = ?').run(id);
      db.prepare('UPDATE run_job_logs SET group_id = NULL WHERE group_id = ?').run(id);
      const changes = db.prepare('DELETE FROM search_groups WHERE id = ?').run(id).changes;
      if (changes === 0) throw Object.assign(new Error('Group not found.'), { status: 404 });
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ success: false, error: (err as Error).message });
    return;
  }

  res.json({ success: true });
});

// PATCH /api/jobs/:id/verdict — override a job's verdict
router.patch('/jobs/:id/verdict', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid job id.' });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const verdict = String(b.verdict || '').trim();
  const allowed = ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE'];
  if (!allowed.includes(verdict)) {
    res.status(400).json({ success: false, error: `Invalid verdict. Must be one of: ${allowed.join(', ')}` });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ success: false, error: 'Job not found.' });
    return;
  }

  db.prepare('UPDATE jobs SET ai_verdict = ?, is_duplicate = ? WHERE id = ?').run(
    verdict,
    verdict === 'DUPLICATE' ? 1 : 0,
    id,
  );

  res.json({ success: true });
});

// PATCH /api/jobs/:id/applied — mark/unmark as applied
router.patch('/jobs/:id/applied', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid job id.' }); return; }
  const b = req.body as Record<string, unknown>;
  const applied = b.applied === true || b.applied === 1 ? 1 : 0;
  const db = getDb();
  const changes = db.prepare('UPDATE jobs SET applied = ? WHERE id = ?').run(applied, id).changes;
  if (!changes) { res.status(404).json({ success: false, error: 'Job not found.' }); return; }
  res.json({ success: true });
});

// PATCH /api/jobs/:id/notes — save user notes
router.patch('/jobs/:id/notes', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid job id.' }); return; }
  const b = req.body as Record<string, unknown>;
  const notes = String(b.notes ?? '').trim().slice(0, 5000);
  const db = getDb();
  const changes = db.prepare('UPDATE jobs SET user_notes = ? WHERE id = ?').run(notes || null, id).changes;
  if (!changes) { res.status(404).json({ success: false, error: 'Job not found.' }); return; }
  res.json({ success: true });
});

// GET /api/check-openai-balance — check remaining OpenAI credit for the configured key
router.get('/check-openai-balance', async (_req: Request, res: Response) => {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | undefined;
  const apiKey = settings?.openai_api_key || config.openAiKey;
  if (!apiKey) {
    res.json({ success: false, error: 'No OpenAI API key configured in Settings.' });
    return;
  }
  try {
    const result = await checkOpenAiBalance(apiKey);
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ success: false, error: msg });
  }
});

// ---- Company Blacklist CRUD ----

// GET /api/blacklist
router.get('/blacklist', (_req: Request, res: Response) => {
  const db = getDb();
  const entries = db
    .prepare('SELECT * FROM blacklisted_companies ORDER BY company_name ASC')
    .all() as BlacklistedCompanyRow[];
  res.json({ success: true, entries });
});

// POST /api/blacklist
router.post('/blacklist', (req: Request, res: Response) => {
  try {
    const b = req.body as Record<string, unknown>;
    const companyName = String(b.company_name || '').trim();
    const notes = String(b.notes || '').trim();

    if (!companyName) {
      res.status(400).json({ success: false, error: 'Company name is required.' });
      return;
    }

    const db = getDb();
    const result = db
      .prepare('INSERT INTO blacklisted_companies (company_name, notes, created_at) VALUES (?, ?, ?)')
      .run(companyName, notes, new Date().toISOString());

    const created = db
      .prepare('SELECT * FROM blacklisted_companies WHERE id = ?')
      .get(result.lastInsertRowid) as BlacklistedCompanyRow;

    res.status(201).json({ success: true, entry: created });
  } catch (err) {
    const msg = (err as Error).message;
    const isDupe = msg.includes('UNIQUE');
    res.status(400).json({ success: false, error: isDupe ? 'That company is already blacklisted.' : msg });
  }
});

// PUT /api/blacklist/:id
router.put('/blacklist/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid id.' }); return; }

  try {
    const b = req.body as Record<string, unknown>;
    const companyName = String(b.company_name || '').trim();
    const notes = String(b.notes || '').trim();

    if (!companyName) {
      res.status(400).json({ success: false, error: 'Company name is required.' });
      return;
    }

    const db = getDb();
    const changes = db
      .prepare('UPDATE blacklisted_companies SET company_name = ?, notes = ? WHERE id = ?')
      .run(companyName, notes, id).changes;

    if (changes === 0) { res.status(404).json({ success: false, error: 'Entry not found.' }); return; }

    const updated = db
      .prepare('SELECT * FROM blacklisted_companies WHERE id = ?')
      .get(id) as BlacklistedCompanyRow;

    res.json({ success: true, entry: updated });
  } catch (err) {
    const msg = (err as Error).message;
    const isDupe = msg.includes('UNIQUE');
    res.status(400).json({ success: false, error: isDupe ? 'That company is already blacklisted.' : msg });
  }
});

// DELETE /api/blacklist/:id
router.delete('/blacklist/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid id.' }); return; }

  const db = getDb();
  const changes = db.prepare('DELETE FROM blacklisted_companies WHERE id = ?').run(id).changes;

  if (changes === 0) { res.status(404).json({ success: false, error: 'Entry not found.' }); return; }

  res.json({ success: true });
});

export { router as apiRouter };
