// ============================================================
//  불확도 전파 계산 엔진
//  1) 토크나이저   : 수식 문자열 -> 토큰 목록
//  2) 파서         : 재귀 하강 파싱으로 토큰 -> 계산 트리(AST)
//  3) 자동 미분    : 계산 트리를 한 번 순회하며 값과 편미분을 동시에 계산
//  4) 불확도 전파  : u_c = sqrt( sum( (df/dxi * u_i)^2 ) )
// ============================================================

// ---------- 1. 토크나이저 ----------
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // 지수 표기 1.5e-3
      if (j < src.length && /[eE]/.test(src[j]) && /[0-9+\-]/.test(src[j + 1] || '')) {
        j++;
        if (/[+\-]/.test(src[j])) j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      if (isNaN(Number(text))) throw new Error(`잘못된 숫자: ${text}`);
      tokens.push({ type: 'num', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_가-힣]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_가-힣]/.test(src[j])) j++;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      tokens.push({ type: c });
      i++;
      continue;
    }
    throw new Error(`알 수 없는 문자: '${c}'`);
  }
  tokens.push({ type: 'end' });
  return tokens;
}

// ---------- 2. 재귀 하강 파서 ----------
// 문법 (우선순위가 낮은 것부터)
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/') unary)*
//   unary  := ('-')? power
//   power  := atom ('^' unary)?        <- 거듭제곱은 오른쪽 결합
//   atom   := number | name | name '(' expr ')' | '(' expr ')'

const FUNCTIONS = ['sin', 'cos', 'tan', 'exp', 'ln', 'log', 'sqrt', 'abs', 'asin', 'acos', 'atan'];
const CONSTANTS = { pi: Math.PI, e: Math.E };

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    if (peek().type !== type) throw new Error(`'${type}' 가 필요한데 찾지 못했습니다`);
    return next();
  };

  function expr() {
    let node = term();
    while (peek().type === '+' || peek().type === '-') {
      const op = next().type;
      node = { kind: 'binary', op, left: node, right: term() };
    }
    return node;
  }

  function term() {
    let node = unary();
    while (peek().type === '*' || peek().type === '/') {
      const op = next().type;
      node = { kind: 'binary', op, left: node, right: unary() };
    }
    return node;
  }

  function unary() {
    if (peek().type === '-') {
      next();
      return { kind: 'neg', operand: unary() };
    }
    if (peek().type === '+') { next(); return unary(); }
    return power();
  }

  function power() {
    const base = atom();
    if (peek().type === '^') {
      next();
      return { kind: 'binary', op: '^', left: base, right: unary() };
    }
    return base;
  }

  function atom() {
    const t = peek();
    if (t.type === 'num') { next(); return { kind: 'const', value: t.value }; }
    if (t.type === 'name') {
      next();
      if (peek().type === '(') {
        if (!FUNCTIONS.includes(t.value)) throw new Error(`모르는 함수: ${t.value}`);
        next();
        const arg = expr();
        expect(')');
        return { kind: 'call', name: t.value, arg };
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, t.value)) {
        return { kind: 'const', value: CONSTANTS[t.value], label: t.value };
      }
      return { kind: 'var', name: t.value };
    }
    if (t.type === '(') {
      next();
      const node = expr();
      expect(')');
      return node;
    }
    throw new Error('수식이 중간에 끊겼습니다');
  }

  const root = expr();
  if (peek().type !== 'end') throw new Error('수식 뒤에 해석할 수 없는 부분이 있습니다');
  return root;
}

// 트리에 등장하는 변수 이름 수집 (등장 순서 유지)
function collectVars(node, out = []) {
  if (node.kind === 'var') { if (!out.includes(node.name)) out.push(node.name); }
  else if (node.kind === 'binary') { collectVars(node.left, out); collectVars(node.right, out); }
  else if (node.kind === 'neg') collectVars(node.operand, out);
  else if (node.kind === 'call') collectVars(node.arg, out);
  return out;
}

// ---------- 3. 전진 모드 자동 미분 ----------
// 각 노드에서 { v: 값, d: [∂/∂x1, ∂/∂x2, ...] } 를 함께 계산한다.
// 트리를 한 번만 순회하면 모든 변수의 편미분이 동시에 나온다.

const zeros = (n) => new Array(n).fill(0);
const mapD = (d, f) => d.map(f);

