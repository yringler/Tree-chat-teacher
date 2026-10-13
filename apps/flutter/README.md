# Tangent Learn (Flutter)

A small Flutter version of Learn (`apps/simple`): sign in, the lessons list,
and the chat with streaming replies and tangents. One codebase for the web,
Android and iOS. The Worker serves the web build at `/app/`.

## Setup

Install the Flutter version in `.flutter-version` (cloud sessions get it from
`.claude/hooks/session-start.sh`). The root `pnpm install`, `pnpm build`,
`pnpm test` and `pnpm typecheck` include this app; in this folder:

```bash
flutter pub get
flutter test                  # unit and widget tests
flutter analyze               # strict analysis (analysis_options.yaml)
dart format lib test
```

### Web

`pnpm dev` from the repo root builds every app, this one included, and serves
it at <http://localhost:8787/app/>. With the default `.dev.vars` (no sign-in)
the app opens signed in; real local sign-in is "Option B" in
`apps/worker/.dev.vars.example`, which prints the sign-in email (the magic
link and the 6-digit code) to the wrangler console.

### Android and iOS

On a machine with Android Studio (Android) or Xcode (iOS, on a Mac), `flutter doctor` should show the toolchain, then:

```bash
flutter run --dart-define=TANGENT_BASE_URL=https://tangentailearning.com
flutter build apk --dart-define=TANGENT_BASE_URL=https://tangentailearning.com
```

Without `TANGENT_BASE_URL` the app talks to production. For a local Worker
from an Android emulator, use `http://10.0.2.2:8787`. The URL must be the
deployment's `PUBLIC_BASE_URL`: Turnstile accepts only tokens issued on that
host.

Sign-in needs no browser on a phone:

- **Captcha:** the Worker's `/app-captcha` page in a web view
  (`lib/ui/turnstile/turnstile_native.dart`), which posts the Turnstile token
  to the app's `TangentCaptcha` JavaScript channel.
- **Code:** the sign-in email carries a 6-digit code next to the link, and
  the app signs in by typing it. The link would open the phone's browser and
  sign in the web app there instead.
- **Google (Android):** google_sign_in_android shows the phone's account
  picker and returns an ID token issued to the Worker's `GOOGLE_CLIENT_ID`
  (from `/api/login-options`); the app posts it with the captcha token to
  `/api/auth/sign-in/social`. It needs the Android OAuth client in
  [operating.md](../../docs/operating.md). The web build's Google and GitHub
  buttons go through the browser instead.
- **Session:** the code and Google sign-ins answer with a signed token
  (`set-auth-token`). The app keeps it in the keychain or keystore
  (`lib/api/token_store.dart`), sends it as `Authorization: Bearer` on every
  call, and forgets it on sign-out. The web build keeps the HttpOnly cookie.

`flutter run --target test_driver/app.dart` runs the app with Flutter
Driver's extension, for a driver or an agent's flutter_driver tool to tap,
type and take screenshots.

The icons on every platform come from `assets/icon/` (the brand mark at
1024px); `dart run flutter_launcher_icons` regenerates them after a change.

## Android

The **Android build** workflow (`.github/workflows/android.yml`) runs only
when you start it: Actions tab → **Android build** → **Run workflow**. It
appears once the file is on master.

- **format**: `apk` installs straight on a phone; `appbundle` (.aab) is what
  Google Play takes; `both` builds the two.
- **track**: `none` only builds. `internal`, `alpha` (closed testing), `beta`
  (open testing) or `production` also publishes the app bundle to that
  Google Play track.
- **status**: `completed` releases it on that track; `draft` leaves it for you
  to roll out in Play Console. Use draft until the app's first release is out.
- **base-url**: the Tangent deployment the app talks to.

When the run finishes, its page lists `tangent-<run number>.apk` and/or
`.aab` under **Artifacts**, kept for 14 days. They download as the file
itself. The run number is the app's version code, so each build is newer
than the last; a re-run reuses it, so start a new run to publish again.

To install the APK, open it on the phone and allow "install unknown apps"
for the browser or file manager. Builds signed with the upload key install
over each other. Builds made without it are signed with a different
throwaway key each time, so uninstall the old one first.

