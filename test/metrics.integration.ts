import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { TracerService } from '@nestjs/observe';
import { Test, TestingModule } from '@nestjs/testing';
import type { WagerTransactionService } from '../src/application/wager-transaction.service.js';
import {
  createDisposableDatabase,
  DisposableDatabase,
} from './support/disposable-database.js';

const sum = (values: Record<string, number>) =>
  Object.values(values).reduce((total, value) => total + value, 0);

describe('Required observability metrics (real PostgreSQL)', () => {
  let database: DisposableDatabase;
  let orm: MikroORM;
  let moduleRef: TestingModule;
  let service: WagerTransactionService;
  let tracer: TracerService;

  const input = (walletId: string, playerId: string, idempotencyKey: string) => ({
    providerId: 'provider-metrics',
    externalTransactionId: idempotencyKey,
    idempotencyKey,
    playerId,
    walletId,
    roundId: randomUUID(),
    gameId: 'game',
    type: 'BET' as const,
    amount: '1.00',
    currency: 'BRL',
  });

  beforeAll(async () => {
    database = await createDisposableDatabase();
    const { default: config } = await import('../src/mikro-orm.config.js');
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    const { AppModule } = await import('../src/app.module.js');
    const { WagerTransactionService: Service } = await import(
      '../src/application/wager-transaction.service.js'
    );
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    service = moduleRef.get(Service);
    tracer = moduleRef.get(TracerService);
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
    await orm?.close(true);
    await database?.drop();
  }, 60_000);

  it('records idempotency-key lock conflicts, wallet-row lock conflicts and processing latency', async () => {
    const playerId = randomUUID();
    const { walletId } = await service.initializeWallet({
      playerId,
      currency: 'BRL',
      openingBalanceMinor: '1000000',
    });

    const conflicts = tracer.counter<'kind'>('wager_lock_conflicts_total', {
      labels: ['kind'],
    });
    const duration = tracer.summary<'http' | 'sqs'>('wager_processing_duration_ms', {
      labels: ['http', 'sqs'],
    });
    expect(sum(conflicts.value)).toBe(0);

    // Same idempotency key in parallel: serialized by the advisory lock.
    const samePayload = input(walletId, playerId, randomUUID());
    await Promise.all(Array.from({ length: 30 }, () => service.process(samePayload)));
    const afterSameKey = { ...conflicts.value };
    const idempotencyConflicts = Object.entries(afterSameKey).filter(([key]) =>
      key.includes('idempotency_key'),
    );
    expect(sum(Object.fromEntries(idempotencyConflicts))).toBeGreaterThan(0);

    // Distinct keys on one hot wallet: serialized by the wallet row lock.
    await Promise.all(
      Array.from({ length: 30 }, () => service.process(input(walletId, playerId, randomUUID()))),
    );
    const walletConflicts = Object.entries(conflicts.value).filter(([key]) =>
      key.includes('wallet_row'),
    );
    expect(sum(Object.fromEntries(walletConflicts))).toBeGreaterThan(0);

    // 60 use-case invocations over HTTP-style (no inbox) calls were timed.
    expect(sum(duration.observations)).toBeGreaterThanOrEqual(60);
    expect(Object.keys(duration.p95).some((key) => key.includes('http'))).toBe(true);
    for (const value of Object.values(duration.p95)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }

    // The metrics did not alter financial results: 31 distinct debits of 1.00.
    expect((await service.reconcileWallet(walletId)).consistent).toBe(true);
  });
});
