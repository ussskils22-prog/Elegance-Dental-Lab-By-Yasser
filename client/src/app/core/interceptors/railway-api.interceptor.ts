import { Injectable } from '@angular/core';
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiBaseUrl } from '../api/api.config';

/**
 * Rewrite absolute /api URLs to the correct Railway API for this host
 * (production vs demo). Vercel serves the Angular app, not Express.
 */
@Injectable()
export class RailwayApiInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    if (req.url.includes('localhost')) {
      return next.handle(req);
    }
    const railwayApi = apiBaseUrl().replace(/\/+$/, '');
    const q = req.url.indexOf('?');
    const pathOnly = q >= 0 ? req.url.slice(0, q) : req.url;
    const query = q >= 0 ? req.url.slice(q) : '';
    const apiAt = pathOnly.lastIndexOf('/api');
    if (apiAt < 0) {
      return next.handle(req);
    }
    const after = pathOnly.slice(apiAt + 4);
    const dest = `${railwayApi}${after}${query}`;
    if (dest === req.url) {
      return next.handle(req);
    }
    return next.handle(req.clone({ url: dest }));
  }
}
