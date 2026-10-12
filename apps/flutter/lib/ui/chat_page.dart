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
import 'lesson_outline.dart';
import 'message_view.dart';
import 'theme.dart';
import 'tier_switch.dart';
import 'widgets.dart';

/// `/t/:treeId` and `/t/:treeId/b/:branchId`: a lesson's thread, the trunk or
/// a side question. Both routes share one page per lesson, so moving between
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
  final _composer = TextEditingController();
  final _composerFocus = FocusNode();
  final _scroll = ScrollController();

  /// The composer asks a side question, the point of a lesson, unless the
  /// learner switched it to continue the branch on screen.
  bool _asksAside = true;

  /// Words "Ask about this" put on the composer, in the reply they are from:
  /// the next message asks about them.
  ({ChatNode node, String text})? _quote;

  /// Follows the end of the thread until the learner scrolls up.
  bool _stickToBottom = true;

  /// Each message's key, to find where a reply starts on screen.
  final _messageKeys = <String, GlobalKey>{};

  /// The header is in view. On a narrow screen it slides away while the
  /// learner reads down, to give the thread the room, and back on the way up.
  bool _headerShown = true;

  static const _outlineWidth = 280.0;

  /// From this width the outline stays beside the thread; below it, it is a
  /// drawer.
  static const _wideFrom = contentMaxWidth + _outlineWidth;

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
    super.dispose();
  }

  /// The main thread opens at its end, a side question at its start.
  void _showBranch() {
    _stickToBottom = !_chat.isSideBranch;
    _headerShown = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final position = _scroll.position;
      _scroll.jumpTo(_stickToBottom ? position.maxScrollExtent : 0);
    });
  }

  void _onScroll() {
    final position = _scroll.position;
    _stickToBottom = position.pixels >= position.maxScrollExtent - 48;
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
      if (!_scroll.hasClients) return;
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
  Future<void> _send(String text) async {
    _stickToBottom = true;
    final accepted = await _chat.send(text);
    if (!mounted) return;
    if (accepted) {
      if (_composer.text.trim() == text) _composer.clear();
    } else if (_composer.text.trim().isEmpty) {
      _composer.text = text;
    }
  }

  void _sendComposer() {
    final text = _composer.text.trim();
    if (text.isEmpty || _chat.sending || _chat.streamingNode != null) return;
    final quote = _quote;
    final from = quote?.node ?? (_asksAside ? _chat.asideFrom : null);
    unawaited(from == null ? _send(text) : _ask(from, text, quote?.text));
  }

  /// Asks [text] in a new side question from [node], about [quote] if given.
  /// The text stays in the composer if it can't be made.
  Future<void> _ask(ChatNode node, String text, String? quote) async {
    final id = await _chat.openSideQuestion(node, anchorQuote: quote);
    if (id == null || !mounted) return;
    context.go('/t/${widget.treeId}/b/$id');
    await _send(text);
  }

  void _askAbout(ChatNode node, String text) {
    setState(() => _quote = (node: node, text: text));
    _composerFocus.requestFocus();
  }

  void _switchDestination() {
    setState(() => _asksAside = !_asksAside);
    _composerFocus.requestFocus();
  }

  void _dropQuote() {
    setState(() => _quote = null);
    _composerFocus.requestFocus();
  }

  String _hint() {
    if (_chat.thread.isEmpty) return 'Ask a question or name a topic';
    if (_quote != null) return 'Ask about this…';
    if (_chat.isSideBranch && _chat.isEmptyBranch) {
      return 'Ask your side question…';
    }
    if (_asksAside && _chat.asideFrom != null) return 'Ask a side question…';
    return _chat.isSideBranch
        ? 'Continue this side question…'
        : 'Continue this lesson…';
  }

  /// Where the composer's message goes, when there is a choice: the quote
  /// it asks about, or a side question or not.
  Widget? _composerLead({required bool compact}) {
    if (_quote case final quote?) {
      return _QuoteChip(text: quote.text, onRemove: _dropQuote);
    }
    if (_chat.asideFrom == null) return null;
    return _DestinationChip(
      aside: _asksAside,
      compact: compact,
      onPressed: _switchDestination,
    );
  }

  Future<void> _follow(ChatNode node, Tangent tangent) async {
    final opened = await _chat.followTangent(node, tangent);
    if (opened == null || !mounted) return;
    context.go('/t/${widget.treeId}/b/${opened.branchId}');
    if (opened.created) await _send(tangent.title);
  }

  void _open(Branch branch) => context.go(
    branch.parentBranchId == null
        ? '/t/${widget.treeId}'
        : '/t/${widget.treeId}/b/${branch.id}',
  );

  @override
  Widget build(BuildContext context) {
    final lessons = AppScope.of(context).lessons;
    final wide = MediaQuery.sizeOf(context).width >= _wideFrom;
    return ListenableBuilder(
      listenable: Listenable.merge([_chat, lessons]),
      builder: (context, _) {
        // The main thread alone needs no outline.
        final hasOutline = _chat.outline.length > 1;
        return Scaffold(
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
      },
    );
  }

  Widget _outline({required ValueChanged<Branch> onOpen}) =>
      LessonOutline(outline: _chat.outline, chain: _chat.chain, onOpen: onOpen);

  /// The app bar and, on a side question, the path down to it.
  Widget _header({required bool wide, required bool hasOutline}) {
    final drawer = hasOutline && !wide;
    return ClipRect(
      child: AnimatedAlign(
        alignment: Alignment.bottomCenter,
        heightFactor: wide || _headerShown ? 1 : 0,
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
              title: Text(
                _chat.loading ? '' : lessonTitle(_chat.title),
                overflow: TextOverflow.ellipsis,
              ),
              actions: [
                if (_chat.branch != null)
                  TierSwitch(
                    tier: _chat.tier,
                    enabled: _chat.canSwitchTier,
                    onChanged: (tier) => unawaited(_chat.setTier(tier)),
                  ),
                if (drawer)
                  Builder(
                    builder: (context) => IconButton(
                      tooltip: 'Side questions',
                      icon: const Icon(Icons.account_tree_outlined),
                      onPressed: Scaffold.of(context).openEndDrawer,
                    ),
                  ),
                const SizedBox(width: 12),
              ],
            ),
            if (_chat.isSideBranch)
              Builder(
                builder: (context) => _Breadcrumb(
                  chain: _chat.chain,
                  onOpen: _open,
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
              : LayoutBuilder(
                  builder: (context, constraints) =>
                      _threadView(thread, columnPadding(constraints.maxWidth)),
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
                controller: _composer,
                focusNode: _composerFocus,
                enabled: !busy,
                streaming: streaming != null,
                hint: _hint(),
                lead: _composerLead,
                onSend: _sendComposer,
                onStop: () => unawaited(_chat.stop()),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// The thread, scrolled around the start of the branch on screen: offset
  /// zero is its first message (on a side question, the fork divider), and
  /// the messages it follows from grow upwards from there. Opening a side
  /// question so shows it from its start.
  Widget _threadView(List<ChatNode> thread, EdgeInsets padding) {
    final id = _chat.branchId;
    final start = max(0, thread.indexWhere((n) => n.branchId == id));
    final center = ValueKey('start-$id');
    return CustomScrollView(
      controller: _scroll,
      center: center,
      slivers: [
        SliverPadding(
          padding: start == 0 ? EdgeInsets.zero : padding.copyWith(bottom: 0),
          sliver: SliverList.builder(
            itemCount: start,
            itemBuilder: (context, i) => _message(thread, start - 1 - i),
          ),
        ),
        SliverPadding(
          key: center,
          padding: padding.copyWith(top: start == 0 ? padding.top : 0),
          sliver: SliverList.builder(
            itemCount: thread.length - start,
            itemBuilder: (context, i) => _message(thread, start + i),
          ),
        ),
      ],
    );
  }

  Widget _message(List<ChatNode> thread, int i) {
    final node = thread[i];
    final message = MessageView(
      key: _messageKeys.putIfAbsent(node.id, GlobalKey.new),
      node: node,
      status: _chat.statusOf(node.id),
      sideQuestions: _chat.sideQuestionsAt(node),
      onFollow: _chat.sending ? null : (t) => unawaited(_follow(node, t)),
      onAskAbout: (text) => _askAbout(node, text),
      onOpenSideQuestion: (b) => context.go('/t/${widget.treeId}/b/${b.id}'),
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

  String _branchTitle(String branchId) {
    final title = _chat.branchTitle(branchId);
    return title.isEmpty ? 'Side question' : 'Side question · $title';
  }
}

/// Main thread › … › the parent › the side question on screen. The steps in
/// between are left out; the outline lists them.
class _Breadcrumb extends StatelessWidget {
  const _Breadcrumb({required this.chain, required this.onOpen, this.onMore});

  /// The main thread down to the side question on screen.
  final List<Branch> chain;
  final ValueChanged<Branch> onOpen;

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
              step(chain.first),
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
                // The parent takes at most a third, so the side question on
                // screen keeps the most room.
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: constraints.maxWidth / 3,
                  ),
                  child: step(parent),
                ),
                chevron,
              ],
              Expanded(
                child: Text(
                  outlineTitle(chain.last),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15),
                ),
              ),
            ],
          ),
        ),
      ),
    );
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