function evalAD(node, values, vars) {
  const n = vars.length;
  switch (node.kind) {
    case 'const':
      return { v: node.value, d: zeros(n) };

    case 'var': {
      const idx = vars.indexOf(node.name);
      const d = zeros(n);
      d[idx] = 1;                       // 자기 자신에 대한 미분은 1, 나머지는 0
      return { v: values[node.name], d };
    }

    case 'neg': {
      const a = evalAD(node.operand, values, vars);
      return { v: -a.v, d: mapD(a.d, (x) => -x) };
    }

    case 'binary': {
      const a = evalAD(node.left, values, vars);
      const b = evalAD(node.right, values, vars);
      switch (node.op) {
        case '+':
          return { v: a.v + b.v, d: a.d.map((x, i) => x + b.d[i]) };
        case '-':
          return { v: a.v - b.v, d: a.d.map((x, i) => x - b.d[i]) };
        case '*':
          // 곱의 미분법: (uv)' = u'v + uv'
          return { v: a.v * b.v, d: a.d.map((x, i) => x * b.v + a.v * b.d[i]) };
        case '/':
          // 몫의 미분법: (u/v)' = (u'v - uv') / v^2
          if (b.v === 0) throw new Error('0으로 나눌 수 없습니다');
          return {
            v: a.v / b.v,
            d: a.d.map((x, i) => (x * b.v - a.v * b.d[i]) / (b.v * b.v)),
          };
        case '^': {
          // 일반형: (u^v)' = u^v * ( v' * ln u + v * u'/u )
          const v = Math.pow(a.v, b.v);
          const bIsConst = b.d.every((x) => x === 0);
          if (bIsConst) {
            // 지수가 상수면 간단히: (u^n)' = n * u^(n-1) * u'
            const coef = b.v * Math.pow(a.v, b.v - 1);
            return { v, d: a.d.map((x) => coef * x) };
          }
          if (a.v <= 0) throw new Error('밑이 0 이하인 거듭제곱은 미분할 수 없습니다');
          return {
            v,
            d: a.d.map((x, i) => v * (b.d[i] * Math.log(a.v) + (b.v * x) / a.v)),
          };
        }
        default:
          throw new Error(`모르는 연산자: ${node.op}`);
      }
    }

    case 'call': {
      const a = evalAD(node.arg, values, vars);
      // 연쇄법칙: f(g(x))' = f'(g(x)) * g'(x)
      let v, dfdx;
      switch (node.name) {
        case 'sin':  v = Math.sin(a.v);  dfdx = Math.cos(a.v); break;
        case 'cos':  v = Math.cos(a.v);  dfdx = -Math.sin(a.v); break;
        case 'tan':  v = Math.tan(a.v);  dfdx = 1 / (Math.cos(a.v) ** 2); break;
        case 'asin': v = Math.asin(a.v); dfdx = 1 / Math.sqrt(1 - a.v * a.v); break;
        case 'acos': v = Math.acos(a.v); dfdx = -1 / Math.sqrt(1 - a.v * a.v); break;
        case 'atan': v = Math.atan(a.v); dfdx = 1 / (1 + a.v * a.v); break;
        case 'exp':  v = Math.exp(a.v);  dfdx = v; break;
        case 'ln':
          if (a.v <= 0) throw new Error('ln 의 입력은 0보다 커야 합니다');
          v = Math.log(a.v); dfdx = 1 / a.v; break;
        case 'log':
          if (a.v <= 0) throw new Error('log 의 입력은 0보다 커야 합니다');
          v = Math.log10(a.v); dfdx = 1 / (a.v * Math.LN10); break;
        case 'sqrt':
          if (a.v < 0) throw new Error('sqrt 의 입력은 음수일 수 없습니다');
          v = Math.sqrt(a.v); dfdx = 1 / (2 * v); break;
        case 'abs':  v = Math.abs(a.v); dfdx = a.v >= 0 ? 1 : -1; break;
        default: throw new Error(`모르는 함수: ${node.name}`);
      }
      return { v, d: mapD(a.d, (x) => dfdx * x) };
    }

    default:
      throw new Error('알 수 없는 노드');
  }
}

