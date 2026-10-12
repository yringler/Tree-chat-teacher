import 'package:flutter/material.dart';
import 'package:mermaid_core/mermaid_core.dart' as core;
import 'package:mermaid_flutter/mermaid_flutter.dart';

/// Draws Mermaid [source] with mermaid_flutter, or builds [fallback] when it
/// doesn't parse or lay out. Loaded deferred by `mermaid_markdown.dart`, so
/// the package stays out of the app's first download.
///
/// Mermaid's own default and dark themes are used rather than ones derived
/// from the app's colors, whose scheme would give every node and pie slice
/// nearly the same color. Node links (`click … href`) stay inert.
Widget drawMermaid(
  String source, {
  required bool dark,
  required WidgetBuilder fallback,
}) => _MermaidDiagram(source: source, dark: dark, fallback: fallback);

class _MermaidDiagram extends StatelessWidget {
  const _MermaidDiagram({
    required this.source,
    required this.dark,
    required this.fallback,
  });

  final String source;
  final bool dark;
  final WidgetBuilder fallback;

  @override
  Widget build(BuildContext context) {
    final scene = _sceneOf(source, dark: dark);
    if (scene == null) return fallback(context);
    final labels = {..._nodeLabels(scene.nodes)};
    return Semantics(
      container: true,
      label: labels.isEmpty ? 'Diagram' : 'Diagram: ${labels.join(', ')}',
      // A diagram is as wide as its layout; a wide one scrolls sideways
      // rather than painting past the reply.
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: CustomPaint(
          painter: ScenePainter(scene),
          size: Size(scene.size.width, scene.size.height),
        ),
      ),
    );
  }
}

/// The labels of a diagram's nodes, in drawing order.
Iterable<String> _nodeLabels(List<core.SceneNode> nodes) sync* {
  for (final node in nodes) {
    if (node is! core.SceneGroup) continue;
    final label = node.semanticLabel?.trim() ?? '';
    if (node.role == core.SceneGroupRole.node && label.isNotEmpty) {
      yield label;
    }
    yield* _nodeLabels(node.children);
  }
}

/// Laid-out diagrams (null for one that failed) by theme and source, most
/// recently used last. Layout runs synchronously while building, and the
/// thread's list drops a message's widgets once it scrolls away, so a diagram
/// scrolled back into view comes from here instead of being laid out again.
final _scenes = <(bool, String), core.RenderScene?>{};
const _maxScenes = 32;

core.RenderScene? _sceneOf(String source, {required bool dark}) {
  final key = (dark, source);
  if (_scenes.containsKey(key)) {
    final scene = _scenes.remove(key);
    return _scenes[key] = scene;
  }
  core.RenderScene? scene;
  try {
    scene = core.Mermaid(
      measurer: const FlutterTextMeasurer(),
      theme: dark
          ? core.MermaidTheme.darkTheme
          : core.MermaidTheme.defaultTheme,
    ).render(source);
  } catch (_) {
    // A parse error, a diagram type the port lacks, or a layout that fails:
    // each shows the source instead.
    scene = null;
  }
  _scenes[key] = scene;
  if (_scenes.length > _maxScenes) _scenes.remove(_scenes.keys.first);
  return scene;
}
