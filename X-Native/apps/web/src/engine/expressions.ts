/**
 * Expressions & Reactive Dependency Graph (Phase 0/4 Foundation)
 *
 * Pipeline:
 * Expression String → Tokenizer → Parser → AST → Dependency Extraction → Dependency Graph (Cycle Detection) → Evaluator
 *
 * Example: `parent.w * 0.5 + spacing`
 * Dependency Graph detects cycles (e.g. A.w -> B.w -> A.w) and rejects them
 * before execution.
 */

// ---------------------------------------------------------------- Tokens & AST

export type TokenType =
  | "NUMBER"
  | "STRING"
  | "IDENTIFIER"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "CARET"
  | "DOT"
  | "COMMA"
  | "LPAREN"
  | "RPAREN"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type ASTNode =
  | { type: "Number"; value: number }
  | { type: "String"; value: string }
  | { type: "Identifier"; name: string }
  | { type: "MemberAccess"; object: ASTNode; property: string }
  | { type: "Binary"; op: string; left: ASTNode; right: ASTNode }
  | { type: "Unary"; op: string; operand: ASTNode }
  | { type: "Call"; callee: string; args: ASTNode[] };

// ---------------------------------------------------------------- Tokenizer

export function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/\d/.test(ch) || (ch === "." && /\d/.test(input[i + 1] || ""))) {
      const start = i;
      let hasDot = false;
      while (i < input.length && (/[\d]/.test(input[i]) || (!hasDot && input[i] === "."))) {
        if (input[i] === ".") hasDot = true;
        i++;
      }
      tokens.push({ type: "NUMBER", value: input.slice(start, i), pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let str = "";
      while (i < input.length && input[i] !== quote) {
        str += input[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: "STRING", value: str, pos: start });
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i])) {
        i++;
      }
      tokens.push({ type: "IDENTIFIER", value: input.slice(start, i), pos: start });
      continue;
    }

    switch (ch) {
      case "+":
        tokens.push({ type: "PLUS", value: "+", pos: i++ });
        break;
      case "-":
        tokens.push({ type: "MINUS", value: "-", pos: i++ });
        break;
      case "*":
        tokens.push({ type: "STAR", value: "*", pos: i++ });
        break;
      case "/":
        tokens.push({ type: "SLASH", value: "/", pos: i++ });
        break;
      case "%":
        tokens.push({ type: "PERCENT", value: "%", pos: i++ });
        break;
      case "^":
        tokens.push({ type: "CARET", value: "^", pos: i++ });
        break;
      case ".":
        tokens.push({ type: "DOT", value: ".", pos: i++ });
        break;
      case ",":
        tokens.push({ type: "COMMA", value: ",", pos: i++ });
        break;
      case "(":
        tokens.push({ type: "LPAREN", value: "(", pos: i++ });
        break;
      case ")":
        tokens.push({ type: "RPAREN", value: ")", pos: i++ });
        break;
      default:
        throw new Error(`Unexpected character '${ch}' at index ${i}`);
    }
  }

  tokens.push({ type: "EOF", value: "", pos: i });
  return tokens;
}

// ---------------------------------------------------------------- Parser

