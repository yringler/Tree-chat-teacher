import 'package:flutter/foundation.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';

/// Asks Google, on the device, for an ID token issued to [serverClientId]
/// (the Worker's `GOOGLE_CLIENT_ID`, the web client). Throws when there is
/// none, a [GoogleSignInException] for whatever Google reports, the learner
/// backing out included: Credential Manager reports some misconfigured builds
/// as `canceled` too, so the page says what Google said either way.
typedef GoogleIdTokenSource = Future<String> Function(String serverClientId);

/// Each platform instance is set up once; tests swap the instance.
final _initialized = Expando<Future<void>>();

/// [GoogleIdTokenSource] through Android's Credential Manager. The app
/// depends on google_sign_in_android alone, not package:google_sign_in:
/// that one's web plugin loads Google's script as the web build starts,
/// which the app's CSP refuses, and the web build signs in through the
/// browser instead.
Future<String> deviceGoogleIdToken(String serverClientId) async {
  final google = GoogleSignInPlatform.instance;
  try {
    final init = _initialized[google] ??= google.init(
      InitParameters(serverClientId: serverClientId),
    );
    try {
      await init;
    } on Object {
      // Not kept, so the next tap sets it up again.
      _initialized[google] = null;
      rethrow;
    }
    final result = await google.authenticate(const AuthenticateParameters());
    final idToken = result.authenticationTokens.idToken;
    if (idToken == null || idToken.isEmpty) {
      throw const GoogleSignInException(
        code: GoogleSignInExceptionCode.unknownError,
        description: 'Google gave no ID token',
      );
    }
    return idToken;
  } on GoogleSignInException catch (error) {
    // In logcat (`adb logcat -s flutter`) on a release build too, to tell a
    // back-out from a setup problem. Google's code and description only:
    // they carry no token.
    debugPrint(
      'Google sign-in failed: ${error.code.name}: ${error.description}',
    );
    rethrow;
  } finally {
    // The token is all the app needs from Google: forgetting the account
    // lets the next sign-in pick another. Failing to forget it doesn't undo
    // the sign-in.
    try {
      await google.signOut(const SignOutParams());
    } on Object catch (error) {
      debugPrint('Google sign-out after sign-in failed: $error');
    }
  }
}
