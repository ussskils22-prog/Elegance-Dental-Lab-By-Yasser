import { EnvironmentProviders, Provider } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { EMPTY, of } from 'rxjs';

/** Service worker is off in unit tests; components that inject SwUpdate get an inert stub. */
const swUpdateStub: Partial<SwUpdate> = {
  isEnabled: false,
  versionUpdates: EMPTY,
  unrecoverable: EMPTY,
  checkForUpdate: () => Promise.resolve(false),
  activateUpdate: () => Promise.resolve(false),
};

/** Providers every component spec needs: HttpClient, Router, and a SwUpdate stub. */
export function commonTestProviders(): (Provider | EnvironmentProviders)[] {
  return [provideHttpClient(), provideRouter([]), { provide: SwUpdate, useValue: swUpdateStub }];
}

/**
 * Wrap a partial service mock so any method the spec did not stub returns an empty,
 * successful API response instead of throwing "is not a function".
 */
export function lenientMock<T extends object>(base: Partial<T>): T {
  return new Proxy(base as T, {
    get: (target, prop) =>
      prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => of({ success: true, data: [] }),
  });
}