export class ExpressionParser {
  private tokens: Token[];
  private current = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.current] || { type: "EOF", value: "", pos: -1 };
  }

  private advance(): Token {
    const token = this.peek();
    if (this.current < this.tokens.length - 1) this.current++;
    return token;
  }

  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  public parse(): ASTNode {
    const ast = this.parseExpression();
    if (this.peek().type !== "EOF") {
      throw new Error(`Unexpected token '${this.peek().value}' after expression at ${this.peek().pos}`);
    }
    return ast;
  }

  private parseExpression(): ASTNode {
    return this.parseAdditive();
  }

  private parseAdditive(): ASTNode {
    let left = this.parseMultiplicative();
    while (this.peek().type === "PLUS" || this.peek().type === "MINUS") {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): ASTNode {
    let left = this.parseExponent();
    while (
      this.peek().type === "STAR" ||
      this.peek().type === "SLASH" ||
      this.peek().type === "PERCENT"
    ) {
      const op = this.advance().value;
      const right = this.parseExponent();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  private parseExponent(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === "CARET") {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === "MINUS" || this.peek().type === "PLUS") {
      const op = this.advance().value;
      const operand = this.parseUnary();
      return { type: "Unary", op, operand };
    }
    return this.parseMemberOrCall();
  }

  private parseMemberOrCall(): ASTNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.match("DOT")) {
        const propToken = this.advance();
        if (propToken.type !== "IDENTIFIER") {
          throw new Error(`Expected property identifier after '.' at ${propToken.pos}`);
        }
        expr = { type: "MemberAccess", object: expr, property: propToken.value };
      } else if (this.match("LPAREN")) {
        if (expr.type !== "Identifier") {
          throw new Error(`Call target must be an identifier at ${this.peek().pos}`);
        }
        const args: ASTNode[] = [];
        if (this.peek().type !== "RPAREN") {
          do {
            args.push(this.parseExpression());
          } while (this.match("COMMA"));
        }
        if (!this.match("RPAREN")) {
          throw new Error(`Expected ')' closing call at ${this.peek().pos}`);
        }
        expr = { type: "Call", callee: expr.name, args };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): ASTNode {
    const token = this.peek();

    if (token.type === "NUMBER") {
      this.advance();
      return { type: "Number", value: parseFloat(token.value) };
    }

    if (token.type === "STRING") {
      this.advance();
      return { type: "String", value: token.value };
    }

    if (token.type === "IDENTIFIER") {
      this.advance();
      return { type: "Identifier", name: token.value };
    }

    if (this.match("LPAREN")) {
      const inner = this.parseExpression();
      if (!this.match("RPAREN")) {
        throw new Error(`Unclosed parenthesis at ${this.peek().pos}`);
      }
      return inner;
    }

    throw new Error(`Unexpected token '${token.value}' (${token.type}) at ${token.pos}`);
  }
}

export function parseExpression(expr: string): ASTNode {
  const tokens = tokenizeExpression(expr);
  const parser = new ExpressionParser(tokens);
  return parser.parse();
}

// ---------------------------------------------------------------- Dependencies

export function extractDependencies(node: ASTNode): string[] {
  const deps: Set<string> = new Set();

  function walk(n: ASTNode): void {
    if (n.type === "Identifier") {
      deps.add(n.name);
    } else if (n.type === "MemberAccess") {
      // E.g., parent.w or var.spacing
      if (n.object.type === "Identifier") {
        deps.add(`${n.object.name}.${n.property}`);
      } else {
        walk(n.object);
      }
    } else if (n.type === "Binary") {
      walk(n.left);
      walk(n.right);
    } else if (n.type === "Unary") {
      walk(n.operand);
    } else if (n.type === "Call") {
      for (const arg of n.args) walk(arg);
    }
  }

  walk(node);
  return Array.from(deps);
}

// ---------------------------------------------------------------- Dependency Graph & Cycle Detection

export interface CycleDiagnostic {
  hasCycle: boolean;
  cycle: string[];
}

export class DependencyGraph {
  // Directed edge: A -> [B, C] means A depends on B and C
  private edges: Map<string, Set<string>> = new Map();

  public addDependency(fromKey: string, toKey: string): void {
    if (!this.edges.has(fromKey)) {
      this.edges.set(fromKey, new Set());
    }
    this.edges.get(fromKey)!.add(toKey);
  }

  public removeDependencies(key: string): void {
    this.edges.delete(key);
  }

  /**
   * Detects if adding fromKey -> toKey would introduce a cycle.
   */
  public detectCycle(startKey?: string): CycleDiagnostic {
    const visited = new Set<string>();
    const recStack: string[] = [];

    const nodes = startKey ? [startKey] : Array.from(this.edges.keys());

    for (const node of nodes) {
      const cycle = this.dfsCheck(node, visited, recStack);
      if (cycle) {
        return { hasCycle: true, cycle };
      }
    }

    return { hasCycle: false, cycle: [] };
  }

