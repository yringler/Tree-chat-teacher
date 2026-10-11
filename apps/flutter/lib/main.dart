import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'api/http_tangent_api.dart';
import 'app.dart';
import 'config.dart';

void main() {
  // Path URLs (/app/t/…) rather than /app/#/t/…; a no-op off the web.
  usePathUrlStrategy();
  runApp(TangentApp(api: HttpTangentApi(baseUri: apiBaseUri())));
}