### The upload key

Needed for Google Play; optional for test APKs.

1. Make the key (keytool comes with any JDK). Use one password of letters and
   digits: keytool's default PKCS12 format uses it for the store and the key.

   ```sh
   keytool -genkeypair -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias upload
   ```

   Keep the file and the password in a password manager and never commit
   them. A lost upload key can be reset only through Google, in Play Console.

2. Base64 it: `base64 -w0 upload-keystore.jks` (Linux) or
   `base64 -i upload-keystore.jks` (macOS).
3. In the repository's Settings → Secrets and variables → Actions, add the
   repository secrets `ANDROID_KEYSTORE_BASE64` (the base64 text),
   `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` (`upload`).

Without them, builds are signed with a debug key, which Google Play refuses;
a run that asks to publish fails at once.

### Google Play

Publishing signs in to Google with Workload Identity Federation: GitHub's
own short-lived token is traded for a service account's, so no Google
credential is stored anywhere.

1. **Create the app.** In Play Console, **Create app** with the package name
   `com.tangentailearning.tangent`, and complete the required declarations.
2. **Upload the first build by hand.** The API can't create an app. Run the
   workflow with format `appbundle` and track `none` (the upload key secrets
   set), download the `.aab`, and upload it in Play Console → Testing →
   **Internal testing** → Create release. Keep **Play App Signing**: Google
   holds the app signing key, and yours is the upload key.
3. **Google Cloud.** In the project you'll use, enable the **Google Play
   Android Developer API**, **IAM Service Account Credentials API**,
   **Security Token Service API** and **IAM API**. Then, in Cloud Shell, with
   `PROJECT_ID` replaced:

   ```sh
   gcloud iam service-accounts create play-publisher --project=PROJECT_ID
   gcloud iam workload-identity-pools create github --project=PROJECT_ID --location=global \
     --display-name="GitHub Actions"
   gcloud iam workload-identity-pools providers create-oidc tree-chat-teacher \
     --project=PROJECT_ID --location=global --workload-identity-pool=github \
     --issuer-uri=https://token.actions.githubusercontent.com \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition="assertion.repository == 'yringler/Tree-chat-teacher'"
   POOL=$(gcloud iam workload-identity-pools describe github --project=PROJECT_ID \
     --location=global --format='value(name)')
   # Only jobs in the google-play environment may act as the service account.
   gcloud iam service-accounts add-iam-policy-binding \
     play-publisher@PROJECT_ID.iam.gserviceaccount.com --project=PROJECT_ID \
     --role=roles/iam.workloadIdentityUser \
     --member="principal://iam.googleapis.com/$POOL/subject/repo:yringler/Tree-chat-teacher:environment:google-play"
   gcloud iam workload-identity-pools providers describe tree-chat-teacher --project=PROJECT_ID \
     --location=global --workload-identity-pool=github --format='value(name)'
   ```

   The last command prints the provider's name,
   `projects/<number>/locations/global/workloadIdentityPools/github/providers/tree-chat-teacher`.

4. **Play Console permissions.** Users and permissions → **Invite new users**:
   `play-publisher@PROJECT_ID.iam.gserviceaccount.com`. Under **App
   permissions**, add Tangent with "Release apps to testing tracks" and, for
   production, "Release to production…".
5. **GitHub environment.** Settings → Environments → **New environment**
   named `google-play`, with two **variables** (neither is a credential):
   `GOOGLE_PLAY_WORKLOAD_IDENTITY_PROVIDER` (the name from step 3) and
   `GOOGLE_PLAY_SERVICE_ACCOUNT` (`play-publisher@PROJECT_ID.iam.gserviceaccount.com`).
   Add yourself as a **required reviewer** to approve every publish, and a
   deployment branch rule for master if you like.

Then run the workflow with a track. A new personal developer account may
have to run a closed test before production unlocks; Play Console shows the
requirement.

iOS isn't set up: it needs a macOS runner with Xcode, a paid Apple Developer
membership, and a signing certificate and provisioning profile on the runner.
