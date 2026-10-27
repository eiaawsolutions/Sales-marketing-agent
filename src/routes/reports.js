import { Router } from 'express';
import { monthlyReport, emailMonthlyReport, currentMonth, isMonth, reportRows } from '../services/monthly-report.js';

// The monthly report for the signed-in account: the numbers the pilot is
// judged on, for any month (Malaysia time). Always read through req.user.id.
const router = Router();

router.get('/monthly', (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : currentMonth();
  const r = monthlyReport(req.user.id, month);
  res.json({ ...r, rows: reportRows(r) });
});

// Email a finished month's report to the account owner's inbox (once per month).
router.post('/monthly/email', async (req, res) => {
  const month = req.body?.month;
  if (!isMonth(month) || month >= currentMonth()) return res.status(400).json({ error: 'Pick a month that has finished.' });
  try {
    const r = await emailMonthlyReport(req.user.id, month);
    res.json({ sent: r.sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
