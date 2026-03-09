/**
 * CORS Plugin
 * 
 * CORS (Cross-Origin Resource Sharing) controls which websites
 * can make requests to our API.
 * 
 * In development, we allow cerrtain origins for convenience like from LiveServer.
 * 
 * In production, this should only allow requests from our frontend domain.
 */

import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

export async function registerCors(app: FastifyInstance): Promise<void> {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Development origins — hardcoded, never need to change
  const devOrigins = [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ];

  // Production origin — set this in Render environment variables
  // Example: https://nomada-tickets-frontend-test.pages.dev
  const productionOrigin = process.env.FRONTEND_ORIGIN || '';
  const scannerOrigin = process.env.SCANNER_ORIGIN || '';

  const allowedOrigins = [...devOrigins, productionOrigin, scannerOrigin].filter(Boolean);

  await app.register(cors, {
    origin: isDevelopment ? true : (origin, callback) => {
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400
  });

  console.log(`[CORS] Configured for ${isDevelopment ? 'development (all origins)' : `production (${allowedOrigins.join(', ')})`}`);
}