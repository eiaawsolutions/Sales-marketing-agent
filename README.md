# EIAAW SalesAgent AI

AI-powered sales and marketing automation platform by [EIAAW Solutions](https://eiaawsolutions.com).

## Features

- **AI Lead Generation** — Describe your audience, AI finds matching leads
- **Smart Lead Scoring** — AI scores leads 0-100 with reasoning
- **Auto-Outreach** — Personalized multi-step sequences for every lead
- **AI Content Studio** — Generate emails, social posts, ad copy, SEO keywords
- **Sales Pipeline** — Kanban board with AI analysis and forecasting
- **AI Chat Assistant** — Full CRM context, instant sales advice
- **Multi-Tenant** — User isolation, subscription plans, budget controls
- **Campaign Management** — Guided wizard, email sending, performance tracking

## Tech Stack

- **Backend**: Node.js, Express
- **Database**: SQLite (better-sqlite3)
- **AI**: Anthropic Claude API
- **Frontend**: Vanilla JS SPA
- **Auth**: bcrypt, session tokens, role-based access
- **Email**: Nodemailer (SMTP)

## Quick Start

```bash
# Clone
git clone https://github.com/eiaawsolutions/Sales-marketing-agent.git
cd Sales-marketing-agent

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Anthropic API key

# Run
npm start
# Visit http://localhost:3000
```

Default login: `admin` / `Sys@dm1n$` (change immediately after first login)

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key | Yes |
| `PORT` | Server port (default 3000) | No |
| `SMTP_HOST` | Email server host | No |
| `SMTP_PORT` | Email server port | No |
| `SMTP_USER` | SMTP username | No |
| `SMTP_PASS` | SMTP password | No |
| `FROM_EMAIL` | Sender email address | No |

## Subscription Plans

| Plan | Price | Leads | Campaigns | AI Actions/mo |
|---|---|---|---|---|
| Starter | RM 99/mo | 100 | 3 | 50 |
| Pro | RM 199/mo | 500 | 10 | 200 |
| Business | RM 399/mo | Unlimited | Unlimited | 1,000 |

## Docker

```bash
docker build -t salesagent .
docker run -p 3000:3000 -v salesagent-data:/app/data salesagent
```

## License

Proprietary - EIAAW Solutions 2026
