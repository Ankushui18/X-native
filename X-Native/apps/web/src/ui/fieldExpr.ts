/**
 * Equations in numeric fields.
 *
 * Figma lets you type arithmetic into the X, Y, W, H, rotation, font-size and
 * similar fields instead of a bare number: `120/3`, `2^3`, `(40+8)*2`. On top of
 * that, an expression that *starts* with an operator is applied to the value
 * already in the field (`+10` means "10 more than now") and one that *ends* with
 * an operator takes the current value as its left operand (`*2` doubles it). The
 * panel has had plain `parseFloat` forever, which silently turned `120/3` into
 * `120`, so the whole feature lives here as a pure function: the field commits
 * whatever this returns, and null means "not an expression, revert".
 */

const NUM = /^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** True when the text contains anything that has to be evaluated rather than
 *  read as a number. A leading minus is a sign, not an operator. */
export function hasExpression(raw: string): boolean {
  const t = raw.trim();
  if (!t || NUM.test(t)) return false;
  if (t.endsWith("%")) return true;
  return /[+\-*/^()]/.test(t.slice(t[0] === "-" ? 1 : 0));
}

/**
 * Evaluate `raw` against the field's current value. Returns a finite number or
 * null. Division by zero, an unbalanced parenthesis, or a trailing operator with
 * nothing to combine with all yield null, so the field keeps its old value
 * instead of writing NaN into the document.
 */
export function evalField(raw: string, current: number): number | null {
  let t = raw.trim();
  if (!t) return null;
  if (t.endsWith("%")) {
    const pct = parseFloat(t.slice(0, -1));
    return Number.isFinite(pct) ? (current * pct) / 100 : null;
  }
  if (NUM.test(t)) {
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
  }
  // No operators at all: keep the field's old leniency, where "120px" and
  // "120 (auto)" both mean 120.
  if (!hasExpression(t)) {
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : null;
  }
  // "starts/end with an operator" combines with what is already in the field.
  if (/^[+\-*/^]/.test(t)) t = `${num(current)}${t}`;
  else if (/[+\-*/^]$/.test(t)) t = `${t}${num(current)}`;
  const p = new Parser(t);
  const v = p.expr();
  if (!p.ok || !p.atEnd() || !Number.isFinite(v)) return null;
  return v;
}

const num = (v: number): string => (Number.isFinite(v) ? String(v) : "0");

class Parser {
  ok = true;
  private i = 0;
  constructor(private readonly s: string) {}

  atEnd(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private peek(): string {
    this.ws();
    return this.s[this.i] ?? "";
  }

  /** expr := term (('+' | '-') term)* */
  expr(): number {
    let v = this.term();
    for (;;) {
      const c = this.peek();
      if (c !== "+" && c !== "-") return v;
      this.i++;
      const r = this.term();
      v = c === "+" ? v + r : v - r;
    }
  }

  /** term := unary (('*' | '/') unary)* */
  private term(): number {
    let v = this.unary();
    for (;;) {
      const c = this.peek();
      if (c !== "*" && c !== "/") return v;
      this.i++;
      const r = this.unary();
      if (c === "/") {
        if (r === 0) {
          this.ok = false;
          return NaN;
        }
        v /= r;
      } else v *= r;
    }
  }

  /** unary := ('-' | '+') unary | power */
  private unary(): number {
    const c = this.peek();
    if (c === "-") {
      this.i++;
      return -this.unary();
    }
    if (c === "+") {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  /** power := primary ('^' unary)?  — right associative, and `2^3^2` is 512 */
  private power(): number {
    const base = this.primary();
    if (this.peek() === "^") {
      this.i++;
      const e = this.unary();
      return Math.pow(base, e);
    }
    return base;
  }

  private primary(): number {
    const c = this.peek();
    if (c === "(") {
      this.i++;
      const v = this.expr();
      if (this.peek() !== ")") {
        this.ok = false;
        return NaN;
      }
      this.i++;
      return v;
    }
    const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) {
      this.ok = false;
      return NaN;
    }
    this.i += m[0].length;
    return Number(m[0]);
  }
}
