import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

// Fortran is case-insensitive (`Call Foo` ≡ `call FOO`), so every name is
// normalised to uppercase before being stored or referenced. That way callers
// match callees regardless of the source casing.
const norm = (s: string) => s.trim().toUpperCase();

// First named child whose type is one of `types`, or null.
function findChild(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

// Pull the symbol name out of a *_statement child (module_statement,
// subroutine_statement, …). Subroutine/function/derived-type statements expose
// `name`/`type_name` either as a tree-sitter field or as a directly-named child.
function statementName(stmt: SyntaxNode | null, source: string): string {
  if (!stmt) return '';
  const fieldName = stmt.childForFieldName('name');
  if (fieldName) return norm(getNodeText(fieldName, source));
  const inner = findChild(stmt, 'name', 'type_name');
  return inner ? norm(getNodeText(inner, source)) : '';
}

// Visit every named child of `node` except the header *_statement and any
// `end_*_statement` — those are syntactic bookkeeping and never carry symbols.
function visitBody(node: SyntaxNode, headerType: string, ctx: ExtractorContext): void {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === headerType) continue;
    if (c.type.startsWith('end_')) continue;
    ctx.visitNode(c);
  }
}

// -----------------------------------------------------------------------------
// Module visibility resolution
// -----------------------------------------------------------------------------
//
// Fortran modules default to PUBLIC. A bare `PRIVATE` statement flips the
// default; `PUBLIC :: a, b` and `PRIVATE :: c, d` override per-symbol. A
// derived type can also carry an inline `access_specifier` (`TYPE, PUBLIC ::
// FOO`) which trumps the module default.
//
// Subroutine and function visibility is NEVER declared inline on the
// `subroutine_statement` — it always has to be resolved from the enclosing
// module's access statements. So we do a one-shot pass over the module body
// when we enter it, build a {default + per-symbol overrides} frame, push it
// on a stack, and let symbol emission look it up by name. The stack handles
// nested forms (interface blocks have their own visibility scope in
// principle); it is cleared on every `translation_unit` so state never
// leaks between files.

type ModuleFrame = {
  defaultVisibility: 'public' | 'private';
  perSymbol: Map<string, 'public' | 'private'>;
};
const moduleFrames: ModuleFrame[] = [];

// Parallel stack of "what kind of scope am I in?" — needed because emission
// of fields / module constants / module variables all flow through the
// `variable_declaration` AST node, and we have to look at the enclosing scope
// to know which one to emit (or to skip the declaration entirely if it's a
// local var inside a routine body).
const scopeKinds: NodeKind[] = [];
function currentScopeKind(): NodeKind | undefined {
  return scopeKinds[scopeKinds.length - 1];
}

function currentModuleVisibility(name: string): 'public' | 'private' | undefined {
  const frame = moduleFrames[moduleFrames.length - 1];
  if (!frame) return undefined;
  return frame.perSymbol.get(name) ?? frame.defaultVisibility;
}

function buildModuleFrame(moduleNode: SyntaxNode, src: string): ModuleFrame {
  const frame: ModuleFrame = { defaultVisibility: 'public', perSymbol: new Map() };
  for (const c of moduleNode.namedChildren) {
    if (!c) continue;
    if (c.type !== 'private_statement' && c.type !== 'public_statement') continue;
    const access: 'public' | 'private' = c.type === 'private_statement' ? 'private' : 'public';
    const idents = c.namedChildren.filter((n) => n?.type === 'identifier');
    if (idents.length === 0) {
      frame.defaultVisibility = access;
    } else {
      for (const id of idents) {
        if (id) frame.perSymbol.set(norm(getNodeText(id, src)), access);
      }
    }
  }
  return frame;
}

// Recursively unwrap `init_declarator` / `sized_declarator` to find the
// declared identifier. The variable name is always the FIRST named child at
// each level, so we walk down child(0) until we hit an `identifier`. Handles:
//   identifier                                      → A
//   sized_declarator { identifier, size }           → A(N)
//   init_declarator  { identifier, value }          → A = 1
//   init_declarator  { sized_declarator{ id, sz }, value }  → A(N) = [..]
function declaratorName(c: SyntaxNode | null): SyntaxNode | null {
  if (!c) return null;
  if (c.type === 'identifier') return c;
  if (c.type === 'sized_declarator' || c.type === 'init_declarator') {
    return declaratorName(c.namedChild(0));
  }
  return null;
}

// Names declared on the LHS of a `variable_declaration`. Walks each top-level
// declarator (`A`, `A(N)`, `A = 1`, or `A(N) = [..]`) and pulls out the
// identifier name. Identifiers nested in a `size` expression (e.g. `N` inside
// `A(N)`) are references and intentionally skipped.
function declaredNames(decl: SyntaxNode, src: string): string[] {
  const names: string[] = [];
  for (const c of decl.namedChildren) {
    const id = declaratorName(c);
    if (id) names.push(norm(getNodeText(id, src)));
  }
  return names;
}

