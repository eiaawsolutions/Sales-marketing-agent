// ============================================================
// EIAAW Email Templates
// 13 categories x 3 templates each = 39 starting points.
// Each template is a build(ctx) function returning a Design object
// (same shape as EmailDesigner.defaultDesign()). The compiler will
// always append the locked EIAAW Solutions footer.
// ============================================================
(function () {
  'use strict';

  function uid() { return 'b' + Math.random().toString(36).slice(2, 9); }

  const FONT_INTER = "'Inter', Arial, Helvetica, sans-serif";
  const FONT_SERIF = "Georgia, 'Times New Roman', serif";

  // Shared block factories ------------------------------------------------
  const h = (level, text, align) => ({ id: uid(), type: 'h' + level, text, align: align || 'left' });
  const p = (text, align) => ({ id: uid(), type: 'p', text, align: align || 'left' });
  const cta = (text, url, opts) => ({
    id: uid(), type: 'cta', text, url,
    font: (opts && opts.font) || FONT_INTER,
    color: (opts && opts.color) || '#FFFFFF',
    bg:    (opts && opts.bg)    || '#1FA896',
    size:  (opts && opts.size)  || 'md',
    align: (opts && opts.align) || 'center',
  });
  const divider = () => ({ id: uid(), type: 'divider' });
  const spacer  = (height) => ({ id: uid(), type: 'spacer', height: height || 24 });
  const image   = (url, alt) => ({ id: uid(), type: 'image', url: url || '', alt: alt || '' });

  // Build a base design that inherits user brand + footer overrides
  function base(ctx, opts) {
    const brand = Object.assign({
      logoUrl: '',
      primaryColor: '#1FA896',
      accentColor: '#11766A',
      font: FONT_INTER,
      bgColor: '#FAF7F2',
      textColor: '#0F1A1D',
    }, (ctx && ctx.brand) || {}, opts.brand || {});

    const footer = Object.assign({
      show: true,
      companyName: 'Your Company',
      address: '',
      phone: '',
      social: { facebook: '', instagram: '', linkedin: '', x: '', youtube: '' },
      unsubscribeText: 'Unsubscribe from these emails',
      unsubscribeUrl: '{{unsubscribe_url}}',
    }, (ctx && ctx.footer) || {});

    return {
      mode: 'scratch',
      brand,
      header: { show: true, align: opts.headerAlign || 'center', bannerUrl: '', bannerHeight: 0 },
      blocks: opts.blocks,
      footer,
    };
  }

  // ---------------------------------------------------------------------
  // CATEGORIES
  // ---------------------------------------------------------------------
  const CATEGORIES = [
    {
      id: 'sales', label: 'Sales',
      templates: [
        { id: 'sales-cold', name: 'Cold Outreach', thumbLabel: 'Cold', thumbBg: '#11766A', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A quick idea for {{company}}'),
              p('Hi {{name}},'),
              p('I noticed your team is scaling fast and likely juggling more pipeline than your reps can keep up with. We help sales leaders like you cut admin time by 60% and surface the right deal at the right time — without changing your stack.'),
              p('Would a 15-minute call next week make sense? I will share two ideas you can use whether or not we work together.'),
              cta('Book 15 minutes', 'https://example.com/book', { bg: ctx.brand && ctx.brand.primaryColor }),
              spacer(8),
              p('— Your name'),
            ],
          }),
        },
        { id: 'sales-discovery', name: 'Discovery Recap', thumbLabel: 'Recap', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Recap: our chat today'),
              p('Hi {{name}}, thanks for the conversation. Quick recap of what I heard:'),
              h(3, 'What you said'),
              p('• Your team is hitting a ceiling around lead qualification.\n• You want to keep human judgement in the loop, not replace it.\n• Decision lands with you and Mei by end of Q2.'),
              h(3, 'What I am proposing'),
              p('A 4-week pilot, fixed price, with two quantified outcomes. No contract until the pilot proves it.'),
              cta('See the proposal', 'https://example.com/proposal'),
              spacer(8),
              p('Tell me what to change. I want this to fit how you actually work.'),
            ],
          }),
        },
        { id: 'sales-closeout', name: 'Closing Push', thumbLabel: 'Close', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Two questions before Friday'),
              p('Hi {{name}},'),
              p('Just two quick questions so we can lock in a Q3 start:'),
              p('1. Is the budget you mentioned still in place?\n2. Anyone else who should join the final review?'),
              cta('Reply with answers', 'mailto:you@example.com', { bg: '#11766A' }),
              spacer(8),
              p('Whatever you decide, I appreciate the time. Genuinely.'),
            ],
          }),
        },
      ],
    },

    {
      id: 'events', label: 'Events',
      templates: [
        { id: 'events-invite', name: 'Webinar Invite', thumbLabel: 'Invite', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'You are invited.'),
              h(2, 'How AI sales teams hit quota in 2026'),
              p('Live, 45 minutes. Tuesday 14 May, 2pm GMT+8. Join 200+ founders and sales leaders for a no-fluff playbook on the workflows we are seeing actually move pipeline.'),
              cta('Save my seat', 'https://example.com/register', { bg: '#7C3AED' }),
              spacer(8),
              p('Can\'t attend live? Register and we\'ll send the recording.'),
            ],
          }),
        },
        { id: 'events-conf', name: 'Conference Save the Date', thumbLabel: 'Conf', thumbBg: '#B4412B', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Save the date'),
              h(2, 'EIAAW Summit 2026 — Kuala Lumpur'),
              p('Three days. 40 speakers. One question: how do humans and AI ship better work together? 12-14 September, Sasana Kijang.'),
              cta('Get early-bird access', 'https://example.com/summit', { bg: '#B4412B' }),
            ],
          }),
        },
        { id: 'events-reminder', name: 'Event Reminder (24h)', thumbLabel: 'Soon', thumbBg: '#F59E0B', thumbInk: '#0F1A1D',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Tomorrow at 2pm'),
              p('Hi {{name}}, just a friendly nudge — your seat for tomorrow is locked in.'),
              h(3, 'Quick details'),
              p('• When: Tuesday 14 May, 2pm GMT+8\n• Where: Zoom (link below)\n• Bring: a question you want answered'),
              cta('Open the room', 'https://example.com/zoom', { bg: '#F59E0B', color: '#0F1A1D' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'leads', label: 'Leads',
      templates: [
        { id: 'leads-magnet', name: 'Lead Magnet Delivery', thumbLabel: 'Magnet', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Here is your guide'),
              p('Hi {{name}}, thanks for grabbing the AI sales playbook. It is short on theory and heavy on what to do tomorrow morning.'),
              cta('Download the PDF', 'https://example.com/playbook.pdf'),
              divider(),
              h(3, 'What to read first'),
              p('Skim the table of contents, then jump to chapter 3 (the one on lead qualification). It is the one most readers tell us moved the needle.'),
            ],
          }),
        },
        { id: 'leads-nurture', name: 'Nurture Day 3', thumbLabel: 'Day 3', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Did chapter 3 land?'),
              p('Hi {{name}}, hope the playbook is useful. A lot of readers tell us chapter 3 changes how they think about lead qualification — would love to hear if it landed for you.'),
              p('If you want to talk it through with someone, we run a free 20-minute working session every Thursday.'),
              cta('Grab a Thursday slot', 'https://example.com/working-session'),
            ],
          }),
        },
        { id: 'leads-survey', name: 'Lead Profile Survey', thumbLabel: 'Profile', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Help us help you.'),
              p('Two minutes, three questions, and we will send you a personalised resource pack instead of more generic content.'),
              cta('Start the 2-min survey', 'https://example.com/survey', { bg: '#7C3AED' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'followup', label: 'Follow-up',
      templates: [
        { id: 'follow-bump', name: 'Soft Bump', thumbLabel: 'Bump', thumbBg: '#F3EDE0', thumbInk: '#0F1A1D',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Bumping this up.'),
              p('Hi {{name}},'),
              p('Sending this back to the top of your inbox. No pressure — if now isn\'t the right time, just reply with "later" and I\'ll circle back next quarter.'),
              cta('Reply', 'mailto:you@example.com', { bg: '#11766A' }),
            ],
          }),
        },
        { id: 'follow-meeting', name: 'After the Meeting', thumbLabel: 'Thanks', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Thanks for the time today'),
              p('Hi {{name}},'),
              p('Quick follow-up on what we discussed. The two next steps:'),
              p('1. I will send the scope document by Wednesday.\n2. You will loop in {{stakeholder}} for the technical review.'),
              cta('Add the next call', 'https://example.com/calendar'),
              spacer(8),
              p('Anything I missed, just reply.'),
            ],
          }),
        },
        { id: 'follow-breakup', name: 'Polite Breakup', thumbLabel: 'Bye', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Last one from me'),
              p('Hi {{name}}, I have written a few times so I will assume the timing isn\'t right. No worries at all.'),
              p('I will close the loop on my end. If anything changes — same email, same person.'),
              cta('Tell me when to circle back', 'https://example.com/snooze', { bg: '#11766A' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'business', label: 'Business',
      templates: [
        { id: 'biz-update', name: 'Customer Update', thumbLabel: 'Update', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A small update for you.'),
              p('We shipped three things this month that you might care about — all aimed at saving you time.'),
              h(3, '1. Faster reports'),
              p('Reports that took 90 seconds now load in under 5.'),
              h(3, '2. Cleaner exports'),
              p('CSV exports keep your column order and formatting.'),
              h(3, '3. Mobile polish'),
              p('Everything that worked on desktop now works just as well on phone.'),
              cta('Open your dashboard', 'https://example.com/app'),
            ],
          }),
        },
        { id: 'biz-partnership', name: 'Partnership Pitch', thumbLabel: 'Partner', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A partnership idea'),
              p('Hi {{name}}, I have been a fan of what your team is building. There is a clean overlap between your audience and ours, and I think we could put something useful in front of both.'),
              p('Quick pitch: we co-host a webinar in June, share the lead list, and run a follow-up offer together. Low effort, high signal.'),
              cta('Want to chat about it?', 'https://example.com/partnership', { bg: '#7C3AED' }),
            ],
          }),
        },
        { id: 'biz-quarterly', name: 'Quarterly Review', thumbLabel: 'Q-Rev', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Q1 in review'),
              p('Numbers, in plain language:'),
              p('• Pipeline up 38% vs Q4\n• Win rate up from 22% to 31%\n• Average deal cycle: 41 days (down from 56)\n• Our team grew by 4'),
              divider(),
              h(3, 'What\'s next'),
              p('Q2 we are doubling down on enterprise pilots and shipping a new analytics module. Reply if you want a preview.'),
              cta('Read the full review', 'https://example.com/q1-review'),
            ],
          }),
        },
      ],
    },

    {
      id: 'deals', label: 'Deals & Offers',
      templates: [
        { id: 'deals-flash', name: 'Flash Offer', thumbLabel: '-30%', thumbBg: '#B4412B', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, '30% off — 48 hours only'),
              p('Hi {{name}}, our biggest offer of the year ends Sunday at midnight. Use code SPRING30 at checkout.'),
              cta('Claim 30% off', 'https://example.com/checkout?code=SPRING30', { bg: '#B4412B', size: 'lg' }),
              spacer(8),
              p('Applies to all annual plans. No fine print.'),
            ],
          }),
        },
        { id: 'deals-bundle', name: 'Bundle Promo', thumbLabel: 'Bundle', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Three things, one price.'),
              p('We bundled our three most-used products into one package. Save 25% versus buying separately.'),
              h(3, 'What\'s inside'),
              p('• Sales Agent — AI lead generation\n• Ads Agency — campaign automation\n• Support Pro — multi-channel inbox'),
              cta('Get the bundle', 'https://example.com/bundle', { size: 'lg' }),
            ],
          }),
        },
        { id: 'deals-loyalty', name: 'Loyalty Reward', thumbLabel: 'VIP', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A thank-you, just for you.'),
              p('You have been with us for over a year. To say thanks: a permanent 15% discount on any add-on, no expiry.'),
              cta('Use my reward', 'https://example.com/loyalty', { bg: '#7C3AED' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'ecommerce', label: 'E-commerce',
      templates: [
        { id: 'ecom-cart', name: 'Abandoned Cart', thumbLabel: 'Cart', thumbBg: '#F59E0B', thumbInk: '#0F1A1D',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Forgot something?'),
              p('Hi {{name}}, your cart is still waiting. We saved it for the next 48 hours.'),
              cta('Complete checkout', 'https://example.com/cart', { bg: '#F59E0B', color: '#0F1A1D' }),
              spacer(8),
              p('Free shipping over $50. Easy 30-day returns.'),
            ],
          }),
        },
        { id: 'ecom-newarrival', name: 'New Arrivals', thumbLabel: 'New', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Just landed.'),
              p('Eight new pieces in store today. Honest materials, slow design, made to last more than one season.'),
              cta('Shop the drop', 'https://example.com/new'),
            ],
          }),
        },
        { id: 'ecom-receipt', name: 'Order Confirmation', thumbLabel: 'Order', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Order confirmed.'),
              p('Hi {{name}}, thanks for your order #{{order_id}}. We\'ll email a tracking link once it ships (usually within 1 business day).'),
              h(3, 'Order summary'),
              p('Item: {{product_name}}\nQuantity: {{quantity}}\nTotal: {{total}}'),
              cta('Track order', 'https://example.com/orders/{{order_id}}'),
            ],
          }),
        },
      ],
    },

    {
      id: 'health', label: 'Health & Wellness',
      templates: [
        { id: 'hw-newsletter', name: 'Wellness Newsletter', thumbLabel: 'Wellness', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A small habit, big results.'),
              p('Hi {{name}}, this week\'s tip: a 10-minute walk after lunch beats most "productivity hacks". Backed by research, costs nothing, you\'ll feel it within a week.'),
              cta('Read this week\'s edition', 'https://example.com/edition', { bg: '#11766A' }),
            ],
          }),
        },
        { id: 'hw-program', name: 'Program Launch', thumbLabel: 'Launch', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A 30-day reset.'),
              h(2, 'Real food. Real movement. Real rest.'),
              p('Our most popular program returns May 1. Five live coaching calls, daily prompts, a private community of people who want to feel better — not perfect.'),
              cta('Save my place', 'https://example.com/reset', { bg: '#7C3AED', size: 'lg' }),
            ],
          }),
        },
        { id: 'hw-appointment', name: 'Appointment Reminder', thumbLabel: 'Appt', thumbBg: '#F3EDE0', thumbInk: '#0F1A1D',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Your appointment, tomorrow.'),
              p('Hi {{name}}, this is a friendly reminder of your appointment:'),
              h(3, 'Details'),
              p('• Date: Tuesday 14 May\n• Time: 10:30 AM\n• With: Dr. Tan\n• Where: Clinic, 12 Jalan Setia'),
              cta('Reschedule if needed', 'https://example.com/reschedule', { bg: '#11766A' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'holiday', label: 'Holiday',
      templates: [
        { id: 'hol-greet', name: 'Holiday Greeting', thumbLabel: 'Cheers', thumbBg: '#B4412B', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Wishing you the season.'),
              p('From all of us — the engineers, designers, support team, and the dog who lives at the office — thank you for being part of our year. Hope you get some real rest.'),
              spacer(8),
              p('See you in the new year.'),
            ],
          }),
        },
        { id: 'hol-promo', name: 'Holiday Promo', thumbLabel: '-25%', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Holiday sale — up to 40% off'),
              p('A small gift to ourselves: our best discount of the year, live until 31 December.'),
              cta('Shop the sale', 'https://example.com/sale', { bg: '#B4412B', size: 'lg' }),
            ],
          }),
        },
        { id: 'hol-recap', name: 'Year in Review', thumbLabel: 'Year', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Our year, in five lines.'),
              p('• Shipped 42 product updates\n• Welcomed 1,200 new customers\n• Replied to 28,400 support tickets in under 6 hours each\n• Carbon-neutral for the second year running\n• Thank you for being here.'),
              cta('Read the full recap', 'https://example.com/year'),
            ],
          }),
        },
      ],
    },

    {
      id: 'nonprofit', label: 'Non-profit',
      templates: [
        { id: 'np-appeal', name: 'Donation Appeal', thumbLabel: 'Donate', thumbBg: '#B4412B', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Will you stand with us?'),
              p('Hi {{name}}, this year we helped 4,200 families. Next year we want to reach 10,000. We can\'t do it without people like you.'),
              cta('Donate any amount', 'https://example.com/donate', { bg: '#B4412B', size: 'lg' }),
              spacer(8),
              p('Every dollar goes directly to programs. Operations are funded by a separate grant.'),
            ],
          }),
        },
        { id: 'np-impact', name: 'Impact Report', thumbLabel: 'Impact', thumbBg: '#11766A', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'What your donation did.'),
              p('Hi {{name}}, you supported us in 2025. Here is exactly what your gift made possible — no fluff, just numbers.'),
              h(3, 'Direct impact'),
              p('• 312 students received scholarships\n• 18 schools got clean water\n• 6 communities trained in solar installation'),
              cta('Read the full impact report', 'https://example.com/impact', { bg: '#11766A' }),
            ],
          }),
        },
        { id: 'np-volunteer', name: 'Volunteer Call', thumbLabel: 'Help', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Could you spare a Saturday?'),
              p('We are running a community day on 8 June and need 30 hands. No experience needed — just willingness, and we\'ll feed you well.'),
              cta('Sign me up', 'https://example.com/volunteer', { bg: '#7C3AED' }),
            ],
          }),
        },
      ],
    },

    {
      id: 'notifications', label: 'Notifications',
      templates: [
        { id: 'notif-receipt', name: 'Payment Receipt', thumbLabel: 'Paid', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Payment received'),
              p('Hi {{name}}, we received your payment of {{amount}}. Receipt #{{receipt_id}} is below for your records.'),
              h(3, 'Details'),
              p('Date: {{date}}\nMethod: {{method}}\nDescription: {{description}}'),
              cta('Download receipt PDF', 'https://example.com/receipts/{{receipt_id}}'),
            ],
          }),
        },
        { id: 'notif-account', name: 'Security Alert', thumbLabel: 'Security', thumbBg: '#B4412B', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'New sign-in to your account'),
              p('Hi {{name}}, we noticed a sign-in from a new device:'),
              p('• Time: {{time}}\n• Device: {{device}}\n• IP / Location: {{location}}'),
              cta('Review activity', 'https://example.com/security', { bg: '#B4412B' }),
              spacer(8),
              p('If this was you, no action needed. If not, change your password right away.'),
            ],
          }),
        },
        { id: 'notif-shipping', name: 'Shipping Update', thumbLabel: 'Shipped', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Your order is on its way'),
              p('Hi {{name}}, order #{{order_id}} just shipped. Estimated arrival: {{eta}}.'),
              cta('Track shipment', 'https://example.com/track/{{order_id}}'),
            ],
          }),
        },
      ],
    },

    {
      id: 'products', label: 'Products',
      templates: [
        { id: 'prod-launch', name: 'Product Launch', thumbLabel: 'New', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'Meet the new {{product_name}}'),
              h(2, 'Faster, lighter, kinder to the planet.'),
              p('Two years in the making. Three core upgrades. One reason you\'ll never go back: it just feels good to use.'),
              cta('See what\'s new', 'https://example.com/launch', { bg: '#7C3AED', size: 'lg' }),
            ],
          }),
        },
        { id: 'prod-feature', name: 'Feature Spotlight', thumbLabel: 'Feature', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A small feature you\'ll love.'),
              h(2, 'Smart Folders'),
              p('Set the rules once. Smart Folders organise everything that comes in after — emails, files, customer notes — without you lifting a finger.'),
              cta('Try Smart Folders', 'https://example.com/smart-folders'),
            ],
          }),
        },
        { id: 'prod-tip', name: 'Power-User Tip', thumbLabel: 'Tip', thumbBg: '#0F1A1D', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'A tip from our team.'),
              p('Press <strong>Cmd+K</strong> anywhere in the app to jump straight to any record, action, or report. Saves about 4 clicks per task — adds up.'),
              cta('Try it now', 'https://example.com/app'),
            ],
          }),
        },
      ],
    },

    {
      id: 'survey', label: 'Survey & Quizzes',
      templates: [
        { id: 'srv-nps', name: 'NPS Survey', thumbLabel: 'NPS', thumbBg: '#1FA896', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'How likely would you recommend us?'),
              p('Hi {{name}}, one quick question — would you recommend us to a friend or colleague? It takes 10 seconds and helps us a lot.'),
              cta('Answer in one click', 'https://example.com/nps'),
            ],
          }),
        },
        { id: 'srv-quiz', name: 'Personality Quiz', thumbLabel: 'Quiz', thumbBg: '#7C3AED', thumbInk: '#FFFFFF',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'What kind of leader are you?'),
              p('Six questions, two minutes. Get your style profile and a tailored playbook based on your answers.'),
              cta('Take the quiz', 'https://example.com/quiz', { bg: '#7C3AED' }),
            ],
          }),
        },
        { id: 'srv-feedback', name: 'Post-Purchase Feedback', thumbLabel: 'Review', thumbBg: '#F59E0B', thumbInk: '#0F1A1D',
          build: (ctx) => base(ctx, {
            blocks: [
              h(1, 'How did we do?'),
              p('Hi {{name}}, you bought from us recently — we\'d love a quick review. It helps other customers and tells us what to keep doing (or stop).'),
              cta('Leave a 1-min review', 'https://example.com/review', { bg: '#F59E0B', color: '#0F1A1D' }),
            ],
          }),
        },
      ],
    },
  ];

  // Public API ------------------------------------------------------------
  window.EmailTemplates = {
    categories: () => CATEGORIES,
    get: (catId, tplId) => {
      const c = CATEGORIES.find(x => x.id === catId);
      if (!c) return null;
      return c.templates.find(t => t.id === tplId) || null;
    },
  };
})();
