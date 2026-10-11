import '../api/models.dart';

/// A link out of the app, to a page of the web apps on the Worker's origin.
class NoticeLink {
  const NoticeLink({required this.label, required this.path});
  final String label;

  /// A path on the Worker's origin, e.g. `/learn/`.
  final String path;
}

/// An inline message about a request that failed, shown where it happened.
class Notice {
  const Notice(this.text, {this.link});
  final String text;
  final NoticeLink? link;
}

const genericErrorText = 'Something went wrong. Please try again.';

/// What to tell the learner about [error]. An `unauthorized` error is handled
/// by signing out rather than shown, so it has no special text here.
Notice noticeFor(Object error) {
  if (error is! ApiException) return const Notice(genericErrorText);
  switch (error.code) {
    case 'pool_empty':
      return const Notice(
        'The open pool is empty until Tangent adds more credit.',
        link: NoticeLink(label: 'How the pool works', path: '/pool'),
      );
    case 'pool_cap_reached':
      return Notice(
        error.message.isEmpty
            ? 'You have reached the open pool’s limit for now.'
            : error.message,
      );
    case 'pool_unavailable' when error.poolReason == 'verify':
      return const Notice(
        'Confirm you are human once to use the open pool.',
        link: NoticeLink(label: 'Verify', path: '/verify?next=/app/'),
      );
    case 'key_required' || 'payment_required' || 'membership_required':
      return const Notice(
        'Add a key or credit in Tangent Learn on the web.',
        link: NoticeLink(label: 'Open Tangent Learn', path: '/learn/'),
      );
    case 'conflict':
      return const Notice('A reply is still being written.');
    default:
      return Notice(error.message.isEmpty ? genericErrorText : error.message);
  }
}

bool isUnauthorized(Object error) =>
    error is ApiException && error.code == 'unauthorized';
