// Adapters: provider payload → canonical candidate.
//
// One hardened receiver (routes/ingest.js) plus a thin adapter per provider.
// An adapter does two things and nothing else:
//   normalize(body, source) → { name, email, phone, company, title,
//                               linkedin_url, company_website, message }
//   externalId(body)        → the provider's own event id, for idempotency
//
// Adapters never touch the DB, never call the network, and never throw on a
// malformed payload — they return whatever they could find and let the ingest
// core reject a candidate with no contact identifier.

import { clampText } from '../utils/normalize.js';

// Providers name fields a dozen different ways. Pull the first non-empty match,
// case-insensitively, so a Zapier user does not have to rename their columns.
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const lowered = {};
  for (const [k, v] of Object.entries(obj)) lowered[k.toLowerCase().replace(/[\s_-]/g, '')] = v;
  for (const key of keys) {
    const v = lowered[key.toLowerCase().replace(/[\s_-]/g, '')];
    if (v !== undefined && v !== null && v !== '') return typeof v === 'object' ? null : String(v);
  }
  return null;
}

const NAME_KEYS = ['name', 'full_name', 'fullname', 'contact_name', 'lead_name'];
const FIRST_KEYS = ['first_name', 'firstname', 'given_name', 'fname'];
const LAST_KEYS = ['last_name', 'lastname', 'family_name', 'surname', 'lname'];
const EMAIL_KEYS = ['email', 'email_address', 'emailaddress', 'work_email', 'contact_email', 'e_mail'];
const PHONE_KEYS = ['phone', 'phone_number', 'phonenumber', 'mobile', 'mobile_number', 'tel', 'telephone', 'contact_phone', 'whatsapp'];
const COMPANY_KEYS = ['company', 'company_name', 'organization', 'organisation', 'org', 'business', 'business_name', 'account'];
const TITLE_KEYS = ['title', 'job_title', 'jobtitle', 'role', 'position', 'designation'];
const LINKEDIN_KEYS = ['linkedin', 'linkedin_url', 'linkedinurl', 'linkedin_profile', 'li_url'];
const WEBSITE_KEYS = ['website', 'company_website', 'url', 'site', 'domain', 'web'];
const MESSAGE_KEYS = ['message', 'notes', 'comments', 'comment', 'enquiry', 'inquiry', 'details', 'question', 'how_can_we_help'];
const ID_KEYS = ['id', 'event_id', 'lead_id', 'submission_id', 'uuid', 'external_id'];

function composeName(body) {
  const whole = pick(body, NAME_KEYS);
  if (whole) return whole;
  const first = pick(body, FIRST_KEYS);
  const last = pick(body, LAST_KEYS);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || null;
}

// The generic shape. Used by webhook, zapier, web_form, and chatbot, and as the
// fallback inside the provider adapters.
function genericNormalize(body) {
  return {
    name: composeName(body),
    email: pick(body, EMAIL_KEYS),
    phone: pick(body, PHONE_KEYS),
    company: pick(body, COMPANY_KEYS),
    title: pick(body, TITLE_KEYS),
    linkedin_url: pick(body, LINKEDIN_KEYS),
    company_website: pick(body, WEBSITE_KEYS),
    message: pick(body, MESSAGE_KEYS),
  };
}

// ---------------------------------------------------------------------------
// Google Ads Lead Form
//
// POST body:
//   { lead_id, user_column_data: [ { column_id, column_name, string_value }, ... ],
//     api_version, form_id, campaign_id, google_key, is_test }
// The answers live in user_column_data keyed by column_id ("FULL_NAME", "EMAIL",
// "PHONE_NUMBER", "COMPANY_NAME", "JOB_TITLE", plus custom questions).
// Docs: developers.google.com/google-ads/webhook/docs/overview
// ---------------------------------------------------------------------------
const GOOGLE_COLUMN_MAP = {
  FULL_NAME: 'name',
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  EMAIL: 'email',
  PHONE_NUMBER: 'phone',
  COMPANY_NAME: 'company',
  JOB_TITLE: 'title',
  WORK_EMAIL: 'email',
  WORK_PHONE: 'phone',
  COMPANY_WEBSITE: 'company_website',
};

