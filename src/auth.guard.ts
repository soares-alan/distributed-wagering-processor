import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Authentication extension point (challenge section 2). Intentionally a no-op:
 * authentication is optional and unscored. A real implementation would validate an
 * OIDC access token from an external Identity Provider (see ARCHITECTURE.md, section 10).
 * Health endpoints must stay open when it is implemented.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
