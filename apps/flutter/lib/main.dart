import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'api/http_tangent_api.dart';
import 'api/token_store.dart';
import 'app.dart';
import 'config.dart';

void main() {
  // Path URLs (/app/t/…) rather than /app/#/t/…; a no-op off the web.
  usePathUrlStrategy();
  // The web build's session is the browser's cookie; a native build keeps
  // its token itself.
  runApp(
    TangentApp(
      api: HttpTangentApi(
        baseUri: apiBaseUri(),
        tokens: kIsWeb ? null : const SecureTokenStore(),
      ),
    ),
  );
}
