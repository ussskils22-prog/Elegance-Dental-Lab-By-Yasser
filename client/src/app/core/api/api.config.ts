import { environment } from '../../../environments/environment';

/**
 * Single source for REST API base URL (must include `/api` if the backend mounts routes under `/api`).
 * All HTTP services should build paths from this value.
 */
export function apiBaseUrl(): string {
  return environment.apiUrl.replace(/\/+$/, '');
}
