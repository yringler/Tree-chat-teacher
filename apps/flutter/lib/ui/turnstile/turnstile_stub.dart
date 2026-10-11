import 'package:flutter/material.dart';

/// Cloudflare Turnstile checks the page's hostname, so it can't run inside a
/// native app; sign-in there waits for a server change.
class TurnstileWidget extends StatelessWidget {
  const TurnstileWidget({
    super.key,
    required this.siteKey,
    required this.onToken,
  });

  final String siteKey;
  final ValueChanged<String?> onToken;

  @override
  Widget build(BuildContext context) => const Text(
    'Signing in on this device isn’t available yet. Use Tangent Learn in a '
    'web browser.',
  );
}
