/**
 * Email Service
 *
 * Sends ticket confirmation emails via Resend.
 * Called by the webhook after tickets are created.
 *
 * This service:
 * - Builds an HTML email with QR codes for each ticket
 * - Sends one email per order (containing all tickets)
 * - Handles errors gracefully (email failure does NOT break ticket creation)
 */

import { Resend } from 'resend';

// ─── Configuration ───────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'tickets@yourdomain.com';

// Only create the Resend client if the API key is set
// This allows the server to start without Resend configured (for local dev)
let resend: Resend | null = null;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('[Email] Resend client initialized');
} else {
  console.warn('[Email] ⚠️  RESEND_API_KEY not set — emails will be skipped');
}

// ─── Types ───────────────────────────────────────────────────

interface TicketForEmail {
  ticketType: 'female' | 'male';
  qrToken: string;
  qrImageDataUrl: string;  // "data:image/png;base64,..."
}

interface SendTicketEmailParams {
  to: string;                // Buyer's email address
  eventName: string;         // Name of the event
  tickets: TicketForEmail[]; // All tickets for this order
  language: string;          // 'en' | 'es' | 'pt-BR'
}

// ─── Translations ────────────────────────────────────────────

const emailStrings: Record<string, Record<string, string>> = {
  en: {
    subject: 'Your Tickets Are Ready!',
    heading: 'Your Tickets Are Ready!',
    subheading: 'Show each QR code at the entrance.',
    womenTicket: 'Women Ticket',
    menTicket: 'Men Ticket',
    ticketLabel: 'Ticket',
    of: 'of',
    footer: 'Save this email — you\'ll need it at the door.',
    footerTip: 'Tip: Screenshot each QR code for quick access.',
    poweredBy: 'Powered by Nómada',
  },
  es: {
    subject: '¡Tus Boletos Están Listos!',
    heading: '¡Tus Boletos Están Listos!',
    subheading: 'Muestra cada código QR en la entrada.',
    womenTicket: 'Boleto Mujer',
    menTicket: 'Boleto Hombre',
    ticketLabel: 'Boleto',
    of: 'de',
    footer: 'Guarda este correo — lo necesitarás en la puerta.',
    footerTip: 'Tip: Toma captura de cada código QR para acceso rápido.',
    poweredBy: 'Powered by Nómada',
  },
  'pt-BR': {
    subject: 'Seus Ingressos Estão Prontos!',
    heading: 'Seus Ingressos Estão Prontos!',
    subheading: 'Mostre cada código QR na entrada.',
    womenTicket: 'Ingresso Feminino',
    menTicket: 'Ingresso Masculino',
    ticketLabel: 'Ingresso',
    of: 'de',
    footer: 'Salve este e-mail — você vai precisar na porta.',
    footerTip: 'Dica: Tire print de cada código QR para acesso rápido.',
    poweredBy: 'Powered by Nómada',
  },
};

function t(lang: string, key: string): string {
  const strings = emailStrings[lang] || emailStrings['en'];
  return strings[key] || emailStrings['en'][key] || key;
}

// ─── HTML Email Builder ──────────────────────────────────────

function buildTicketEmailHtml(params: SendTicketEmailParams): string {
  const { eventName, tickets, language } = params;
  const lang = language || 'en';
  const total = tickets.length;

  const ticketCards = tickets.map((ticket, index) => {
    const typeLabel = ticket.ticketType === 'female'
      ? t(lang, 'womenTicket')
      : t(lang, 'menTicket');

    const typeColor = ticket.ticketType === 'female' ? '#E91E8C' : '#2196F3';

    return `
      <div style="background: #ffffff; border-radius: 12px; padding: 24px; margin-bottom: 20px; text-align: center; border: 1px solid #e0e0e0;">
        <div style="font-size: 14px; color: #666; margin-bottom: 8px;">
          ${t(lang, 'ticketLabel')} ${index + 1} ${t(lang, 'of')} ${total}
        </div>
        <div style="margin-bottom: 12px;">
          <img
            src="${ticket.qrImageDataUrl}"
            alt="QR Code"
            width="200"
            height="200"
            style="display: block; margin: 0 auto; border-radius: 8px;"
          />
        </div>
        <div style="display: inline-block; padding: 6px 16px; border-radius: 20px; background: ${typeColor}; color: #ffffff; font-size: 14px; font-weight: 600;">
          ${typeLabel}
        </div>
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t(lang, 'subject')}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #1a1a2e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <div style="max-width: 480px; margin: 0 auto; padding: 32px 16px;">

    <!-- Header -->
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">
        ${t(lang, 'heading')}
      </h1>
      <p style="color: #b0b0b0; font-size: 14px; margin: 0;">
        ${eventName}
      </p>
    </div>

    <!-- Instruction -->
    <p style="color: #d0d0d0; font-size: 15px; text-align: center; margin-bottom: 24px;">
      ${t(lang, 'subheading')}
    </p>

    <!-- Ticket Cards -->
    ${ticketCards}

    <!-- Footer -->
    <div style="text-align: center; margin-top: 32px; padding-top: 24px; border-top: 1px solid #333;">
      <p style="color: #999; font-size: 13px; margin: 0 0 8px 0;">
        ${t(lang, 'footer')}
      </p>
      <p style="color: #777; font-size: 12px; margin: 0 0 16px 0;">
        ${t(lang, 'footerTip')}
      </p>
      <p style="color: #555; font-size: 11px; margin: 0;">
        ${t(lang, 'poweredBy')}
      </p>
    </div>

  </div>
</body>
</html>
  `.trim();
}

// ─── Send Function ───────────────────────────────────────────

/**
 * Sends a ticket confirmation email.
 *
 * IMPORTANT: This function never throws. If the email fails,
 * it logs the error and returns false. This is intentional —
 * a failed email should NEVER prevent the ticket from being created
 * or the webhook from responding 200 to Stripe.
 */
export async function sendTicketEmail(params: SendTicketEmailParams): Promise<boolean> {
  // If Resend is not configured, skip silently
  if (!resend) {
    console.warn('[Email] Skipping email — Resend not configured');
    return false;
  }

  // Validate email
  if (!params.to || !params.to.includes('@')) {
    console.warn(`[Email] Skipping email — invalid address: ${params.to}`);
    return false;
  }

  const lang = params.language || 'en';

  try {
    const html = buildTicketEmailHtml(params);

    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to: params.to,
      subject: `${t(lang, 'subject')} — ${params.eventName}`,
      html: html,
    });

    console.log(`[Email] ✅ Sent to ${params.to} — Resend ID: ${result.data?.id}`);
    return true;
  } catch (error) {
    console.error(`[Email] ❌ Failed to send to ${params.to}:`, error);
    return false;
  }
}