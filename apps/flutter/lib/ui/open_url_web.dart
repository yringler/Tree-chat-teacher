import 'package:web/web.dart' as web;

/// Opens [url] in this tab (pages of the web apps) or a new one (links in
/// replies). Returns whether it could.
bool openUrl(Uri url, {required bool newTab}) {
  if (newTab) {
    web.window.open(url.toString(), '_blank', 'noopener');
  } else {
    web.window.location.assign(url.toString());
  }
  return true;
}
