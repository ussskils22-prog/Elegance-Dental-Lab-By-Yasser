import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly title = signal('client');
  private readonly auth = inject(AuthService);

  /** Exposed for template: hide router until JWT/session bootstrap finishes. */
  protected readonly authReady = this.auth.bootstrapComplete;
}
