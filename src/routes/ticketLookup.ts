/**
 * Ticket Lookup Routes
 *
 * Allows customers to retrieve their purchased tickets by providing
 * their email address and order reference code (e.g. NMD-2847-XK9Q).
 *
 * Endpoints:
 *   POST /api/tickets/lookup   — look up tickets by email + order reference
 *   POST /api/tickets/resend   — resend confirmation email (max 2/day per email)
 *
 * Security:
 *   - Escalating lockout on failed attempts (stored in Supabase, survives restarts)
 *   - Lockout tiers by total lifetime failed attempts for this email+IP combination:
 *       Attempt 3  → locked 60 seconds
 *       Attempt 4  → locked 5 minutes
 *       Attempt 5  → locked 1 hour
 *       Attempt 6  → locked 12 hours
 *       Attempt 7+ → repeats: 60s, 5min, 1hr, 12hr, ...
 *   - Resend capped at 2 successful sends per email per 24 hours
 *   - All resend attempts (success + failure) logged for audit
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from '../plugins/supabase.js';
import { ticketStore } from '../services/supabaseTicketStore.js';
import { generateQRCodeDataUrl } from '../services/qrService.js';
import { sendTicketEmail } from '../services/emailService.js';
import crypto from 'node:crypto';

// ─── Lockout Tier Configuration ──────────────────────────────
// Maps attempt number (3rd, 4th, 5th...) to lockout duration in seconds.
// After attempt 6, the pattern repeats from index 0.
const LOCKOUT_TIERS_SECONDS = [
  60,          // 3rd fail  → 60 seconds
  5 * 60,      // 4th fail  → 5 minutes
  60 * 60,     // 5th fail  → 1 hour
  12 * 60 * 60 // 6th fail  → 12 hours
];

// How many failed attempts before lockout kicks in
const FREE_ATTEMPTS = 2; // Attempts 1 and 2 are free; 3rd triggers first lockout

// Resend cap: max successful resends per email per rolling 24h window
const MAX_RESENDS_PER_DAY = 2;

// ─── Helper: Get client IP ────────────────────────────────────

function getClientIp(request: FastifyRequest): string {
  // Render.com passes real IP in x-forwarded-for header
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ip.trim();
  }
  return request.ip || 'unknown';
}

// ─── Helper: Check lockout status ────────────────────────────

/**
 * Checks if this email+IP combo is currently locked out.
 * Returns { locked: false } or { locked: true, secondsRemaining: N }
 */
async function checkLockout(
  email: string,
  ip: string
): Promise<{ locked: false } | { locked: true; secondsRemaining: number }> {

  // Count total failed attempts for this email+ip (all time, not just recent)
  const { count, error: countError } = await supabase
    .from('lookup_attempts_log')
    .select('*', { count: 'exact', head: true })
    .eq('email', email.toLowerCase())
    .eq('ip_address', ip);

  if (countError) {
    console.error('[Lockout] Failed to count attempts:', countError.message);
    // Fail open — if we can't check, let the request through
    return { locked: false };
  }

  const totalFails = count || 0;

  // Below the free attempt threshold — no lockout
  if (totalFails < FREE_ATTEMPTS + 1) {
    return { locked: false };
  }

  // Determine which lockout tier applies.
  // Tier index cycles: 3rd fail=0, 4th=1, 5th=2, 6th=3, 7th=0, 8th=1, ...
  const tierIndex = (totalFails - FREE_ATTEMPTS - 1) % LOCKOUT_TIERS_SECONDS.length;
  const lockoutSeconds = LOCKOUT_TIERS_SECONDS[tierIndex];

  // Find the timestamp of the most recent failed attempt
  const { data: lastAttempt, error: lastError } = await supabase
    .from('lookup_attempts_log')
    .select('attempted_at')
    .eq('email', email.toLowerCase())
    .eq('ip_address', ip)
    .order('attempted_at', { ascending: false })
    .limit(1)
    .single();

  if (lastError || !lastAttempt) {
    return { locked: false };
  }

  const lastAttemptAt = new Date(lastAttempt.attempted_at);
  const lockoutEndsAt = new Date(lastAttemptAt.getTime() + lockoutSeconds * 1000);
  const now = new Date();

  if (now < lockoutEndsAt) {
    const secondsRemaining = Math.ceil((lockoutEndsAt.getTime() - now.getTime()) / 1000);
    return { locked: true, secondsRemaining };
  }

  // Lockout has expired — they're free to try again
  return { locked: false };
}

// ─── Helper: Record a failed lookup attempt ───────────────────

async function recordFailedAttempt(email: string, ip: string): Promise<void> {
  const { error } = await supabase
    .from('lookup_attempts_log')
    .insert({
      email: email.toLowerCase(),
      ip_address: ip,
      attempted_at: new Date().toISOString(),
    });

  if (error) {
    console.error('[Lockout] Failed to record attempt:', error.message);
    // Non-fatal — don't throw
  }
}

// ─── Helper: Check resend cap ─────────────────────────────────