// For a given variable name, return the declared type ("INTEGER", "REAL",
// "TYPE(FOO)" …) by scanning a wrapper's `variable_declaration` children.
// Used both for parameter types and for RESULT-clause return types — anywhere
// where Fortran declares the name in a list separately from its type spec.
function declaredTypeOf(wrapper: SyntaxNode, name: string, src: string): string | undefined {
  for (const c of wrapper.namedChildren) {
    if (!c || c.type !== 'variable_declaration') continue;
    if (!declaredNames(c, src).includes(name)) continue;
    const typeNode = c.namedChildren.find(
      (n) => n?.type === 'intrinsic_type' || n?.type === 'derived_type',
    );
    if (typeNode) return norm(getNodeText(typeNode, src));
  }
  return undefined;
}

// Return type of a Fortran function. Three forms, in priority order:
//   1. Prefix type:        `INTEGER FUNCTION foo(...)`         → intrinsic_type/derived_type sibling of `name` on function_statement
//   2. RESULT clause:      `FUNCTION foo(...) RESULT(r)` + `INTEGER :: r` in body → declared type of `r`
//   3. Implicit:           `FUNCTION foo(...)` with `INTEGER :: foo` in body → declared type of `foo` itself
function functionReturnType(
  stmt: SyntaxNode | null,
  wrapper: SyntaxNode,
  fname: string,
  src: string,
): string | undefined {
  if (!stmt) return undefined;
  // Form 1 — prefix type on the function_statement itself
  for (const c of stmt.namedChildren) {
    if (!c) continue;
    if (c.type === 'intrinsic_type' || c.type === 'derived_type') {
      return norm(getNodeText(c, src));
    }
  }
  // Form 2 — RESULT clause names a different return variable
  let resultName: string | undefined;
  const resultClause = findChild(stmt, 'function_result');
  if (resultClause) {
    const id = findChild(resultClause, 'identifier');
    if (id) resultName = norm(getNodeText(id, src));
  }
  // Form 3 — fall back to a body declaration of the function name itself
  return declaredTypeOf(wrapper, resultName ?? fname, src);
}

// Collect the type qualifiers off a variable_declaration (lowercased, trimmed).
// E.g. `INTEGER, PARAMETER, PUBLIC :: X` → ['parameter', 'public'].
function typeQualifiers(decl: SyntaxNode, src: string): string[] {
  const out: string[] = [];
  for (const c of decl.namedChildren) {
    if (c?.type === 'type_qualifier') out.push(getNodeText(c, src).trim().toLowerCase());
  }
  return out;
}

// Walk a variable_declaration and yield one record per declared name. Each
// record carries the name, a position node, and (for `init_declarator`) the
// initialiser text — used as the value of PARAMETER constants.
function eachDeclaredEntry(
  decl: SyntaxNode,
  src: string,
): Array<{ name: string; node: SyntaxNode; value?: string }> {
  const out: Array<{ name: string; node: SyntaxNode; value?: string }> = [];
  for (const c of decl.namedChildren) {
    if (!c) continue;
    const id = declaratorName(c);
    if (!id) continue;
    // Only `init_declarator` carries an initialiser. The init expression is
    // always the second named child — the first slot is whatever declarator
    // form the name is in (bare identifier, or sized_declarator wrapping it).
    let value: string | undefined;
    if (c.type === 'init_declarator') {
      const valueNode = c.namedChild(1);
      if (valueNode) value = getNodeText(valueNode, src).trim();
    }
    out.push({ name: norm(getNodeText(id, src)), node: id, value });
  }
  return out;
}

function addRef(
  node: SyntaxNode,
  name: string,
  kind: 'calls' | 'imports' | 'extends',
  ctx: ExtractorContext,
): void {
  if (!name) return;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return; // skip refs that have no enclosing scope (e.g. file-level junk)
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    filePath: ctx.filePath,
  });
}

