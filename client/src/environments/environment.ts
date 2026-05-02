/**
 * REST base URL (must match backend mount, e.g. Express `app.use('/api/auth', …)` → ends with `/api`).
 * Mirror the same value in `client/.env` as `NG_APP_API_URL` for documentation/CI; Angular reads this file at build time unless you add a custom env replacement.
 */
export const environment = {
  production: false,
  apiUrl: 'http://localhost:5000/api',
  socketUrl: 'http://localhost:5000',
};
