import 'package:flutter/material.dart';

import '../config.dart';
import 'open_url.dart';

/// Opens [href], a path of the web apps or a link in a reply. Only web links
/// are followed; where the platform can't open one, its address is shown.
void openLink(BuildContext context, String href, {bool newTab = false}) {
  final url = apiBaseUri().resolve(href);
  if (url.scheme != 'https' && url.scheme != 'http') return;
  if (openUrl(url, newTab: newTab)) return;
  ScaffoldMessenger.maybeOf(
    context,
  )?.showSnackBar(SnackBar(content: SelectableText('Open $url in a browser.')));
}
