import 'token_store.dart';

/// Native builds keep values in [SecureTokenStore] instead.
TokenStore browserStore(String key) =>
    throw UnsupportedError('No browser storage off the web');
