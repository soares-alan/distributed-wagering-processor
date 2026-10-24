import { Money } from './value-objects/money.js';
import type { LedgerDirection } from './wallet-ledger-entry.js';

export type WagerTransactionKind =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export type WagerTransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

export class InvalidTransactionStateError extends Error {
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Invalid wager transaction transition: ${from} -> ${to}.`);
    this.name = 'InvalidTransactionStateError';
  }
}

/**
 * Valid transitions. PROCESSED, REJECTED and FAILED are terminal.
 * PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 * PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 */
const TRANSITIONS: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  PENDING: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
>;

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: string,
    private _processedAt?: Date,
  ) {}

  /** Starts in PENDING; REFUND and ROLLBACK must name the transaction they reference. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresReference = props.kind === 'REFUND' || props.kind === 'ROLLBACK';
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new TypeError(`${props.kind} requires a referenceExternalTransactionId.`);
    }
    if (!requiresReference && props.referenceExternalTransactionId) {
      throw new TypeError(`${props.kind} must not carry a reference.`);
    }
    return WagerTransaction.rehydrate({ ...props, status: 'PENDING' });
  }

  /** Reconstructs persisted state without revalidating transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transition('PROCESSED');
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transition('PENDING_REFERENCE');
  }

  reject(code: string, at?: Date): void {
    this.transition('REJECTED');
    this._failureCode = code;
    this._processedAt = at;
  }

  fail(code: string, at?: Date): void {
    this.transition('FAILED');
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case 'BET':
        return 'DEBIT';
      case 'WIN':
      case 'OPENING':
      case 'REFUND':
        return 'CREDIT';
      case 'ROLLBACK': {
        if (!reference) throw new TypeError('ROLLBACK needs its reference transaction.');
        return reference.ledgerDirectionFor() === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      }
      case 'LOSS':
        throw new TypeError('LOSS does not affect the balance.');
    }
  }

  private transition(to: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    this._status = to;
  }
}
