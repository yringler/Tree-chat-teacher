import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/chat_controller.dart';
import 'package:tangent/state/composer_plan.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/reply_follower.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart';

void main() {
  group('cameFromIds', () {
    late ChatController chat;

    /// The main thread with Moon › Deep and Sun under its first reply.
    setUp(() async {
      final api = FakeTangentApi()
        ..details['t1'] = treeDetail(
          branches: [
            branch('trunk'),
            branch('moon', parent: 'trunk', fork: 'a1'),
            branch('deep', parent: 'moon', fork: 'm1'),
            branch('sun', parent: 'trunk', fork: 'a1'),
          ],
        );
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test('is empty when the lesson opens', () {
      expect(chat.cameFromIds, isEmpty);
    });

    test('stays empty going deeper', () {
      chat.selectBranch('moon');
      expect(chat.cameFromIds, isEmpty);
      chat.selectBranch('deep');
      expect(chat.cameFromIds, isEmpty);
    });

    test('back on the parent, holds the tangent left', () {
      chat
        ..selectBranch('moon')
        ..selectBranch(null);
      expect(chat.cameFromIds, {'moon'});
    });

    test('back on the main thread from deeper, holds every tangent left', () {
      chat
        ..selectBranch('deep')
        ..selectBranch(null);
      expect(chat.cameFromIds, {'moon', 'deep'});
    });

    test('back one step, holds only the step left', () {
      chat
        ..selectBranch('deep')
        ..selectBranch('moon');
      expect(chat.cameFromIds, {'deep'});
    });

    test('across to another tangent, holds the one left', () {
      chat
        ..selectBranch('moon')
        ..selectBranch('sun');
      expect(chat.cameFromIds, {'moon'});
    });

    test('clears on going back into the tangent', () {
      chat
        ..selectBranch('moon')
        ..selectBranch(null)
        ..selectBranch('moon');
      expect(chat.cameFromIds, isEmpty);
    });
  });

  group('the composer’s target', () {
    late FakeTangentApi api;
    late ChatController chat;

    /// The main thread u1 a1 u2 a2, and the tangent `side` from a1 with two
    /// questions and their replies.
    setUp(() async {
      api = FakeTangentApi()
        ..details['t1'] = treeDetail(
          branches: [
            branch('trunk'),
            branch('side', parent: 'trunk', fork: 'a1'),
          ],
          nodes: [
            node('u1', branch: 'trunk', seq: 0),
            node('a1', branch: 'trunk', seq: 1, role: Role.assistant),
            node('u2', branch: 'trunk', seq: 2),
            node('a2', branch: 'trunk', seq: 3, role: Role.assistant),
            node('s1', branch: 'side', seq: 0),
            node('s2', branch: 'side', seq: 1, role: Role.assistant),
            node('s3', branch: 'side', seq: 2),
            node('s4', branch: 'side', seq: 3, role: Role.assistant),
          ],
        );
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
        branchId: 'side',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test('a tangent opened at its start goes on from its first reply, '
        'named', () {
      expect(chat.target?.id, 's2');
      expect(chat.plan.nameTarget, isTrue);
      expect(chat.plan.place, ComposerPlace.tangent);
    });

    test('opened again, from its first reply again', () {
      chat
        ..jumpedToEnd()
        ..selectBranch(null)
        ..selectBranch('side');
      expect(chat.target?.id, 's2');
    });

    test('once something is sent, from the last reply', () {
      unawaited(chat.send('And then?'));
      expect(chat.target?.id, 's4');
      expect(chat.plan.nameTarget, isFalse);
    });

    test('a jump to the end lets the start go', () {
      chat.jumpedToEnd();
      expect(chat.target?.id, 's4');
    });

    test('the main thread goes on from its last reply', () {
      chat.selectBranch(null);
      expect(chat.target?.id, 'a2');
      expect(chat.plan.nameTarget, isFalse);
    });

    test('words aimed at win, and go with a move to another thread', () {
      chat.aim((nodeId: 'a1', quote: 'the sea'));
      expect(chat.target?.id, 'a1');
      expect(chat.plan.place, ComposerPlace.lead);
      expect(chat.plan.actions, [(id: ComposerSendId.tangent, primary: true)]);
      chat.dropLead();
      expect(chat.lead, isNull);
      expect(chat.target?.id, 's2');

      chat
        ..aim((nodeId: 'a1', quote: 'the sea'))
        ..selectBranch(null);
      expect(chat.lead, isNull);
    });

    test('a reply deleted from under the box takes the lead with it', () async {
      chat
        ..selectBranch(null)
        ..aim((nodeId: 'a1', quote: 'the sea'));
      api.deleteAnswer = const DeletedMessages(
        branchIds: [],
        nodeIds: ['s3', 's4'],
      );
      await chat.deleteMessage(node('s3', branch: 'side', seq: 2));
      expect(chat.lead?.nodeId, 'a1');

      chat.aim((nodeId: 'a2', quote: null));
      api.deleteAnswer = const DeletedMessages(
        branchIds: [],
        nodeIds: ['u2', 'a2'],
      );
      await chat.deleteMessage(node('u2', branch: 'trunk', seq: 2));
      expect(chat.lead, isNull);
      expect(chat.target?.id, 'a1');
      expect(chat.plan.place, ComposerPlace.main);
    });
  });

  group('startTangent', () {
    late FakeTangentApi api;
    late ChatController chat;
    final reply = node('a1', branch: 'trunk', seq: 1, role: Role.assistant);

    setUp(() async {
      api = FakeTangentApi()..details['t1'] = treeDetail(nodes: [reply]);
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test('makes the tangent with its question as the first message', () async {
      final started = await chat.startTangent(reply, 'Why?', anchorQuote: 'w');
      expect(started?.id, 'side-1');
      expect(api.createdBranches.single.anchorQuote, 'w');
      expect(chat.branchId, 'side-1');
      expect(api.sends.single.target, 'side-1');
      expect(api.sends.single.content, 'Why?');
    });

    test('makes nothing without a question', () async {
      expect(await chat.startTangent(reply, '  '), isNull);
      expect(api.createdBranches, isEmpty);
      expect(api.sends, isEmpty);
    });
  });

  group('replies being written', () {
    late FakeTangentApi api;
    late ChatController chat;

    setUp(() {
      api = FakeTangentApi()
        ..details['t1'] = treeDetail(
          nodes: [
            node('u1', branch: 'trunk', seq: 0),
            node(
              'a1',
              branch: 'trunk',
              seq: 1,
              role: Role.assistant,
              status: NodeStatus.streaming,
            ),
          ],
        );
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
    });

    tearDown(() => chat.dispose());

    test('are followed when the lesson opens, once', () async {
      await chat.load();
      await chat.load();
      expect([for (final s in api.resumes) s.target], ['a1']);
    });

    test('a send is sending until the server starts its reply', () async {
      await chat.load();
      final accepted = chat.send('And then?');
      expect(chat.sending, isTrue);
      expect(await chat.send('Again?'), isFalse);
      api.sends.single.controller.add(
        StartEvent(
          userNode: node('u2', branch: 'trunk', seq: 2),
          assistantNode: node(
            'a2',
            branch: 'trunk',
            seq: 3,
            role: Role.assistant,
            status: NodeStatus.streaming,
          ),
          branch: branch('trunk'),
        ),
      );
      expect(await accepted, isTrue);
      expect(chat.sending, isFalse);
      expect([for (final n in chat.thread) n.id], ['u1', 'a1', 'u2', 'a2']);
    });
  });

  group('deleteMessage', () {
    late FakeTangentApi api;
    late ChatController chat;
    final u1 = node('u1', branch: 'trunk', seq: 0);
    final a1 = node('a1', branch: 'trunk', seq: 1, role: Role.assistant);
    final u2 = node('u2', branch: 'trunk', seq: 2);
    final a2 = node(
      'a2',
      branch: 'trunk',
      seq: 3,
      role: Role.assistant,
      status: NodeStatus.streaming,
    );
    final s1 = node('s1', branch: 'side', seq: 0);

    setUp(() async {
      api = FakeTangentApi()
        ..details['t1'] = treeDetail(
          branches: [
            branch('trunk'),
            branch('side', parent: 'trunk', fork: 'a1'),
          ],
          nodes: [u1, a1, u2, a2, s1],
        );
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test('takes what the server deleted out of the lesson', () async {
      chat.selectBranch('side');
      api.deleteAnswer = const DeletedMessages(
        branchIds: ['side'],
        nodeIds: ['u1', 'a1', 'u2', 'a2', 's1'],
      );
      expect(await chat.deleteMessage(u1), isTrue);
      expect(api.deletedMessages, ['u1']);
      expect(chat.branchById('side'), isNull);
      expect(chat.branchId, 'trunk');
      expect(chat.thread, isEmpty);
    });

    test('a reply being written stays deleted when its stream ends', () async {
      api.deleteAnswer = const DeletedMessages(
        branchIds: [],
        nodeIds: ['u2', 'a2'],
      );
      await chat.deleteMessage(u2);
      api.resumes.single.controller.add(
        ErrorEvent(
          nodeId: 'a2',
          message: 'Cancelled',
          node: node(
            'a2',
            branch: 'trunk',
            seq: 3,
            role: Role.assistant,
            status: NodeStatus.error,
          ),
        ),
      );
      await api.resumes.single.controller.close();
      await pumpEventQueue();
      expect([for (final n in chat.thread) n.id], ['u1', 'a1']);
    });

    test('a refusal leaves the lesson as it was, and says why', () async {
      api.refuseDeleteMessage = const ApiException(
        status: 409,
        code: 'conflict',
        message: 'Still writing',
      );
      expect(await chat.deleteMessage(u2), isFalse);
      expect(chat.thread, hasLength(4));
      expect(chat.notice, isNotNull);
    });

    test('asks before deleting a message, never a reply', () {
      expect(
        chat.deleteQuestion(u2, titleOf: (b) => b.title),
        'Delete this message? Everything after it goes too: 1 later message. '
        'Replies still being written there are stopped. This cannot be undone.',
      );
      expect(chat.deleteQuestion(a1, titleOf: (b) => b.title), isNull);
    });
  });

  group('a reply whose stream gives up', () {
    late FakeTangentApi api;
    late ChatController chat;
    final question = node('u1', branch: 'trunk', seq: 0, content: 'hi');
    final writing = node(
      'a1',
      branch: 'trunk',
      seq: 1,
      role: Role.assistant,
      status: NodeStatus.streaming,
    );
    final written = node(
      'a1',
      branch: 'trunk',
      seq: 1,
      role: Role.assistant,
      content: 'Hello',
    );

    setUp(() async {
      api = FakeTangentApi()..details['t1'] = treeDetail();
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    /// Sends a question and loses its reply after `start`. Any loss will
    /// do; one the stream doesn't reconnect after keeps the test off the
    /// real waits between reconnects.
    Future<void> sendAndLose() async {
      unawaited(chat.send('hi'));
      api.sends.single.controller
        ..add(
          StartEvent(
            userNode: question,
            assistantNode: writing,
            branch: branch('trunk'),
          ),
        )
        ..addError(StateError('lost'));
      await pumpEventQueue();
    }

    test('is followed again while the server still writes it', () async {
      api.details['t1'] = treeDetail(nodes: [question, writing]);
      await sendAndLose();
      expect([for (final r in api.resumes) r.target], ['a1']);
      expect(chat.notice, isNull);

      api.resumes.single.controller.add(
        DoneEvent(node: written, branch: branch('trunk')),
      );
      await pumpEventQueue();
      expect(chat.streamingNode, isNull);
      expect(chat.thread.last.content, 'Hello');
    });

    test('shows what the server has, with no notice, once it ended', () async {
      api.details['t1'] = treeDetail(nodes: [question, written]);
      await sendAndLose();
      expect(api.resumes, isEmpty);
      expect(chat.notice, isNull);
      expect(chat.thread.last.content, 'Hello');
    });

    test('ends in an error that names no reply', () async {
      unawaited(chat.send('hi'));
      api.sends.single.controller
        ..add(
          StartEvent(
            userNode: question,
            assistantNode: writing,
            branch: branch('trunk'),
          ),
        )
        ..add(const ErrorEvent(nodeId: null, message: 'Boom', node: null));
      await pumpEventQueue();
      expect(chat.streamingNode, isNull);
      expect(chat.thread.last.status, NodeStatus.error);
      expect(chat.thread.last.error, 'Boom');
    });

    test('is marked failed when the lesson cannot be read again', () async {
      api.details.remove('t1');
      await sendAndLose();
      expect(api.resumes, isEmpty);
      expect(chat.streamingNode, isNull);
      expect(chat.thread.last.status, NodeStatus.error);
      expect(chat.thread.last.error, connectionLostText);
      expect(chat.notice, isNotNull);
    });
  });

  group('a send lost before its reply started', () {
    late FakeTangentApi api;
    late ChatController chat;

    setUp(() async {
      api = FakeTangentApi()..details['t1'] = treeDetail();
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test(
      'counts as sent, with no notice, when the question reached the server',
      () async {
        api.details['t1'] = treeDetail(
          nodes: [
            node('u1', branch: 'trunk', seq: 0, content: 'hi'),
            node(
              'a1',
              branch: 'trunk',
              seq: 1,
              role: Role.assistant,
              status: NodeStatus.streaming,
            ),
          ],
        );
        final accepted = chat.send('hi');
        await api.sends.single.controller.close();
        expect(await accepted, isTrue);
        expect(chat.sending, isFalse);
        expect(chat.notice, isNull);
        expect(chat.streamingNode?.id, 'a1');
        expect([for (final r in api.resumes) r.target], ['a1']);
      },
    );

    test('is refused, with a notice, when it did not, after a second look '
        '3s later', () {
      fakeAsync((async) {
        bool? accepted;
        unawaited(chat.send('hi').then((value) => accepted = value));
        unawaited(api.sends.single.controller.close());
        async.elapse(const Duration(milliseconds: 2999));
        expect(accepted, isNull);
        expect(chat.sending, isTrue);

        async.elapse(const Duration(milliseconds: 1));
        expect(accepted, isFalse);
        expect(chat.sending, isFalse);
        expect(chat.notice, isNotNull);
      });
    });
  });
}
