import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { SwUpdateService } from './core/services/sw-update.service';
import { LanguageService } from './core/i18n/language.service';
import { DemoModeService } from './core/services/demo-mode.service';

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
  /** Eager init so dir/lang apply before first route paint */
  private readonly lang = inject(LanguageService);
  readonly swUpdate = inject(SwUpdateService);
  readonly demoModeSvc = inject(DemoModeService);

  /** Exposed for template: hide router until JWT/session bootstrap finishes. */
  protected readonly authReady = this.auth.bootstrapComplete;
}
