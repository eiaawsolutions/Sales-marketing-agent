import { Router } from 'express';
import { getProfile, saveProfile, senderFor, hasOffer, hasMarket, TONES, COMPANY_SIZES } from '../services/account-profile.js';
import { draftsWaiting, redraftFromBrief } from '../services/outreach-queue.js';
import { requireAccountOwner, checkPlanLimit } from '../middleware/auth.js';

// The signed-in account's brief: its offer, the claims it may make, who it
// sells to, who its email comes from, and whether outreach waits for
// approval. Each account reads and writes only its own row (keyed by
// req.user.id). Teammates read it; only the owner changes it — it decides
// where prospects' replies go and whether anything is sent without approval.
const router = Router();

function view(userId) {
  const profile = getProfile(userId);
  const sender = senderFor(userId);
  return {
    profile,
    ready: hasOffer(profile),
    market_ready: hasMarket(profile),
    tones: TONES,
    company_sizes: COMPANY_SIZES,
    sender,
    from_domain_verified: profile.from_email ? sender.from === profile.from_email : null,
    drafts_waiting: draftsWaiting(userId),
  };
}

router.get('/', (req, res) => {
  res.json(view(req.user.id));
});

router.put('/', requireAccountOwner, (req, res) => {
  const { errors } = saveProfile(req.user.id, req.body || {});
  if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
  res.json(view(req.user.id));
});

// POST /redraft — rewrite unapproved drafts from the brief as it is now.
// Approved and sent messages are never touched. Uses AI actions.
router.post('/redraft', requireAccountOwner, async (req, res) => {
  try {
    try {
      checkPlanLimit(req, 'auto_outreach');
      checkPlanLimit(req, 'ai_action');
    } catch (e) { return res.status(403).json({ error: e.message }); }
    if (!hasOffer(getProfile(req.user.id))) return res.status(400).json({ error: 'Add your business name and offer first.' });
    res.json(await redraftFromBrief(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
