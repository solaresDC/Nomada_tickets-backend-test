/**
 * Scanner Routes
 *
 * Three endpoints for the door scanner app:
 * 1. POST /api/scanner/auth     — PIN login, returns session token
 * 2. GET  /api/scanner/tickets  — Fetch all valid tickets (authenticated)
 * 3. POST /api/scanner/scan     — Mark a ticket as used (authenticated)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { supabase } from '../plugins/supabase.js';
import { ticketStore } from '../services/supabaseTicketStore.js';

// How long a scanner session lasts (12 hours)
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * Verify the session token from the Authorization header.
 * Returns true if valid, false if not.
 */
async function verifySession(request: FastifyRequest): Promise<boolean> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.replace('Bearer ', '');

  const { data, error } = await supabase
    .from('scanner_sessions')
    .select('id, expires_at')
    .eq('token', token)
    .single();

  if (error || !data) {
    return false;
  }

  // Check if session has expired
  if (new Date(data.expires_at) < new Date()) {
    // Clean up expired session
    await supabase.from('scanner_sessions').delete().eq('id', data.id);
    return false;
  }

  return true;
}

export async function scannerRoutes(app: FastifyInstance): Promise<void> {

  // ─── POST /api/scanner/auth ────────────────────────────────
  app.post('/api/scanner/auth', async (request: FastifyRequest, reply: FastifyReply) => {
    const { pin } = request.body as { pin: string };

    // Validate input
    if (!pin || typeof pin !== 'string' || pin.length !== 4) {
      return reply.status(400).send({
        error: 'Invalid PIN format. Must be exactly 4 digits.',
      });
    }

    // Check PIN against environment variable
    const correctPin = process.env.SCANNER_PIN;
    if (!correctPin) {
      console.error('[Scanner] SCANNER_PIN environment variable is not set!');
      return reply.status(500).send({ error: 'Scanner not configured.' });
    }

    // Timing-safe comparison to prevent timing attacks
    const pinBuffer = Buffer.from(pin);
    const correctBuffer = Buffer.from(correctPin);

    if (pinBuffer.length !== correctBuffer.length ||
        !crypto.timingSafeEqual(pinBuffer, correctBuffer)) {
      return reply.status(401).send({ error: 'Incorrect PIN.' });
    }

    // PIN is correct — create a session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const { error } = await supabase
      .from('scanner_sessions')
      .insert({
        token: sessionToken,
        device_info: request.headers['user-agent'] || 'unknown',
        expires_at: expiresAt.toISOString(),
      });

    if (error) {
      console.error('[Scanner] Failed to create session:', error);
      return reply.status(500).send({ error: 'Failed to create session.' });
    }

    console.log(`[Scanner] New session created, expires at ${expiresAt.toISOString()}`);

    return reply.send({
      token: sessionToken,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // ─── GET /api/scanner/tickets ──────────────────────────────
  app.get('/api/scanner/tickets', async (request: FastifyRequest, reply: FastifyReply) => {
    // Check authentication
    const isValid = await verifySession(request);
    if (!isValid) {
      return reply.status(401).send({ error: 'Unauthorized. Please log in with your PIN.' });
    }

    try {
      const tickets = await ticketStore.getAllValidTickets();

      return reply.send({
        tickets,
        count: tickets.length,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[Scanner] Failed to fetch tickets:', error);
      return reply.status(500).send({ error: 'Failed to fetch tickets.' });
    }
  });

  // ─── POST /api/scanner/scan ────────────────────────────────
  app.post('/api/scanner/scan', async (request: FastifyRequest, reply: FastifyReply) => {
    // Check authentication
    const isValid = await verifySession(request);
    if (!isValid) {
      return reply.status(401).send({ error: 'Unauthorized. Please log in with your PIN.' });
    }

    const { qrToken } = request.body as { qrToken: string };

    if (!qrToken || typeof qrToken !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid qrToken.' });
    }

    try {
      const result = await ticketStore.markTicketAsUsed(qrToken);

      if (result.success) {
        return reply.send({
          result: 'accepted',
          ticketType: result.ticketType,
          message: `Accepted — ${result.ticketType === 'female' ? 'Female' : 'Male'}`,
        });
      }

      if (result.alreadyUsed) {
        return reply.send({
          result: 'rejected',
          ticketType: result.ticketType,
          message: 'Already Scanned',
        });
      }

      return reply.send({
        result: 'not_found',
        message: 'QR code not recognized',
      });
    } catch (error) {
      console.error('[Scanner] Failed to process scan:', error);
      return reply.status(500).send({ error: 'Failed to process scan.' });
    }
  });
}