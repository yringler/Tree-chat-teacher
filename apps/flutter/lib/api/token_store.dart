import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A string a build keeps between launches: a native build's session token
/// and sealed key cookie (the web build's browser keeps its cookies), and
/// the learner's pick of who pays.
abstract interface class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// [TokenStore] in the platform's keychain or keystore, under [key].
class SecureTokenStore implements TokenStore {
  const SecureTokenStore([this.key = sessionTokenKey]);

  static const sessionTokenKey = 'tangent.session_token';
  static const keyCookieKey = 'tangent.key_cookie';

  final String key;

  static const _storage = FlutterSecureStorage();

  @override
  Future<String?> read() => _storage.read(key: key);

  @override
  Future<void> write(String token) => _storage.write(key: key, value: token);

  @override
  Future<void> clear() => _storage.delete(key: key);
}
