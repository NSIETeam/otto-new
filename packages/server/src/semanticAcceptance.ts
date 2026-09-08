/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import type { ParserOptions } from 'prettier';
type Node = Record<string, unknown>;
const node = (value: unknown): Node | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Node)
    : undefined;
const args = (n: Node) =>
  Array.isArray(n.arguments)
    ? n.arguments.map(node).filter((x): x is Node => !!x)
    : [];
function name(value: unknown): string {
  const n = node(value);
  if (!n) return '';
  if (n.type === 'Identifier') return String(n.name);
  if (n.type === 'MemberExpression')
    return `${name(n.object)}.${name(n.property)}`;
  return '';
}
function bindings(value: unknown): string[] {
  const n = node(value);
  if (!n) return [];
  if (n.type === 'Identifier') return [String(n.name)];
  if (n.type === 'ObjectPattern')
    return (n.properties as unknown[]).flatMap((p) => bindings(node(p)?.value));
  if (n.type === 'ArrayPattern')
    return (n.elements as unknown[]).flatMap(bindings);
  if (n.type === 'AssignmentPattern') return bindings(n.left);
  if (n.type === 'RestElement') return bindings(n.argument);
  return [];
}
const functionNode = (n: Node) =>
  [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ].includes(String(n.type));
// Known built-in matcher calls only; arbitrary toX helpers and chain modifiers
// are not proof an assertion was executed. Custom matchers need separate review.
const matchers = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeNaN',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toMatch',
  'toMatchObject',
  'toBeInstanceOf',
  'toThrow',
  'toThrowError',
]);
/** Resolve only the assertion/test names we understand. Unknown helpers remain
 * unverified; never execute an import to find out what an identifier means. */
