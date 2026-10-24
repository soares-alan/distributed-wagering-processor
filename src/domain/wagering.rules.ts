import { Money } from './value-objects/money.js';

export type WagerTransactionType =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export interface BalanceChange {
  amountMinor: bigint;
  balanceAfterMinor: bigint;
}

export function calculateBalanceChange(
  type: WagerTransactionType,
  amountMinor: bigint,
  balanceBeforeMinor: bigint,
  referencedLedgerAmountMinor?: bigint,
  referencedType?: WagerTransactionType,
): BalanceChange {
  const amount = Money.fromMinorUnits(amountMinor, 'USD');
  const balance = Money.fromMinorUnits(balanceBeforeMinor, 'USD');
  let signedChange: bigint;

  switch (type) {
    case 'BET':
      signedChange = -amount.minorUnits;
      break;
    case 'WIN':
      signedChange = amount.minorUnits;
      break;
    case 'LOSS':
      signedChange = 0n;
      break;
    case 'REFUND':
    case 'ROLLBACK':
      if (referencedLedgerAmountMinor === undefined) {
        throw new TypeError(`${type} requires a referenced ledger entry.`);
      }
      if (
        (type === 'REFUND' && referencedType !== 'BET') ||
        (type === 'ROLLBACK' &&
          !['BET', 'WIN', 'REFUND'].includes(referencedType ?? ''))
      ) {
        throw new TypeError(`${type} does not allow the referenced transaction type.`);
      }

      if (amount.minorUnits !==
        (referencedLedgerAmountMinor < 0n
          ? -referencedLedgerAmountMinor
          : referencedLedgerAmountMinor)
      ) {
        throw new RangeError('Reversal amount must match the original entry.');
      }

      signedChange = -referencedLedgerAmountMinor;
      break;
  }

  const balanceAfter = balance.minorUnits + signedChange;
  if (balanceAfter < 0n) {
    throw new RangeError('Insufficient funds.');
  }

  const checkedBalance = Money.fromMinorUnits(balanceAfter, 'USD');

  return {
    amountMinor: signedChange,
    balanceAfterMinor: checkedBalance.minorUnits,
  };
}
