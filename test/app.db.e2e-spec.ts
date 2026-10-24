import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  createDisposableDatabase,
  DisposableDatabase,
} from './support/disposable-database.js';

describe('HTTP API with the real financial service and PostgreSQL (e2e)', () => {
  let database: DisposableDatabase;
  let app: INestApplication<App>;
  let sqs: SQSClient | undefined;
  let queueUrl: string | undefined;
  const envBackup = { ...process.env };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    database = await createDisposableDatabase();
    const { default: config } = await import('../src/mikro-orm.config.js');
    const { MikroORM } = await import('@mikro-orm/core');
    const migrationOrm = await MikroORM.init(config);
    try {
      await migrationOrm.migrator.up();
    } finally {
      await migrationOrm.close(true);
    }

    const endpoint = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `http-ready-${randomUUID().slice(0, 8)}.fifo`,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl;
    Object.assign(process.env, {
      SQS_INBOX_QUEUE_URL: queueUrl,
      SQS_ENDPOINT_URL: endpoint,
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      SQS_QUEUE_URL: '',
    });

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (sqs && queueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    }
    sqs?.destroy();
    await database?.drop();
    Object.assign(process.env, envBackup);
  }, 60_000);

  it('reports liveness and readiness backed by PostgreSQL and SQS', async () => {
    await http().get('/health/live').expect(200);
    await http().get('/health/ready').expect(200);
  });

  it('creates a wallet, processes idempotent wagers, and exposes balance, ledger, and reconciliation', async () => {
    const playerId = randomUUID();
    const created = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);
    expect(created.body).toMatchObject({
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = created.body.id as string;

    await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })
      .expect(409);

    const idempotencyKey = randomUUID();
    const providerId = `http-${randomUUID()}`;
    const externalTransactionId = randomUUID();
    const body = {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'game',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    const first = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
      balance: { amount: '70.00', currency: 'BRL' },
    });

    const replay = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      idempotentReplay: true,
    });

    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({ ...body, money: { amount: '31.00', currency: 'BRL' } })
      .expect(409);

    await http().post('/wagering/transactions').send(body).expect(400);

    const wallet = await http().get(`/wallets/${walletId}`).expect(200);
    expect(wallet.body.balance).toBe('70.00');

    const ledger = await http().get(`/wallets/${walletId}/ledger`).expect(200);
    expect(ledger.body.items).toHaveLength(2);

    const byId = await http()
      .get(`/wagering/transactions/${first.body.transactionId as string}`)
      .expect(200);
    expect(byId.body).toMatchObject({ status: 'PROCESSED' });
    await http()
      .get(`/providers/${providerId}/wagering/transactions/${externalTransactionId}`)
      .expect(200)
      .expect(({ body: found }) =>
        expect(found.transactionId).toBe(first.body.transactionId),
      );

    await http()
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200)
      .expect(({ body: result }) =>
        expect(result).toMatchObject({
          consistent: true,
          checkedEntries: 2,
          storedBalance: { amount: '70.00', currency: 'BRL' },
          calculatedBalance: { amount: '70.00', currency: 'BRL' },
          difference: { amount: '0.00', currency: 'BRL' },
        }),
      );
  });

  it('rejects a bet above the balance without changing the wallet', async () => {
    const playerId = randomUUID();
    const { body: created } = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } })
      .expect(201);
    const response = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send({
        providerId: `http-${randomUUID()}`,
        externalTransactionId: randomUUID(),
        playerId,
        walletId: created.id,
        roundId: randomUUID(),
        gameId: 'game',
        kind: 'BET',
        money: { amount: '10.01', currency: 'BRL' },
      });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    const wallet = await http().get(`/wallets/${created.id as string}`).expect(200);
    expect(wallet.body.balance).toBe('10.00');
  });

  it('returns 404 for unknown resources and 400 for malformed identifiers', async () => {
    await http().get(`/wallets/${randomUUID()}`).expect(404);
    await http().get(`/wagering/transactions/${randomUUID()}`).expect(404);
    await http().get('/wallets/not-a-uuid').expect(400);
    await http().get('/wagering/transactions/not-a-uuid').expect(400);
  });
});
