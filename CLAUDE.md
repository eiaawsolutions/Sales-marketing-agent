# Project: EIAAW SalesAgent

## Deployment

**Production**: Railway (project: stunning-sparkle, service: Sales-marketing-agent)

**Deploy method**: `railway up --detach` from project root. Do NOT rely on GitHub auto-deploy.

**After every commit**, always deploy by running:
```bash
railway up --detach
```

The Railway CLI path on this machine: `C:\Users\User\AppData\Roaming\npm\railway`

**Cache busting**: Bump the `?v=` query string on `<script src="/app.js?v=...">` in `public/app.html` on every frontend change.

## Git

- **origin**: GitHub (https://github.com/eiaawsolutions/Sales-marketing-agent.git) — code backup only
- Push to GitHub with `git push origin main`, then deploy with `railway up --detach`
