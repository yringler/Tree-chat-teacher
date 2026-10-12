import 'package:web/web.dart' as web;

import 'token_store.dart';

/// [TokenStore] in this browser's localStorage, under [key].
TokenStore browserStore(String key) => _LocalStorage(key);

class _LocalStorage implements TokenStore {
  const _LocalStorage(this.key);

  final String key;

  @override
  Future<String?> read() async => web.window.localStorage.getItem(key);

  @override
  Future<void> write(String token) async =>
      web.window.localStorage.setItem(key, token);

  @override
  Future<void> clear() async => web.window.localStorage.removeItem(key);
}
