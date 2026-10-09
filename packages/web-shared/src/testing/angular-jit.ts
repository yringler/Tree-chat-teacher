import { angularJitApplicationTransform } from '@angular/compiler-cli';
import ts from 'typescript';
import type { Plugin } from 'vitest/config';

/**
 * Compiles components for TestBed the way the Angular CLI's JIT mode does,
 * so specs can render them without a build: signal inputs, outputs, models
 * and queries become the decorators the JIT compiler reads, and a
 * `templateUrl` becomes the template itself. Styles are dropped: nothing a
 * rendered test asserts depends on them, and `styleUrl` would need loading.
 */
export function angularJit(): Plugin {
  return {
    name: 'tangent:angular-jit',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!file.endsWith('.ts') || file.includes('/node_modules/')) return null;
      if (!/@(Component|Directive)\(/.test(code)) return null;
      return compile(file, code);
    },
  };
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  experimentalDecorators: true,
  useDefineForClassFields: false,
  sourceMap: true,
  // One file at a time: the transform only needs to see what that file imports from @angular/core.
  noResolve: true,
  noLib: true,
  isolatedModules: true,
};

function compile(file: string, code: string): { code: string; map: string } {
  const host = ts.createCompilerHost(OPTIONS);
  const source = ts.createSourceFile(file, code, OPTIONS.target!, true);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...rest) => (name === file ? source : getSourceFile(name, ...rest));
  const program = ts.createProgram([file], OPTIONS, host);
  let js = '';
  let map = '';
  program.emit(
    source,
    (name, text) => {
      if (name.endsWith('.map')) map = text;
      else js = text.replace(/\/\/# sourceMappingURL=.*$/m, '');
    },
    undefined,
    false,
    { before: [inlineResources(file), angularJitApplicationTransform(program)] },
  );
  return { code: js, map };
}

/** `templateUrl` read into `template`; `styles`, `styleUrl` and `styleUrls` left out. */
function inlineResources(file: string): ts.TransformerFactory<ts.SourceFile> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  return (ctx) => {
    const f = ctx.factory;
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isDecorator(node) && isComponentCall(node.expression)) {
        const [meta] = node.expression.arguments;
        if (meta && ts.isObjectLiteralExpression(meta)) {
          const props = meta.properties.flatMap((p) => {
            const name = p.name && ts.isIdentifier(p.name) ? p.name.text : '';
            if (name === 'styles' || name === 'styleUrl' || name === 'styleUrls') return [];
            if (name === 'templateUrl' && ts.isPropertyAssignment(p)) {
              if (!ts.isStringLiteral(p.initializer)) throw new Error(`${file}: templateUrl`);
              const html = ts.sys.readFile(ts.sys.resolvePath(`${dir}/${p.initializer.text}`));
              if (html === undefined) throw new Error(`${file}: no ${p.initializer.text}`);
              return [f.createPropertyAssignment('template', f.createStringLiteral(html))];
            }
            return [p];
          });
          return f.updateDecorator(
            node,
            f.updateCallExpression(node.expression, node.expression.expression, undefined, [
              f.updateObjectLiteralExpression(meta, props),
            ]),
          );
        }
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return (source) => ts.visitNode(source, visit, ts.isSourceFile);
  };
}

function isComponentCall(e: ts.Expression): e is ts.CallExpression {
  return (
    ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Component'
  );
}
