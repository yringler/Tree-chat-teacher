import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:tangent/ui/google_id_token.dart';

/// Credential Manager as google_sign_in_android reports it: [authenticate]
/// answers [result], or throws [failure]; [signOut] throws [signOutFailure].
class _FakeGoogle extends GoogleSignInPlatform {
  _FakeGoogle({this.idToken = 'id.token', this.failure, this.signOutFailure});

  final String? idToken;
  final Object? failure;
  final Object? signOutFailure;
  final inits = <String?>[];
  var signOuts = 0;

  @override
  Future<void> init(InitParameters params) async =>
      inits.add(params.serverClientId);

  @override
  Future<AuthenticationResults?>? attemptLightweightAuthentication(
    AttemptLightweightAuthenticationParameters params,
  ) => null;

  @override
  bool supportsAuthenticate() => true;

  @override
  Future<AuthenticationResults> authenticate(
    AuthenticateParameters params,
  ) async {
    final error = failure;
    if (error != null) throw error;
    return AuthenticationResults(
      user: const GoogleSignInUserData(email: 'ada@example.com', id: 'g1'),
      authenticationTokens: AuthenticationTokenData(idToken: idToken),
    );
  }

  @override
  bool authorizationRequiresUserInteraction() => true;

  @override
  Future<ClientAuthorizationTokenData?> clientAuthorizationTokensForScopes(
    ClientAuthorizationTokensForScopesParameters params,
  ) async => null;

  @override
  Future<ServerAuthorizationTokenData?> serverAuthorizationTokensForScopes(
    ServerAuthorizationTokensForScopesParameters params,
  ) async => null;

  @override
  Future<void> signOut(SignOutParams params) async {
    signOuts++;
    final error = signOutFailure;
    if (error != null) throw error;
  }

  @override
  Future<void> disconnect(DisconnectParams params) async {}
}

void main() {
  test('asks for a token for the web client id, once set up', () async {
    final google = _FakeGoogle();
    GoogleSignInPlatform.instance = google;
    expect(await deviceGoogleIdToken('web-client'), 'id.token');
    expect(await deviceGoogleIdToken('web-client'), 'id.token');
    expect(google.inits, ['web-client']);
    expect(google.signOuts, 2, reason: 'the next sign-in can pick another');
  });

  test('a picker the learner backs out of throws, for the page to say', () {
    final google = _FakeGoogle(
      failure: const GoogleSignInException(
        code: GoogleSignInExceptionCode.canceled,
        description: 'activity is cancelled by the user.',
      ),
    );
    GoogleSignInPlatform.instance = google;
    expect(
      deviceGoogleIdToken('web-client'),
      throwsA(
        isA<GoogleSignInException>().having(
          (e) => e.code,
          'code',
          GoogleSignInExceptionCode.canceled,
        ),
      ),
    );
  });

  test('an account without an ID token is a failure, not a back-out', () {
    GoogleSignInPlatform.instance = _FakeGoogle(idToken: null);
    expect(
      deviceGoogleIdToken('web-client'),
      throwsA(isA<GoogleSignInException>()),
    );
  });

  test('forgetting the account failing keeps the token', () async {
    GoogleSignInPlatform.instance = _FakeGoogle(
      signOutFailure: PlatformException(code: 'Clear Failed'),
    );
    expect(await deviceGoogleIdToken('web-client'), 'id.token');
  });
}
