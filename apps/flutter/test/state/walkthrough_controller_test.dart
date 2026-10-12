import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/session_controller.dart';
import 'package:tangent/state/walkthrough_controller.dart';

import '../fakes.dart';

void main() {
  late FakeTangentApi api;
  late SessionController session;
  late WalkthroughController walkthrough;

  setUp(() async {
    api = FakeTangentApi()
      ..settingsAnswer = const Settings(walkthroughDoneAt: null);
    session = SessionController(api);
    await session.start();
    walkthrough = WalkthroughController(api: api, session: session);
  });

  tearDown(() {
    walkthrough.dispose();
    session.dispose();
  });

  test('walks the loop once: tangent, back, next', () async {
    await walkthrough.start();
    expect(walkthrough.showing, isNull, reason: 'no reply yet');

    walkthrough.onTrunkReplyReady();
    expect(walkthrough.showing, WalkthroughPhase.tangent);

    walkthrough.onEnteredTangent();
    expect(walkthrough.showing, WalkthroughPhase.back);

    walkthrough.onBackOnTrunk();
    expect(walkthrough.showing, WalkthroughPhase.next);
    expect(api.walkthroughDoneMarks, 0);

    walkthrough.next();
    expect(walkthrough.showing, isNull);
    expect(walkthrough.state.phase, WalkthroughPhase.done);
    await pumpEventQueue();
    expect(api.walkthroughDoneMarks, 1);
  });

  test('a reply sent with Next ➜ on step 3 ends it, as Done does', () async {
    await walkthrough.start();
    walkthrough
      ..onTrunkReplyReady()
      ..onRepliedOnTrunk();
    expect(walkthrough.showing, WalkthroughPhase.tangent, reason: 'step 1');

    walkthrough
      ..onEnteredTangent()
      ..onBackOnTrunk();
    expect(walkthrough.showing, WalkthroughPhase.next);
    walkthrough
      ..onRepliedOnTrunk()
      ..onRepliedOnTrunk();
    expect(walkthrough.state.phase, WalkthroughPhase.done);
    await pumpEventQueue();
    expect(api.walkthroughDoneMarks, 1);
  });

  test(
    '"Got it" puts a step away until the learner gets to the next',
    () async {
      await walkthrough.start();
      walkthrough
        ..onTrunkReplyReady()
        ..next();
      expect(walkthrough.showing, isNull);
      walkthrough.onTrunkReplyReady();
      expect(walkthrough.showing, isNull, reason: 'step 1 is done');

      walkthrough.onEnteredTangent();
      expect(walkthrough.showing, WalkthroughPhase.back);
    },
  );

  test(
    'a tangent entered before step 1 showed goes straight to step 2',
    () async {
      await walkthrough.start();
      walkthrough.onEnteredTangent();
      expect(walkthrough.showing, WalkthroughPhase.back);
    },
  );

  test('skip ends it and tells the server once', () async {
    await walkthrough.start();
    walkthrough
      ..onTrunkReplyReady()
      ..skip()
      ..skip();
    expect(walkthrough.state.phase, WalkthroughPhase.done);

    walkthrough
      ..replay()
      ..onTrunkReplyReady()
      ..skip();
    await pumpEventQueue();
    expect(api.walkthroughDoneMarks, 1);
  });

  test('replay starts over from step 1 without telling the server', () async {
    api.settingsAnswer = const Settings(walkthroughDoneAt: '2026-01-01');
    await walkthrough.start();
    walkthrough.onTrunkReplyReady();
    expect(walkthrough.showing, isNull, reason: 'the account has had it');

    walkthrough
      ..replay()
      ..onTrunkReplyReady();
    expect(walkthrough.showing, WalkthroughPhase.tangent);
    walkthrough.skip();
    await pumpEventQueue();
    expect(api.walkthroughDoneMarks, 0);
  });

  test('asks the server once', () async {
    await walkthrough.start();
    walkthrough
      ..onTrunkReplyReady()
      ..skip();
    await walkthrough.start();
    expect(walkthrough.state.phase, WalkthroughPhase.done);
  });

  test('signing out forgets it, for the next learner', () async {
    await walkthrough.start();
    walkthrough.onTrunkReplyReady();
    await session.signOut();
    expect(walkthrough.state, walkthroughOff);

    await walkthrough.start();
    walkthrough.onTrunkReplyReady();
    expect(walkthrough.showing, WalkthroughPhase.tangent);
  });
}
