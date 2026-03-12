/**
 * Ticket Backend Server
 *
 * Main entry point for the application.
 * Initializes Fastify with all plugins and routes.
 *
 * CHANGE: Added ticketLookupRoutes import and registration.
 */

// Load environment variables FIRST (before any other imports)
import 'dotenv/config';

import Fastify from 'fastify';
import { registerCors } from './plugins/cors.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { registerHelmet } from './plugins/helmet.js';
import { checkoutRoutes } from './routes/checkout.js';
import { webhookRoutes } from './routes/webhook.js';
import { orderRoutes } from './routes/orders.js';
import { scannerRoutes } from './routes/scanner.js';
import { ticketLookupRoutes } from './routes/ticketLookup.js'; // NEW

// Create Fastify instance
const app = Fastify({
  logger: true,
  bodyLimit: 1048576,  // 1MB body size limit
  trustProxy: true     // Trust proxy headers (needed for Render)
});

// Server configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Register all plugins
 */
async function registerPlugins(): Promise<void> {
  console.log('[Server] Registering plugins...');

  // IMPORTANT: Register webhook routes FIRST — needs raw body parser
  await app.register(async (webhookApp) => {
    await webhookRoutes(webhookApp);
  });

  // Now register plugins for other routes
  await registerCors(app);
  await registerRateLimit(app);
  await registerHelmet(app);
}

/**
 * Register all routes
 */
async function registerRoutes(): Promise<void> {
  console.log('[Server] Registering routes...');

  await checkoutRoutes(app);
  await orderRoutes(app);
  await scannerRoutes(app);
  await ticketLookupRoutes(app); // NEW

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}

/**
 * Start the server
 */
async function startServer(): Promise<void> {
  try {
    await registerPlugins();
    await registerRoutes();

    await app.listen({ port: PORT, host: HOST });

    console.log('='.repeat(50));
    console.log(`🚀 Server running at http://${HOST}:${PORT}`);
    console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 CORS Origin: ${process.env.FRONTEND_ORIGIN || 'all (development)'}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

startServer();