/// The words of the message before it that a side question asks about.
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
              'a few tangents worth following. Each one opens a side question '
              'of its own.',
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

/// The message box. On the web, Enter sends and Shift+Enter starts a new
/// line, as in the web apps. Where the message goes ([lead]) sits before the
/// text; with the focus it takes a row of its own, and the box grows to
/// three lines.
class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.streaming,
    required this.hint,
    required this.lead,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final bool streaming;
  final String hint;

  /// Builds where the message goes, if there is a choice; [compact]: just
  /// its icon.
  final Widget? Function({required bool compact}) lead;
  final VoidCallback onSend;
  final VoidCallback onStop;

  /// Below this width the lead shows only its icon until the box has the
  /// focus.
  static const _narrow = 560.0;

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    if (!kIsWeb ||
        event is! KeyDownEvent ||
        !enter ||
        HardwareKeyboard.instance.isShiftPressed ||
        controller.value.composing.isValid) {
      return KeyEventResult.ignored;
    }
    onSend();
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => ListenableBuilder(
      listenable: focusNode,
      builder: (context, _) {
        final focused = focusNode.hasFocus;
        final leading = lead(
          compact: !focused && constraints.maxWidth < _narrow,
        );
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
        const SizedBox(width: 8),
        if (streaming)
          IconButton.filledTonal(
            tooltip: 'Stop',
            onPressed: onStop,
            icon: const Icon(Icons.stop),
          )
        else
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
    );
  }
}