function googleAdsNormalize(body) {
  const flat = {};
  const extras = [];
  const columns = Array.isArray(body?.user_column_data) ? body.user_column_data : [];
  for (const col of columns) {
    const id = String(col?.column_id || '').toUpperCase();
    const value = col?.string_value;
    if (value === undefined || value === null || value === '') continue;
    const mapped = GOOGLE_COLUMN_MAP[id];
    if (mapped) flat[mapped] = String(value);
    else extras.push(`${col.column_name || id}: ${value}`);
  }
  if (!flat.name && (flat.first_name || flat.last_name)) {
    flat.name = [flat.first_name, flat.last_name].filter(Boolean).join(' ');
  }
  return {
    name: flat.name || null,
    email: flat.email || null,
    phone: flat.phone || null,
    company: flat.company || null,
    title: flat.title || null,
    linkedin_url: null,
    company_website: flat.company_website || null,
    // Custom-question answers are the only place a Google lead can express
    // intent, so keep them — they feed the "left a message" scoring rule.
    message: extras.length ? clampText(extras.join('\n'), 2000) : null,
  };
}

// `lead_id` is unique per lead per form. `is_test` marks Google's own probe,
// which we accept (so the "Send test lead" button in Google Ads goes green) but
// tag so it can be told apart.
const googleAdsExternalId = (body) => (body?.lead_id ? `google:${body.lead_id}` : null);

// ---------------------------------------------------------------------------
// Calendly — `invitee.created`
//   { event: 'invitee.created', payload: { email, name, questions_and_answers: [...],
//     scheduled_event: { start_time, name, uri }, tracking: {...}, uri } }
//
// Cal.com — `BOOKING_CREATED`
//   { triggerEvent, payload: { uid, title, startTime, attendees:[{name,email,...}],
//     responses: {...} } }
// ---------------------------------------------------------------------------
function calendlyNormalize(body) {
  const p = body?.payload || {};

  // Cal.com shape
  if (body?.triggerEvent || Array.isArray(p.attendees)) {
    const attendee = Array.isArray(p.attendees) ? p.attendees[0] : null;
    const responses = p.responses && typeof p.responses === 'object' ? p.responses : {};
    const flatResponses = {};
    for (const [k, v] of Object.entries(responses)) {
      flatResponses[k] = v && typeof v === 'object' ? v.value : v;
    }
    const base = genericNormalize(flatResponses);
    return {
      ...base,
      name: attendee?.name || base.name,
      email: attendee?.email || base.email,
      phone: base.phone || pick(flatResponses, PHONE_KEYS),
      message: [p.title && `Booked: ${p.title}`, p.startTime && `Starts: ${p.startTime}`, base.message]
        .filter(Boolean).join('\n') || null,
    };
  }

  // Calendly shape
  const qa = Array.isArray(p.questions_and_answers) ? p.questions_and_answers : [];
  const qaFlat = {};
  const qaLines = [];
  for (const item of qa) {
    const q = String(item?.question || '').trim();
    const a = item?.answer;
    if (!q || a === undefined || a === null || a === '') continue;
    qaFlat[q] = String(a);
    qaLines.push(`${q}: ${a}`);
  }
  const fromQa = genericNormalize(qaFlat);
  const evt = p.scheduled_event || {};
  return {
    name: p.name || fromQa.name || null,
    email: p.email || fromQa.email || null,
    phone: p.text_reminder_number || fromQa.phone || null,
    company: fromQa.company || null,
    title: fromQa.title || null,
    linkedin_url: fromQa.linkedin_url || null,
    company_website: fromQa.company_website || null,
    message: [evt.name && `Booked: ${evt.name}`, evt.start_time && `Starts: ${evt.start_time}`, ...qaLines]
      .filter(Boolean).join('\n') || null,
  };
}