// ---------- 4. 불확도 전파 ----------
// 변수들이 서로 독립이라고 가정할 때
//   u_c(f) = sqrt( Σ ( ∂f/∂x_i · u(x_i) )^2 )
function propagate(formula, inputs, opts = {}) {
  const degrees = !!opts.degrees;          // 삼각함수 입력을 도(°)로 볼지
  const ast = parse(formula);
  const vars = collectVars(ast);

  for (const name of vars) {
    if (!(name in inputs)) throw new Error(`변수 '${name}' 의 값이 없습니다`);
  }

  const values = {};
  const uncerts = {};
  for (const name of vars) {
    let val = Number(inputs[name].value);
    let unc = Number(inputs[name].uncertainty ?? 0);
    if (degrees && isAngleVar(ast, name)) { val = val * Math.PI / 180; unc = unc * Math.PI / 180; }
    values[name] = val;
    uncerts[name] = unc;
  }

  const { v, d } = evalAD(ast, values, vars);

  const terms = vars.map((name, i) => {
    const partial = d[i];
    const contribution = partial * uncerts[name];   // 이 변수가 만든 오차 항
    return { name, partial, uncertainty: uncerts[name], contribution };
  });

  const uc = Math.sqrt(terms.reduce((s, t) => s + t.contribution ** 2, 0));

  // 기여도(%) — 어느 측정이 오차를 지배하는지
  const total = terms.reduce((s, t) => s + t.contribution ** 2, 0);
  for (const t of terms) {
    t.share = total === 0 ? 0 : (t.contribution ** 2 / total) * 100;
  }
  terms.sort((a, b) => b.share - a.share);

  return { value: v, uncertainty: uc, terms, vars, ast };
}

// 삼각함수 안에 들어가는 변수인지 (도 단위 변환 대상 판별용)
function isAngleVar(node, name, inside = false) {
  if (node.kind === 'var') return inside && node.name === name;
  if (node.kind === 'call') {
    const trig = ['sin', 'cos', 'tan'].includes(node.name);
    return isAngleVar(node.arg, name, inside || trig);
  }
  if (node.kind === 'binary') return isAngleVar(node.left, name, inside) || isAngleVar(node.right, name, inside);
  if (node.kind === 'neg') return isAngleVar(node.operand, name, inside);
  return false;
}

// ---------- 5. 유효숫자 처리 ----------
// 관례: 불확도를 유효숫자 1자리로 반올림한다.
//       단, 첫 유효숫자가 1 또는 2이면 2자리까지 남긴다.
//       측정값은 불확도의 마지막 자릿수에 맞춰 반올림한다.
function formatResult(value, uncertainty, opts = {}) {
  if (!isFinite(value)) return { value: String(value), uncertainty: '-', text: String(value) };
  if (uncertainty === 0 || !isFinite(uncertainty)) {
    return { value: String(value), uncertainty: '0', text: `${value}` };
  }

  const exp = Math.floor(Math.log10(Math.abs(uncertainty)));
  const firstDigit = Math.floor(Math.abs(uncertainty) / Math.pow(10, exp));
  const sigFigs = opts.forceTwo ? 2 : (firstDigit <= 2 ? 2 : 1);
  const roundExp = exp - (sigFigs - 1);          // 반올림할 자릿수(10의 지수)
  const step = Math.pow(10, roundExp);

  const u = Math.ceil(uncertainty / step - 1e-9) * step;   // 불확도는 올림이 관례
  const x = Math.round(value / step) * step;

  const decimals = Math.max(0, -roundExp);
  return {
    value: x.toFixed(decimals),
    uncertainty: u.toFixed(decimals),
    decimals,
    text: `${x.toFixed(decimals)} ± ${u.toFixed(decimals)}`,
  };
}

// ---------- 6. 검증용 수치 미분 (중앙 차분) ----------
function numericPartials(formula, inputs, h = 1e-6) {
  const ast = parse(formula);
  const vars = collectVars(ast);
  const base = {};
  for (const n of vars) base[n] = Number(inputs[n].value);

  const evalAt = (vals) => evalAD(ast, vals, vars).v;
  const out = {};
  for (const n of vars) {
    const step = Math.abs(base[n]) > 0 ? Math.abs(base[n]) * h : h;
    const plus = { ...base, [n]: base[n] + step };
    const minus = { ...base, [n]: base[n] - step };
    out[n] = (evalAt(plus) - evalAt(minus)) / (2 * step);
  }
  return out;
}

