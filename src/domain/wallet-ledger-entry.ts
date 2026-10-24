import { Money } from './value-objects/money.js';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Immutable by construction: no setters, no transition methods. */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}

  /** Validates `balanceBefore ± money === balanceAfter`. */
  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (entry.money.minorUnits === 0n) {
      throw new RangeError('A ledger entry must move a non-zero amount.');
    }
    if (!entry.isBalanced()) {
      throw new RangeError('Ledger entry arithmetic is inconsistent.');
    }
    return entry;
  }

  /** Reconstructs persisted state without revalidating it. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === 'DEBIT'
        ? this.balanceBefore.minorUnits - this.money.minorUnits
        : this.balanceBefore.minorUnits + this.money.minorUnits;
    return expected === this.balanceAfter.minorUnits;
  }
}
