import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';

/// Asks Google, on the device, for an ID token issued to [serverClientId]
/// (the Worker's `GOOGLE_CLIENT_ID`); null when the learner backs out.
typedef GoogleIdTokenSource = Future<String?> Function(String serverClientId);

Future<void>? _initialized;

/// [GoogleIdTokenSource] through Android's Credential Manager. The app
/// depends on google_sign_in_android alone, not package:google_sign_in:
/// that one's web plugin loads Google's script as the web build starts,
/// which the app's CSP refuses, and the web build signs in through the
/// browser instead.
Future<String?> deviceGoogleIdToken(String serverClientId) async {
  final google = GoogleSignInPlatform.instance;
  await (_initialized ??= google.init(
    InitParameters(serverClientId: serverClientId),
  ));
  try {
    final result = await google.authenticate(const AuthenticateParameters());
    return result.authenticationTokens.idToken;
  } on GoogleSignInException catch (error) {
    if (error.code == GoogleSignInExceptionCode.canceled) return null;
    rethrow;
  } finally {
    // The token is all the app needs from Google: forgetting the account
    // lets the next sign-in pick another.
    await google.signOut(const SignOutParams());
  }
}