/// Where the composer's message goes: a new side question from the last
/// reply, or on in the branch on screen. A tap switches it.
class _DestinationChip extends StatelessWidget {
  const _DestinationChip({
    required this.aside,
    required this.compact,
    required this.onPressed,
  });

  final bool aside;
  final bool compact;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final label = aside ? 'Side question' : 'Continue';
    final color = aside
        ? Theme.of(context).colorScheme.primary
        : tokens.fgMuted;
    return Semantics(
      button: true,
      label: 'Send as: $label',
      excludeSemantics: true,
      child: Tooltip(
        message: aside
            ? 'Your message starts a side question from the last reply. '
                  'Tap to continue here instead.'
            : 'Your message continues here. Tap to ask a side question '
                  'instead.',
        child: Material(
          color: aside ? tokens.accentSoft : Colors.transparent,
          shape: StadiumBorder(side: BorderSide(color: color)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onPressed,
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: compact ? 8 : 12,
                vertical: 6,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    aside ? Icons.call_split : Icons.chevron_right,
                    size: 16,
                    color: color,
                  ),
                  if (!compact) ...[
                    const SizedBox(width: 4),
                    Text(
                      label,
                      style: Theme.of(context).textTheme.labelMedium
                          ?.copyWith(color: color),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
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
      avatar: Icon(Icons.call_split, size: 16, color: accent),
      label: Text('“$text”', maxLines: 1, overflow: TextOverflow.ellipsis),
      backgroundColor: tokens.accentSoft,
      side: BorderSide(color: accent),
      shape: const StadiumBorder(),
      onDeleted: onRemove,
      deleteButtonTooltipMessage: 'Don’t ask about these words',
    );
  }
}
