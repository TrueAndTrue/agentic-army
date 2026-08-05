import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { evaluate } = await import(pathToFileURL(join(process.cwd(), 'src/sheet.js')).href);

test('number literal corners: leading zeros, trailing decimal zeros, negative-zero literal', () => {
  const result = evaluate({ A1: '007', A2: '10.100', A3: '  -0  ' });
  assert.equal(result.A1, 7);
  assert.equal(result.A2, 10.1);
  assert.equal(result.A3, 0); // -0 must normalise to 0
});

test('functions over a range with cells entirely absent from the object, not just empty text', () => {
  // catches an implementation that treats an absent-key gap the same as a real zero
  const result = evaluate({ A1: '10', A4: '20', S: '=SUM(A1:A5)', C: '=COUNT(A1:A5)', MN: '=MIN(A1:A5)', MX: '=MAX(A1:A5)' });
  assert.equal(result.S, 30);
  assert.equal(result.C, 2);
  assert.equal(result.MN, 10); // catches an impl that folds skipped/absent cells in as 0 for MIN
  assert.equal(result.MX, 20);
});

test('MAX and COUNT over a reversed 3x3 range containing a text error', () => {
  const result = evaluate({
    A1: '1', B1: '2', C1: '3',
    A2: '4', B2: 'bad', C2: '6',
    A3: '7', B3: '8', C3: '9',
    MX: '=MAX(C3:A1)',
    CT: '=COUNT(C3:A1)',
  });
  assert.equal(result.MX, '#ERROR!');
  // catches an implementation that assumes COUNT is immune to errors the way it is immune to #EMPTY!
  assert.equal(result.CT, '#ERROR!');
});

test('first error in row-major order, not column-major and not the last one found', () => {
  const result = evaluate({
    A1: '5', B1: 'bad1',
    A2: '=1/0', B2: '9',
    S: '=SUM(A1:B2)',
  });
  assert.equal(result.B1, '#ERROR!');
  assert.equal(result.A2, '#DIV/0!');
  // row-major order is A1, B1, A2, B2 -> first error is B1's #ERROR!.
  // catches an impl that scans column-major (would report A2's #DIV/0!) or takes the last error found.
  assert.equal(result.S, '#ERROR!');
});

test('left-operand-wins when one side is #EMPTY! rather than #ERROR!/#DIV/0!', () => {
  const result = evaluate({
    E9: '=MIN(Q1:Q2)', // Q1, Q2 absent -> #EMPTY!
    B9: 'notnum', // #ERROR!
    LWA: '=E9+B9',
    LWB: '=B9+E9',
  });
  assert.equal(result.E9, '#EMPTY!');
  assert.equal(result.B9, '#ERROR!');
  // catches an impl whose error-propagation check special-cases #ERROR!/#DIV/0!/#CYCLE! but forgets #EMPTY! is also an error value
  assert.equal(result.LWA, '#EMPTY!');
  assert.equal(result.LWB, '#ERROR!');
});

test('unary minus binds tighter than * in deeper expressions', () => {
  const result = evaluate({
    A1: '=-3*-2', // (-3) * (-2) = 6
    A2: '=2*-3+1', // 2*(-3)+1 = -5
    A3: '=-(2+3)*-2', // (-(5)) * (-2) = 10
  });
  assert.equal(result.A1, 6);
  assert.equal(result.A2, -5);
  assert.equal(result.A3, 10);
});

test('a deep reference chain resolves correctly', () => {
  const cells = { A1: '1' };
  for (let i = 2; i <= 10; i++) cells[`A${i}`] = `=A${i - 1}*2`;
  const result = evaluate(cells);
  assert.equal(result.A5, 16);
  assert.equal(result.A10, 512);
});

test('a cycle touches only part of the sheet: downstream cells fail, unrelated cells compute fine', () => {
  const result = evaluate({
    C1: '=C2',
    C2: '=C1',
    D1: '=C1+1', // depends on the cycle, must also be #CYCLE!
    G1: '=SUM(C1:C2)', // a range entirely inside the cycle
    E1: '=10*3', // wholly unrelated
    H1: '=SUM(E1,10)', // depends on a healthy cell, must compute normally
  });
  assert.equal(result.C1, '#CYCLE!');
  assert.equal(result.C2, '#CYCLE!');
  assert.equal(result.D1, '#CYCLE!');
  assert.equal(result.G1, '#CYCLE!');
  assert.equal(result.E1, 30);
  assert.equal(result.H1, 40);
});

test('rounding removes float dust at a value visible-suite naive arithmetic would not catch', () => {
  const result = evaluate({ A1: '=1.005*100', A2: '=0.3-0.2-0.1' });
  // catches an implementation with no rounding step, or one that rounds only formula
  // results and not the -0 that this computation actually produces
  assert.equal(result.A1, 100.5);
  assert.equal(result.A2, 0);
});

test('a function call nested as an expression argument to another function', () => {
  const result = evaluate({ A1: '3', A2: '4', N: '=SUM(SUM(A1:A2), MAX(A1:A2))' });
  assert.equal(result.N, 11);
});

test('a single call mixing range arguments and expression arguments', () => {
  const result = evaluate({ A1: '1', A2: '2', B1: '3', B2: '', M: '=SUM(A1:A2, 100, B1:B2)' });
  assert.equal(result.M, 106);
});

test('a range collapsed to a single cell', () => {
  const result = evaluate({
    A1: '42',
    SUMSELF: '=SUM(A1:A1)',
    COUNTSELF: '=COUNT(A1:A1)',
    Z1: '',
    MINEMPTY: '=MIN(Z1:Z1)',
    COUNTEMPTY: '=COUNT(Z1:Z1)',
  });
  assert.equal(result.SUMSELF, 42);
  assert.equal(result.COUNTSELF, 1);
  assert.equal(result.MINEMPTY, '#EMPTY!');
  assert.equal(result.COUNTEMPTY, 0);
});

test('#DIV/0! where the divisor is itself computed by a function, not a literal', () => {
  const result = evaluate({ M1: '=MIN(0,5)', D: '=10/M1' });
  assert.equal(result.M1, 0);
  assert.equal(result.D, '#DIV/0!');
});

test('#EMPTY! propagates through arithmetic and then through a function argument list', () => {
  const result = evaluate({
    E9: '=MAX(Z9:Z10)', // Z9, Z10 absent -> #EMPTY!
    U1: '=E9*2',
    FN: '=SUM(U1,1)',
  });
  assert.equal(result.E9, '#EMPTY!');
  assert.equal(result.U1, '#EMPTY!');
  assert.equal(result.FN, '#EMPTY!');
});
