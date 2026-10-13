import 'package:google_sign_in/google_sign_in.dart';

/// Asks Google, on the device, for an ID token issued to [serverClientId]
/// (the Worker's `GOOGLE_CLIENT_ID`); null when the learner backs out.
typedef GoogleIdTokenSource = Future<String?> Function(String serverClientId);

Future<void>? _initialized;

/// [GoogleIdTokenSource] through package:google_sign_in (Android's
/// Credential Manager).
Future<String?> deviceGoogleIdToken(String serverClientId) async {
  final google = GoogleSignIn.instance;
  await (_initialized ??= google.initialize(serverClientId: serverClientId));
  try {
    final account = await google.authenticate();
    return account.authentication.idToken;
  } on GoogleSignInException catch (error) {
    if (error.code == GoogleSignInExceptionCode.canceled) return null;
    rethrow;
  } finally {
    // The token is all the app needs from Google: forgetting the account
    // lets the next sign-in pick another.
    await google.signOut();
  }
}