export const fortranExtractor: LanguageExtractor = {
  // All dispatch happens in visitNode below — we drive the AST ourselves
  // because the tree-sitter-fortran grammar models each declaration as a
  // header `*_statement` (which carries the name) plus body children that
  // live as siblings inside the wrapping `module` / `subroutine` / `function`
  // node. Default dispatch assumes name+body share a single node, so we opt out.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const src = ctx.source;

    switch (node.type) {
      case 'translation_unit': {
        // Clear per-file state at every file boundary so a crash mid-walk
        // on a previous file can't leak state into the next one.
        moduleFrames.length = 0;
        scopeKinds.length = 0;
        return false; // let the default walker descend into children
      }

      case 'module':
      case 'submodule': {
        const headerType = node.type === 'module' ? 'module_statement' : 'submodule_statement';
        const stmt = findChild(node, headerType);
        const name = statementName(stmt, src);
        const created = ctx.createNode('module', name || '<anonymous>', node);
        // Only top-level modules carry access statements; submodules inherit
        // visibility from the parent module's interface section, which we
        // don't try to resolve here.
        const frame = node.type === 'module' ? buildModuleFrame(node, src) : null;
        if (frame) moduleFrames.push(frame);
        if (created) {
          ctx.pushScope(created.id);
          scopeKinds.push('module');
        }
        visitBody(node, headerType, ctx);
        if (created) {
          scopeKinds.pop();
          ctx.popScope();
        }
        if (frame) moduleFrames.pop();
        return true;
      }

      case 'program': {
        const stmt = findChild(node, 'program_statement');
        const name = statementName(stmt, src) || 'MAIN';
        const created = ctx.createNode('module', name, node);
        if (created) {
          ctx.pushScope(created.id);
          scopeKinds.push('module');
        }
        visitBody(node, 'program_statement', ctx);
        if (created) {
          scopeKinds.pop();
          ctx.popScope();
        }
        return true;
      }

      case 'subroutine':
      case 'function': {
        const headerType = node.type === 'subroutine' ? 'subroutine_statement' : 'function_statement';
        const stmt = findChild(node, headerType);
        const name = statementName(stmt, src);
        if (!name) return true; // malformed — skip but don't recurse
        const params = stmt ? stmt.childForFieldName('parameters') : null;
        const paramsText = params ? getNodeText(params, src) : '';
        // Return type only applies to functions. Compose `(params) -> TYPE` so
        // the signature carries the full call-site shape at a glance.
        let signature: string | undefined;
        if (node.type === 'function') {
          const returnType = functionReturnType(stmt, node, name, src);
          const head = paramsText || '()';
          signature = returnType ? `${head} -> ${returnType}` : head;
        } else {
          signature = paramsText || undefined;
        }
        // Resolve visibility:
        //   in module          → module's resolver (default + per-symbol)
        //   top-level (no scope) → `public` — external routines are globally callable
        //   nested in program / parent routine's CONTAINS → `private` to the enclosing unit
        // The file scope is always at the bottom of nodeStack, so length === 1
        // means "no Fortran scope above me".
        let visibility = currentModuleVisibility(name);
        if (visibility === undefined) {
          visibility = ctx.nodeStack.length <= 1 ? 'public' : 'private';
        }
        const created = ctx.createNode('function', name, node, { signature, visibility });
        if (created) {
          ctx.pushScope(created.id);
          scopeKinds.push('function');
          // Emit a `parameter` node per declared argument, with the declared
          // type ("INTEGER", "REAL", "TYPE(FOO)", …) in `signature`. The type
          // comes from a `variable_declaration` in the routine's body, since
          // Fortran declares the parameter list and the parameter types
          // separately.
          if (params) {
            for (const p of params.namedChildren) {
              if (!p || p.type !== 'identifier') continue;
              const pname = norm(getNodeText(p, src));
              const ptype = declaredTypeOf(node, pname, src);
              ctx.createNode('parameter', pname, p, { signature: ptype });
            }
          }
          visitBody(node, headerType, ctx);
          scopeKinds.pop();
          ctx.popScope();
        }
        return true;
      }

      case 'derived_type_definition': {
        const stmt = findChild(node, 'derived_type_statement');
        const name = statementName(stmt, src);
        // Inline `access_specifier` on `TYPE, PUBLIC :: …` wins; otherwise
        // fall back to the enclosing module's resolved visibility for `name`.
        let visibility: 'public' | 'private' | undefined;
        if (stmt) {
          const accessSpec = findChild(stmt, 'access_specifier');
          if (accessSpec) {
            const text = getNodeText(accessSpec, src).trim().toLowerCase();
            if (text === 'public' || text === 'private') visibility = text;
          }
        }
        if (!visibility) visibility = currentModuleVisibility(name);
        const created = ctx.createNode('struct', name || '<anonymous>', node, { visibility });
        // Capture `EXTENDS(Parent)` as an `extends` reference.
        if (created && stmt) {
          const base = stmt.childForFieldName('base');
          if (base) {
            const baseIdent = findChild(base, 'identifier') ?? base;
            addRef(baseIdent, norm(getNodeText(baseIdent, src)), 'extends', ctx);
          }
        }
        if (created) {
          ctx.pushScope(created.id);
          scopeKinds.push('struct');
        }
        visitBody(node, 'derived_type_statement', ctx);
        if (created) {
          scopeKinds.pop();
          ctx.popScope();
        }
        return true;
      }

      case 'interface': {
        const stmt = findChild(node, 'interface_statement');
        // Generic interfaces have a name (`INTERFACE SOLVE`); abstract /
        // explicit-interface blocks are anonymous — index them as a container
        // anyway so the procedures inside still belong to *something*.
        const ifaceName = statementName(stmt, src);
        const name = ifaceName || '<anonymous-interface>';
        const visibility = ifaceName ? currentModuleVisibility(ifaceName) : undefined;
        const created = ctx.createNode('interface', name, node, { visibility });
        if (created) {
          ctx.pushScope(created.id);
          scopeKinds.push('interface');
        }
        visitBody(node, 'interface_statement', ctx);
        if (created) {
          scopeKinds.pop();
          ctx.popScope();
        }
        return true;
      }

      case 'variable_declaration': {
        // Only emit symbols when the declaration is the public/private surface
        // of a module or the field list of a derived type. Inside a routine
        // body these are local variables / parameter type specs and we don't
        // surface them as graph nodes.
        const scope = currentScopeKind();
        if (scope !== 'module' && scope !== 'struct') return true;

        const typeNode = node.namedChildren.find(
          (n) => n?.type === 'intrinsic_type' || n?.type === 'derived_type',
        );
        const declaredType = typeNode ? norm(getNodeText(typeNode, src)) : undefined;
        const qualifiers = typeQualifiers(node, src);
        const isParameter = qualifiers.includes('parameter');
        const inlineVisibility: 'public' | 'private' | undefined = qualifiers.includes('private')
          ? 'private'
          : qualifiers.includes('public')
          ? 'public'
          : undefined;

        const kind: NodeKind =
          scope === 'struct' ? 'field' : isParameter ? 'constant' : 'variable';

        for (const entry of eachDeclaredEntry(node, src)) {
          // For module-level decls visibility resolves through the module
          // frame (inline qualifier wins, else the per-symbol/default
          // resolver). For struct fields the default is public; an inline
          // qualifier overrides.
          const visibility =
            inlineVisibility ??
            (scope === 'module' ? currentModuleVisibility(entry.name) : 'public');
          // Pack the value into the signature for PARAMETER constants — the
          // value is part of what defines the constant.
          const signature =
            entry.value !== undefined && isParameter
              ? declaredType
                ? `${declaredType} = ${entry.value}`
                : `= ${entry.value}`
              : declaredType;
          ctx.createNode(kind, entry.name, entry.node, { signature, visibility });
        }
        return true;
      }

      case 'procedure_statement': {
        // Type-bound procedure: `PROCEDURE :: APPEND => APPEND_INT` inside a
        // derived-type CONTAINS section. The method NAME is the LHS of the
        // binding (here: APPEND); the RHS points at the implementing routine
        // (APPEND_INT) which we emit as a `calls`-style reference so callers
        // of the method can be found.
        const declarator = node.childForFieldName('declarator');
        if (!declarator) return true;

        let methodName = '';
        let target = '';
        if (declarator.type === 'binding') {
          const binding = findChild(declarator, 'binding_name');
          const targetNode = findChild(declarator, 'method_name');
          if (binding) methodName = norm(getNodeText(binding, src));
          if (targetNode) target = norm(getNodeText(targetNode, src));
        } else if (declarator.type === 'method_name') {
          // `PROCEDURE :: SIZE` (no rename — name and target are identical)
          methodName = norm(getNodeText(declarator, src));
          target = methodName;
        }
        if (!methodName) return true;

        const created = ctx.createNode('method', methodName, node);
        if (created && target && target !== methodName) {
          // Bind the implementing routine inside the method's own scope so it
          // doesn't get attributed to the enclosing type.
          ctx.pushScope(created.id);
          addRef(node, target, 'calls', ctx);
          ctx.popScope();
        }
        return true;
      }

      case 'use_statement': {
        const modNode = findChild(node, 'module_name');
        if (modNode) addRef(modNode, norm(getNodeText(modNode, src)), 'imports', ctx);
        return true; // a USE has no callable body
      }

      case 'subroutine_call': {
        const callee = node.childForFieldName('subroutine');
        if (callee) addRef(callee, norm(getNodeText(callee, src)), 'calls', ctx);
        // Recurse into argument_list — nested calls in args matter too.
        for (const c of node.namedChildren) {
          if (c && c.type === 'argument_list') ctx.visitNode(c);
        }
        return true;
      }

      case 'call_expression': {
        // `call_expression` has no `function` field — the callee is the first
        // identifier child, the rest is the argument_list.
        const ident = findChild(node, 'identifier');
        if (ident) addRef(ident, norm(getNodeText(ident, src)), 'calls', ctx);
        for (const c of node.namedChildren) {
          if (c && c.type === 'argument_list') ctx.visitNode(c);
        }
        return true;
      }

      default:
        return false; // let the default walker recurse into children
    }
  },
};
