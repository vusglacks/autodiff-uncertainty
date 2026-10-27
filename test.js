const { propagate, formatResult, numericPartials, parse, sim, diff, render } = require('./engine');

let pass = 0, fail = 0;
function check(label, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (ok) { pass++; console.log(`  ✓ ${label}: ${got}`); }
  else { fail++; console.log(`  ✗ ${label}: got ${got}, want ${want}`); }
}

console.log('\n[1] 밀도 rho = m / V   (m=10.00±0.05, V=5.00±0.02)');
{
  const r = propagate('m / V', { m: { value: 10.00, uncertainty: 0.05 }, V: { value: 5.00, uncertainty: 0.02 } });
  check('값', r.value, 2.0);
  check('∂/∂m = 1/V', r.terms.find(t => t.name === 'm').partial, 0.2);
  check('∂/∂V = -m/V^2', r.terms.find(t => t.name === 'V').partial, -0.4);
  check('합성불확도', r.uncertainty, Math.sqrt(1e-4 + 6.4e-5));
  console.log('  표기:', formatResult(r.value, r.uncertainty).text);
}

console.log('\n[2] 단진자 g = 4*pi^2*L / T^2   (L=1.000±0.002, T=2.006±0.004)');
{
  const L = 1.000, T = 2.006;
  const r = propagate('4*pi^2*L / T^2', { L: { value: L, uncertainty: 0.002 }, T: { value: T, uncertainty: 0.004 } });
  check('값', r.value, 4 * Math.PI ** 2 * L / T ** 2);
  check('∂g/∂L = 4pi^2/T^2', r.terms.find(t => t.name === 'L').partial, 4 * Math.PI ** 2 / T ** 2);
  check('∂g/∂T = -8pi^2 L/T^3', r.terms.find(t => t.name === 'T').partial, -8 * Math.PI ** 2 * L / T ** 3);
  console.log('  표기:', formatResult(r.value, r.uncertainty).text);
}

console.log('\n[3] 삼각함수 n = sin(a)/sin(b)  (자동 미분 vs 수치 미분)');
{
  const inputs = { a: { value: 0.7854, uncertainty: 0.0017 }, b: { value: 0.5236, uncertainty: 0.0017 } };
  const r = propagate('sin(a)/sin(b)', inputs);
  const num = numericPartials('sin(a)/sin(b)', inputs);
  for (const t of r.terms) check(`∂/∂${t.name} 자동 vs 수치`, t.partial, num[t.name], 1e-5);
}

console.log('\n[4] 지수·로그 f = exp(-k*t)*ln(1+x)  (자동 미분 vs 수치 미분)');
{
  const inputs = {
    k: { value: 0.35, uncertainty: 0.01 },
    t: { value: 4.2, uncertainty: 0.1 },
    x: { value: 2.5, uncertainty: 0.05 },
  };
  const r = propagate('exp(-k*t)*ln(1+x)', inputs);
  const num = numericPartials('exp(-k*t)*ln(1+x)', inputs);
  for (const t of r.terms) check(`∂/∂${t.name} 자동 vs 수치`, t.partial, num[t.name], 1e-5);
}

console.log('\n[5] 거듭제곱 우결합성 2^3^2 = 2^(3^2) = 512');
check('값', propagate('2^3^2', {}).value, 512);

console.log('\n[6] 유효숫자 처리');
for (const [v, u, want] of [
  [2.0, 0.0128062, '2.000 ± 0.013'],
  [9.7823, 0.0456, '9.78 ± 0.05'],
  [1234.5, 12.3, '1235 ± 13'],
  [0.0004567, 0.0000234, '0.000457 ± 0.000024'],
]) {
  const got = formatResult(v, u).text;
  if (got === want) { pass++; console.log(`  ✓ ${v} ± ${u} → ${got}`); }
  else { fail++; console.log(`  ✗ ${v} ± ${u} → ${got}  (기대: ${want})`); }
}

console.log('\n[7] 오류 처리');
for (const f of ['m / ', '2 +* 3', 'foo(3)', 'm / 0']) {
  try {
    propagate(f, { m: { value: 1, uncertainty: 0 } });
    fail++; console.log(`  ✗ '${f}' 는 오류가 나야 하는데 통과함`);
  } catch (e) {
    pass++; console.log(`  ✓ '${f}' → ${e.message}`);
  }
}

console.log('\n[8] 기호 미분으로 구한 편미분 식');
for (const [f, v, want] of [
  ['4*pi^2*L / T^2', 'L', '4·pi^2 / T^2'],
  ['4*pi^2*L / T^2', 'T', '−(8·pi^2·L / T^3)'],
  ['m / V', 'm', '1 / V'],
  ['m / V', 'V', '−(m / V^2)'],
  ['sin(i)/sin(r)', 'i', 'cos(i) / sin(r)'],
  ['sin(i)/sin(r)', 'r', '−(sin(i)·cos(r) / sin(r)^2)'],
  ['pi * d^2 * h / 4', 'h', 'pi·d^2 / 4'],
]) {
  const got = render(sim(diff(parse(f), v)), 0);
  if (got === want) { pass++; console.log(`  ✓ ∂(${f})/∂${v} = ${got}`); }
  else { fail++; console.log(`  ✗ ∂(${f})/∂${v} = ${got}  (기대: ${want})`); }
}

console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
process.exit(fail === 0 ? 0 : 1);
