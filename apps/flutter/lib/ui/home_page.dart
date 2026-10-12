import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../api/models.dart';
import '../state/app_scope.dart';
import '../state/lessons_controller.dart';
import 'format.dart';
import 'tier_switch.dart';
import 'widgets.dart';

/// `/`: start a lesson, and the list of lessons.
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  @override
  void initState() {
    super.initState();
    unawaited(AppScope.of(context).lessons.ensureLoaded());
  }

  @override
  Widget build(BuildContext context) {
    final lessons = AppScope.of(context).lessons;
    return Scaffold(
      appBar: AppBar(
        title: const Logo(),
        actions: const [_AccountMenu(), SizedBox(width: 8)],
      ),
      body: ListenableBuilder(
        listenable: lessons,
        builder: (context, _) => LayoutBuilder(
          builder: (context, constraints) => RefreshIndicator(
            onRefresh: lessons.load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: columnPadding(constraints.maxWidth),
              children: [
                const _NewLessonCard(),
                const SizedBox(height: 28),
                Text(
                  'Your lessons',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                if (lessons.notice case final notice?) ...[
                  NoticeBanner(
                    notice: notice,
                    onDismiss: lessons.dismissNotice,
                  ),
                  const SizedBox(height: 8),
                ],
                ..._lessonList(context, lessons),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _lessonList(BuildContext context, LessonsController lessons) {
    final trees = lessons.trees;
    if (trees == null) {
      return [
        if (lessons.loading)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          ),
      ];
    }
    if (trees.isEmpty) {
      return [
        Text(
          'No lessons yet. Start one above.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ];
    }
    return [for (final tree in trees) _LessonTile(tree: tree)];
  }
}

class _AccountMenu extends StatelessWidget {
  const _AccountMenu();

  @override
  Widget build(BuildContext context) {
    final session = AppScope.of(context).session;
    return PopupMenuButton<void>(
      tooltip: 'Account',
      icon: const Icon(Icons.account_circle_outlined),
      itemBuilder: (context) => [
        PopupMenuItem<void>(
          enabled: false,
          child: Text(session.me?.email ?? 'Signed in'),
        ),
        const PopupMenuDivider(),
        PopupMenuItem<void>(
          onTap: () => unawaited(session.signOut()),
          child: const Text('Sign out'),
        ),
      ],
    );
  }
}

class _NewLessonCard extends StatefulWidget {
  const _NewLessonCard();

  @override
  State<_NewLessonCard> createState() => _NewLessonCardState();
}

class _NewLessonCardState extends State<_NewLessonCard> {
  final _topic = TextEditingController();
  Tier _tier = Tier.normal;
  bool _starting = false;

  @override
  void dispose() {
    _topic.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    if (_starting) return;
    setState(() => _starting = true);
    final id = await AppScope.of(context).lessons.start(_topic.text, _tier);
    if (!mounted) return;
    setState(() => _starting = false);
    if (id != null) context.go('/t/$id');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('New lesson', style: theme.textTheme.headlineSmall),
            const SizedBox(height: 4),
            Text(
              'Name a topic or ask a first question. Every answer ends with '
              'tangents you can follow.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _topic,
              enabled: !_starting,
              minLines: 2,
              maxLines: 8,
              keyboardType: TextInputType.multiline,
              decoration: const InputDecoration(
                labelText: 'Topic or first question',
                hintText: 'e.g. Why is the sky blue?',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: 16),
            // Full width, so spaceBetween puts the button at the end.
            SizedBox(
              width: double.infinity,
              child: Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                alignment: WrapAlignment.spaceBetween,
                children: [
                  TierSwitch(
                    tier: _tier,
                    enabled: !_starting,
                    onChanged: (tier) => setState(() => _tier = tier),
                  ),
                  FilledButton.icon(
                    onPressed: _starting ? null : () => unawaited(_start()),
                    icon: const Icon(Icons.add),
                    label: const Text('Start lesson'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LessonTile extends StatelessWidget {
  const _LessonTile({required this.tree});

  final TreeSummary tree;

  Future<void> _delete(BuildContext context) async {
    final lessons = AppScope.of(context).lessons;
    final title = lessonTitle(tree.title);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete lesson?'),
        content: Text(
          'Delete the lesson “$title” with all its side questions?',
        ),
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
    if (confirmed ?? false) await lessons.delete(tree.id);
  }

  @override
  Widget build(BuildContext context) {
    final title = lessonTitle(tree.title);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Text(
          '${relativeDate(tree.updatedAt)}${sideQuestionsLabel(tree.branchCount)}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        onTap: () => context.go('/t/${tree.id}'),
        trailing: IconButton(
          tooltip: 'Delete $title',
          icon: const Icon(Icons.delete_outline),
          onPressed: () => unawaited(_delete(context)),
        ),
      ),
    );
  }
}
