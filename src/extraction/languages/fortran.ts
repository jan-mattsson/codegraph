import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

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

// Names declared on the LHS of a `variable_declaration`. Direct `identifier`
// children are simple names (`INTEGER :: A, B`); `sized_declarator` and
// `init_declarator` wrap a name plus a size/initialiser (`INTEGER :: A(N)`),
// in which case the first identifier child is the variable name. We
// deliberately ignore identifiers nested deeper (e.g. `N` inside `A(N)`)
// because those are references, not declarations.
function declaredNames(decl: SyntaxNode, src: string): string[] {
  const names: string[] = [];
  for (const c of decl.namedChildren) {
    if (!c) continue;
    if (c.type === 'identifier') {
      names.push(norm(getNodeText(c, src)));
    } else if (c.type === 'sized_declarator' || c.type === 'init_declarator') {
      for (const cc of c.namedChildren) {
        if (cc?.type === 'identifier') {
          names.push(norm(getNodeText(cc, src)));
          break;
        }
      }
    }
  }
  return names;
}

// For a given parameter name, return the declared type ("INTEGER", "REAL",
// "TYPE(FOO)" …) by scanning the subroutine/function wrapper's
// `variable_declaration` children. Returns undefined if the parameter has no
// explicit declaration (e.g. implicit typing).
function parameterType(wrapper: SyntaxNode, pname: string, src: string): string | undefined {
  for (const c of wrapper.namedChildren) {
    if (!c || c.type !== 'variable_declaration') continue;
    if (!declaredNames(c, src).includes(pname)) continue;
    const typeNode = c.namedChildren.find(
      (n) => n?.type === 'intrinsic_type' || n?.type === 'derived_type',
    );
    if (typeNode) return norm(getNodeText(typeNode, src));
  }
  return undefined;
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
        // Clear the visibility stack at every file boundary so a crash mid-
        // walk on a previous file can't leak state into the next one.
        moduleFrames.length = 0;
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
        if (created) ctx.pushScope(created.id);
        visitBody(node, headerType, ctx);
        if (created) ctx.popScope();
        if (frame) moduleFrames.pop();
        return true;
      }

      case 'program': {
        const stmt = findChild(node, 'program_statement');
        const name = statementName(stmt, src) || 'MAIN';
        const created = ctx.createNode('module', name, node);
        if (created) ctx.pushScope(created.id);
        visitBody(node, 'program_statement', ctx);
        if (created) ctx.popScope();
        return true;
      }

      case 'subroutine':
      case 'function': {
        const headerType = node.type === 'subroutine' ? 'subroutine_statement' : 'function_statement';
        const stmt = findChild(node, headerType);
        const name = statementName(stmt, src);
        if (!name) return true; // malformed — skip but don't recurse
        const params = stmt ? stmt.childForFieldName('parameters') : null;
        const signature = params ? getNodeText(params, src) : undefined;
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
          // Emit a `parameter` node per declared argument, with the declared
          // type ("INTEGER", "REAL", "TYPE(FOO)", …) in `signature`. The type
          // comes from a `variable_declaration` in the routine's body, since
          // Fortran declares the parameter list and the parameter types
          // separately.
          if (params) {
            for (const p of params.namedChildren) {
              if (!p || p.type !== 'identifier') continue;
              const pname = norm(getNodeText(p, src));
              const ptype = parameterType(node, pname, src);
              ctx.createNode('parameter', pname, p, { signature: ptype });
            }
          }
          visitBody(node, headerType, ctx);
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
        if (created) ctx.pushScope(created.id);
        visitBody(node, 'derived_type_statement', ctx);
        if (created) ctx.popScope();
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
        if (created) ctx.pushScope(created.id);
        visitBody(node, 'interface_statement', ctx);
        if (created) ctx.popScope();
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
