import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import {
  createDisposableDatabase,
  DisposableDatabase,
} from './support/disposable-database.js';

const APPLICATION_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'outbox_messages',
  'inbox_messages',
];

describe('Schema migrations and ledger immutability (disposable PostgreSQL)', () => {
  let database: DisposableDatabase;
  let orm: MikroORM;

  const sql = async <T>(query: string, params: unknown[] = []): Promise<T> =>
    (await orm.em.fork().getConnection().execute(query, params)) as unknown as T;

  const existingTables = async () =>
    (
      await sql<{ table_name: string }[]>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name in (${APPLICATION_TABLES.map((name) => `'${name}'`).join(', ')})`,
      )
    ).map((row) => row.table_name);

  beforeAll(async () => {
    database = await createDisposableDatabase();
    const { default: config } = await import('../src/mikro-orm.config.js');
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm?.close(true);
    await database?.drop();
  });

  it('applies every migration, reverts them all, and applies them again', async () => {
    await orm.migrator.up();
    expect((await existingTables()).sort()).toEqual([...APPLICATION_TABLES].sort());
    expect(await orm.migrator.getPending()).toHaveLength(0);

    const executed = await orm.migrator.getExecuted();
    expect(executed.length).toBeGreaterThanOrEqual(6);

    await orm.migrator.down({ to: 0 });
    expect(await existingTables()).toEqual([]);
    expect(await orm.migrator.getExecuted()).toHaveLength(0);

    await orm.migrator.up();
    expect((await existingTables()).sort()).toEqual([...APPLICATION_TABLES].sort());
  });

  describe('with the schema applied', () => {
    let moduleRef: TestingModule;
    let walletId: string;
    let playerId: string;

    beforeAll(async () => {
      const { AppModule } = await import('../src/app.module.js');
      const { WagerTransactionService } = await import(
        '../src/application/wager-transaction.service.js'
      );
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      const service = moduleRef.get(WagerTransactionService);
      playerId = randomUUID();
      ({ walletId } = await service.initializeWallet({
        playerId,
        currency: 'BRL',
        openingBalanceMinor: '10000',
      }));
      await service.process({
        providerId: 'ledger-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'game',
        type: 'BET',
        amount: '25.00',
        currency: 'BRL',
      });
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('creates ledger rows through the normal flow', async () => {
      const rows = await sql<{ direction: string; amount_minor: string }[]>(
        'select direction, amount_minor from wallet_ledger_entries where wallet_id = ? order by created_at',
        [walletId],
      );
      expect(rows.map((row) => [row.direction, String(row.amount_minor)])).toEqual([
        ['CREDIT', '10000'],
        ['DEBIT', '2500'],
      ]);
      const wallet = await sql<{ balance_minor: string }[]>(
        'select balance_minor from wallets where id = ?',
        [walletId],
      );
      expect(String(wallet[0]?.balance_minor)).toBe('7500');
    });

    it.each([
      ['UPDATE', 'update wallet_ledger_entries set amount_minor = amount_minor + 1'],
      ['DELETE', 'delete from wallet_ledger_entries'],
      ['TRUNCATE', 'truncate table wallet_ledger_entries'],
    ])('rejects %s on the append-only ledger', async (_name, statement) => {
      await expect(sql(statement)).rejects.toThrow(/append-only/);
      const count = await sql<{ n: string }[]>(
        'select count(*)::text n from wallet_ledger_entries where wallet_id = ?',
        [walletId],
      );
      expect(count[0]?.n).toBe('2');
    });

    it('rejects a ledger row whose balances are arithmetically inconsistent', async () => {
      const tx = await sql<{ id: string }[]>(
        'select id from wager_transactions where wallet_id = ? limit 1',
        [walletId],
      );
      await expect(
        sql(
          `insert into wallet_ledger_entries
             (id, transaction_id, wallet_id, direction, amount_minor, currency,
              balance_before_minor, balance_after_minor, created_at)
           values (?, ?, ?, 'CREDIT', 100, 'BRL', 0, 5, now())`,
          [randomUUID(), tx[0]?.id, walletId],
        ),
      ).rejects.toThrow(/ledger_entries_balance_consistent/);
    });

    it('rejects a negative wallet balance at the database level', async () => {
      await expect(
        sql('update wallets set balance_minor = -1 where id = ?', [walletId]),
      ).rejects.toThrow(/wallets_balance_non_negative/);
    });
  });
});
