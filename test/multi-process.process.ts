import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
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
import { createDisposableDatabase, DisposableDatabase } from './support/disposable-database.js';

const ENDPOINT = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const RUN_ID = randomUUID().slice(0, 8);

type Row = Record<string, unknown>;
interface Infra {
  input: string;
  dlq: string;
  destination: string;
}
interface Worker {
  child: ChildProcess;
  pid: number;
  port: number;
  lines: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe('Independent application processes against real PostgreSQL and LocalStack', () => {
  let database: DisposableDatabase;
  let orm: MikroORM;
  let sqs: SQSClient;
  let infra: Infra;
  let queues: string[] = [];
  let workers: Worker[] = [];

  const sql = async <T = Row[]>(query: string, params: unknown[] = []): Promise<T> =>
    (await orm.em.fork().getConnection().execute(query, params)) as unknown as T;
  const scalar = async (query: string, params: unknown[] = []) =>
    Number((await sql<{ n: string }[]>(query, params))[0]?.n);

  async function createQueue(name: string, attributes: Record<string, string> = {}) {
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: `${name}-${RUN_ID}-${randomUUID().slice(0, 6)}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
      }),
    );
    const url = created.QueueUrl as string;
    queues.push(url);
    const arn = (
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn as string;
    return { url, arn };
  }

  async function queueDepth(url: string) {
    const attributes =
      (
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
    return Object.values(attributes).reduce((total, value) => total + Number(value), 0);
  }

  async function drainEventIds(url: string) {
    const ids = new Set<string>();
    let received = 0;
    let emptyPolls = 0;
    while (emptyPolls < 3) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 60,
        }),
      );
      const messages = response.Messages ?? [];
      emptyPolls = messages.length === 0 ? emptyPolls + 1 : 0;
      for (const message of messages) {
        received += 1;
        ids.add((JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId);
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
    return { ids, received };
  }

  function baseEnv(port: number, outboxEnabled: boolean): NodeJS.ProcessEnv {
    return {
      ...process.env,
      POSTGRES_DB: database.name,
      PORT: String(port),
      AWS_REGION: REGION,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_ENDPOINT_URL: ENDPOINT,
      SQS_INBOX_QUEUE_URL: infra.input,
      SQS_DLQ_QUEUE_URL: infra.dlq,
      SQS_QUEUE_URL: outboxEnabled ? infra.destination : '',
      SQS_MAX_MESSAGES_PER_POLL: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
      OUTBOX_POLL_INTERVAL_MS: '200',
      OUTBOX_BASE_BACKOFF_MS: '200',
      OUTBOX_MAX_BACKOFF_MS: '1000',
    };
  }

  async function startWorker(options: {
    crashAfterCommit?: boolean;
    outbox?: boolean;
  } = {}): Promise<Worker> {
    // Safety: workers must only ever see the disposable database.
    expect(database.name.startsWith('wagering_it_')).toBe(true);
    const port = await freePort();
    const env = baseEnv(port, options.outbox ?? !options.crashAfterCommit);
    const child = options.crashAfterCommit
      ? spawn('node', ['test/support/crash-worker.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('node', ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buffer = '';
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      lines.push(...parts);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const worker: Worker = { child, pid: child.pid as number, port, lines, exit };
    workers.push(worker);

    await vi.waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`worker exited early: ${lines.slice(-5).join('\n')}`);
        }
        if (options.crashAfterCommit) {
          expect(lines.some((line) => line === 'READY')).toBe(true);
          return;
        }
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
        expect(response.status).toBe(200);
      },
      { timeout: 60_000, interval: 300 },
    );
    return worker;
  }

  async function stopAll() {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
        await once(worker.child, 'exit');
      }
    }
    workers = [];
  }

  async function createWallet(port: number, balance = '100.00') {
    const playerId = randomUUID();
    const response = await fetch(`http://127.0.0.1:${port}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    return { walletId: body.id, playerId };
  }

  async function send(
    walletId: string,
    playerId: string,
    amount: string,
    twice = false,
  ) {
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();
    const body = JSON.stringify({
      type: 'WagerTransactionRequested',
      messageId,
      occurredAt: new Date().toISOString(),
      data: {
        providerId: `provider-${RUN_ID}`,
        externalTransactionId: randomUUID(),
        idempotencyKey,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'game',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
    });
    // A distinct group per message lets separate processes take them concurrently.
    for (let copy = 0; copy < (twice ? 2 : 1); copy += 1) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: infra.input,
          MessageBody: body,
          MessageGroupId: randomUUID(),
          MessageDeduplicationId: randomUUID(),
        }),
      );
    }
    return { messageId, idempotencyKey };
  }

  async function assertConsistent(walletIds: string[]) {
    const rows = await sql<{ id: string; balance_minor: string; ledger: string }[]>(
      `select w.id, w.balance_minor::text balance_minor,
              coalesce((select sum(case when l.direction = 'DEBIT' then -l.amount_minor else l.amount_minor end) from wallet_ledger_entries l where l.wallet_id = w.id), 0)::text ledger
         from wallets w where w.id = any(?::uuid[])`,
      [`{${walletIds.join(',')}}`],
    );
    expect(rows).toHaveLength(walletIds.length);
    for (const row of rows) {
      expect(row.balance_minor).toBe(row.ledger);
      expect(BigInt(row.balance_minor) >= 0n).toBe(true);
    }
  }

  beforeAll(async () => {
    sqs = new SQSClient({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  beforeEach(async () => {
    database = await createDisposableDatabase();
    const { default: config } = await import('../src/mikro-orm.config.js');
    orm = await MikroORM.init({ ...config, dbName: database.name });
    await orm.migrator.up();
    const dlq = await createQueue('proc-dlq');
    const input = await createQueue('proc-in', {
      VisibilityTimeout: '5',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: '10' }),
    });
    const destination = await createQueue('proc-out');
    infra = { input: input.url, dlq: dlq.url, destination: destination.url };
  }, 60_000);

  afterEach(async () => {
    await stopAll();
    for (const url of queues) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    queues = [];
    await orm?.close(true);
    await database?.drop();
  }, 60_000);

  afterAll(() => sqs?.destroy());

  it('keeps one debit per contested wallet across three independent processes, with duplicate deliveries', async () => {
    const processes = await Promise.all([startWorker(), startWorker(), startWorker()]);
    expect(new Set(processes.map((worker) => worker.pid)).size).toBe(3);
    expect(processes.every((worker) => worker.pid !== process.pid)).toBe(true);

    const wallets = [];
    for (let index = 0; index < 8; index += 1) {
      wallets.push(await createWallet(processes[index % 3]!.port));
    }
    for (const wallet of wallets) {
      await send(wallet.walletId, wallet.playerId, '80.00', true);
      await send(wallet.walletId, wallet.playerId, '80.00', true);
    }

    await vi.waitFor(
      async () => {
        expect(await scalar('select count(*)::int n from wager_transactions where kind <> \'OPENING\'')).toBe(16);
        expect(await queueDepth(infra.input)).toBe(0);
      },
      { timeout: 90_000, interval: 500 },
    );

    const ids = wallets.map((wallet) => wallet.walletId);
    for (const wallet of wallets) {
      const statuses = await sql<{ status: string }[]>(
        "select status from wager_transactions where wallet_id = ? and kind <> 'OPENING' order by status",
        [wallet.walletId],
      );
      expect(statuses.map((row) => row.status)).toEqual(['PROCESSED', 'REJECTED']);
      const wallet_ = (
        await sql<{ balance_minor: string }[]>(
          'select balance_minor::text balance_minor from wallets where id = ?',
          [wallet.walletId],
        )
      )[0];
      expect(wallet_?.balance_minor).toBe('2000');
      expect(
        await scalar(
          "select count(*)::int n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
          [wallet.walletId],
        ),
      ).toBe(1);
    }
    await assertConsistent(ids);
    expect(await scalar('select count(*)::int n from inbox_messages')).toBe(16);
    expect(await scalar('select count(*)::int n from inbox_messages where processed_at is null')).toBe(0);

    // Outbox: every event published exactly-once-as-distinct, none failed.
    await vi.waitFor(
      async () => {
        expect(await scalar('select count(*)::int n from outbox_messages where published_at is null')).toBe(0);
      },
      { timeout: 60_000, interval: 500 },
    );
    expect(await scalar('select count(*)::int n from outbox_messages where failed_at is not null')).toBe(0);
    const outboxRows = await scalar('select count(*)::int n from outbox_messages');
    const published = await drainEventIds(infra.destination);
    expect(published.ids.size).toBe(outboxRows);

    // Structured logs: JSON with the required correlation fields; work was shared.
    const handledPerProcess = processes.map((worker) => {
      const handled = worker.lines
        .map((line) => {
          try {
            return JSON.parse(line) as { pid?: number; message?: Record<string, unknown> };
          } catch {
            return undefined;
          }
        })
        .filter((entry) => entry?.message?.event === 'wager_transaction_handled' && entry.message.messageId);
      for (const entry of handled) {
        expect(entry?.pid).toBe(worker.pid);
        for (const field of ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId']) {
          expect(entry?.message?.[field]).toBeTruthy();
        }
        expect(JSON.stringify(entry)).not.toMatch(/"amount"|"money"|balanceMinor/);
      }
      return handled.length;
    });
    console.log(`handled per process (pid ${processes.map((w) => String(w.pid)).join(',')}): ${handledPerProcess.join(',')}`);
    expect(handledPerProcess.filter((count) => count > 0).length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('recovers after a real SIGKILL between database commit and SQS ACK without duplicating effects', async () => {
    const crashing = await startWorker({ crashAfterCommit: true });
    const { walletId, playerId } = await createWallet(
      (await startWorker({ outbox: false })).port,
    );
    // The HTTP helper worker also consumes; stop it so only the crashing worker owns the queue.
    const helper = workers.find((worker) => worker !== crashing) as Worker;
    helper.child.kill('SIGKILL');
    await helper.exit;

    const { idempotencyKey } = await send(walletId, playerId, '10.00');
    await vi.waitFor(() => expect(crashing.lines.some((line) => line.startsWith('COMMITTED'))).toBe(true), {
      timeout: 60_000,
      interval: 200,
    });

    // Committed but not ACKed: the message is still in flight, outbox rows are unpublished.
    expect(await scalar('select count(*)::int n from wager_transactions where idempotency_key = ?', [idempotencyKey])).toBe(1);
    expect(await queueDepth(infra.input)).toBe(1);
    // 2 events of the BET plus the wallet-opening event (helper worker runs without the outbox publisher).
    expect(await scalar('select count(*)::int n from outbox_messages where published_at is null')).toBe(3);

    crashing.child.kill('SIGKILL');
    expect(await crashing.exit).toEqual({ code: null, signal: 'SIGKILL' });

    const survivor = await startWorker();
    expect(survivor.pid).not.toBe(crashing.pid);

    await vi.waitFor(async () => expect(await queueDepth(infra.input)).toBe(0), {
      timeout: 60_000,
      interval: 500,
    });
    await vi.waitFor(
      async () =>
        expect(await scalar('select count(*)::int n from outbox_messages where published_at is null')).toBe(0),
      { timeout: 60_000, interval: 500 },
    );

    expect(await scalar('select count(*)::int n from wager_transactions where idempotency_key = ?', [idempotencyKey])).toBe(1);
    expect(await scalar('select count(*)::int n from inbox_messages')).toBe(1);
    expect(
      (await sql<{ balance_minor: string }[]>('select balance_minor::text balance_minor from wallets where id = ?', [walletId]))[0]?.balance_minor,
    ).toBe('9000');
    expect(await scalar("select count(*)::int n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId])).toBe(1);
    const outboxRows = await scalar('select count(*)::int n from outbox_messages');
    expect(outboxRows).toBe(3);
    expect((await drainEventIds(infra.destination)).ids.size).toBe(outboxRows);
    await assertConsistent([walletId]);
  }, 180_000);

  it('survives a SIGKILL under load and a SIGTERM, and converges to a consistent state after restart', async () => {
    const victim = await startWorker();
    const terminated = await startWorker();
    const wallets = [];
    for (let index = 0; index < 20; index += 1) wallets.push(await createWallet(victim.port));
    for (const wallet of wallets) {
      await send(wallet.walletId, wallet.playerId, '80.00');
      await send(wallet.walletId, wallet.playerId, '80.00');
    }

    await vi.waitFor(
      async () =>
        expect(await scalar('select count(*)::int n from wager_transactions where kind <> \'OPENING\'')).toBeGreaterThanOrEqual(4),
      { timeout: 60_000, interval: 100 },
    );
    victim.child.kill('SIGKILL');
    expect(await victim.exit).toEqual({ code: null, signal: 'SIGKILL' });

    terminated.child.kill('SIGTERM');
    const outcome = await terminated.exit;
    // Graceful shutdown: either a clean exit or the Nest hook re-raising SIGTERM after closing.
    expect(outcome.code === 0 || outcome.signal === 'SIGTERM').toBe(true);

    const restarted = await Promise.all([startWorker(), startWorker()]);
    expect(restarted.every((worker) => worker.pid !== victim.pid && worker.pid !== terminated.pid)).toBe(true);

    await vi.waitFor(
      async () => {
        expect(await scalar('select count(*)::int n from wager_transactions where kind <> \'OPENING\'')).toBe(40);
        expect(await queueDepth(infra.input)).toBe(0);
        expect(await scalar('select count(*)::int n from outbox_messages where published_at is null')).toBe(0);
      },
      { timeout: 150_000, interval: 1000 },
    );

    for (const wallet of wallets) {
      const statuses = await sql<{ status: string }[]>(
        "select status from wager_transactions where wallet_id = ? and kind <> 'OPENING' order by status",
        [wallet.walletId],
      );
      expect(statuses.map((row) => row.status)).toEqual(['PROCESSED', 'REJECTED']);
    }
    await assertConsistent(wallets.map((wallet) => wallet.walletId));
    expect(await scalar('select count(*)::int n from inbox_messages')).toBe(40);
    const outboxRows = await scalar('select count(*)::int n from outbox_messages');
    expect((await drainEventIds(infra.destination)).ids.size).toBe(outboxRows);
    expect(await scalar('select count(*)::int n from wallet_ledger_entries where direction = ?', ['DEBIT'])).toBe(20);
  }, 240_000);
});