// ============================================================
//  기호 미분 — 편미분 "식"을 만들어 계산 과정을 보여줄 때 쓴다.
//  값은 자동 미분(evalAD)이 구하고, 여기서는 사람이 읽을 식을 만든다.
// ============================================================
  function num(v) { return { kind: "const", value: v }; }
  function bin(op, l, r) { return { kind: "binary", op: op, left: l, right: r }; }
  function callN(name, arg) { return { kind: "call", name: name, arg: arg }; }
  function negN(x) { return { kind: "neg", operand: x }; }
  function isZero(n) { return n.kind === "const" && !n.label && n.value === 0; }
  function isOne(n) { return n.kind === "const" && !n.label && n.value === 1; }

  // 미분 규칙을 그대로 코드로 옮긴 것
  function diff(node, x) {
    if (node.kind === "const") return num(0);
    if (node.kind === "var") return num(node.name === x ? 1 : 0);
    if (node.kind === "neg") return negN(diff(node.operand, x));

    if (node.kind === "binary") {
      const u = node.left, v = node.right;
      const du = diff(u, x), dv = diff(v, x);
      if (node.op === "+") return bin("+", du, dv);
      if (node.op === "-") return bin("-", du, dv);
      if (node.op === "*") return bin("+", bin("*", du, v), bin("*", u, dv));   // 곱의 미분법
      if (node.op === "/") {
        if (isZero(sim(dv))) return bin("/", du, v);                             // 분모에 이 변수가 없을 때
        if (isZero(sim(du))) return negN(bin("/", bin("*", u, dv), bin("^", v, num(2))));
        return bin("/", bin("-", bin("*", du, v), bin("*", u, dv)), bin("^", v, num(2)));
      }
      if (node.op === "^") {
        if (isZero(sim(dv))) {                                                   // 지수가 상수: (uⁿ)' = n·uⁿ⁻¹·u'
          return bin("*", bin("*", v, bin("^", u, bin("-", v, num(1)))), du);
        }
        return bin("*", bin("^", u, v),
          bin("+", bin("*", dv, callN("ln", u)), bin("/", bin("*", v, du), u)));
      }
    }

    if (node.kind === "call") {                                                  // 연쇄법칙
      const u = node.arg, du = diff(u, x);
      let outer;
      switch (node.name) {
        case "sin": outer = callN("cos", u); break;
        case "cos": outer = negN(callN("sin", u)); break;
        case "tan": outer = bin("/", num(1), bin("^", callN("cos", u), num(2))); break;
        case "asin": outer = bin("/", num(1), callN("sqrt", bin("-", num(1), bin("^", u, num(2))))); break;
        case "acos": outer = negN(bin("/", num(1), callN("sqrt", bin("-", num(1), bin("^", u, num(2)))))); break;
        case "atan": outer = bin("/", num(1), bin("+", num(1), bin("^", u, num(2)))); break;
        case "exp": outer = callN("exp", u); break;
        case "ln": outer = bin("/", num(1), u); break;
        case "log": outer = bin("/", num(1), bin("*", u, callN("ln", num(10)))); break;
        case "sqrt": outer = bin("/", num(1), bin("*", num(2), callN("sqrt", u))); break;
        case "abs": outer = bin("/", u, callN("abs", u)); break;
        default: return num(0);
      }
      return bin("*", outer, du);
    }
    return num(0);
  }

  // 식 정리 — 0과 1을 없애고, 상수끼리 미리 계산하고, 같은 밑의 거듭제곱을 약분한다
  function sim(n) {
    if (n.kind === "neg") {
      const a = sim(n.operand);
      if (isZero(a)) return num(0);
      if (a.kind === "neg") return a.operand;
      if (a.kind === "const" && !a.label) return num(-a.value);
      return negN(a);
    }
    if (n.kind === "call") return callN(n.name, sim(n.arg));
    if (n.kind !== "binary") return n;

    const l = sim(n.left), r = sim(n.right), op = n.op;

    if (l.kind === "const" && r.kind === "const" && !l.label && !r.label) {
      if (op === "+") return num(l.value + r.value);
      if (op === "-") return num(l.value - r.value);
      if (op === "*") return num(l.value * r.value);
      if (op === "/" && r.value !== 0) return num(l.value / r.value);
      if (op === "^") return num(Math.pow(l.value, r.value));
    }
    if (op === "+") { if (isZero(l)) return r; if (isZero(r)) return l; }
    if (op === "-") { if (isZero(r)) return l; if (isZero(l)) return sim(negN(r)); }
    if (op === "*") {
      if (isZero(l) || isZero(r)) return num(0);
      if (isOne(l)) return r;
      if (isOne(r)) return l;
      if (l.kind === "const" && !l.label && l.value === -1) return sim(negN(r));
      if (r.kind === "const" && !r.label && r.value === -1) return sim(negN(l));
    }
    if (op === "/") {
      if (isZero(l)) return num(0);
      if (isOne(r)) return l;
      return cancel(l, r);
    }
    if (op === "^") {
      if (isOne(r)) return l;
      if (isZero(r)) return num(1);
      if (l.kind === "binary" && l.op === "^" && l.right.kind === "const" && !l.right.label
          && r.kind === "const" && !r.label) {
        return sim(bin("^", l.left, num(l.right.value * r.value)));
      }
    }
    return bin(op, l, r);
  }

  function flattenMul(n, out) {
    out = out || [];
    if (n.kind === "binary" && n.op === "*") { flattenMul(n.left, out); flattenMul(n.right, out); }
    else out.push(n);
    return out;
  }

  function asPower(n) {
    if (n.kind === "binary" && n.op === "^" && n.right.kind === "const" && !n.right.label) {
      return { base: n.left, exp: n.right.value };
    }
    return { base: n, exp: 1 };
  }

  // 분자와 분모에서 같은 밑끼리 지수를 빼서 약분한다
  function cancel(l, r) {
    const ln = flattenMul(l).map(asPower);
    const rn = flattenMul(r).map(asPower);
    for (let i = 0; i < ln.length; i++) {
      for (let j = 0; j < rn.length; j++) {
        if (ln[i].exp > 0 && rn[j].exp > 0 && render(ln[i].base, 0) === render(rn[j].base, 0)) {
          const d = Math.min(ln[i].exp, rn[j].exp);
          ln[i].exp -= d; rn[j].exp -= d;
        }
      }
    }
    const build = function (arr) {
      let coef = 1;
      const parts = [];
      arr.forEach(function (p) {
        if (p.exp === 0) return;
        if (p.base.kind === "const" && !p.base.label && p.exp === 1) { coef *= p.base.value; return; }
        parts.push(p.exp === 1 ? p.base : bin("^", p.base, num(p.exp)));
      });
      let node = parts.length ? parts.reduce(function (a, b) { return bin("*", a, b); }) : null;
      if (coef !== 1 || !node) node = node ? bin("*", num(coef), node) : num(coef);
      return node;
    };
    const N = build(ln), D = build(rn);
    if (D.kind === "const" && !D.label && D.value === 1) return N;
    return bin("/", N, D);
  }

  const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };

  function fmtConst(v) {
    const t = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
    return t.replace("-", "−");
  }

  // 계산 트리를 사람이 읽는 수식 문자열로 되돌린다
  function render(n, parentPrec) {
    parentPrec = parentPrec || 0;
    if (n.kind === "const") return n.label || fmtConst(n.value);
    if (n.kind === "var") return n.name;
    if (n.kind === "call") return n.name + "(" + render(n.arg, 0) + ")";
    if (n.kind === "neg") {
      const t = "−" + render(n.operand, 2.5);
      return parentPrec > 2 ? "(" + t + ")" : t;
    }
    const p = PREC[n.op];
    const ls = render(n.left, n.op === "^" ? p + 0.5 : p);
    const rs = render(n.right, (n.op === "-" || n.op === "/") ? p + 0.5 : p);
    let t;
    if (n.op === "*") t = ls + "·" + rs;
    else if (n.op === "/") t = ls + " / " + rs;
    else if (n.op === "^") t = ls + "^" + rs;
    else t = ls + " " + n.op + " " + rs;
    return p < parentPrec ? "(" + t + ")" : t;
  }

module.exports = {
  tokenize, parse, collectVars, evalAD, propagate, formatResult, numericPartials,
  diff, sim, render,   // 기호 미분 — 편미분 '식'을 만들어 보여줄 때 쓴다
};