/**
 * Returns how many successful resends this email has used in the last 24 hours.
 */
async function getResendCountToday(email: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('email_resend_log')
    .select('*', { count: 'exact', head: true })
    .eq('email', email.toLowerCase())
    .eq('was_successful', true)
    .gte('requested_at', since);

  if (error) {
    console.error('[Resend] Failed to check resend count:', error.message);
    return 0; // Fail open
  }

  return count || 0;
}

// ─── Helper: Log a resend attempt ────────────────────────────

async function logResendAttempt(params: {
  email: string;
  paymentIntentId: string;
  ip: string;
  wasSuccessful: boolean;
  failureReason?: string;
}): Promise<void> {
  const { email, paymentIntentId, ip, wasSuccessful, failureReason } = params;

  // Insert into audit log
  const { error: logError } = await supabase
    .from('email_resend_log')
    .insert({
      email: email.toLowerCase(),
      payment_intent_id: paymentIntentId,
      ip_address: ip,
      requested_at: new Date().toISOString(),
      was_successful: wasSuccessful,
      failure_reason: failureReason || null,
    });

  if (logError) {
    console.error('[Resend] Failed to insert resend log:', logError.message);
  }

  // Upsert into stats scoreboard (one row per email, running counters)
  const incrementField = wasSuccessful ? 'successful_resends' : 'failed_resends';

  // We use a raw RPC call to atomically increment the counter.
  // This avoids the read-then-write race condition.
  const { error: statsError } = await supabase.rpc('increment_resend_stat', {
    p_email: email.toLowerCase(),
    p_field: incrementField,
    p_ip: ip,
  });

  if (statsError) {
    // Fallback: try a manual upsert (less safe but better than nothing)
    console.warn('[Resend] RPC increment failed, trying upsert fallback:', statsError.message);
    await supabase
      .from('email_resend_stats')
      .upsert({
        email: email.toLowerCase(),
        [incrementField]: 1,
        last_resend_at: new Date().toISOString(),
        last_resend_ip: ip,
      }, {
        onConflict: 'email',
        ignoreDuplicates: false,
      });
  }
}

// ─── Route Registration ───────────────────────────────────────

