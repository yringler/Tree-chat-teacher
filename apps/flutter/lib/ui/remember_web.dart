import 'package:web/web.dart' as web;

/// Asks the Worker for a persistent session on the sign-in this browser
/// completes next; without it the session ends with the browser and lasts a
/// day. The cookie is `REMEMBER_COOKIE` in packages/shared/src/auth.ts, set
/// as the Angular apps' `setRemember(true)` does, and lives 15 minutes, as
/// long as a magic link.
void rememberSignIn() {
  final secure = web.window.location.protocol == 'https:' ? '; Secure' : '';
  web.document.cookie =
      'tangent-remember=1; Path=/api/auth; Max-Age=900; SameSite=Lax$secure';
}
