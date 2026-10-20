import 'package:flutter/foundation.dart';

import '../api/models.dart';

// What the message box offers once there is a reply, and the reply a tangent
// sent from it starts at. This mirrors `composerPlan` in
// packages/shared/src/composer-plan.ts, which Learn web follows, so a
// tangent from the box starts from the same reply on both; the two must
// change together, and test/state/composer_plan_test.dart has its cases by
// name. The words of each button and place are the page's
// (tangent_help_copy.dart).

/// What the next message asks about, on a tangent made when it is sent: a
/// message on screen, about [quote] when words of it were selected.
typedef ComposerLead = ({String nodeId, String? quote});

/// The buttons that send the box's text their own way, in place of Send.
enum ComposerSendId { tangent, next }

/// A button in place of Send: [primary] is filled and sent with Enter, the
/// other outlined and sent with Ctrl or Cmd+Enter.
typedef ComposerSend = ({ComposerSendId id, bool primary});

/// Where the box's message goes, as its placeholder says.
enum ComposerPlace { start, lead, emptyTangent, tangent, main }

/// [target]: the reply a tangent from the box starts at; null: there is
/// none, and the message continues the open thread. [actions]: the buttons
/// in place of Send, always Tangent ↳ before Next ➜; none: a plain Send.
/// [nameTarget]: the box names the target, since it wasn't aimed at (a lead
/// names itself) and isn't the last message on screen, so it may not be the
/// reply the reader has in mind.
typedef ComposerPlan = ({
  String? target,
  List<ComposerSend> actions,
  ComposerPlace place,
  bool nameTarget,
});

/// The composer's plan for [path], the messages on screen root to leaf (the
/// earlier threads' up to where the open one, [branchId], starts, then its
/// own), [inTangent] when the open thread is a tangent. The target is the
/// first of:
/// 1. the [lead];
/// 2. the focused message ([focusedId]), if it is the open thread's own: a
///    finished reply itself, and a question the finished reply that answers
///    it, so a tangent opened at its start goes on from its first reply;
/// 3. the open thread's last message, if it is a reply that didn't fail.
///
/// A message of an earlier thread is never the target unless the box is
/// aimed at it: it is there as the open thread's context.
///
/// With no target there is only Send; with a lead, only Tangent ↳, since
/// words to ask about only go on a tangent; otherwise Tangent ↳ and Next ➜.
/// The filled one, which Enter sends, is Tangent ↳ on the main thread, where
/// a stray reply is read on every later turn, and Next ➜ inside a tangent,
/// where going on is the natural step: a reflexive Enter goes at most one
/// level down, and every level below that is chosen.
ComposerPlan composerPlan({
  required List<ChatNode> path,
  required String? branchId,
  required bool inTangent,
  required String? focusedId,
  required ComposerLead? lead,
}) {
  final own = [
    for (final m in path)
      if (m.branchId == branchId) m,
  ];
  final target = lead?.nodeId ?? _implicitTarget(own, focusedId);
  return (
    target: target,
    actions: target == null
        ? const []
        : [
            (id: ComposerSendId.tangent, primary: lead != null || !inTangent),
            if (lead == null) (id: ComposerSendId.next, primary: inTangent),
          ],
    place: _placeOf(path, lead, inTangent, own.isNotEmpty),
    nameTarget: lead == null && target != null && target != path.lastOrNull?.id,
  );
}

/// What Enter sends among the box's [actions] (null: the plain Send): the
/// filled one, and with Ctrl or Cmd ([modified]) the other, or the filled
/// one again when it is alone, so the keys follow the fill wherever it
/// stands. As the web's `Composer.onKey`.
T? sentByEnter<T>(
  List<T> actions, {
  required bool Function(T) primary,
  required bool modified,
}) {
  final filled = actions.where(primary).firstOrNull ?? actions.firstOrNull;
  final other = actions.where((a) => a != filled).firstOrNull ?? filled;
  return modified ? other : filled;
}

/// Whether Enter, alone or with Ctrl or Cmd ([modified]), sends from the box
/// ([sentByEnter] says which way) rather than starting a new line. Only in a
/// browser: a native keyboard's Enter is the box's new line
/// (`TextInputAction.newline`). In a browser on a phone or tablet a plain
/// Enter is a new line too, and only the buttons send, as on the web's touch
/// screens: its keyboard has no Shift+Enter.
bool enterSends({
  required bool web,
  required TargetPlatform platform,
  required bool modified,
}) =>
    web &&
    (modified ||
        (platform != TargetPlatform.android && platform != TargetPlatform.iOS));

String? _implicitTarget(List<ChatNode> own, String? focusedId) {
  final focused = _finishedReplyAt(
    own,
    own.indexWhere((m) => m.id == focusedId),
  );
  if (focused != null) return focused.id;
  return switch (own.lastOrNull) {
    ChatNode(role: Role.assistant, :final status, :final id)
        when status != NodeStatus.error =>
      id,
    _ => null,
  };
}

/// The finished reply at [i]: the message itself, or for a question the
/// next one.
ChatNode? _finishedReplyAt(List<ChatNode> messages, int i) {
  final m = i < 0 ? null : messages[i];
  final reply = m?.role == Role.user ? messages.elementAtOrNull(i + 1) : m;
  return switch (reply) {
    ChatNode(role: Role.assistant, status: NodeStatus.complete) => reply,
    _ => null,
  };
}

ComposerPlace _placeOf(
  List<ChatNode> path,
  ComposerLead? lead,
  bool inTangent,
  bool ownMessages,
) {
  if (path.isEmpty) return ComposerPlace.start;
  if (lead != null) return ComposerPlace.lead;
  if (!inTangent) return ComposerPlace.main;
  return ownMessages ? ComposerPlace.tangent : ComposerPlace.emptyTangent;
}
