import { environment } from '../../../environments/environment';

/** Production Elegance Railway API */
export const ELEGANCE_RAILWAY_API =
  'https://elegance-dental-lab-by-yasser-production-5940.up.railway.app/api';

/**
 * Demo Railway API — replace after you create the demo Railway service.
 * Keep this updated in vercel.demo.json rewrites too (see docs/DEMO.md).
 */
export const DEMO_RAILWAY_API =
  'https://elegance-demo-api.up.railway.app/api';

/** Hostnames that must talk to the demo API (never production Mongo). */
const DEMO_HOSTS = new Set([
  'elegance-demo.vercel.app',
  'unishop-demo.vercel.app',
]);

function isDemoHostname(host: string): boolean {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (DEMO_HOSTS.has(h)) return true;
  // Preview deploys named *demo* on Vercel
  if (h.endsWith('.vercel.app') && h.includes('demo')) return true;
  return false;
}

export function isDemoFrontendHost(): boolean {
  try {
    return isDemoHostname(String(globalThis.location?.hostname || ''));
  } catch {
    return false;
  }
}

/**
 * Single source for REST API base URL (must include `/api`).
 */
export function apiBaseUrl(): string {
  const fromEnv = String(environment.apiUrl || '').replace(/\/+$/, '');
  try {
    const host = String(globalThis.location?.hostname || '');
    if (isDemoHostname(host)) {
      return DEMO_RAILWAY_API.replace(/\/+$/, '');
    }
    if (host === 'dental-system-seven.vercel.app' || host.endsWith('.vercel.app')) {
      return ELEGANCE_RAILWAY_API;
    }
  } catch {
    // SSR / tests
  }
  return fromEnv || ELEGANCE_RAILWAY_API;
}

/** Socket.IO origin (no `/api` suffix). */
export function socketBaseUrl(): string {
  const api = apiBaseUrl().replace(/\/+$/, '');
  if (api.endsWith('/api')) {
    return api.slice(0, -4);
  }
  const fromEnv = String(environment.socketUrl || '').replace(/\/+$/, '');
  return fromEnv || api;
}
