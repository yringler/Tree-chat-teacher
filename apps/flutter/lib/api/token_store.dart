import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where a native build keeps its session token between launches. The web
/// build has none: the browser keeps Better Auth's session cookie.
abstract interface class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// [TokenStore] in the platform's keychain or keystore.
class SecureTokenStore implements TokenStore {
  const SecureTokenStore();

  static const _key = 'tangent.session_token';
  static const _storage = FlutterSecureStorage();

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String token) => _storage.write(key: _key, value: token);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}