function calendlyExternalId(body) {
  const p = body?.payload || {};
  if (p.uri) return `calendly:${p.uri}`;          // Calendly invitee URI
  if (p.uid) return `cal:${p.uid}`;               // Cal.com booking uid
  return null;
}

// ---------------------------------------------------------------------------
// Resend inbound email — `email.received`
//   { type: 'email.received', data: { email_id, from, to, subject, text, html, headers } }
//
// `from` may be "Amos Tan <amos@acme.com>" or a bare address.
// We take ONLY what the sender actually presented. The display name is a name
// they chose; the address is the address they sent from. Nothing is inferred:
// notably, we do NOT turn acme.com into a company website or guess a title.
// ---------------------------------------------------------------------------
// "Display Name <addr@host>" or a bare "addr@host". Two explicit alternatives
// rather than one regex with an optional name group — the optional-group form
// let the non-greedy name match steal the first characters of a bare local part
// ("raw@corp.my" → name "r", email "aw@corp.my").
const ANGLE_RE = /^\s*"?([^"<]*?)"?\s*<([^\s<>@]+@[^\s<>@]+)>\s*$/;
const BARE_RE = /^\s*([^\s<>@]+@[^\s<>@]+)\s*$/;

function parseFrom(value) {
  if (typeof value !== 'string') return { name: null, email: null };
  const angle = value.match(ANGLE_RE);
  if (angle) {
    const name = (angle[1] || '').trim();
    return { name: name || null, email: angle[2] || null };
  }
  const bare = value.match(BARE_RE);
  if (bare) return { name: null, email: bare[1] };
  return { name: null, email: null };
}

function emailInboundNormalize(body) {
  const d = body?.data || {};
  const from = typeof d.from === 'string' ? parseFrom(d.from) : parseFrom(d.from?.address || '');
  const subject = clampText(d.subject, 200);
  const text = clampText(d.text, 1800);
  return {
    name: from.name,
    email: from.email,
    phone: null,
    company: null,
    title: null,
    linkedin_url: null,
    company_website: null,
    message: [subject && `Subject: ${subject}`, text].filter(Boolean).join('\n\n') || null,
  };
}

const emailInboundExternalId = (body) => (body?.data?.email_id ? `resend:${body.data.email_id}` : null);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const ADAPTERS = {
  webhook: { normalize: genericNormalize, externalId: (b) => (pick(b, ID_KEYS) ? `webhook:${pick(b, ID_KEYS)}` : null) },
  zapier: { normalize: genericNormalize, externalId: (b) => (pick(b, ID_KEYS) ? `zap:${pick(b, ID_KEYS)}` : null) },
  web_form: { normalize: genericNormalize, externalId: () => null },
  chatbot: { normalize: genericNormalize, externalId: () => null },
  google_ads: { normalize: googleAdsNormalize, externalId: googleAdsExternalId },
  calendly: { normalize: calendlyNormalize, externalId: calendlyExternalId },
  email_inbound: { normalize: emailInboundNormalize, externalId: emailInboundExternalId },
};

export function adapterFor(type) {
  return ADAPTERS[type] || null;
}

// Providers send events we do not care about (Calendly `invitee.canceled`,
// Resend `email.delivered`). Returning false here means "200 OK, ignored" —
// never a 4xx, or the provider will retry forever and eventually disable the
// endpoint.
export function isLeadBearingEvent(type, body) {
  if (type === 'calendly') {
    const evt = body?.event || body?.triggerEvent;
    return evt === 'invitee.created' || evt === 'BOOKING_CREATED';
  }
  if (type === 'email_inbound') {
    return body?.type === 'email.received';
  }
  return true;
}

export const __testing = { pick, composeName, parseFrom, genericNormalize, googleAdsNormalize, calendlyNormalize, emailInboundNormalize };
