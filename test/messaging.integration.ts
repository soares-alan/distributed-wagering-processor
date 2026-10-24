import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import type { WagerTransactionService } from '../src/application/wager-transaction.service.js';
import {
  createDisposableDatabase,
  DisposableDatabase,
} from './support/disposable-database.js';

const ENDPOINT = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const RUN_ID = randomUUID().slice(0, 8);
const FAULT_PREFIX = 'fault-injection:';
const FAULT_LEDGER_AMOUNT_MINOR = 123456;
// A processed wager emits WalletBalanceChanged and WagerTransactionProcessed.
const EVENTS_PER_PROCESSED_WAGER = 2;

type Row = Record<string, unknown>;

describe('Atomicity, SQS inbox consumer and outbox publisher (real PostgreSQL + LocalStack)', () => {
  let database: DisposableDatabase;
  let orm: MikroORM;
  let sqs: SQSClient;
  const createdQueues: string[] = [];
  const modules: TestingModule[] = [];
  const envBackup = { ...process.env };

  const sql = async <T = Row[]>(query: string, params: unknown[] = []): Promise<T> =>
    (await orm.em.fork().getConnection().execute(query, params)) as unknown as T;

  const setFaults = async (enabled: boolean) => {
    const action = enabled ? 'enable' : 'disable';
    await sql(`alter table outbox_messages ${action} trigger test_fail_outbox`);
    await sql(`alter table wallet_ledger_entries ${action} trigger test_fail_ledger`);
  };

  async function createQueue(
    name: string,
    attributes: Record<string, string> = {},
  ): Promise<{ url: string; arn: string }> {
    const fullName = `${name}-${RUN_ID}.fifo`;
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: fullName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...attributes,
        },
      }),
    );
    const url = created.QueueUrl as string;
    createdQueues.push(url);
    const arn = (
      await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
      )
    ).Attributes?.QueueArn as string;
    return { url, arn };
  }

  async function createInputQueue(maxReceiveCount: number) {
    const dlq = await createQueue(`wt-dlq-${maxReceiveCount}`);
    const input = await createQueue(`wt-in-${maxReceiveCount}`, {
      VisibilityTimeout: '1',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlq.arn,
        maxReceiveCount: String(maxReceiveCount),
      }),
    });
    return { input: input.url, dlq: dlq.url };
  }

  async function depth(url: string): Promise<number> {
    const attributes = (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      )
    ).Attributes ?? {};
    return Object.values(attributes).reduce((sum, value) => sum + Number(value), 0);
  }

  async function drain(url: string, waitSeconds = 1): Promise<Row[]> {
    const bodies: Row[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: waitSeconds,
          VisibilityTimeout: 30,
        }),
      );
      for (const message of response.Messages ?? []) {
        bodies.push(JSON.parse(message.Body ?? '{}') as Row);
      }
    }
    return bodies;
  }

  async function startApp(env: Record<string, string | undefined>) {
    Object.assign(process.env, {
      SQS_INBOX_QUEUE_URL: '',
      SQS_DLQ_QUEUE_URL: '',
      SQS_QUEUE_URL: '',
      SQS_ENDPOINT_URL: ENDPOINT,
      AWS_REGION: REGION,
      SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '100',
      OUTBOX_BASE_BACKOFF_MS: '100',
      OUTBOX_MAX_BACKOFF_MS: '500',
      ...env,
    });
    const { AppModule } = await import('../src/app.module.js');
    const { WagerTransactionService: Service } = await import(
      '../src/application/wager-transaction.service.js'
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    modules.push(moduleRef);
    return { moduleRef, service: moduleRef.get(Service) };
  }

  const stopApp = async (moduleRef: TestingModule) => {
    await moduleRef.close();
    modules.splice(modules.indexOf(moduleRef), 1);
  };

  async function newWallet(service: WagerTransactionService, openingMinor: string) {
    const playerId = randomUUID();
    const { walletId } = await service.initializeWallet({
      playerId,
      currency: 'BRL',
      openingBalanceMinor: openingMinor,
    });
    return { walletId, playerId };
  }

  const balanceOf = async (walletId: string) =>
    String(
      (await sql<{ balance_minor: string }[]>(
        'select balance_minor from wallets where id = ?',
        [walletId],
      ))[0]?.balance_minor,
    );

  const count = async (query: string, params: unknown[]) =>
    Number((await sql<{ n: string }[]>(query, params))[0]?.n);

  const ledgerCount = (walletId: string) =>
    count('select count(*)::int n from wallet_ledger_entries where wallet_id = ?', [walletId]);

  const transactionCount = (idempotencyKey: string) =>
    count('select count(*)::int n from wager_transactions where idempotency_key = ?', [
      idempotencyKey,
    ]);

  const outboxCount = (correlationId: string) =>
    count('select count(*)::int n from outbox_messages where correlation_id = ?', [
      correlationId,
    ]);

  const wagerData = (
    walletId: string,
    playerId: string,
    overrides: Partial<{ idempotencyKey: string; amount: string }> = {},
  ) => ({
    providerId: `provider-${RUN_ID}`,
    externalTransactionId: randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    playerId,
    walletId,
    roundId: randomUUID(),
    gameId: 'game',
    kind: 'BET' as const,
    money: { amount: overrides.amount ?? '10.00', currency: 'BRL' },
  });

  const toInput = (data: ReturnType<typeof wagerData>) => ({
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    type: data.kind,
    amount: data.money.amount,
    currency: data.money.currency,
  });

  async function sendEnvelope(
    queueUrl: string,
    data: ReturnType<typeof wagerData>,
    messageId: string = randomUUID(),
  ) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          type: 'WagerTransactionRequested',
          messageId,
          occurredAt: new Date().toISOString(),
          data,
        }),
        MessageGroupId: data.walletId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    return messageId;
  }

  const eventually = (assertion: () => Promise<void>, timeout = 20_000) =>
    vi.waitFor(assertion, { timeout, interval: 200 });

  beforeAll(async () => {
    database = await createDisposableDatabase();
    const { default: config } = await import('../src/mikro-orm.config.js');
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    await sql(`
      create function test_fail_outbox() returns trigger language plpgsql as $$
      begin
        if new.correlation_id like '${FAULT_PREFIX}%' then
          raise exception 'injected outbox failure';
        end if;
        return new;
      end $$`);
    await sql(`
      create function test_fail_ledger() returns trigger language plpgsql as $$
      begin
        if new.amount_minor = ${FAULT_LEDGER_AMOUNT_MINOR} then
          raise exception 'injected ledger failure';
        end if;
        return new;
      end $$`);
    await sql(`create trigger test_fail_outbox before insert on outbox_messages
      for each row execute function test_fail_outbox()`);
    await sql(`create trigger test_fail_ledger before insert on wallet_ledger_entries
      for each row execute function test_fail_ledger()`);
    await setFaults(false);

    sqs = new SQSClient({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  }, 60_000);

  afterAll(async () => {
    for (const moduleRef of modules.splice(0)) await moduleRef.close();
    for (const url of createdQueues) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    sqs?.destroy();
    await orm?.close(true);
    await database?.drop();
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    Object.assign(process.env, envBackup);
  }, 60_000);

  describe('financial atomicity with a real database rollback', () => {
    let service: WagerTransactionService;
    let moduleRef: TestingModule;

    beforeAll(async () => {
      ({ moduleRef, service } = await startApp({}));
    });

    afterAll(async () => {
      await setFaults(false);
      await stopApp(moduleRef);
    });

    it.each([
      ['outbox insert', '10.00', true],
      ['ledger insert', '1234.56', false],
    ])(
      'leaves no partial state when the %s fails inside the transaction, and then processes exactly once',
      async (_name, amount, failOnCorrelation) => {
        const { walletId, playerId } = await newWallet(service, '500000');
        const idempotencyKey = failOnCorrelation
          ? `${FAULT_PREFIX}${randomUUID()}`
          : randomUUID();
        const input = toInput(wagerData(walletId, playerId, { idempotencyKey, amount }));
        const openingBalance = '500000';

        await setFaults(true);
        await expect(service.process(input)).rejects.toThrow();
        await setFaults(false);

        expect(await balanceOf(walletId)).toBe(openingBalance);
        expect(await ledgerCount(walletId)).toBe(1);
        expect(await transactionCount(idempotencyKey)).toBe(0);
        expect(await outboxCount(idempotencyKey)).toBe(0);
        expect((await service.reconcileWallet(walletId)).consistent).toBe(true);

        const first = await service.process(input);
        expect(first.status).toBe('PROCESSED');
        expect(first.idempotentReplay).toBe(false);
        const debitMinor = BigInt(amount.replace('.', ''));
        expect(await balanceOf(walletId)).toBe((BigInt(openingBalance) - debitMinor).toString());
        expect(await ledgerCount(walletId)).toBe(2);
        expect(await outboxCount(idempotencyKey)).toBe(EVENTS_PER_PROCESSED_WAGER);

        const replay = await service.process(input);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.transactionId).toBe(first.transactionId);
        expect(await ledgerCount(walletId)).toBe(2);
        expect(await transactionCount(idempotencyKey)).toBe(1);
        expect(await outboxCount(idempotencyKey)).toBe(EVENTS_PER_PROCESSED_WAGER);
        expect((await service.reconcileWallet(walletId)).consistent).toBe(true);
      },
    );
  });

  describe('SQS inbox consumer', () => {
    let service: WagerTransactionService;
    let moduleRef: TestingModule;
    let queues: { input: string; dlq: string };

    beforeAll(async () => {
      queues = await createInputQueue(20);
      ({ moduleRef, service } = await startApp({
        SQS_INBOX_QUEUE_URL: queues.input,
        SQS_DLQ_QUEUE_URL: queues.dlq,
      }));
    }, 60_000);

    afterAll(async () => {
      await setFaults(false);
      await stopApp(moduleRef);
    }, 60_000);

    it('consumes a real message, commits the financial change, and acknowledges it', async () => {
      const { walletId, playerId } = await newWallet(service, '10000');
      const data = wagerData(walletId, playerId);
      const messageId = await sendEnvelope(queues.input, data);

      await eventually(async () => {
        expect(await transactionCount(data.idempotencyKey)).toBe(1);
        expect(await depth(queues.input)).toBe(0);
      });
      expect(await balanceOf(walletId)).toBe('9000');
      expect(await ledgerCount(walletId)).toBe(2);
      expect(await outboxCount(data.idempotencyKey)).toBe(EVENTS_PER_PROCESSED_WAGER);
      expect(
        await count(
          'select count(*)::int n from inbox_messages where message_id = ? and processed_at is not null',
          [messageId],
        ),
      ).toBe(1);
    });

    it('deduplicates a redelivered message through the persistent inbox', async () => {
      const { walletId, playerId } = await newWallet(service, '10000');
      const data = wagerData(walletId, playerId);
      const messageId = await sendEnvelope(queues.input, data);
      await eventually(async () => {
        expect(await transactionCount(data.idempotencyKey)).toBe(1);
        expect(await depth(queues.input)).toBe(0);
      });

      await sendEnvelope(queues.input, data, messageId);
      await eventually(async () => expect(await depth(queues.input)).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await balanceOf(walletId)).toBe('9000');
      expect(await ledgerCount(walletId)).toBe(2);
      expect(await transactionCount(data.idempotencyKey)).toBe(1);
      expect(
        await count('select count(*)::int n from inbox_messages where message_id = ?', [
          messageId,
        ]),
      ).toBe(1);
    });

    it('does not debit twice when a commit succeeded but the ACK never happened', async () => {
      const { walletId, playerId } = await newWallet(service, '10000');
      const data = wagerData(walletId, playerId);
      const messageId = randomUUID();

      // Same use case and inbox identity as the consumer: commits, but no ACK is ever sent.
      await service.process(toInput(data), {
        messageId,
        consumerName: process.env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer',
      });
      expect(await balanceOf(walletId)).toBe('9000');

      await sendEnvelope(queues.input, data, messageId);
      await eventually(async () => expect(await depth(queues.input)).toBe(0));

      expect(await balanceOf(walletId)).toBe('9000');
      expect(await ledgerCount(walletId)).toBe(2);
      expect(await transactionCount(data.idempotencyKey)).toBe(1);
    });

    it('does not acknowledge a failed commit and succeeds on redelivery', async () => {
      const { walletId, playerId } = await newWallet(service, '10000');
      const data = wagerData(walletId, playerId, {
        idempotencyKey: `${FAULT_PREFIX}${randomUUID()}`,
      });

      await setFaults(true);
      await sendEnvelope(queues.input, data);
      await new Promise((resolve) => setTimeout(resolve, 3500));

      expect(await depth(queues.input)).toBe(1);
      expect(await transactionCount(data.idempotencyKey)).toBe(0);
      expect(await balanceOf(walletId)).toBe('10000');
      expect(await ledgerCount(walletId)).toBe(1);
      expect(await depth(queues.dlq)).toBe(0);

      await setFaults(false);
      await eventually(async () => {
        expect(await transactionCount(data.idempotencyKey)).toBe(1);
        expect(await depth(queues.input)).toBe(0);
      });
      expect(await balanceOf(walletId)).toBe('9000');
      expect(await ledgerCount(walletId)).toBe(2);
    }, 40_000);
  });

  describe('SQS dead-letter queue', () => {
    let service: WagerTransactionService;
    let moduleRef: TestingModule;
    let queues: { input: string; dlq: string };

    beforeAll(async () => {
      queues = await createInputQueue(2);
      ({ moduleRef, service } = await startApp({
        SQS_INBOX_QUEUE_URL: queues.input,
        SQS_DLQ_QUEUE_URL: queues.dlq,
      }));
    }, 60_000);

    afterAll(async () => {
      await setFaults(false);
      await stopApp(moduleRef);
    }, 60_000);

    it('moves a message that keeps failing to the DLQ without any financial effect', async () => {
      const { walletId, playerId } = await newWallet(service, '10000');
      const data = wagerData(walletId, playerId, {
        idempotencyKey: `${FAULT_PREFIX}${randomUUID()}`,
      });

      await setFaults(true);
      const messageId = await sendEnvelope(queues.input, data);

      await eventually(async () => expect(await depth(queues.dlq)).toBe(1), 40_000);
      await eventually(async () => expect(await depth(queues.input)).toBe(0), 20_000);
      await setFaults(false);

      const dead = await drain(queues.dlq, 2);
      expect(dead.map((body) => body.messageId)).toContain(messageId);
      expect(await transactionCount(data.idempotencyKey)).toBe(0);
      expect(await balanceOf(walletId)).toBe('10000');
      expect(await ledgerCount(walletId)).toBe(1);
    }, 90_000);
  });

  describe('transactional outbox publisher', () => {
    it('publishes committed events to SQS and never publishes a rolled-back transaction', async () => {
      const outbox = await createQueue('wt-out');
      const { moduleRef, service } = await startApp({ SQS_QUEUE_URL: outbox.url });
      try {
        const { walletId, playerId } = await newWallet(service, '10000');
        const committedKey = randomUUID();
        const rolledBackKey = `${FAULT_PREFIX}${randomUUID()}`;

        await setFaults(true);
        await expect(
          service.process(toInput(wagerData(walletId, playerId, { idempotencyKey: rolledBackKey }))),
        ).rejects.toThrow();
        await setFaults(false);
        await service.process(
          toInput(wagerData(walletId, playerId, { idempotencyKey: committedKey })),
        );

        await eventually(async () => {
          expect(
            await count(
              'select count(*)::int n from outbox_messages where correlation_id = ? and published_at is not null',
              [committedKey],
            ),
          ).toBe(EVENTS_PER_PROCESSED_WAGER);
        });

        const published = await drain(outbox.url, 2);
        const correlationIds = published.map((body) => body.correlationId);
        expect(correlationIds).toContain(committedKey);
        expect(correlationIds).not.toContain(rolledBackKey);
        expect(await outboxCount(rolledBackKey)).toBe(0);
      } finally {
        await stopApp(moduleRef);
      }
    }, 60_000);

    it('retries a failed publication and delivers it once SQS is reachable again', async () => {
      const outbox = await createQueue('wt-out-recovery');
      await sqs.send(new DeleteQueueCommand({ QueueUrl: outbox.url }));
      const { moduleRef, service } = await startApp({ SQS_QUEUE_URL: outbox.url });
      try {
        const { walletId, playerId } = await newWallet(service, '10000');
        const key = randomUUID();
        await service.process(toInput(wagerData(walletId, playerId, { idempotencyKey: key })));

        await eventually(async () => {
          const rows = await sql<{ attempts: number; last_error: string | null; published_at: Date | null }[]>(
            'select attempts, last_error, published_at from outbox_messages where correlation_id = ?',
            [key],
          );
          expect(rows[0]?.last_error).toBeTruthy();
          expect(rows[0]?.published_at).toBeNull();
          expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
        });

        await createQueue('wt-out-recovery');
        await eventually(async () => {
          expect(
            await count(
              'select count(*)::int n from outbox_messages where correlation_id = ? and published_at is not null',
              [key],
            ),
          ).toBe(EVENTS_PER_PROCESSED_WAGER);
        }, 30_000);

        const published = await drain(outbox.url, 2);
        expect(published.map((body) => body.correlationId)).toContain(key);
        expect(await balanceOf(walletId)).toBe('9000');
      } finally {
        await stopApp(moduleRef);
      }
    }, 90_000);
  });

  describe('concurrency across wallets and competing publishers', () => {
    const WALLETS = 12;

    it('processes distinct wallets in parallel and keeps each wallet reconciled', async () => {
      const { moduleRef, service } = await startApp({});
      try {
        const wallets = await Promise.all(
          Array.from({ length: WALLETS }, () => newWallet(service, '10000')),
        );
        const results = await Promise.all(
          wallets.flatMap(({ walletId, playerId }) =>
            [0, 1].map(() =>
              service.process(
                toInput(wagerData(walletId, playerId, { amount: '80.00' })),
              ),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(WALLETS);
        const rejected = results.filter((r) => r.status === 'REJECTED');
        expect(rejected).toHaveLength(WALLETS);
        expect(new Set(rejected.map((r) => r.failureCode))).toEqual(
          new Set(['INSUFFICIENT_FUNDS']),
        );
        for (const { walletId } of wallets) {
          expect(await balanceOf(walletId)).toBe('2000');
          // OPENING credit plus exactly one debit.
          expect(await ledgerCount(walletId)).toBe(2);
          expect((await service.reconcileWallet(walletId)).consistent).toBe(true);
        }
      } finally {
        await stopApp(moduleRef);
      }
    }, 60_000);

    it('lets two publishers drain the same outbox without losing events', async () => {
      const outbox = await createQueue('wt-out-two-publishers');
      // Producer without a destination queue: events stay pending in the outbox.
      const producer = await startApp({});
      const keys: string[] = [];
      try {
        const wallets = await Promise.all(
          Array.from({ length: 10 }, () => newWallet(producer.service, '10000')),
        );
        await Promise.all(
          wallets.map(({ walletId, playerId }) => {
            const key = randomUUID();
            keys.push(key);
            return producer.service.process(
              toInput(wagerData(walletId, playerId, { idempotencyKey: key })),
            );
          }),
        );
      } finally {
        await stopApp(producer.moduleRef);
      }
      const pending = await count(
        'select count(*)::int n from outbox_messages where correlation_id = any(?::text[]) and published_at is null',
        [`{${keys.join(',')}}`],
      );
      expect(pending).toBe(keys.length * EVENTS_PER_PROCESSED_WAGER);

      const first = await startApp({ SQS_QUEUE_URL: outbox.url });
      const second = await startApp({ SQS_QUEUE_URL: outbox.url });
      try {
        await eventually(async () => {
          expect(
            await count(
              'select count(*)::int n from outbox_messages where correlation_id = any(?::text[]) and published_at is not null',
              [`{${keys.join(',')}}`],
            ),
          ).toBe(keys.length * EVENTS_PER_PROCESSED_WAGER);
        }, 30_000);

        const eventIds = new Set<string>();
        for (let attempt = 0; attempt < 20 && eventIds.size < pending; attempt += 1) {
          const response = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: outbox.url,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
              VisibilityTimeout: 30,
            }),
          );
          for (const message of response.Messages ?? []) {
            eventIds.add(String((JSON.parse(message.Body ?? '{}') as Row).eventId));
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: outbox.url,
                ReceiptHandle: message.ReceiptHandle as string,
              }),
            );
          }
        }
        expect(eventIds.size).toBe(pending);
        expect(
          await count(
            'select count(*)::int n from outbox_messages where correlation_id = any(?::text[]) and failed_at is not null',
            [`{${keys.join(',')}}`],
          ),
        ).toBe(0);
      } finally {
        await stopApp(first.moduleRef);
        await stopApp(second.moduleRef);
      }
    }, 90_000);
  });
});