export async function ticketLookupRoutes(app: FastifyInstance): Promise<void> {

  // ────────────────────────────────────────────────────────────
  // POST /api/tickets/lookup
  //
  // Looks up an order by email + order reference code.
  // Returns ticket info and payment summary if found.
  // Records failed attempts and enforces escalating lockout.
  // ────────────────────────────────────────────────────────────
  app.post('/api/tickets/lookup', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'orderReference'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          orderReference: { type: 'string', minLength: 5, maxLength: 20 },
        },
        additionalProperties: false,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, orderReference } = request.body as {
      email: string;
      orderReference: string;
    };
    const ip = getClientIp(request);
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedRef = orderReference.toUpperCase().trim();

    console.log(`[Lookup] Attempt from IP ${ip} for ref: ${normalizedRef}`);

    // ── Step 1: Check lockout ──────────────────────────────────
    const lockoutStatus = await checkLockout(normalizedEmail, ip);
    if (lockoutStatus.locked) {
      console.log(`[Lookup] LOCKED — ${lockoutStatus.secondsRemaining}s remaining`);
      return reply.status(429).send({
        error: 'too_many_attempts',
        secondsRemaining: lockoutStatus.secondsRemaining,
      });
    }

    // ── Step 2: Look up the order by reference code ────────────
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('payment_intent_id, email, female_qty, male_qty, created_at, order_reference')
      .eq('order_reference', normalizedRef)
      .single();

    if (orderError || !order) {
      // Wrong reference code — record the failure
      await recordFailedAttempt(normalizedEmail, ip);
      console.log(`[Lookup] Not found: ref=${normalizedRef}`);
      return reply.status(404).send({ error: 'not_found' });
    }

    // ── Step 3: Verify the email matches ──────────────────────
    if (!order.email || order.email.toLowerCase() !== normalizedEmail) {
      // Wrong email — record the failure
      await recordFailedAttempt(normalizedEmail, ip);
      console.log(`[Lookup] Email mismatch for ref=${normalizedRef}`);
      return reply.status(404).send({ error: 'not_found' });
      // NOTE: We return 'not_found' (not 'wrong_email') intentionally.
      // Never confirm that a reference code exists — that leaks information.
    }

    // ── Step 4: Fetch tickets for this order ──────────────────
    const tickets = await ticketStore.getTicketsByPaymentIntentId(order.payment_intent_id);

    if (!tickets || tickets.length === 0) {
      // Order exists but tickets not yet created (very unlikely, but handle it)
      return reply.status(202).send({
        status: 'pending',
        message: 'Tickets are being generated. Please try again in a moment.',
      });
    }

    // ── Step 5: Generate QR code images for each ticket ───────
    const ticketsWithQR = await Promise.all(
      tickets.map(async (tk) => ({
        id: tk.id,
        ticketType: tk.ticketType,
        status: tk.status,
        qrImageDataUrl: await generateQRCodeDataUrl(tk.qrToken),
      }))
    );

    // ── Step 6: Build payment summary ─────────────────────────
    const femaleQty = order.female_qty || 0;
    const maleQty = order.male_qty || 0;
    const subtotal = femaleQty * 1 + maleQty * 2;
    const fee = Math.round(subtotal * 0.08 * 100) / 100;
    const total = subtotal + fee;

    console.log(`[Lookup] ✅ Success — ${tickets.length} tickets returned for ref=${normalizedRef}`);

    return reply.status(200).send({
      status: 'found',
      orderReference: order.order_reference,
      paymentIntentId: order.payment_intent_id,
      createdAt: order.created_at,
      pricing: {
        femaleQty,
        maleQty,
        subtotal,
        fee,
        total,
      },
      tickets: ticketsWithQR,
    });
  });


  // ────────────────────────────────────────────────────────────
  // POST /api/tickets/resend
  //
  // Resends the confirmation email for an order.
  // Requires the same email + orderReference as lookup.
  // Capped at MAX_RESENDS_PER_DAY successful sends per email per 24h.
  // Logs everything to email_resend_log and email_resend_stats.
  // ────────────────────────────────────────────────────────────
  app.post('/api/tickets/resend', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'orderReference', 'language'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          orderReference: { type: 'string', minLength: 5, maxLength: 20 },
          language: { type: 'string', enum: ['en', 'es', 'pt-BR'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, orderReference, language } = request.body as {
      email: string;
      orderReference: string;
      language: string;
    };
    const ip = getClientIp(request);
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedRef = orderReference.toUpperCase().trim();

    console.log(`[Resend] Request from IP ${ip} for ref: ${normalizedRef}`);

    // ── Step 1: Check daily resend cap ─────────────────────────
    const resendCount = await getResendCountToday(normalizedEmail);
    if (resendCount >= MAX_RESENDS_PER_DAY) {
      await logResendAttempt({
        email: normalizedEmail,
        paymentIntentId: 'unknown', // We don't look up the order if cap exceeded
        ip,
        wasSuccessful: false,
        failureReason: 'cap_exceeded',
      });
      console.log(`[Resend] Cap exceeded for ${normalizedEmail}`);
      return reply.status(429).send({
        error: 'cap_exceeded',
        message: 'Maximum resend limit reached for today.',
      });
    }

    // ── Step 2: Verify email + order reference ─────────────────
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('payment_intent_id, email, female_qty, male_qty')
      .eq('order_reference', normalizedRef)
      .single();

    if (orderError || !order) {
      await logResendAttempt({
        email: normalizedEmail,
        paymentIntentId: 'not_found',
        ip,
        wasSuccessful: false,
        failureReason: 'order_not_found',
      });
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!order.email || order.email.toLowerCase() !== normalizedEmail) {
      await logResendAttempt({
        email: normalizedEmail,
        paymentIntentId: order.payment_intent_id,
        ip,
        wasSuccessful: false,
        failureReason: 'email_mismatch',
      });
      return reply.status(404).send({ error: 'not_found' });
    }

    // ── Step 3: Fetch tickets ─────────────────────────────────
    const tickets = await ticketStore.getTicketsByPaymentIntentId(order.payment_intent_id);

    if (!tickets || tickets.length === 0) {
      await logResendAttempt({
        email: normalizedEmail,
        paymentIntentId: order.payment_intent_id,
        ip,
        wasSuccessful: false,
        failureReason: 'no_tickets',
      });
      return reply.status(404).send({ error: 'no_tickets' });
    }

    // ── Step 4: Generate QR images and send email ─────────────
    try {
      const { generateQRCodeDataUrl } = await import('../services/qrService.js');

      const ticketsWithImages = await Promise.all(
        tickets.map(async (tk) => ({
          ticketType: tk.ticketType,
          qrToken: tk.qrToken,
          qrImageDataUrl: await generateQRCodeDataUrl(tk.qrToken),
        }))
      );

      const emailSent = await sendTicketEmail({
        to: normalizedEmail,
        eventName: 'Nómada',
        tickets: ticketsWithImages,
        language,
      });

      if (emailSent) {
        await logResendAttempt({
          email: normalizedEmail,
          paymentIntentId: order.payment_intent_id,
          ip,
          wasSuccessful: true,
        });
        console.log(`[Resend] ✅ Email resent to ${normalizedEmail}`);
        return reply.status(200).send({ status: 'sent' });
      } else {
        await logResendAttempt({
          email: normalizedEmail,
          paymentIntentId: order.payment_intent_id,
          ip,
          wasSuccessful: false,
          failureReason: 'resend_api_error',
        });
        return reply.status(500).send({ error: 'send_failed' });
      }

    } catch (err) {
      console.error('[Resend] ❌ Error sending email:', err);
      await logResendAttempt({
        email: normalizedEmail,
        paymentIntentId: order.payment_intent_id,
        ip,
        wasSuccessful: false,
        failureReason: 'resend_api_error',
      });
      return reply.status(500).send({ error: 'send_failed' });
    }
  });
}