/**
 * Settings Routes — Global settings only (AI model, score thresholds, email, cron).
 * Per-location config (keywords, filters, AI prompt) is managed via /api/groups.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SettingsRow, type SearchGroupRow } from '../db';

const router = Router();

function getGroups(db: ReturnType<typeof getDb>, profileId: number): SearchGroupRow[] {
  return db.prepare('SELECT * FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as SearchGroupRow[];
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
  res.render('settings', { settings, groups: getGroups(db, profileId), title: 'Settings', saved: false, error: null });
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  try {
    const body = req.body as Record<string, string | string[]>;

    const provider = String(body.scraping_provider || 'harvestapi');
    const validProviders = ['harvestapi', 'valig'];

    db.prepare(`
      UPDATE settings SET
        ai_model = ?,
        dedup_system_prompt = ?,
        summary_prompt = ?,
        email_recipient = ?,
        apify_api_token = ?,
        openai_api_key = ?,
        resend_api_key = ?,
        email_from = ?,
        email_enabled = ?,
        scraping_provider = ?,
        updated_at = ?
      WHERE profile_id = ?
    `).run(
      String(body.ai_model || 'gpt-5.4'),
      String(body.dedup_system_prompt || ''),
      String(body.summary_prompt || ''),
      String(body.email_recipient || ''),
      String(body.apify_api_token || ''),
      String(body.openai_api_key || ''),
      String(body.resend_api_key || ''),
      String(body.email_from || ''),
      (body.email_enabled === 'on' || body.email_enabled === '1') ? 1 : 0,
      validProviders.includes(provider) ? provider : 'harvestapi',
      new Date().toISOString(),
      profileId,
    );

    const updated = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    res.render('settings', { settings: updated, groups: getGroups(db, profileId), title: 'Settings', saved: true, error: null });
  } catch (err) {
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    res.status(400).render('settings', {
      settings,
      groups: getGroups(db, profileId),
      title: 'Settings',
      saved: false,
      error: (err as Error).message,
    });
  }
});

export { router as settingsRouter };
