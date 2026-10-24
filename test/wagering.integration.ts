import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { OutboxSqsPublisher } from '../src/application/outbox-sqs-publisher.service.js';
import { SqsInboxConsumer } from '../src/application/sqs-inbox-consumer.service.js';
import { WagerTransactionService } from '../src/application/wager-transaction.service.js';
import mikroOrmConfig from '../src/mikro-orm.config.js';

describe('WagerTransactionService (PostgreSQL integration)', () => {
  let moduleRef: TestingModule;
  let service: WagerTransactionService;
  let orm: MikroORM;

  beforeAll(async () => {
    const migrationOrm = await MikroORM.init(mikroOrmConfig);
    try {
      await migrationOrm.migrator.up();
    } finally {
      await migrationOrm.close(true);
    }

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OutboxSqsPublisher)
      .useValue({})
      .overrideProvider(SqsInboxConsumer)
      .useValue({})
      .compile();
    await moduleRef.init();
    service = moduleRef.get(WagerTransactionService);
    orm = moduleRef.get(MikroORM);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('processes 50 concurrent submissions with one key exactly once', async () => {
    const wallet = await createWallet('100.00');
    const input = wagerInput(wallet.walletId, wallet.playerId, {
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '1.00',
      type: 'BET',
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.process(input)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    expect((await service.getWallet(wallet.walletId)).balance).toBe('99.00');
    const transactionRows = await orm.em
      .fork({ clear: true })
      .getConnection()
      .execute<{ count: string }[]>(
        `select count(*)::text as count
         from wager_transactions
         where provider_id = ? and idempotency_key = ?`,
        [input.providerId, input.idempotencyKey],
      );
    expect(transactionRows[0]?.count).toBe('1');
    const ledger = await service.getLedger(wallet.walletId);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await service.reconcileWallet(wallet.walletId)).consistent).toBe(true);
  });

  it('conflicts when an idempotency key is reused with a different payload', async () => {
    const wallet = await createWallet('10.00');
    const input = wagerInput(wallet.walletId, wallet.playerId, {
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '1.00',
      type: 'BET',
    });
    await service.process(input);

    await expect(
      service.process({
        ...input,
        externalTransactionId: randomUUID(),
        amount: '2.00',
      }),
    ).rejects.toThrow('Idempotency key was already used with a different business payload.');

    expect((await service.getWallet(wallet.walletId)).balance).toBe('9.00');
    expect((await service.getLedger(wallet.walletId)).items).toHaveLength(2);
  });

  it('serializes two 80.00 bets against a 100.00 wallet', async () => {
    const wallet = await createWallet('100.00');
    const results = await Promise.all(
      ['bet-a', 'bet-b'].map((externalTransactionId) =>
        service.process(
          wagerInput(wallet.walletId, wallet.playerId, {
            externalTransactionId,
            idempotencyKey: randomUUID(),
            amount: '80.00',
            type: 'BET',
          }),
        ),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect((await service.getWallet(wallet.walletId)).balance).toBe('20.00');
    const ledger = await service.getLedger(wallet.walletId);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await service.reconcileWallet(wallet.walletId)).consistent).toBe(true);
  });

  it('resolves a persisted rollback after its reference arrives later', async () => {
    const wallet = await createWallet('10.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = randomUUID();
    const referenceExternalTransactionId = randomUUID();
    const rollback = await service.process({
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId,
      gameId: 'integration-game',
      type: 'ROLLBACK',
      amount: '1.00',
      currency: 'BRL',
      referenceExternalTransactionId,
    });
    expect(rollback.status).toBe('PENDING_REFERENCE');

    await service.process({
      providerId,
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId,
      gameId: 'integration-game',
      type: 'WIN',
      amount: '1.00',
      currency: 'BRL',
    });
    await vi.waitFor(
      async () =>
        expect(
          (await service.getTransaction(rollback.transactionId)).status,
        ).toBe('PROCESSED'),
      { timeout: 5000, interval: 100 },
    );
    expect((await service.getWallet(wallet.walletId)).balance).toBe('10.00');
    expect((await service.reconcileWallet(wallet.walletId)).consistent).toBe(true);
  });

  async function createWallet(openingBalance: string) {
    const playerId = randomUUID();
    const wallet = await service.initializeWallet({
      playerId,
      currency: 'BRL',
      openingBalanceMinor: (BigInt(openingBalance.replace('.', ''))).toString(),
    });
    return { ...wallet, playerId };
  }

  function wagerInput(
    walletId: string,
    playerId: string,
    overrides: Partial<{
      externalTransactionId: string;
      idempotencyKey: string;
      amount: string;
      type: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
    }> = {},
  ) {
    return {
      providerId: `integration-${randomUUID()}`,
      externalTransactionId: overrides.externalTransactionId ?? randomUUID(),
      idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'integration-game',
      type: overrides.type ?? 'BET',
      amount: overrides.amount ?? '1.00',
      currency: 'BRL',
    } as const;
  }
});