  private dfsCheck(
    node: string,
    visited: Set<string>,
    recStack: string[],
  ): string[] | null {
    if (recStack.includes(node)) {
      const idx = recStack.indexOf(node);
      return [...recStack.slice(idx), node];
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    recStack.push(node);

    const neighbors = this.edges.get(node);
    if (neighbors) {
      for (const next of neighbors) {
        const cycle = this.dfsCheck(next, visited, recStack);
        if (cycle) return cycle;
      }
    }

    recStack.pop();
    return null;
  }

  /**
   * Returns a valid topological evaluation order for computed properties.
   */
  public topologicalSort(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    for (const node of this.edges.keys()) {
      if (!visited.has(node)) {
        this.dfsSort(node, visited, order);
      }
    }

    return order;
  }

  private dfsSort(node: string, visited: Set<string>, order: string[]): void {
    visited.add(node);
    const neighbors = this.edges.get(node);
    if (neighbors) {
      for (const next of neighbors) {
        if (!visited.has(next)) {
          this.dfsSort(next, visited, order);
        }
      }
    }
    order.push(node);
  }
}

// ---------------------------------------------------------------- Evaluator

export interface EvaluationContext {
  vars?: Record<string, any>;
  self?: Record<string, any>;
  parent?: Record<string, any>;
  getNode?: (id: string) => any;
}

const BUILTIN_FUNCS: Record<string, (...args: any[]) => any> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  pow: Math.pow,
  sin: Math.sin,
  cos: Math.cos,
  clamp: (val: number, min: number, max: number) => Math.min(Math.max(val, min), max),
};

export function evaluateAST(node: ASTNode, ctx: EvaluationContext): any {
  switch (node.type) {
    case "Number":
      return node.value;

    case "String":
      return node.value;

    case "Identifier": {
      const id = node.name;
      // Check self properties first
      if (ctx.self && id in ctx.self) return ctx.self[id];
      // Check global vars
      if (ctx.vars && id in ctx.vars) return ctx.vars[id];
      // Check math constants
      if (id === "PI") return Math.PI;
      if (id === "E") return Math.E;
      return 0;
    }

    case "MemberAccess": {
      const obj = evaluateAST(node.object, ctx);
      if (node.object.type === "Identifier") {
        const root = node.object.name;
        if (root === "parent" && ctx.parent) {
          return ctx.parent[node.property] ?? 0;
        }
        if (root === "var" && ctx.vars) {
          return ctx.vars[node.property] ?? 0;
        }
        if (root === "self" && ctx.self) {
          return ctx.self[node.property] ?? 0;
        }
      }
      if (obj && typeof obj === "object") {
        return obj[node.property] ?? 0;
      }
      return 0;
    }

    case "Binary": {
      const l = evaluateAST(node.left, ctx);
      const r = evaluateAST(node.right, ctx);
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r === 0 ? 0 : l / r;
        case "%":
          return l % r;
        case "^":
          return Math.pow(l, r);
        default:
          throw new Error(`Unsupported binary operator ${node.op}`);
      }
    }

    case "Unary": {
      const val = evaluateAST(node.operand, ctx);
      if (node.op === "-") return -val;
      if (node.op === "+") return +val;
      return val;
    }

    case "Call": {
      const fn = BUILTIN_FUNCS[node.callee];
      if (!fn) {
        if (node.callee === "node" && ctx.getNode && node.args.length === 1) {
          const targetId = evaluateAST(node.args[0], ctx);
          return ctx.getNode(targetId);
        }
        throw new Error(`Unknown function '${node.callee}'`);
      }
      const evalArgs = node.args.map((arg) => evaluateAST(arg, ctx));
      return fn(...evalArgs);
    }
  }
}

/**
 * Full evaluation helper: parses, checks cycles, and evaluates expression string.
 */
export function evaluateExpression(
  exprStr: string,
  ctx: EvaluationContext,
  graph?: DependencyGraph,
  targetKey?: string,
): { value: any; dependencies: string[]; error?: string } {
  try {
    const ast = parseExpression(exprStr);
    const deps = extractDependencies(ast);

    if (graph && targetKey) {
      for (const d of deps) {
        graph.addDependency(targetKey, d);
      }
      const cycle = graph.detectCycle(targetKey);
      if (cycle.hasCycle) {
        return {
          value: 0,
          dependencies: deps,
          error: `Cycle detected: ${cycle.cycle.join(" -> ")}`,
        };
      }
    }

    const value = evaluateAST(ast, ctx);
    return { value, dependencies: deps };
  } catch (err: any) {
    return {
      value: 0,
      dependencies: [],
      error: err.message || String(err),
    };
  }
}
