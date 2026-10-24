import { Money } from './money.js';

describe('Money', () => {
  it.each([
    ['0.00', 0n],
    ['12.34', 1234n],
    ['001.05', 105n],
  ])('parses decimal %s exactly', (amount, expectedMinorUnits) => {
    expect(Money.fromDecimal(amount, 'USD').minorUnits).toBe(
      expectedMinorUnits,
    );
  });

  it('normalizes the currency code', () => {
    expect(Money.fromDecimal('1.00', 'usd').currency).toBe('USD');
  });

  it.each([
    '',
    '-1.00',
    '+1.00',
    '1.',
    '.25',
    '1',
    '1.2',
    '1.234',
    '1e2',
    ' 1.00',
  ])(
    'rejects invalid decimal input %j',
    (amount) => {
      expect(() => Money.fromDecimal(amount, 'USD')).toThrow(TypeError);
    },
  );

  it('rejects an invalid currency code', () => {
    expect(() => Money.fromDecimal('1.00', 'US')).toThrow(TypeError);
    expect(() => Money.fromDecimal('1.00', 'ZZZ')).toThrow(TypeError);
  });

  it('compares and serializes without losing decimal precision', () => {
    const amount = Money.fromDecimal('10.50', 'USD');

    expect(amount.equals(Money.fromDecimal('10.50', 'USD'))).toBe(true);
    expect(amount.isLessThan(Money.fromDecimal('10.51', 'USD'))).toBe(true);
    expect(amount.isGreaterThan(Money.fromDecimal('10.49', 'USD'))).toBe(true);
    expect(JSON.stringify(amount)).toBe('{"amount":"10.50","currency":"USD"}');
  });

  it('adds amounts without floating-point arithmetic', () => {
    expect(
      Money.fromDecimal('0.10', 'USD')
        .add(Money.fromDecimal('0.20', 'USD'))
        .toDecimal(),
    ).toBe('0.30');
  });

  it('rejects arithmetic across currencies', () => {
    expect(() =>
      Money.fromDecimal('1.00', 'USD').add(Money.fromDecimal('1.00', 'EUR')),
    ).toThrow(/Currency mismatch/);
  });

  it('rejects subtraction that exceeds the available amount', () => {
    expect(() =>
      Money.fromDecimal('1.00', 'USD').subtract(
        Money.fromDecimal('1.01', 'USD'),
      ),
    ).toThrow('Insufficient funds.');
  });

  it('accepts the maximum PostgreSQL BIGINT value', () => {
    const maximumMinorUnits = (1n << 63n) - 1n;

    expect(
      Money.fromMinorUnits(maximumMinorUnits, 'USD').minorUnits,
    ).toBe(maximumMinorUnits);
  });

  it('rejects values outside the non-negative PostgreSQL BIGINT range', () => {
    expect(() => Money.fromMinorUnits((1n << 63n).toString(), 'USD')).toThrow(
      RangeError,
    );
    expect(() => Money.fromMinorUnits(-1n, 'USD')).toThrow(RangeError);
    expect(() => Money.fromDecimal('92233720368547758.08', 'USD')).toThrow(
      RangeError,
    );
  });

  it('rejects addition that exceeds the PostgreSQL BIGINT limit', () => {
    const maximum = Money.fromMinorUnits((1n << 63n) - 1n, 'USD');

    expect(() => maximum.add(Money.fromMinorUnits(1n, 'USD'))).toThrow(
      RangeError,
    );
  });

  it('round-trips the maximum decimal representable by PostgreSQL BIGINT', () => {
    const maximumMinorUnits = (1n << 63n) - 1n;
    const amount = Money.fromMinorUnits(maximumMinorUnits, 'USD');

    expect(
      Money.fromDecimal(amount.toDecimal(), 'USD').minorUnits,
    ).toBe(maximumMinorUnits);
  });
});