function bindingReviewer(ast: unknown) {
  const declarations: Array<{
    ids: string[];
    scope?: Node;
    trusted: boolean;
    requireContext?: Node[];
  }> = [];
  const assignments: Array<{ id: string; scopes: Node[] }> = [];
  walk(ast, (n, ancestors) => {
    const scope = (functionScoped = false) =>
      [...ancestors]
        .reverse()
        .find(
          (a) =>
            functionNode(a) ||
            a.type === 'Program' ||
            (!functionScoped && a.type === 'BlockStatement'),
        );
    if (n.type === 'ImportDeclaration') {
      const module = node(n.source)?.value;
      for (const raw of n.specifiers as unknown[]) {
        const specifier = node(raw)!;
        const local = name(specifier.local);
        const imported = name(specifier.imported);
        const trusted =
          (module === 'vitest' &&
            ['expect', 'test', 'it', 'describe'].includes(local) &&
            imported === local) ||
          (module === 'node:test' &&
            ['test', 'it', 'describe'].includes(local) &&
            (imported === local ||
              (local === 'test' &&
                specifier.type === 'ImportDefaultSpecifier'))) ||
          (['node:assert', 'node:assert/strict'].includes(String(module)) &&
            local === 'assert' &&
            ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(
              String(specifier.type),
            ));
        declarations.push({
          ids: bindings(specifier.local),
          scope: scope(),
          trusted,
        });
      }
    }
    if (n.type === 'VariableDeclarator') {
      const init = node(n.init);
      const module =
        init?.type === 'CallExpression' &&
        name(init.callee) === 'require' &&
        args(init).length === 1
          ? args(init)[0].value
          : undefined;
      for (const id of bindings(n.id)) {
        const named =
          node(n.id)?.type === 'ObjectPattern' &&
          (node(n.id)!.properties as unknown[]).some((raw) => {
            const property = node(raw);
            return (
              property?.type === 'Property' &&
              !property.computed &&
              name(property.key) === id &&
              name(property.value) === id
            );
          });
        const trusted =
          (['node:assert', 'node:assert/strict'].includes(String(module)) &&
            name(n.id) === 'assert') ||
          (module === 'node:test' &&
            named &&
            ['test', 'it', 'describe'].includes(id));
        declarations.push({
          ids: [id],
          scope: scope(ancestors.at(-1)?.kind === 'var'),
          trusted,
          ...(trusted ? { requireContext: ancestors } : {}),
        });
      }
    }
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration')
      declarations.push({
        ids: bindings(n.id),
        scope: scope(),
        trusted: false,
      });
    if (functionNode(n))
      declarations.push({
        ids: (n.params as unknown[]).flatMap(bindings),
        scope: n,
        trusted: false,
      });
    if (n.type === 'CatchClause')
      declarations.push({
        ids: bindings(n.param),
        scope: node(n.body),
        trusted: false,
      });
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
      let lhs = node(n.left ?? n.argument);
      while (lhs?.type === 'MemberExpression') lhs = node(lhs.object);
      for (const id of bindings(lhs))
        assignments.push({ id, scopes: ancestors });
    }
  });
  const isTrusted = (id: string, ancestors: Node[]): boolean => {
    const applicable = declarations.filter(
      (d) => d.ids.includes(id) && (!d.scope || ancestors.includes(d.scope)),
    );
    const nearest = applicable.sort(
      (a, b) => ancestors.indexOf(b.scope!) - ancestors.indexOf(a.scope!),
    )[0];
    if (nearest && !nearest.trusted) return false;
    if (
      nearest?.requireContext &&
      !isTrusted('require', nearest.requireContext)
    )
      return false;
    // An assignment to this binding anywhere may replace it before the test
    // runs. Assignments to a different lexical local of the same name do not.
    return !assignments.some(
      (a) =>
        a.id === id &&
        !declarations.some(
          (d) =>
            !d.trusted &&
            d.ids.includes(id) &&
            d.scope &&
            a.scopes.includes(d.scope) &&
            !ancestors.includes(d.scope),
        ),
    );
  };
  return isTrusted;
}
function walk(
  value: unknown,
  visit: (n: Node, ancestors: Node[]) => boolean | void,
  ancestors: Node[] = [],
  budget = { left: 30000 },
): void {
  if (--budget.left < 0 || ancestors.length > 80)
    throw new Error('Test AST exceeds review limit');
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, ancestors, budget);
    return;
  }
  const n = node(value);
  if (!n) return;
  if (typeof n.type === 'string' && visit(n, ancestors) === false) return;
  for (const [key, child] of Object.entries(n)) {
    if (
      !['loc', 'range', 'tokens', 'comments', 'parent'].includes(key) &&
      typeof child === 'object'
    )
      walk(child, visit, [...ancestors, n], budget);
  }
}
export interface TestSemanticReview {
  status: 'passed' | 'not_run' | 'failed';
  reason: string;
  assertionRanges: number[][];
}
/** Structural weak-test detector. It proves a dynamic assertion is in the named
 * case, NOT that the business behavior or hidden requirements are fully covered.
 * Bundled parser only: no config/plugins, imports, test execution or download. */
