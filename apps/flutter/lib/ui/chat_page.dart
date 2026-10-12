import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../api/models.dart';
import '../api/tangents.dart';
import '../state/app_scope.dart';
import '../state/chat_controller.dart';
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
  final _scroll = ScrollController();

  /// Follows the end of the thread until the learner scrolls up.
  bool _stickToBottom = true;

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
      _showBranch();
    }
  }

  @override
  void dispose() {
    _chat.dispose();
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// The main thread opens at its end, a side question at its start.
  void _showBranch() {
    _stickToBottom = !_chat.isSideBranch;
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

  void _followEnd() {
    if (!_stickToBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
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
    unawaited(_send(text));
  }

  Future<void> _follow(ChatNode node, Tangent tangent) async {
    final opened = await _chat.followTangent(node, tangent);
    if (opened == null || !mounted) return;
    context.go('/t/${widget.treeId}/b/${opened.branchId}');
    if (opened.created) await _send(tangent.title);
  }

  @override
  Widget build(BuildContext context) {
    final lessons = AppScope.of(context).lessons;
    return ListenableBuilder(
      listenable: Listenable.merge([_chat, lessons]),
      builder: (context, _) => Scaffold(
        appBar: AppBar(
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
            const SizedBox(width: 12),
          ],
        ),
        body: SafeArea(child: _body(context)),
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
        if (_chat.isSideBranch)
          _Breadcrumb(
            title: _chat.branch?.title ?? '',
            onMainThread: () => context.go('/t/${widget.treeId}'),
          ),
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
                enabled: !busy,
                streaming: streaming != null,
                hint: thread.isEmpty
                    ? 'Ask a question or name a topic'
                    : 'Ask a follow-up',
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
      key: ValueKey(node.id),
      node: node,
      status: _chat.statusOf(node.id),
      sideQuestions: _chat.sideQuestionsAt(node),
      onFollow: _chat.sending ? null : (t) => unawaited(_follow(node, t)),
      onOpenSideQuestion: (b) => context.go('/t/${widget.treeId}/b/${b.id}'),
    );
    final forked = i > 0 && thread[i - 1].branchId != node.branchId;
    if (!forked) return message;
    return Column(
      children: [
        _ForkDivider(title: _branchTitle(node.branchId)),
        message,
      ],
    );
  }

  String _branchTitle(String branchId) {
    final title = _chat.branchTitle(branchId);
    return title.isEmpty ? 'Side question' : 'Side question · $title';
  }
}

class _Breadcrumb extends StatelessWidget {
  const _Breadcrumb({required this.title, required this.onMainThread});

  final String title;
  final VoidCallback onMainThread;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: tokens.border)),
      ),
      child: ContentColumn(
        child: Row(
          children: [
            TextButton(
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 4),
              ),
              onPressed: onMainThread,
              child: const Text('Main thread'),
            ),
            Icon(Icons.chevron_right, size: 18, color: tokens.fgMuted),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 15),
              ),
            ),
          ],
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
/// line, as in the web apps.
class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.streaming,
    required this.hint,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool streaming;
  final String hint;
  final VoidCallback onSend;
  final VoidCallback onStop;

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
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Focus(
            onKeyEvent: _onKey,
            child: TextField(
              controller: controller,
              enabled: enabled,
              minLines: 1,
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
