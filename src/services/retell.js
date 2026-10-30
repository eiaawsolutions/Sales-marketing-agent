import db from '../db/index.js';
import { decrypt } from '../utils/crypto.js';

// The one Retell account behind every EIAAW voice surface (Sales Agent, the
// parent site, Workforce). Its key and agent live in the global settings.
export function getVoiceConfig() {
  const provider = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_provider'").get()?.value || 'retell';
  const apiKey = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_api_key'").get()?.value) || '';
  const agentId = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_agent_id'").get()?.value || '';
  const phoneNumber = db.prepare("SELECT value FROM settings WHERE key = 'voice_phone_number'").get()?.value || '';
  return { provider, apiKey, agentId, phoneNumber };
}

// Errors keep Retell's HTTP status: a 402 means the account is out of credit.
export async function retellAPI(apiKey, endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.retellai.com${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Retell API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Retell switched off /v2/create-web-call on 18 Oct 2026. v3 answers with
// connection details only, and the browser SDK must be given `transport` and
// `iceServers`: handed just the token, SDK 3.x assumes LiveKit and never
// connects. Returns what the browser passes straight to startCall().
export async function createWebCall(apiKey, body) {
  const call = await retellAPI(apiKey, '/v3/create-web-call', 'POST', body);
  return {
    accessToken: call.access_token,
    callId: call.call_id,
    transport: call.transport,
    iceServers: call.ice_servers,
  };
}