export async function inspectTestSemantics(
  source: string,
  caseName: string,
): Promise<TestSemanticReview> {
  const result = (
    status: TestSemanticReview['status'],
    reason: string,
    assertionRanges: number[][] = [],
  ): TestSemanticReview => ({ status, reason, assertionRanges });
  if (source.length > 256000)
    return result('not_run', '测试源码超出静态审查上限');
  try {
    // Public export in pinned prettier@3.9.6 package.json; load only for a code review.
    // eslint-disable-next-line import/no-internal-modules
    const { parsers } = await import('prettier/plugins/typescript');
    const ast: unknown = await parsers.typescript.parse(source, {
      filepath: 'review.test.ts',
    } as ParserOptions);
    const matches: Array<{ call: Node; ancestors: Node[] }> = [];
    walk(ast, (n, ancestors) => {
      if (
        n.type !== 'CallExpression' ||
        !/^(?:test|it)(?:\.(?:skip|only|todo|concurrent|sequential))*$/.test(
          name(n.callee),
        )
      )
        return;
      const title = args(n)[0]?.value;
      // Reporters may prefix describe suites; never fuzzy match arbitrary names.
      const suites = ancestors
        .filter(
          (a) =>
            a.type === 'CallExpression' &&
            /^describe(?:\.(?:skip|only))?$/.test(name(a.callee)),
        )
        .map((a) => args(a)[0]?.value)
        .filter((v): v is string => typeof v === 'string');
      if (
        title === caseName ||
        [...suites, title].join(' ') === caseName ||
        [...suites, title].join(' > ') === caseName
      )
        matches.push({ call: n, ancestors });
    });
    if (matches.length !== 1)
      return result(
        'not_run',
        '无法唯一定位具名用例；动态/参数化用例需单独提供可审查测试',
      );
    const { call, ancestors } = matches[0];
    if (
      [call, ...ancestors].some(
        (n) =>
          n.type === 'CallExpression' &&
          /^(?:test|it|describe)(?:\.\w+)*\.(?:skip|todo)(?:\.|$)/.test(
            name(n.callee),
          ),
      )
    )
      return result('failed', '测试或所属测试组被跳过');
    const callback = args(call).find((a) =>
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(
        String(a.type),
      ),
    );
    if (!callback) return result('not_run', '用例使用外部回调，当前无法审查');
    const trustedBinding = bindingReviewer(ast);
    if (
      [
        call,
        ...ancestors.filter(
          (n) =>
            n.type === 'CallExpression' &&
            /^describe(?:\.|$)/.test(name(n.callee)),
        ),
      ].some((n) => !trustedBinding(name(n.callee).split('.')[0], ancestors))
    )
      return result('not_run', '测试注册函数被替换或来源无法核实');
    const variables = new Map<string, Node>();
    const assigned = new Set<string>();
    walk(callback.body, (n) => {
      if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
        let lhs = node(n.left ?? n.argument);
        while (lhs?.type === 'MemberExpression') lhs = node(lhs.object);
        for (const id of bindings(lhs)) assigned.add(id);
      }
    });
    walk(callback.body, (n) => {
      if (
        [
          'FunctionExpression',
          'ArrowFunctionExpression',
          'FunctionDeclaration',
          'IfStatement',
          'TryStatement',
        ].includes(String(n.type))
      )
        return false;
      if (n.type === 'VariableDeclarator' && node(n.init))
        for (const id of bindings(n.id))
          if (!assigned.has(id)) variables.set(id, node(n.init)!);
    });
    function dynamic(value: unknown, seen = new Set<string>()): boolean {
      const n = node(value);
      if (!n) return false;
      if (n.type === 'AwaitExpression') return dynamic(n.argument, seen);
      if (n.type === 'CallExpression')
        return !/^(?:expect|Boolean|Number|String|Object|Array)(?:\.|$)/.test(
          name(n.callee),
        );
      if (n.type === 'MemberExpression') return dynamic(n.object, seen);
      if (n.type === 'Identifier' && !seen.has(String(n.name))) {
        seen.add(String(n.name));
        return dynamic(variables.get(String(n.name)), seen);
      }
      return false;
    }
    // Only exception matchers actually invoke their callback argument. Do not
    // mistake a truthy function object or code after return for tested behavior.
    function exceptionCallback(value: unknown): boolean {
      const n = node(value);
      if (
        !n ||
        !['ArrowFunctionExpression', 'FunctionExpression'].includes(
          String(n.type),
        )
      )
        return false;
      const body = node(n.body);
      if (body?.type !== 'BlockStatement') return dynamic(body);
      for (const statement of body.body as unknown[]) {
        const s = node(statement);
        if (s?.type === 'ReturnStatement') return dynamic(s.argument);
        if (s?.type === 'ExpressionStatement' && dynamic(s.expression))
          return true;
        if (
          !['ExpressionStatement', 'VariableDeclaration'].includes(
            String(s?.type),
          )
        )
          return false;
      }
      return false;
    }
    const awaited = (parents: Node[]) =>
      parents.some((p) =>
        ['AwaitExpression', 'ReturnStatement'].includes(String(p.type)),
      ) || node(callback.body)?.type !== 'BlockStatement';
    const assertionRanges: number[][] = [];
    walk(callback.body, (n, parents) => {
      if (
        [
          'FunctionExpression',
          'ArrowFunctionExpression',
          'FunctionDeclaration',
        ].includes(String(n.type))
      )
        return false;
      if (
        [
          'IfStatement',
          'ConditionalExpression',
          'LogicalExpression',
          'ForStatement',
          'ForOfStatement',
          'ForInStatement',
          'WhileStatement',
          'DoWhileStatement',
          'TryStatement',
          'SwitchStatement',
        ].includes(String(n.type))
      )
        return false;
      if (
        parents.some(
          (p) =>
            p.type === 'BlockStatement' &&
            Array.isArray(p.body) &&
            p.body.some((s) => {
              const statement = node(s);
              return (
                ['ReturnStatement', 'ThrowStatement'].includes(
                  String(statement?.type),
                ) &&
                !!statement &&
                !parents.includes(statement) &&
                Array.isArray(statement.range) &&
                Array.isArray(n.range) &&
                statement.range[0] < n.range[0]
              );
            }),
        )
      )
        return;
      if (
        n.type === 'CallExpression' &&
        name(n.callee) === 'expect' &&
        trustedBinding('expect', [...ancestors, call, callback, ...parents]) &&
        (dynamic(args(n)[0]) ||
          (parents.some(
            (p) =>
              p.type === 'CallExpression' &&
              /^toThrow(?:Error)?$/.test(name(node(p.callee)?.property)),
          ) &&
            exceptionCallback(args(n)[0])))
      ) {
        const asynchronous = parents.some(
          (p) =>
            p.type === 'MemberExpression' &&
            /^(?:resolves|rejects)$/.test(name(p.property)),
        );
        if (asynchronous && !awaited(parents)) return;
        // expect(value) alone is not an assertion. Require an actual matcher call.
        if (
          !parents.some((p) => {
            const callee = node(p.callee);
            if (
              p.type !== 'CallExpression' ||
              callee?.type !== 'MemberExpression' ||
              callee.computed ||
              !matchers.has(name(callee.property))
            )
              return false;
            let receiver = node(callee.object);
            while (
              receiver?.type === 'MemberExpression' &&
              !receiver.computed &&
              ['not', 'resolves', 'rejects'].includes(name(receiver.property))
            )
              receiver = node(receiver.object);
            return receiver === n;
          })
        )
          return;
        if (Array.isArray(n.range)) assertionRanges.push(n.range as number[]);
      }
      if (
        n.type === 'CallExpression' &&
        trustedBinding('assert', [...ancestors, call, callback, ...parents]) &&
        /^(?:assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|ok|throws|rejects))$/.test(
          name(n.callee),
        ) &&
        (dynamic(args(n)[0]) ||
          (/^assert\.(?:throws|rejects)$/.test(name(n.callee)) &&
            exceptionCallback(args(n)[0]))) &&
        (name(n.callee) !== 'assert.rejects' || awaited(parents)) &&
        Array.isArray(n.range)
      )
        assertionRanges.push(n.range as number[]);
    });
    return assertionRanges.length
      ? result(
          'passed',
          '具名用例含依赖实际调用的断言；仅为弱测试筛查，不证明完整业务语义',
          assertionRanges,
        )
      : result(
          'not_run',
          '未找到可核实的动态断言；空测试、恒真断言、仅打印通过或无法分析的辅助函数不能代替业务验收',
        );
  } catch {
    return result('not_run', '测试源码无法解析，不能按通过处理');
  }
}
