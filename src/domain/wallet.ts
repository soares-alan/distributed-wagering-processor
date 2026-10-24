import { Money } from './value-objects/money.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/** Aggregate root. Every balance change returns the ledger entry that explains it. */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now: Date;
  }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstructs persisted state without revalidating it. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    // Money.subtract rejects a result below zero.
    return this.apply('DEBIT', this._balance.subtract(movement.money), movement);
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply('CREDIT', this._balance.add(movement.money), movement);
  }

  private apply(
    direction: 'DEBIT' | 'CREDIT',
    balanceAfter: Money,
    movement: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new TypeError(
        `Currency mismatch: wallet is ${this.currency}, operation is ${money.currency}.`,
      );
    }
  }
}
