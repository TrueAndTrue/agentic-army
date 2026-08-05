import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/sheet.js';

test('cell literal values: numbers vs non-numeric text', () => {
  const result = evaluate({
    A1: '42',
    A2: '-3.5',
    A3: '  7  ',
    B1: 'hello',
    B2: '12x',
    B3: '1.2.3',
  });
  assert.equal(result.A1, 42);
  assert.equal(result.A2, -3.5);
  assert.equal(result.A3, 7);
  assert.equal(result.B1, '#ERROR!');
  assert.equal(result.B2, '#ERROR!');
  assert.equal(result.B3, '#ERROR!');
});

test('empty cells return 0, and absent references behave as empty', () => {
  const result = evaluate({ A1: '', A2: '   ', REF: '=Z9+Y8' }); // Z9, Y8 are absent keys
  assert.equal(result.A1, 0);
  assert.equal(result.A2, 0);
  assert.equal(result.REF, 0);
  assert.ok(!('Z9' in result) && !('Y8' in result));
});

test('arithmetic operators: left-associativity and precedence', () => {
  const result = evaluate({
    A1: '=2+3*4', // * binds tighter than +: 14, not 20
    A2: '=1-2-3', // left-associative: (1-2)-3 = -4, not 2
    A3: '=20/4/5', // left-associative: (20/4)/5 = 1
  });
  assert.equal(result.A1, 14);
  assert.equal(result.A2, -4);
  assert.equal(result.A3, 1);
});

test('unary minus and parentheses', () => {
  const result = evaluate({
    A1: '=-2*3', // unary binds tighter than *: (-2)*3 = -6
    A2: '=--1', // double unary minus is legal: 1
    A3: '=-2+3', // unary applies only to 2: 1
    A4: '=(1+2)*3', // 9
  });
  assert.equal(result.A1, -6);
  assert.equal(result.A2, 1);
  assert.equal(result.A3, 1);
  assert.equal(result.A4, 9);
});

test('cell references and chains of references', () => {
  const result = evaluate({ A1: '5', A2: '=A1+1', A3: '=A2*2', A4: '=A3-A1' });
  assert.equal(result.A1, 5);
  assert.equal(result.A2, 6);
  assert.equal(result.A3, 12);
  assert.equal(result.A4, 7);
});

test('all four functions over both ranges and expression arguments', () => {
  const result = evaluate({
    A1: '1',
    A2: '2',
    A3: '3',
    S: '=SUM(A1:A3)',
    MN: '=MIN(A1:A3)',
    MX: '=MAX(A1:A3)',
    C: '=COUNT(A1:A3)',
    SX: '=SUM(A1,A2,10)', // expression arguments contribute their single value
  });
  assert.equal(result.S, 6);
  assert.equal(result.MN, 1);
  assert.equal(result.MX, 3);
  assert.equal(result.C, 3);
  assert.equal(result.SX, 13);
});

test('ranges with reversed corners denote the same rectangle', () => {
  const result = evaluate({
    A1: '1',
    A2: '2',
    B1: '3',
    B2: '4',
    S: '=SUM(B2:A1)', // same four cells as A1:B2
    C: '=COUNT(B2:A1)',
  });
  assert.equal(result.S, 10);
  assert.equal(result.C, 4);
});

test('empty cells are skipped by functions; MIN/MAX on all-empty give #EMPTY!, COUNT gives 0', () => {
  const skip = evaluate({ A1: '1', A2: '', A3: '3', S: '=SUM(A1:A3)', C: '=COUNT(A1:A3)' });
  assert.equal(skip.S, 4); // A2 skipped, not counted as a zero
  assert.equal(skip.C, 2);

  const empty = evaluate({ A1: '', A2: '', MN: '=MIN(A1:A2)', MX: '=MAX(A1:A2)', C: '=COUNT(A1:A2)' });
  assert.equal(empty.MN, '#EMPTY!');
  assert.equal(empty.MX, '#EMPTY!');
  assert.equal(empty.C, 0);
});

test('#DIV/0! when the divisor evaluates to zero', () => {
  const result = evaluate({ A1: '=5/0', A2: '0', A3: '=5/A2' });
  assert.equal(result.A1, '#DIV/0!');
  assert.equal(result.A3, '#DIV/0!');
});

test('#ERROR! for each malformed formula shape', () => {
  const result = evaluate({
    E1: '=sum(A1:A2)', // lowercase function name
    E2: '=a1', // lowercase ref
    E3: '=A0', // row 0 is not a valid ref
    E4: '=AA1', // two letters is not a valid ref
    E5: '=A1000', // four digits is not a valid ref
    E6: '=A1:B2', // bare range outside a function
    E7: '=SUM()', // zero-argument call
    E8: '=1+1x', // trailing junk after a complete expression
    E9: '=', // empty formula
  });
  for (const key of Object.keys(result)) {
    assert.equal(result[key], '#ERROR!', `${key} should be #ERROR!`);
  }
});

test('error propagation: through operators, through functions, and left-operand-wins', () => {
  const result = evaluate({
    B9: 'notanumber', // #ERROR!
    D9: '=1/0', // #DIV/0!
    P1: '=B9+1', // single error propagates through an operator
    LW: '=D9+B9', // both operands are errors: left (#DIV/0!) wins
    LW2: '=B9+D9', // both operands are errors: left (#ERROR!) wins
    FN1: '=SUM(B9, D9)', // first error in argument order: B9's #ERROR!
    FN2: '=SUM(D9, B9)', // first error in argument order: D9's #DIV/0!
  });
  assert.equal(result.P1, '#ERROR!');
  assert.equal(result.LW, '#DIV/0!');
  assert.equal(result.LW2, '#ERROR!');
  assert.equal(result.FN1, '#ERROR!');
  assert.equal(result.FN2, '#DIV/0!');
});

test('#CYCLE! for self, mutual, and range cycles, without taking down the rest of the sheet', () => {
  const result = evaluate({
    S1: '=S1',
    X1: '=Y1',
    Y1: '=X1',
    R1: '=SUM(R1:R3)',
    R2: '2',
    R3: '3',
    INDEP: '=5+2', // must still compute correctly even though the sheet contains cycles
  });
  assert.equal(result.S1, '#CYCLE!');
  assert.equal(result.X1, '#CYCLE!');
  assert.equal(result.Y1, '#CYCLE!');
  assert.equal(result.R1, '#CYCLE!');
  assert.equal(result.INDEP, 7);
});

test('ten-decimal rounding rule', () => {
  const result = evaluate({ A1: '=0.1+0.2', A2: '=1/3*3' });
  assert.equal(result.A1, 0.3);
  assert.equal(result.A2, 1);
});

test('evaluate is safe: does not mutate its argument, and never throws', () => {
  const input = { A1: '5', A2: '=A1+1', A3: 'bad text', A4: '' };
  const snapshot = JSON.parse(JSON.stringify(input));
  evaluate(input);
  assert.deepEqual(input, snapshot);

  assert.deepEqual(evaluate({}), {});
  const hostile = evaluate({ A1: '=', A2: '=(', A3: '=)', A4: '=1+', A5: '=SUM(A1' });
  assert.equal(hostile.A1, '#ERROR!');
  assert.equal(hostile.A2, '#ERROR!');
  assert.equal(hostile.A3, '#ERROR!');
  assert.equal(hostile.A4, '#ERROR!');
  assert.equal(hostile.A5, '#ERROR!');
});
