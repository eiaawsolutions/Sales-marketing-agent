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

**Linked service**: `railway add` re-links the CLI to the service it creates. Before any deploy, `railway status` must show `Sales-marketing-agent` as the linked service (`railway service Sales-marketing-agent`), or the app's code is uploaded to the wrong service.

## Lead tools (self-hosted, same Railway project)

Apollo was removed on 28 Oct 2026. Lead search is the Claude open-web search, plus two Railway services reachable only on the private network (no public domain):

- **crawl4ai**: image `unclecode/crawl4ai:0.9.5`, pinned by digest, port 11235. Read by `src/services/site-reader.js` for emails a company publishes on its own site. It needs `CRAWL4AI_API_TOKEN`, a reference to `${{SALES_AGENT_CRAWL4AI_API_TOKEN}}`, which Infisical's Railway sync provides. Without the token it listens only inside its own container. The token is the one secret kept in a folder, `/crawl4ai` in `eiaaw-all-projects/prod`, because an Infisical sync copies every secret in its source folder. Never point that sync at `/`.
  - Sync settings: source path `/crawl4ai` with subfolders off; destination service `crawl4ai`; initial sync "Import Secrets (Prioritize Infisical)" (never "Overwrite", which would delete `PORT` and the reference); secret deletion disabled. The Railway connection uses a project token scoped to `production`.
- **reacher**: image `reacherhq/backend:v0.11.8`, pinned by digest, listens on `::` port 8080. Used by `src/services/email-check.js` to check that a mailbox accepts mail. SMTP checks need outbound port 25.
- Sales Agent env: `CRAWL4AI_URL`, `REACHER_URL` and the `CRAWL4AI_API_TOKEN` Infisical handle. See `.env.example`.
- To verify: after each boot the deploy log prints `[lead-tools] website reader: …` and `[lead-tools] mailbox check: …` (including whether port 25 is open). The Settings page has a "Lead search tools" card with a Test button.

## Git

- **origin**: GitHub (https://github.com/eiaawsolutions/Sales-marketing-agent.git) — code backup only
- Push to GitHub with `git push origin main`, then deploy with `railway up --detach`
