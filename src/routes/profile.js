import { Router } from 'express';
import { getProfile, saveProfile, senderFor, hasOffer, TONES } from '../services/account-profile.js';
import { requireAccountOwner } from '../middleware/auth.js';

// The signed-in account's brief: its offer, the claims it may make, who its
// email comes from, and whether outreach waits for approval. Each account
// reads and writes only its own row (keyed by req.user.id). Teammates read it;
// only the owner changes it — it decides where prospects' replies go and
// whether anything is sent without approval.
const router = Router();

function view(userId) {
  const profile = getProfile(userId);
  const sender = senderFor(userId);
  return {
    profile,
    ready: hasOffer(profile),
    tones: TONES,
    sender,
    from_domain_verified: profile.from_email ? sender.from === profile.from_email : null,
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

export default router;
