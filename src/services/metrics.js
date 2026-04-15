import { execSync } from 'child_process';
import db from '../db/index.js';

/**
 * Auto-compute system metrics and cache in settings table.
 * Runs daily at midnight via scheduler + on first load.
 */
export async function refreshMetrics() {
  console.log('[Metrics] Refreshing system metrics...');
  try {
    const metrics = {
      ...getCodeMetrics(),
      ...getDbMetrics(),
      ...getAiCostMetrics(),
      updated_at: new Date().toISOString(),
    };

    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run('system_metrics', JSON.stringify(metrics));

    console.log('[Metrics] Cached:', JSON.stringify(metrics, null, 2));
    return metrics;
  } catch (err) {
    console.error('[Metrics] Error:', err.message);
    return null;
  }
}

function getCodeMetrics() {
  try {
    // Count source lines (src/ + public/ JS/HTML/CSS, excluding node_modules)
    const srcLines = parseInt(execSync(
      "find src -name '*.js' -exec cat {} + 2>/dev/null | wc -l",
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 }
    ).trim()) || 0;

    const publicLines = parseInt(execSync(
      "find public -name '*.js' -o -name '*.html' -o -name '*.css' | xargs cat 2>/dev/null | wc -l",
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 }
    ).trim()) || 0;

    const totalLines = srcLines + publicLines;

    // Count source files
    const srcFiles = parseInt(execSync(
      "find src -name '*.js' | wc -l",
      { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }
    ).trim()) || 0;

    const publicFiles = parseInt(execSync(
      "find public -name '*.js' -o -name '*.html' -o -name '*.css' | wc -l",
      { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }
    ).trim()) || 0;

    const totalFiles = srcFiles + publicFiles;

    // Count API endpoints (router.get/post/put/delete + app.get/post/put/delete)
    const endpoints = parseInt(execSync(
      "grep -rE '(router|app)\\.(get|post|put|delete|patch)\\(' src/ --include='*.js' | wc -l",
      { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }
    ).trim()) || 0;

    return { totalLines, totalFiles, endpoints };
  } catch (err) {
    console.error('[Metrics] Code metrics error:', err.message);
    return { totalLines: 0, totalFiles: 0, endpoints: 0 };
  }
}

function getDbMetrics() {
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();

    let totalColumns = 0;
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
      totalColumns += cols.length;
    }

    return { tables: tables.length, columns: totalColumns };
  } catch (err) {
    console.error('[Metrics] DB metrics error:', err.message);
    return { tables: 0, columns: 0 };
  }
}

function getAiCostMetrics() {
  try {
    // Average cost per action type (from real usage data)
    const byType = db.prepare(`
      SELECT task_type,
             ROUND(AVG(input_tokens), 0) as avg_input,
             ROUND(AVG(output_tokens), 0) as avg_output,
             ROUND(AVG(cost_usd), 6) as avg_cost,
             COUNT(*) as count
      FROM ai_cost_log
      WHERE task_type IS NOT NULL AND task_type != ''
      GROUP BY task_type
      HAVING count >= 3
      ORDER BY count DESC
    `).all();

    // Average cost per user this month
    const perUser = db.prepare(`
      SELECT ROUND(AVG(user_total), 4) as avg_cost_per_user
      FROM (
        SELECT user_id, SUM(cost_usd) as user_total
        FROM ai_cost_log
        WHERE created_at >= datetime('now', 'start of month')
        GROUP BY user_id
      )
    `).get();

    // Total users and active subscribers
    const userCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role != 'superadmin'").get();
    const activeCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role != 'superadmin' AND status = 'active'").get();

    return {
      aiCostByType: byType,
      avgCostPerUser: perUser?.avg_cost_per_user || 0,
      totalUsers: userCount?.count || 0,
      activeSubscribers: activeCount?.count || 0,
    };
  } catch (err) {
    console.error('[Metrics] AI cost metrics error:', err.message);
    return { aiCostByType: [], avgCostPerUser: 0, totalUsers: 0, activeSubscribers: 0 };
  }
}
