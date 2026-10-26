import { Router } from 'express';
import { getProfile, saveProfile, senderFor, hasOffer, TONES, verifiedSenderDomains } from '../services/account-profile.js';

// The signed-in account's brief: its offer, the claims it may make, who its
// email comes from, and whether outreach waits for approval. Each account
// reads and writes only its own row (keyed by req.user.id).
const router = Router();

function view(userId) {
  const profile = getProfile(userId);
  const fromDomain = profile.from_email ? profile.from_email.split('@')[1] : null;
  return {
    profile,
    ready: hasOffer(profile),
    tones: TONES,
    sender: senderFor(userId),
    from_domain_verified: fromDomain ? verifiedSenderDomains().has(fromDomain) : null,
  };
}

router.get('/', (req, res) => {
  res.json(view(req.user.id));
});

router.put('/', (req, res) => {
  const { errors } = saveProfile(req.user.id, req.body || {});
  if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
  res.json(view(req.user.id));
});

export default router;
