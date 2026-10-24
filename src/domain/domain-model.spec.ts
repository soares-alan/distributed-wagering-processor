import { IntegrationEvent, WalletBalanceChanged, integrationEventFor } from './integration-event.js';
import { InboxMessage } from './inbox-message.js';
import { OutboxMessage } from './outbox-message.js';
import { Money } from './value-objects/money.js';
import { InvalidTransactionStateError, WagerTransaction } from './wager-transaction.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { Wallet } from './wallet.js';

const at = new Date('2026-01-01T00:00:00.000Z');
const brl = (amount: string) => Money.fromDecimal(amount, 'BRL');
const openWallet = (amount = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), now: at });
const movement = (amount: string) => ({
  entryId: 'e1',
  transactionId: 't1',
  money: brl(amount),
  at,
});

describe('Wallet aggregate', () => {
  it('opens at version 1 and bumps the version only when the balance moves', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    const entry = wallet.debit(movement('80.00'));
    expect(wallet.balance.toDecimal()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceBefore.toDecimal()).toBe('100.00');
    expect(entry.balanceAfter.toDecimal()).toBe('20.00');
  });

  it('never allows a negative balance and leaves state untouched on failure', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.debit(movement('20.01'))).toThrow('Insufficient funds.');
    expect(wallet.balance.toDecimal()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects an operation in another currency', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.credit({ ...movement('1.00'), money: Money.fromDecimal('1.00', 'USD') }),
    ).toThrow(/Currency mismatch/);
    expect(wallet.version).toBe(1);
  });

  it('credits and rehydrates without revalidating', () => {
    const wallet = openWallet('0.00');
    wallet.credit(movement('0.10'));
    wallet.credit(movement('0.20'));
    expect(wallet.balance.toDecimal()).toBe('0.30');
    const copy = Wallet.rehydrate({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    expect(copy.version).toBe(3);
  });
});

describe('WalletLedgerEntry', () => {
  const state = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    direction: 'DEBIT' as const,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    createdAt: at,
  };

  it('validates its arithmetic in the factory', () => {
    expect(WalletLedgerEntry.create(state).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...state, balanceAfter: brl('41.00') })).toThrow(
      /inconsistent/,
    );
    expect(() => WalletLedgerEntry.create({ ...state, money: brl('0.00'), balanceAfter: brl('50.00') })).toThrow();
  });

  it('exposes no mutators', () => {
    const entry = WalletLedgerEntry.create(state);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(entry))).toEqual([
      'constructor',
      'isBalanced',
    ]);
  });
});

describe('WagerTransaction', () => {
  const base = {
    id: 't',
    providerId: 'prov',
    externalTransactionId: 'ext',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET' as const,
    money: brl('10.00'),
    createdAt: at,
  };

  it('is created PENDING and requires a reference only for REFUND and ROLLBACK', () => {
    expect(WagerTransaction.create(base).status).toBe('PENDING');
    expect(() => WagerTransaction.create({ ...base, kind: 'REFUND' })).toThrow(/requires/);
    expect(() =>
      WagerTransaction.create({ ...base, referenceExternalTransactionId: 'x' }),
    ).toThrow(/must not carry/);
    expect(
      WagerTransaction.create({ ...base, kind: 'ROLLBACK', referenceExternalTransactionId: 'x' })
        .requiresReference(),
    ).toBe(true);
  });

  it('allows PENDING -> PENDING_REFERENCE -> PROCESSED and then treats it as terminal', () => {
    const tx = WagerTransaction.create({ ...base, kind: 'REFUND', referenceExternalTransactionId: 'x' });
    tx.markPendingReference();
    tx.markProcessed('ref-id', at);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(() => tx.reject('X')).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it.each(['reject', 'fail'] as const)('%s is terminal and records the failure code', (method) => {
    const tx = WagerTransaction.create(base);
    tx[method]('CODE', at);
    expect(tx.failureCode).toBe('CODE');
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
  });

  it('rehydrate does not revalidate transitions', () => {
    const tx = WagerTransaction.rehydrate({ ...base, status: 'PROCESSED' });
    expect(tx.isTerminal()).toBe(true);
  });

  it('derives ledger direction and balance effect from the kind', () => {
    const make = (kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK') =>
      WagerTransaction.rehydrate({ ...base, kind, status: 'PENDING' });
    expect(make('BET').ledgerDirectionFor()).toBe('DEBIT');
    expect(make('WIN').ledgerDirectionFor()).toBe('CREDIT');
    expect(make('REFUND').ledgerDirectionFor()).toBe('CREDIT');
    expect(make('ROLLBACK').ledgerDirectionFor(make('BET'))).toBe('CREDIT');
    expect(make('ROLLBACK').ledgerDirectionFor(make('WIN'))).toBe('DEBIT');
    expect(() => make('LOSS').ledgerDirectionFor()).toThrow();
    expect(make('LOSS').affectsBalance()).toBe(false);
    expect(make('BET').matchesPayload('hash')).toBe(true);
    expect(make('BET').matchesPayload('other')).toBe(false);
  });
});

describe('IntegrationEvent and OutboxMessage', () => {
  const props = {
    eventId: 'ev1',
    aggregateId: 'agg',
    correlationId: 'corr',
    occurredAt: at,
    data: { walletId: 'w' },
  };

  it('keeps type and version on the class and serializes a stable envelope', () => {
    const event = WalletBalanceChanged.from(props);
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.toJSON()).toEqual({
      eventId: 'ev1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'agg',
      correlationId: 'corr',
      causationId: null,
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      data: { walletId: 'w' },
    });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(integrationEventFor('WagerTransactionRejected', props).eventType).toBe(
      'WagerTransactionRejected',
    );
  });

  it('enqueues a due message and schedules exponential retries until published', () => {
    const message = OutboxMessage.enqueue(WalletBalanceChanged.from(props));
    expect(message.isDue(at)).toBe(true);
    message.scheduleRetry(at, 1000, 3000);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 1000);
    expect(message.isDue(at)).toBe(false);
    message.scheduleRetry(at, 1000, 3000);
    message.scheduleRetry(at, 1000, 3000);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 3000);
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 10_000))).toBe(false);
  });
});

describe('InboxMessage', () => {
  it('records receipt and can be processed once', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: at,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at)).toThrow();
    expect(() =>
      InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', receivedAt: at }),
    ).toThrow();
  });
});
