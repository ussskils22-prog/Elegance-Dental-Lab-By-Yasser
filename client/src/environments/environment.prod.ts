/**
 * Elite Dental Lab production API.
 * Prefer ELITE_API_URL / NG_APP_API_URL at build time (see scripts/write-prod-env.js).
 * Fallback must stay on Elite Railway — never Elegance.
 */
export const environment = {
  production: true,
  apiUrl: 'https://elegance-dental-lab-by-yasser-production-962c.up.railway.app/api',
  socketUrl: 'https://elegance-dental-lab-by-yasser-production-962c.up.railway.app',
};
