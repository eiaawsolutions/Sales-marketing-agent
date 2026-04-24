import db from '../db/index.js';
import { decrypt } from '../utils/crypto.js';

// Apollo.io API client.
// Docs: https://docs.apollo.io/reference/people-api-search
//       https://docs.apollo.io/reference/people-enrichment

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
// Apollo's people-search endpoint is /mixed_people/search for OAuth-paired
// integrations and /mixed_people/api_search for master-API-key callers.
// We use the API-key path because the user authenticates via X-Api-Key.
const SEARCH_ENDPOINT = `${APOLLO_BASE}/mixed_people/search`;
const API_SEARCH_ENDPOINT = `${APOLLO_BASE}/mixed_people/api_search`;
const ENRICH_ENDPOINT = `${APOLLO_BASE}/people/match`;
const HEALTH_ENDPOINT = `${APOLLO_BASE}/auth/health`;

export function getApolloKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'apollo_api_key'").get();
  const key = row?.value ? decrypt(row.value) : (process.env.APOLLO_API_KEY || '');
  if (!key || key.startsWith('enc:')) return '';
  return key.trim();
}

export function isApolloConfigured() {
  return getApolloKey().length > 5;
}

// Apollo's documented header for API-key auth is X-Api-Key. Sending an
// Authorization: Bearer at the same time confuses their gateway and yields
// 401 "Access token is invalid", so we only send X-Api-Key here.
function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    Accept: 'application/json',
    'X-Api-Key': apiKey,
  };
}

async function apolloFetch(url, body, method = 'POST') {
  const apiKey = getApolloKey();
  if (!apiKey) throw new Error('Apollo API key not configured. Add it in Settings → Lead Generation (Apollo).');

  const init = {
    method,
    headers: authHeaders(apiKey),
  };
  if (method !== 'GET' && body) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }

  if (!res.ok) {
    let msg = json?.error || json?.message || json?.errors?.[0]?.message || text || `HTTP ${res.status}`;
    if (res.status === 401) {
      msg = `${msg} — your Apollo key was rejected. Confirm it is a MASTER API key (not a scoped key) created at app.apollo.io → Settings → Integrations → API.`;
    } else if (res.status === 403) {
      msg = `${msg} — your Apollo key does not have access to this endpoint. People search requires a MASTER API key.`;
    }
    const err = new Error(`Apollo API ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// People Search returns persons WITHOUT emails (per Apollo docs). We must call
// enrichment afterwards to actually reveal verified contact info.
export async function searchPeople(filters) {
  const body = {
    page: filters.page || 1,
    per_page: Math.min(filters.per_page || 10, 100),
    contact_email_status: filters.contact_email_status || ['verified'],
  };

  if (Array.isArray(filters.person_titles) && filters.person_titles.length) {
    body.person_titles = filters.person_titles;
  }
  if (Array.isArray(filters.person_seniorities) && filters.person_seniorities.length) {
    body.person_seniorities = filters.person_seniorities;
  }
  if (Array.isArray(filters.person_locations) && filters.person_locations.length) {
    body.person_locations = filters.person_locations;
  }
  if (Array.isArray(filters.organization_locations) && filters.organization_locations.length) {
    body.organization_locations = filters.organization_locations;
  }
  if (Array.isArray(filters.organization_industries) && filters.organization_industries.length) {
    body.q_organization_keyword_tags = filters.organization_industries;
  }
  if (Array.isArray(filters.organization_num_employees_ranges) && filters.organization_num_employees_ranges.length) {
    body.organization_num_employees_ranges = filters.organization_num_employees_ranges;
  }
  if (filters.q_keywords) {
    body.q_keywords = filters.q_keywords;
  }

  // Try the master-key endpoint first (api_search). If Apollo returns 404 we
  // fall back to the OAuth/search variant — covers both API-key tier shapes.
  try {
    return await apolloFetch(API_SEARCH_ENDPOINT, body);
  } catch (err) {
    if (err.status === 404) {
      return apolloFetch(SEARCH_ENDPOINT, body);
    }
    throw err;
  }
}

// Enrich a single person. reveal_personal_emails=true is required to actually
// get the email address back — search alone returns email_status only.
export async function enrichPerson(person) {
  const body = { reveal_personal_emails: true };
  if (person.id) body.id = person.id;
  if (person.first_name) body.first_name = person.first_name;
  if (person.last_name) body.last_name = person.last_name;
  if (person.organization_name || person.organization?.name) {
    body.organization_name = person.organization_name || person.organization?.name;
  }
  if (person.domain || person.organization?.primary_domain) {
    body.domain = person.domain || person.organization?.primary_domain;
  }
  if (person.linkedin_url) body.linkedin_url = person.linkedin_url;
  return apolloFetch(ENRICH_ENDPOINT, body);
}

// Lightweight connectivity test for the Settings page. Uses /auth/health which
// is available on every Apollo plan tier, so a 200 here means "key is valid".
// We then try a 1-result search to confirm the key has people-search scope.
export async function testConnection() {
  try {
    // Step 1: prove the key itself is valid (any tier).
    const health = await apolloFetch(HEALTH_ENDPOINT, null, 'GET');
    const isLoggedIn = health?.is_logged_in === true || health?.success === true || !!health?.user;

    // Step 2: prove the key can hit people-search (master-key only).
    let total = null;
    let searchScope = false;
    try {
      const res = await searchPeople({ person_titles: ['CEO'], per_page: 1, page: 1 });
      total = res?.pagination?.total_entries ?? null;
      searchScope = !!(res?.people || res?.contacts);
    } catch (searchErr) {
      return {
        success: false,
        error: `Key is valid but cannot search people: ${searchErr.message}`,
        keyValid: isLoggedIn,
      };
    }

    return {
      success: isLoggedIn && searchScope,
      keyValid: isLoggedIn,
      searchScope,
      total_entries: total,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Extract a "where Apollo found this lead" string from the raw person object.
// Used for the Source detail line on every lead so users can see what surfaced it.
export function describeApolloSource(person) {
  const bits = [];
  if (person.seniority) bits.push(`Seniority: ${person.seniority}`);
  if (Array.isArray(person.departments) && person.departments.length) bits.push(`Dept: ${person.departments.join(', ')}`);
  if (person.organization?.industry) bits.push(`Industry: ${person.organization.industry}`);
  if (person.city || person.state || person.country) {
    bits.push(`Location: ${[person.city, person.state, person.country].filter(Boolean).join(', ')}`);
  }
  if (person.organization?.estimated_num_employees) {
    bits.push(`Company size: ${person.organization.estimated_num_employees}`);
  }
  return bits.length ? bits.join(' • ') : 'Apollo people search';
}

// Detect "hot" buying signals from Apollo's enriched person object.
// Hot if: changed jobs in last 12 months, current role is recent, or company is hiring.
export function detectHotSignal(enriched) {
  if (!enriched || typeof enriched !== 'object') return null;

  const employments = Array.isArray(enriched.employment_history) ? enriched.employment_history : [];
  const current = employments.find(e => e.current) || employments[0];
  if (current?.start_date) {
    const start = new Date(current.start_date);
    if (!Number.isNaN(start.getTime())) {
      const monthsInRole = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (monthsInRole < 12) {
        return `Recently joined ${current.organization_name || enriched.organization?.name || 'company'} (${monthsInRole.toFixed(0)} months in role)`;
      }
    }
  }
  if (enriched.organization?.publicly_traded_symbol || enriched.organization?.total_funding) {
    return `Funded company (${enriched.organization?.organization_revenue_printed_total || enriched.organization?.publicly_traded_symbol || 'public'})`;
  }
  return null;
}
