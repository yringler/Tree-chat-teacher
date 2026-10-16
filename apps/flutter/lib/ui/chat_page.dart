import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../api/models.dart';
import '../api/tangents.dart';
import '../state/app_scope.dart';
import '../state/chat_controller.dart';
import '../state/walkthrough_controller.dart';
import 'coach_mark.dart';
import 'help.dart';
import 'lesson_outline.dart';
import 'message_view.dart';
import 'tangent_help_copy.dart';
import 'theme.dart';
import 'widgets.dart';

/// `/t/:treeId` and `/t/:treeId/b/:branchId`: a lesson's thread, the trunk or
/// a tangent. Both routes share one page per lesson, so moving between
/// its branches keeps the replies streaming.
class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.treeId, this.branchId});

  final String treeId;
  final String? branchId;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  late final ChatController _chat;
  late final WalkthroughController _walkthrough;

  /// Holds the walkthrough's coach mark above the page (and below any
  /// dialog or sheet opened over it).
  final _coach = OverlayPortalController();

  /// A report to the walkthrough is waiting for the frame to end.
  bool _reportPending = false;
  final _composer = TextEditingController();
  final _composerFocus = FocusNode();
  final _scroll = ScrollController();

  /// Words "Ask about this" put on the composer, in the reply they are from:
  /// the next message asks about them.
  ({ChatNode node, String text})? _quote;

  /// Follows the end of the thread until the learner scrolls up.
  bool _stickToBottom = true;

  /// Each message's key, to find where a reply starts on screen.
  final _messageKeys = <String, GlobalKey>{};

  /// The send actions and the way back to the main thread, for the
  /// walkthrough to point at.
  final _tangentKey = GlobalKey(debugLabel: 'tangent-action');
  final _nextKey = GlobalKey(debugLabel: 'next-action');
  final _mainThreadKey = GlobalKey(debugLabel: 'main-thread');

  /// The message box with its actions, which a coach mark pointing at one
  /// of them leaves clear.
  final _composerKey = GlobalKey(debugLabel: 'composer');

  /// The header is in view. On a narrow screen it slides away while the
  /// learner reads down, to give the thread the room, and back on the way up.
  bool _headerShown = true;

  /// The end of the thread is far enough below to offer the jump to it. A
  /// notifier of its own, so scrolling rebuilds the button alone.
  final _farFromEnd = ValueNotifier(false);

  static const _outlineWidth = 280.0;

  /// From this width the outline stays beside the thread; below it, it is a
  /// drawer.
  static const _wideFrom = contentMaxWidth + _outlineWidth;

  /// Home and End, with Ctrl or Cmd as on a desktop page.
  static const _threadEnds = <ShortcutActivator, Intent>{
    SingleActivator(LogicalKeyboardKey.home): _ToStartIntent(),
    SingleActivator(LogicalKeyboardKey.home, control: true): _ToStartIntent(),
    SingleActivator(LogicalKeyboardKey.home, meta: true): _ToStartIntent(),
    SingleActivator(LogicalKeyboardKey.end): _ToEndIntent(),
    SingleActivator(LogicalKeyboardKey.end, control: true): _ToEndIntent(),
    SingleActivator(LogicalKeyboardKey.end, meta: true): _ToEndIntent(),
  };

  late final _threadEndActions = <Type, Action<Intent>>{
    _ToStartIntent: _ThreadEndAction<_ToStartIntent>(_jumpToStart),
    _ToEndIntent: _ThreadEndAction<_ToEndIntent>(_jumpToEnd),
  };

  @override
  void initState() {
    super.initState();
    final scope = AppScope.of(context);
    _chat = ChatController(
      api: scope.api,
      session: scope.session,
      lessons: scope.lessons,
      treeId: widget.treeId,
      branchId: widget.branchId,
    )..addListener(_followEnd);
    _scroll.addListener(_onScroll);
    _walkthrough = scope.walkthrough;
    unawaited(_walkthrough.start());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _coach.show();
    });
    unawaited(scope.lessons.ensureLoaded());
    unawaited(_load());
  }

  Future<void> _load() async {
    final lessons = AppScope.of(context).lessons;
    await _chat.load();
    if (mounted) _showBranch();
    final first = lessons.takeFirstMessage(widget.treeId);
    if (first != null && mounted && _chat.thread.isEmpty) await _send(first);
  }

  @override
  void didUpdateWidget(ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.branchId != widget.branchId) {
      _chat.selectBranch(widget.branchId);
      _quote = null;
      _showBranch();
    }
  }

  @override
  void dispose() {
    _chat.dispose();
    _composer.dispose();
    _composerFocus.dispose();
    _scroll.dispose();
    _farFromEnd.dispose();
    super.dispose();
  }

  /// The main thread opens at its end, a tangent at its start.
  void _showBranch() {
    // Decided now: a jump made before the frame ends moves the flag.
    final atEnd = !_chat.isSideBranch;
    _stickToBottom = atEnd;
    _headerShown = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final position = _scroll.position;
      _scroll.jumpTo(atEnd ? position.maxScrollExtent : 0);
    });
  }

  void _onScroll() {
    final position = _scroll.position;
    _stickToBottom = position.pixels >= position.maxScrollExtent - 48;
    _measureEnd();
  }

  /// Offers the jump to the end once it is more than half a screen (and at
  /// least a few lines) below. Asked on every scroll and whenever the thread
  /// changes size, since a reply growing below moves the end without a
  /// scroll.
  void _measureEnd() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    if (!position.hasContentDimensions || !position.hasViewportDimension) {
      return;
    }
    final below = position.maxScrollExtent - position.pixels;
    _farFromEnd.value = below > max(240, position.viewportDimension / 2);
  }

  bool _onMetrics(ScrollMetricsNotification notification) {
    if (notification.depth == 0) _measureEnd();
    return false;
  }

  /// Animates a short way, which shows where it went; jumps a long one, or
  /// while a reply is written, whose growth would move the target under the
  /// animation, or when the learner asked for less motion.
  bool _glidesTo(double offset) {
    final position = _scroll.position;
    return !MediaQuery.disableAnimationsOf(context) &&
        _chat.streamingNode == null &&
        (offset - position.pixels).abs() <= 2 * position.viewportDimension;
  }

  /// Scrolls to the end of the thread and follows it from there, so a reply
  /// being written stays in view.
  void _jumpToEnd() {
    if (!_scroll.hasClients) return;
    _stickToBottom = true;
    final end = _scroll.position.maxScrollExtent;
    if (_glidesTo(end)) {
      unawaited(
        _scroll
            .animateTo(
              end,
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeOutCubic,
            )
            // Unless the learner took over on the way.
            .then((_) => _settleAtEnd()),
      );
    } else {
      _scroll.jumpTo(end);
      _settleAtEnd();
    }
  }

  /// Jumps on to the end for a few frames while it moves: the messages laid
  /// out on the way there replace the list's estimate of its length.
  void _settleAtEnd([int frames = 3]) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_stickToBottom || !_scroll.hasClients) return;
      final position = _scroll.position;
      if (position.pixels == position.maxScrollExtent) return;
      _scroll.jumpTo(position.maxScrollExtent);
      if (frames > 1) _settleAtEnd(frames - 1);
    });
  }

  /// Scrolls to the start of the branch on screen (offset zero: on a tangent,
  /// its fork divider, with what it came from above), and brings the header
  /// back with it.
  void _jumpToStart() {
    _stickToBottom = false;
    if (!_headerShown) setState(() => _headerShown = true);
    if (!_scroll.hasClients || _scroll.position.pixels.abs() <= 1) return;
    if (_glidesTo(0)) {
      unawaited(
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOutCubic,
        ),
      );
    } else {
      _scroll.jumpTo(0);
    }
  }

  /// Only the learner's own scrolling moves the header: not following a
  /// reply, and not a code block or formula scrolled sideways.
  bool _onUserScroll(UserScrollNotification notification) {
    if (notification.depth != 0) return false;
    final shown = switch (notification.direction) {
      ScrollDirection.forward => true,
      ScrollDirection.reverse => false,
      ScrollDirection.idle => _headerShown,
    };
    if (shown != _headerShown) setState(() => _headerShown = shown);
    return false;
  }

  /// Follows a reply only until its first line reaches the top of the view,
  /// so the learner reads it from its start; past that, the end grows out of
  /// sight. A learner who scrolls on below its start is followed again.
  void _followEnd() {
    if (!_stickToBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Asked again: opening a tangent in the meantime stops the following.
      if (!_stickToBottom || !_scroll.hasClients) return;
      final position = _scroll.position;
      final top = _replyTop();
      if (top != null &&
          position.pixels <= top &&
          top < position.maxScrollExtent) {
        _stickToBottom = false;
        _scroll.jumpTo(top);
      } else {
        _scroll.jumpTo(position.maxScrollExtent);
      }
    });
  }

  /// The scroll offset that puts the start of the reply being written at the
  /// top of the view, while it is laid out.
  double? _replyTop() {
    final reply = _chat.streamingNode;
    if (reply == null) return null;
    final box = _messageKeys[reply.id]?.currentContext?.findRenderObject();
    if (box == null || !box.attached) return null;
    return RenderAbstractViewport.of(box).getOffsetToReveal(box, 0).offset;
  }

  /// Sends [text]. A refused message stays (or lands) in the composer, so it
  /// can be sent again.
  Future<void> _send(String text) {
    _stickToBottom = true;
    return _settle(text, _chat.send(text));
  }

  /// Clears the composer once [text] is [accepted]; a refused one stays (or
  /// lands) there.
  Future<void> _settle(String text, Future<bool> accepted) async {
    final ok = await accepted;
    if (!mounted) return;
    if (ok) {
      if (_composer.text.trim() == text) _composer.clear();
    } else if (_composer.text.trim().isEmpty) {
      _composer.text = text;
    }
  }

  /// Sends the composer's text: on a tangent from the reply on screen (or
  /// the one quoted), or as the next step of the branch on screen. False
  /// when there is nothing to send yet.
  bool _sendComposer({required bool tangent}) {
    final text = _composer.text.trim();
    if (text.isEmpty || _chat.sending || _chat.streamingNode != null) {
      return false;
    }
    final quote = _quote;
    final from = quote?.node ?? (tangent ? _chat.asideFrom : null);
    unawaited(from == null ? _send(text) : _ask(from, text, quote?.text));
    return true;
  }

  /// Next ➜: on the main thread, the reply the walkthrough's last step asks
  /// for.
  void _sendNext() {
    final onTrunk = !_chat.isSideBranch;
    if (_sendComposer(tangent: false) && onTrunk) {
      _walkthrough.onRepliedOnTrunk();
    }
  }

  /// Asks [text] in a new tangent from [node], about [quote] if given.
  /// The text stays in the composer if it can't be made.
  Future<void> _ask(ChatNode node, String text, String? quote) async {
    final started = await _chat.startTangent(node, text, anchorQuote: quote);
    if (started == null || !mounted) return;
    context.go('/t/${widget.treeId}/b/${started.id}');
    _stickToBottom = true;
    await _settle(text, started.accepted);
  }

  void _askAbout(ChatNode node, String text) {
    setState(() => _quote = (node: node, text: text));
    _composerFocus.requestFocus();
  }

  void _dropQuote() {
    setState(() => _quote = null);
    _composerFocus.requestFocus();
  }

  /// The composer's placeholder, as Learn web words it: where the message
  /// goes, not which button sends it.
  String _hint() {
    if (_chat.thread.isEmpty) return 'Ask a question or name a topic';
    if (_chat.isSideBranch && _chat.isEmptyBranch) {
      return 'Ask your tangent…';
    }
    if (_quote != null) return 'Ask about this…';
    return _chat.isSideBranch
        ? 'Ask anything in this tangent…'
        : 'Ask anything…';
  }

  /// Where the composer's message can go, when there is a choice: on a
  /// tangent from the last reply, the recommended default, or as the next
  /// step. A quote is always asked about on a tangent. Without a reply to
  /// start a tangent from, there is no choice, and a plain Send continues.
  List<_SendAction> _composerActions() {
    if (_quote == null && _chat.asideFrom == null) return const [];
    return [
      _SendAction(
        key: _tangentKey,
        label: tangentAction.label,
        tooltip: tangentAction.hint,
        semanticsLabel: 'Send as tangent',
        primary: true,
        onPressed: () => _sendComposer(tangent: true),
      ),
      if (_quote == null)
        _SendAction(
          key: _nextKey,
          label: replyAction.label,
          tooltip: _chat.isSideBranch
              ? replyAction.hintInTangent
              : replyAction.hint,
          semanticsLabel: 'Send as next message',
          primary: false,
          onPressed: _sendNext,
        ),
    ];
  }

  /// Starts a tangent that follows [tangent], a suggestion of [node], and
  /// asks it. A suggestion a tangent already follows is under Your tangents
  /// instead, so this always starts a new one.
  Future<void> _follow(ChatNode node, Tangent tangent) async {
    final started = await _chat.startTangent(
      node,
      tangent.title,
      title: tangent.title,
    );
    if (started == null || !mounted) return;
    context.go('/t/${widget.treeId}/b/${started.id}');
    _stickToBottom = true;
    await _settle(tangent.title, started.accepted);
  }

  /// Tells the walkthrough what the frame just drawn shows: a tangent, or
  /// the main thread with the send actions under its reply.
  void _reportToWalkthrough() {
    if (_reportPending) return;
    _reportPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _reportPending = false;
      if (!mounted || _chat.loading) return;
      if (_chat.isSideBranch) {
        _walkthrough.onEnteredTangent();
        return;
      }
      if (_tangentKey.currentContext != null) {
        _walkthrough.onTrunkReplyReady();
      }
      if (_nextKey.currentContext != null) _walkthrough.onBackOnTrunk();
    });
  }

  /// The walkthrough's coach mark for the step on screen, if any.
  Widget _coachMark(BuildContext context) => ListenableBuilder(
    listenable: _walkthrough,
    builder: (context, _) {
      final step = _walkthrough.showing;
      if (step == null) return const SizedBox.shrink();
      final (target, text, button) = switch (step) {
        WalkthroughPhase.back => (
          _mainThreadKey,
          walkthroughSteps.back,
          walkthroughButtons.next,
        ),
        WalkthroughPhase.next => (
          _nextKey,
          walkthroughSteps.next,
          walkthroughButtons.done,
        ),
        _ => (_tangentKey, walkthroughSteps.tangent, walkthroughButtons.next),
      };
      return CoachMark(
        key: ValueKey(step),
        target: target,
        clear: step == WalkthroughPhase.back ? null : _composerKey,
        text: text,
        buttonText: button,
        onNext: _walkthrough.next,
        onSkip: _walkthrough.skip,
      );
    },
  );

  void _open(Branch branch) => context.go(
    branch.parentBranchId == null
        ? '/t/${widget.treeId}'
        : '/t/${widget.treeId}/b/${branch.id}',
  );

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final lessons = scope.lessons;
    final wide = MediaQuery.sizeOf(context).width >= _wideFrom;
    return ListenableBuilder(
      listenable: Listenable.merge([_chat, lessons, _walkthrough]),
      builder: (context, _) {
        _reportToWalkthrough();
        // The main thread alone needs no outline.
        final hasOutline = _chat.outline.length > 1;
        final scaffold = Scaffold(
          endDrawer: hasOutline && !wide
              ? Drawer(
                  child: SafeArea(
                    child: Builder(
                      builder: (context) => _outline(
                        onOpen: (branch) {
                          Scaffold.of(context).closeEndDrawer();
                          _open(branch);
                        },
                      ),
                    ),
                  ),
                )
              : null,
          body: SafeArea(
            child: Row(
              children: [
                // Where it sits doesn't matter: the coach mark is drawn
                // over the whole page. Without a child of its own, it leaves
                // the page's semantics as they are.
                OverlayPortal(
                  controller: _coach,
                  overlayChildBuilder: _coachMark,
                ),
                if (hasOutline && wide)
                  Container(
                    key: const ValueKey('outline'),
                    width: _outlineWidth,
                    decoration: BoxDecoration(
                      border: Border(
                        right: BorderSide(
                          color: TangentColors.of(context).border,
                        ),
                      ),
                    ),
                    child: _outline(onOpen: _open),
                  ),
                Expanded(
                  child: Column(
                    children: [
                      _header(wide: wide, hasOutline: hasOutline),
                      Expanded(
                        child: NotificationListener<UserScrollNotification>(
                          onNotification: _onUserScroll,
                          child: _body(context),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
        // Always there, so the page under it stays put as coach marks come
        // and go.
        return CallbackShortcuts(
          bindings: {
            if (_walkthrough.showing != null)
              const SingleActivator(LogicalKeyboardKey.escape):
                  _walkthrough.skip,
          },
          child: Shortcuts(
            shortcuts: _threadEnds,
            child: Actions(
              actions: _threadEndActions,
              // A tap on the status bar (iOS) scrolls the thread to its
              // start, and Page Up and Down scroll it while no control has
              // the focus. No scroll view takes the controller on its own:
              // the outline's list would share it with the thread.
              child: PrimaryScrollController(
                controller: _scroll,
                automaticallyInheritForPlatforms: const {},
                // Holds the focus while no control has it, as when the page
                // opens or the message box lets go, so the keys reach the
                // shortcuts above.
                child: FocusScope(autofocus: true, child: scaffold),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _outline({required ValueChanged<Branch> onOpen}) =>
      LessonOutline(outline: _chat.outline, chain: _chat.chain, onOpen: onOpen);

  /// The app bar and, on a tangent, the path down to it.
  Widget _header({required bool wide, required bool hasOutline}) {
    final drawer = hasOutline && !wide;
    // The way back stays in view while the walkthrough points at it.
    final shown =
        wide || _headerShown || _walkthrough.showing == WalkthroughPhase.back;
    return ClipRect(
      child: AnimatedAlign(
        alignment: Alignment.bottomCenter,
        heightFactor: shown ? 1 : 0,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AppBar(
              primary: false,
              leading: IconButton(
                tooltip: 'Your lessons',
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/'),
              ),
              titleSpacing: 0,
              title: _chat.loading
                  ? null
                  : _ToStartButton(
                      title: lessonTitle(_chat.title),
                      tooltip: backToStart,
                      onTap: _jumpToStart,
                    ),
              actions: [
                const HelpButton(),
                if (drawer)
                  Builder(
                    builder: (context) => IconButton(
                      tooltip: 'Tangents',
                      icon: const Icon(Icons.list_alt_outlined),
                      onPressed: Scaffold.of(context).openEndDrawer,
                    ),
                  ),
                const SizedBox(width: 12),
              ],
            ),
            if (_chat.isSideBranch)
              Builder(
                builder: (context) => _Breadcrumb(
                  mainThreadKey: _mainThreadKey,
                  chain: _chat.chain,
                  onOpen: _open,
                  onCurrent: _jumpToStart,
                  onMore: drawer ? Scaffold.of(context).openEndDrawer : null,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (_chat.loading) {
      return const Center(child: CircularProgressIndicator());
    }
    final error = _chat.loadError;
    if (error != null) {
      return _CantOpen(message: error.text);
    }
    final thread = _chat.thread;
    final streaming = _chat.streamingNode;
    final busy = _chat.sending;
    return Column(
      children: [
        Expanded(
          child: thread.isEmpty
              ? const _EmptyThread()
              : Stack(
                  children: [
                    Positioned.fill(
                      child: NotificationListener<ScrollMetricsNotification>(
                        onNotification: _onMetrics,
                        child: LayoutBuilder(
                          builder: (context, constraints) => _threadView(
                            thread,
                            columnPadding(constraints.maxWidth),
                          ),
                        ),
                      ),
                    ),
                    // Centred under the reading column, just above the
                    // message box, so it rises with a notice or the keyboard.
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 12,
                      child: Center(
                        child: ValueListenableBuilder(
                          valueListenable: _farFromEnd,
                          builder: (context, far, _) => _JumpToEndButton(
                            // A coach mark has the learner's attention.
                            shown: far && _walkthrough.showing == null,
                            onPressed: _jumpToEnd,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
        ),
        ContentColumn(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_chat.notice case final notice?) ...[
                NoticeBanner(notice: notice, onDismiss: _chat.dismissNotice),
                const SizedBox(height: 8),
              ],
              _Composer(
                key: _composerKey,
                controller: _composer,
                focusNode: _composerFocus,
                enabled: !busy,
                streaming: streaming != null,
                hint: _hint(),
                lead: switch (_quote) {
                  final quote? => _QuoteChip(
                    text: quote.text,
                    onRemove: _dropQuote,
                  ),
                  null => null,
                },
                actions: _composerActions(),
                onSend: () => _sendComposer(tangent: false),
                onStop: () => unawaited(_chat.stop()),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// The thread, scrolled around the start of the branch on screen: offset
  /// zero is its first message (on a tangent, the fork divider), and the
  /// messages it follows from grow upwards from there. Opening a tangent so
  /// shows it from its start.
  Widget _threadView(List<ChatNode> thread, EdgeInsets padding) {
    final id = _chat.branchId;
    final start = max(0, thread.indexWhere((n) => n.branchId == id));
    final center = ValueKey('start-$id');
    final chainIds = {for (final b in _chat.chain) b.id};
    return CustomScrollView(
      controller: _scroll,
      center: center,
      slivers: [
        SliverPadding(
          padding: start == 0 ? EdgeInsets.zero : padding.copyWith(bottom: 0),
          sliver: SliverList.builder(
            itemCount: start,
            itemBuilder: (context, i) =>
                _message(thread, start - 1 - i, chainIds),
          ),
        ),
        SliverPadding(
          key: center,
          padding: padding.copyWith(top: start == 0 ? padding.top : 0),
          sliver: SliverList.builder(
            itemCount: thread.length - start,
            itemBuilder: (context, i) => _message(thread, start + i, chainIds),
          ),
        ),
      ],
    );
  }

  Widget _message(List<ChatNode> thread, int i, Set<String> chainIds) {
    final node = thread[i];
    final message = MessageView(
      key: _messageKeys.putIfAbsent(node.id, GlobalKey.new),
      node: node,
      status: _chat.statusOf(node.id),
      tangents: _chat.tangentsAt(node),
      chainIds: chainIds,
      cameFromIds: _chat.cameFromIds,
      onFollow: _chat.sending ? null : (t) => unawaited(_follow(node, t)),
      onAskAbout: (text) => _askAbout(node, text),
      onOpenTangent: (b) => context.go('/t/${widget.treeId}/b/${b.id}'),
      onDelete: node.role == Role.user
          ? () => unawaited(_deleteMessage(node))
          : null,
    );
    final forked = i > 0 && thread[i - 1].branchId != node.branchId;
    if (!forked) return message;
    final quote = _chat.anchorQuoteOf(node.branchId);
    return Column(
      children: [
        _ForkDivider(title: _branchTitle(node.branchId)),
        if (quote != null && quote.isNotEmpty) _AnchorQuote(quote),
        message,
      ],
    );
  }

  /// Asks, then deletes [node] with everything after it on its thread. When
  /// the tangent on screen goes with it, moves to where the message was: its
  /// thread, or the thread a deleted tangent came from.
  Future<void> _deleteMessage(ChatNode node) async {
    final question = _chat.deleteQuestion(node, titleOf: tangentTitle);
    if (question == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete message?'),
        content: Text(question),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
              foregroundColor: Theme.of(context).colorScheme.onError,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (!(confirmed ?? false) || !mounted) return;
    final from = _chat.branchById(node.branchId);
    if (!await _chat.deleteMessage(node) || !mounted || from == null) return;
    final open = widget.branchId;
    if (open == null || _chat.branchById(open) != null) return;
    final back =
        _chat.branchById(from.id) ??
        _chat.branchById(from.parentBranchId ?? from.id);
    if (back != null) _open(back);
  }

  String _branchTitle(String branchId) {
    final branch = _chat.branchById(branchId);
    final title = branch == null ? '' : tangentTitle(branch);
    return title.isEmpty ? 'Tangent' : 'Tangent · $title';
  }
}

/// Main thread › … › the parent › the tangent on screen. The steps in
/// between are left out; the outline lists them.
class _Breadcrumb extends StatelessWidget {
  const _Breadcrumb({
    required this.mainThreadKey,
    required this.chain,
    required this.onOpen,
    required this.onCurrent,
    this.onMore,
  });

  /// On the main thread step, the way back.
  final GlobalKey mainThreadKey;

  /// The main thread down to the tangent on screen.
  final List<Branch> chain;
  final ValueChanged<Branch> onOpen;

  /// Scrolls to the start of the tangent on screen, its last step.
  final VoidCallback onCurrent;

  /// Opens the outline, when it is a drawer.
  final VoidCallback? onMore;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final parent = chain.length > 2 ? chain[chain.length - 2] : null;
    final chevron = Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Icon(Icons.chevron_right, size: 18, color: tokens.fgMuted),
    );
    final buttonStyle = TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      minimumSize: const Size(0, 40),
    );
    Widget step(Branch branch) => TextButton(
      style: buttonStyle,
      onPressed: () => onOpen(branch),
      child: Text(
        outlineTitle(branch),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
    return Container(
      key: const ValueKey('breadcrumb'),
      width: double.infinity,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: tokens.border)),
      ),
      child: ContentColumn(
        child: LayoutBuilder(
          builder: (context, constraints) => Row(
            children: [
              Tooltip(
                key: mainThreadKey,
                message: mainThreadBack,
                excludeFromSemantics: true,
                // A node of its own that taps through, since the button
                // under it is left out.
                child: Semantics(
                  container: true,
                  label: mainThreadBack,
                  button: true,
                  onTap: () => onOpen(chain.first),
                  excludeSemantics: true,
                  child: step(chain.first),
                ),
              ),
              chevron,
              if (chain.length > 3) ...[
                TextButton(
                  style: buttonStyle,
                  onPressed: onMore,
                  child: const Text('…'),
                ),
                chevron,
              ],
              if (parent != null) ...[
                // The parent takes at most a third, so the tangent on screen
                // keeps the most room.
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: constraints.maxWidth / 3,
                  ),
                  child: step(parent),
                ),
                chevron,
              ],
              // The whole rest of the row, so it is easy to hit.
              Expanded(
                child: _ToStartButton(
                  title: outlineTitle(chain.last),
                  tooltip: backToTangentStart,
                  style: const TextStyle(fontSize: 15),
                  onTap: onCurrent,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Words that scroll the thread to its start when tapped: the lesson title,
/// and a tangent's current step in its path. Read out as a button that says
/// where it goes.
class _ToStartButton extends StatelessWidget {
  const _ToStartButton({
    required this.title,
    required this.tooltip,
    required this.onTap,
    this.style,
  });

  final String title;

  /// Where a tap goes; ends the label read out after [title].
  final String tooltip;
  final VoidCallback onTap;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    excludeFromSemantics: true,
    child: Semantics(
      container: true,
      button: true,
      label: '$title, ${tooltip[0].toLowerCase()}${tooltip.substring(1)}',
      onTap: onTap,
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 40),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Align(
              alignment: Alignment.centerLeft,
              widthFactor: 1,
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/// Floats over the thread while its end is far below, and scrolls there.
/// Hidden, it takes no taps and isn't read out.
class _JumpToEndButton extends StatelessWidget {
  const _JumpToEndButton({required this.shown, required this.onPressed});

  final bool shown;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 150);
    return IgnorePointer(
      key: const ValueKey('jump-to-end'),
      ignoring: !shown,
      child: ExcludeSemantics(
        excluding: !shown,
        child: AnimatedOpacity(
          opacity: shown ? 1 : 0,
          duration: duration,
          curve: Curves.easeOut,
          child: AnimatedScale(
            scale: shown ? 1 : 0.8,
            duration: duration,
            curve: Curves.easeOut,
            // Part of the message box for taps, and never focused, so the
            // box keeps the focus and a phone's keyboard stays up.
            child: TextFieldTapRegion(
              child: ExcludeFocus(
                child: IconButton.filledTonal(
                  tooltip: jumpToEnd,
                  onPressed: onPressed,
                  style: IconButton.styleFrom(
                    side: BorderSide(color: tokens.border),
                    elevation: 2,
                  ),
                  icon: const Icon(Icons.arrow_downward),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ToStartIntent extends Intent {
  const _ToStartIntent();
}

class _ToEndIntent extends Intent {
  const _ToEndIntent();
}

/// Scrolls the thread to one end, unless a text field has the focus: there
/// Home and End move the caret.
class _ThreadEndAction<T extends Intent> extends Action<T> {
  _ThreadEndAction(this.onInvoke);

  final VoidCallback onInvoke;

  @override
  bool isEnabled(T intent) =>
      FocusManager.instance.primaryFocus?.context
          ?.findAncestorStateOfType<EditableTextState>() ==
      null;

  @override
  Object? invoke(T intent) {
    onInvoke();
    return null;
  }
}

class _ForkDivider extends StatelessWidget {
  const _ForkDivider({required this.title});
  final String title;

  /// The shortest rule kept on each side of a long title.
  static const _minRule = 24.0;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    // The title takes the width it needs (up to the row less two short
    // rules), and the rules share the rest, so the title stays centred.
    child: LayoutBuilder(
      builder: (context, constraints) => Row(
        children: [
          const Expanded(child: Divider()),
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: max(0, constraints.maxWidth - 2 * _minRule),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    ),
  );
}

/// The words of the message before it that a tangent asks about.
class _AnchorQuote extends StatelessWidget {
  const _AnchorQuote(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final accent = Theme.of(context).colorScheme.primary;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.fromLTRB(12, 4, 0, 4),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: accent, width: 3)),
      ),
      child: Text(
        text,
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodyMedium
            ?.copyWith(color: tokens.fgMuted),
      ),
    );
  }
}

class _EmptyThread extends StatelessWidget {
  const _EmptyThread();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: ContentColumn(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'What would you like to learn?',
              style: theme.textTheme.headlineSmall,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              'Ask a question or name a topic. You get a straight answer, then '
              'a few tangents worth following. Each one opens on the side, so '
              'your main lesson stays clean.',
              style: theme.textTheme.bodySmall,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _CantOpen extends StatelessWidget {
  const _CantOpen({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Center(
    child: ContentColumn(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Can’t open this lesson',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => context.go('/'),
            child: const Text('Back to your lessons'),
          ),
        ],
      ),
    ),
  );
}

/// One way to send the composer's message, as a button under the box.
class _SendAction {
  const _SendAction({
    required this.key,
    required this.label,
    required this.tooltip,
    required this.semanticsLabel,
    required this.primary,
    required this.onPressed,
  });

  final GlobalKey key;
  final String label;

  /// When to pick it; also shown on a long press.
  final String tooltip;
  final String semanticsLabel;

  /// Filled, as the recommended default; otherwise outlined.
  final bool primary;
  final VoidCallback onPressed;
}

/// The message box. On the web, Enter sends (as the first of [actions]),
/// Ctrl or Cmd+Enter sends as the second, and Shift+Enter starts a new line.
/// The words it asks about ([lead]) sit before the text; with the focus they
/// take a row of their own, and the box grows to three lines. With
/// [actions], they replace the Send button with a row of equal buttons
/// under the box.
class _Composer extends StatelessWidget {
  const _Composer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.streaming,
    required this.hint,
    required this.lead,
    required this.actions,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final bool streaming;
  final String hint;

  /// What the message asks about, if anything.
  final Widget? lead;
  final List<_SendAction> actions;
  final VoidCallback onSend;
  final VoidCallback onStop;

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final keyboard = HardwareKeyboard.instance;
    if (!kIsWeb ||
        event is! KeyDownEvent ||
        !enter ||
        keyboard.isShiftPressed ||
        controller.value.composing.isValid) {
      return KeyEventResult.ignored;
    }
    final modified = keyboard.isControlPressed || keyboard.isMetaPressed;
    final action = modified && actions.length > 1
        ? actions[1]
        : actions.firstOrNull;
    (action?.onPressed ?? onSend)();
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => ListenableBuilder(
      listenable: focusNode,
      builder: (context, _) {
        final focused = focusNode.hasFocus;
        final leading = lead;
        // A tap on it keeps the focus in the box.
        final tappable = leading == null
            ? null
            : TextFieldTapRegion(child: leading);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (focused && tappable != null) ...[
              tappable,
              const SizedBox(height: 6),
            ],
            _row(
              focused: focused,
              leading: focused ? null : tappable,
              maxLeadWidth: constraints.maxWidth / 2,
            ),
            if (actions.isNotEmpty && !streaming) ...[
              const SizedBox(height: 8),
              // Part of the box, so the focus (and its height) stays put
              // until the tap lands.
              TextFieldTapRegion(child: _actionRow()),
            ],
          ],
        );
      },
    ),
  );

  Widget _row({
    required bool focused,
    required Widget? leading,
    required double maxLeadWidth,
  }) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (leading != null) ...[
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxLeadWidth),
            child: Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: leading,
            ),
          ),
          const SizedBox(width: 8),
        ],
        Expanded(
          key: const ValueKey('composer-field'),
          child: Focus(
            onKeyEvent: _onKey,
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              enabled: enabled,
              minLines: focused ? 3 : 1,
              maxLines: 8,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(hintText: hint),
            ),
          ),
        ),
        if (streaming) ...[
          const SizedBox(width: 8),
          IconButton.filledTonal(
            tooltip: 'Stop',
            onPressed: onStop,
            icon: const Icon(Icons.stop),
          ),
        ] else if (actions.isEmpty) ...[
          const SizedBox(width: 8),
          ValueListenableBuilder(
            valueListenable: controller,
            builder: (context, value, _) => IconButton.filled(
              tooltip: 'Send',
              onPressed: enabled && value.text.trim().isNotEmpty
                  ? onSend
                  : null,
              icon: const Icon(Icons.arrow_upward),
            ),
          ),
        ],
      ],
    );
  }

  /// The actions side by side, equally wide, so the tangent is never the
  /// smaller choice. The label carries the arrow, so no icon doubles it.
  Widget _actionRow() => ValueListenableBuilder(
    valueListenable: controller,
    builder: (context, value, _) {
      final ready = enabled && value.text.trim().isNotEmpty;
      return Row(
        children: [
          for (final (i, action) in actions.indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: Tooltip(
                message: action.tooltip,
                child: _actionButton(action, ready: ready),
              ),
            ),
          ],
        ],
      );
    },
  );

  Widget _actionButton(_SendAction action, {required bool ready}) {
    final label = Text(
      action.label,
      semanticsLabel: action.semanticsLabel,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
    final onPressed = ready ? action.onPressed : null;
    return action.primary
        ? FilledButton(key: action.key, onPressed: onPressed, child: label)
        : OutlinedButton(key: action.key, onPressed: onPressed, child: label);
  }
}

/// The words the composer's message asks about, with a way to take them off.
class _QuoteChip extends StatelessWidget {
  const _QuoteChip({required this.text, required this.onRemove});

  final String text;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final accent = Theme.of(context).colorScheme.primary;
    return InputChip(
      key: const ValueKey('composer-quote'),
      avatar: Icon(Icons.subdirectory_arrow_right, size: 16, color: accent),
      label: Text('“$text”', maxLines: 1, overflow: TextOverflow.ellipsis),
      backgroundColor: tokens.accentSoft,
      side: BorderSide(color: accent),
      shape: const StadiumBorder(),
      onDeleted: onRemove,
      deleteButtonTooltipMessage: 'Don’t ask about these words',
    );
  }
}
