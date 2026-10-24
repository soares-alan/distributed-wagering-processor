import { calculateBalanceChange } from './wagering.rules.js';

describe('calculateBalanceChange', () => {
  it('debits bets and rejects insufficient balance', () => {
    expect(calculateBalanceChange('BET', 40n, 100n)).toEqual({
      amountMinor: -40n,
      balanceAfterMinor: 60n,
    });
    expect(() => calculateBalanceChange('BET', 101n, 100n)).toThrow(
      'Insufficient funds.',
    );
  });

  it('credits wins and leaves balance unchanged for losses', () => {
    expect(calculateBalanceChange('WIN', 20n, 100n).balanceAfterMinor).toBe(
      120n,
    );
    expect(calculateBalanceChange('LOSS', 20n, 100n)).toEqual({
      amountMinor: 0n,
      balanceAfterMinor: 100n,
    });
  });

  it('reverses the exact amount and direction of a referenced entry', () => {
    expect(calculateBalanceChange('REFUND', 40n, 60n, -40n, 'BET')).toEqual({
      amountMinor: 40n,
      balanceAfterMinor: 100n,
    });
    expect(calculateBalanceChange('ROLLBACK', 20n, 120n, 20n, 'WIN')).toEqual({
      amountMinor: -20n,
      balanceAfterMinor: 100n,
    });
    expect(calculateBalanceChange('ROLLBACK', 40n, 100n, 40n, 'REFUND')).toEqual({
      amountMinor: -40n,
      balanceAfterMinor: 60n,
    });
  });

  it('requires a matching referenced ledger movement for reversals', () => {
    expect(() => calculateBalanceChange('REFUND', 40n, 60n)).toThrow(
      'REFUND requires a referenced ledger entry.',
    );
    expect(() => calculateBalanceChange('REFUND', 41n, 60n, -40n, 'BET')).toThrow(
      'Reversal amount must match the original entry.',
    );
  });

  it('rejects reversal kinds that do not permit the reference kind', () => {
    expect(() =>
      calculateBalanceChange('REFUND', 20n, 100n, 20n, 'WIN'),
    ).toThrow('REFUND does not allow the referenced transaction type.');
    expect(() =>
      calculateBalanceChange('ROLLBACK', 20n, 100n, -20n, 'LOSS'),
    ).toThrow('ROLLBACK does not allow the referenced transaction type.');
  });

  it('rejects credits that exceed the PostgreSQL BIGINT limit', () => {
    expect(() =>
      calculateBalanceChange('WIN', 1n, (1n << 63n) - 1n),
    ).toThrow('Amount is outside the PostgreSQL BIGINT range.');
  });
});
