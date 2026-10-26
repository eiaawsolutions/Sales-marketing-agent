// Anthropic model registry — the single place a model id is chosen.
//
// Model ids retire on a schedule, and a call to a retired id fails outright.
// That is what took every agent task down on 15 Jun 2026: Settings still held
// claude-sonnet-4-20250514 and getModel() passed it straight through. Every path
// that picks a model now goes through resolveModel(), so a retired id falls back
// to DEFAULT_MODEL instead of breaking lead search, scoring and outreach.
//
// Retirement dates are the Claude API dates from Anthropic's models overview,
// checked 2026-10-26. Add a row here when Anthropic announces a deprecation.

// Proven in production by the public chatbot since May 2026.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// What Settings offers. Only ids this codebase has been run against.
export const SELECTABLE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Recommended)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Fastest)' },
];

// id → first day the id stops working (YYYY-MM-DD, UTC).
export const MODEL_SUNSETS = {
  'claude-sonnet-4-5-20250929': '2026-11-30',
  'claude-sonnet-4-5': '2026-11-30',
  'claude-opus-4-1-20250805': '2026-08-05',
  'claude-sonnet-4-20250514': '2026-06-15',
  'claude-opus-4-20250514': '2026-06-15',
  'claude-3-haiku-20240307': '2026-04-20',
  'claude-3-7-sonnet-20250219': '2026-02-19',
  'claude-3-5-haiku-20241022': '2026-02-19',
  'claude-3-opus-20240229': '2026-01-05',
  'claude-3-5-sonnet-20241022': '2025-10-28',
  'claude-3-5-sonnet-20240620': '2025-10-28',
  'claude-3-sonnet-20240229': '2025-07-21',
};

export function isRetired(id, now = new Date()) {
  const sunset = MODEL_SUNSETS[id];
  return !!sunset && now.toISOString().slice(0, 10) >= sunset;
}

export function resolveModel(stored, now = new Date()) {
  const id = typeof stored === 'string' ? stored.trim() : '';
  if (!id || isRetired(id, now)) return DEFAULT_MODEL;
  return id;
}

// Settings accepts any well-formed Claude id that is not retired, so a newer
// model can be switched on without a deploy.
export function isAcceptableModelId(id) {
  return typeof id === 'string' && /^claude-[a-z0-9.-]{3,60}$/.test(id) && !isRetired(id);
}
