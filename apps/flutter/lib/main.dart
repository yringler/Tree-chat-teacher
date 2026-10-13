import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'api/browser_store.dart';
import 'api/http_tangent_api.dart';
import 'api/token_store.dart';
import 'app.dart';
import 'config.dart';

/// `STORAGE_KEY` in apps/simple/src/app/state/payment-choice.ts.
const _choiceKey = 'tangent.learn.payment';

const _signInKey = 'tangent.learn.sign_in';

void main() {
  // Path URLs (/app/t/…) rather than /app/#/t/…; a no-op off the web.
  usePathUrlStrategy();
  // The web build's session and key are the browser's cookies; a native
  // build keeps its token and the sealed key cookie itself.
  runApp(
    TangentApp(
      api: HttpTangentApi(
        baseUri: apiBaseUri(),
        tokens: kIsWeb ? null : const SecureTokenStore(),
        keyCookie: kIsWeb
            ? null
            : const SecureTokenStore(SecureTokenStore.keyCookieKey),
      ),
      // The web app's Learn keeps the pick under the same name on this
      // origin, so a browser's pick holds in both.
      choiceStore: kIsWeb
          ? browserStore(_choiceKey)
          : const SecureTokenStore(_choiceKey),
      signInStore: kIsWeb
          ? browserStore(_signInKey)
          : const SecureTokenStore(_signInKey),
    ),
  );
}
