/**
 * Who the voice assistant speaks for on a call about a lead.
 *
 * One Retell agent serves every account; its prompt branches on site_scope.
 * A customer's lead gets site_scope "customer_lead" plus the customer's brief
 * as dynamic variables, so the prospect hears the customer's business and
 * offer. Only EIAAW's own leads hear about EIAAW. A customer with no brief on
 * file gets no call: the assistant would have nothing true to say.
 *
 * Every customer variable is always sent (empty when unused): Retell leaves an
 * unset {{variable}} in the prompt as literal text.
 */
import { getProfile, hasOffer, isHqAccount } from './account-profile.js';

export const EMPTY_CUSTOMER_VARS = {
  business_name: '', sender_name: '', offer: '', proof_points: '',
  call_to_action: '', voice_notes: '', meeting_link_present: 'no',
  // Real free times from the account's calendar (calendar.js calendarVars).
  calendar_connected: 'no', available_times: '', available_slot_codes: '',
};

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/**
 * Returns { kind: 'eiaaw', vars } for EIAAW's own leads (and calls with no
 * lead), { kind: 'customer', vars, profile } for a customer's lead, or
 * { kind: 'unconfigured' } for a customer without a brief.
 */
export function personaFor(lead, { outbound = false } = {}) {
  if (!lead || isHqAccount(lead.user_id)) return { kind: 'eiaaw', vars: { ...EMPTY_CUSTOMER_VARS } };

  const profile = getProfile(lead.user_id);
  if (!hasOffer(profile)) return { kind: 'unconfigured' };

  const sender = profile.sender_name || profile.business_name;
  const hi = firstName(lead.name) ? `Hi ${firstName(lead.name)}` : 'Hi';
  const begin = outbound
    ? `${hi}, this is an AI assistant calling for ${sender} at ${profile.business_name}. Have you got two minutes?`
    : `${hi}! I'm an AI assistant for ${profile.business_name}. I can answer your questions and find a time for you to speak with ${sender}. Is now a good time?`;

  return {
    kind: 'customer',
    profile,
    vars: {
      business_name: profile.business_name,
      sender_name: sender,
      offer: profile.offer,
      proof_points: profile.proof_points || '',
      call_to_action: profile.call_to_action || '',
      voice_notes: profile.voice_notes || '',
      meeting_link_present: profile.meeting_link ? 'yes' : 'no',
      site_scope: 'customer_lead',
      call_objective: 'qualify_and_book',
      begin_message: begin,
    },
  };
}
