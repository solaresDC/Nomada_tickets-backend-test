/**
 * Email Service
 *
 * Sends ticket confirmation emails via Resend.
 * Called by the webhook after tickets are created,
 * and also by the resend endpoint in ticketLookup.ts.
 *
 * CHANGES FROM ORIGINAL:
 * - SendTicketEmailParams now accepts optional `orderReference`
 * - Email template includes a styled "Your Order Reference" section
 *   so customers can find their tickets using the lookup feature
 *
 * This service:
 * - Builds an HTML email with QR codes as CID-attached images (inline in body)
 * - ALSO attaches the same QR codes as regular PNG file downloads (fallback)
 * - Sends one email per order (containing all tickets)
 * - Handles errors gracefully (email failure does NOT break ticket creation)
 *
 * RESEND CID FORMAT (from their official docs):
 *   attachments: [{
 *     content: "<base64 string>",   // NOT a Buffer — raw base64 text
 *     filename: "qr-0.png",
 *     contentId: "qr-0",            // camelCase — makes it inline CID
 *   }]
 *   HTML: <img src="cid:qr-0" />
 */

import { Resend } from 'resend';

// ─── Configuration ───────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'tickets@yourdomain.com';

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
  to: string;
  eventName: string;
  tickets: TicketForEmail[];
  language: string;           // 'en' | 'es' | 'pt-BR'
  orderReference?: string;    // NEW — e.g. "NMD-2847-XK9Q"
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
    orderRefLabel: 'Your Order Reference',
    orderRefHelper: 'Save this code — you can use it to look up your tickets anytime.',
    footer: "Save this email — you'll need it at the door.",
    footerTip: 'Tip: Screenshot each QR code for quick access.',
    supportMsg: 'Need help? Contact us at nomada.events.to@gmail.com',
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
    orderRefLabel: 'Tu Número de Orden',
    orderRefHelper: 'Guarda este código — puedes usarlo para consultar tus boletos en cualquier momento.',
    footer: 'Guarda este correo — lo necesitarás en la puerta.',
    footerTip: 'Tip: Toma captura de cada código QR para acceso rápido.',
    supportMsg: '¿Necesitas ayuda? Contáctanos en nomada.events.to@gmail.com',
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
    orderRefLabel: 'Seu Número de Pedido',
    orderRefHelper: 'Salve este código — você pode usá-lo para consultar seus ingressos a qualquer momento.',
    footer: 'Salve este e-mail — você vai precisar na porta.',
    footerTip: 'Dica: Tire print de cada código QR para acesso rápido.',
    supportMsg: 'Precisa de ajuda? Entre em contato: nomada.events.to@gmail.com',
    poweredBy: 'Powered by Nómada',
  },
};

function t(lang: string, key: string): string {
  const strings = emailStrings[lang] || emailStrings['en'];
  return strings[key] || emailStrings['en'][key] || key;
}

// ─── HTML Email Builder ──────────────────────────────────────

function buildTicketEmailHtml(params: SendTicketEmailParams): string {
  const { eventName, tickets, language, orderReference } = params;
  const lang = language || 'en';
  const total = tickets.length;

  // Build ticket cards (one per QR code)
  const ticketCards = tickets.map((ticket, index) => {
    const typeLabel = ticket.ticketType === 'female'
      ? t(lang, 'womenTicket')
      : t(lang, 'menTicket');

    const typeColor = ticket.ticketType === 'female' ? '#E91E8C' : '#2196F3';
    const cidName = `qr-${index}`;

    return `
      <div style="background: #ffffff; border-radius: 12px; padding: 24px; margin-bottom: 20px; text-align: center; border: 1px solid #e0e0e0;">
        <div style="font-size: 14px; color: #666; margin-bottom: 8px;">
          ${t(lang, 'ticketLabel')} ${index + 1} ${t(lang, 'of')} ${total}
        </div>
        <div style="margin-bottom: 12px;">
          <img
            src="cid:${cidName}"
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

  // Order reference section — only shown if reference was generated
  const orderRefSection = orderReference ? `
    <div style="background: #2a003b; border: 1px solid #6b21a8; border-radius: 12px; padding: 20px; margin-bottom: 24px; text-align: center;">
      <div style="font-size: 12px; color: #c084fc; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">
        ${t(lang, 'orderRefLabel')}
      </div>
      <div style="font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: 0.15em; font-family: 'Courier New', Courier, monospace;">
        ${orderReference}
      </div>
      <div style="font-size: 12px; color: #a0a0a0; margin-top: 8px;">
        ${t(lang, 'orderRefHelper')}
      </div>
    </div>
  ` : '';

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

    <!-- Order Reference Box -->
    ${orderRefSection}

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
      <p style="color: #777; font-size: 12px; margin: 0 0 16px 0;">
        ${t(lang, 'supportMsg')}
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

// ─── Helper: Extract base64 from data URL ────────────────────

function extractBase64FromDataUrl(dataUrl: string): string {
  const marker = 'base64,';
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex === -1) return dataUrl;
  return dataUrl.substring(markerIndex + marker.length);
}

// ─── Build ALL Attachments ────────────────────────────────────

function buildAttachments(tickets: TicketForEmail[], lang: string) {
  const attachments: Array<{
    content: string;
    filename: string;
    contentId?: string;
  }> = [];

  tickets.forEach((ticket, index) => {
    const base64Data = extractBase64FromDataUrl(ticket.qrImageDataUrl);
    const cidName = `qr-${index}`;

    const typeLabel = ticket.ticketType === 'female'
      ? t(lang, 'womenTicket')
      : t(lang, 'menTicket');
    const friendlyName = `${t(lang, 'ticketLabel')}-${index + 1}-${typeLabel}.png`;

    // 1) CID inline — renders in the email body
    attachments.push({
      content: base64Data,
      filename: `${cidName}.png`,
      contentId: cidName,
    });

    // 2) Regular downloadable — same image, no contentId
    attachments.push({
      content: base64Data,
      filename: friendlyName,
    });
  });

  return attachments;
}

// ─── Send Function ───────────────────────────────────────────

export async function sendTicketEmail(params: SendTicketEmailParams): Promise<boolean> {
  if (!resend) {
    console.warn('[Email] Skipping email — Resend not configured');
    return false;
  }

  if (!params.to || !params.to.includes('@')) {
    console.warn(`[Email] Skipping email — invalid address: ${params.to}`);
    return false;
  }

  const lang = params.language || 'en';

  try {
    const html = buildTicketEmailHtml(params);
    const attachments = buildAttachments(params.tickets, lang);

    const inlineCount = attachments.filter(a => a.contentId).length;
    const downloadCount = attachments.filter(a => !a.contentId).length;
    console.log(`[Email] Sending to ${params.to} — ${inlineCount} inline CID + ${downloadCount} downloadable PNGs`);

    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to: params.to,
      subject: `${t(lang, 'subject')} — ${params.eventName}`,
      html: html,
      attachments: attachments,
    });

    console.log(`[Email] ✅ Sent to ${params.to} — Resend ID: ${result.data?.id}`);
    return true;
  } catch (error) {
    console.error(`[Email] ❌ Failed to send to ${params.to}:`, error);
    return false;
  }
}