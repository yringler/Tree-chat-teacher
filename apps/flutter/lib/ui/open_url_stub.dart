/// Opens [url] in the browser. Native builds have no browser to hand it to
/// yet, so this returns false and the caller shows the address instead.
bool openUrl(Uri url, {required bool newTab}) => false;
