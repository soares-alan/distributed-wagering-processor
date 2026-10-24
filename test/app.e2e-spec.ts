import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';
import { InfrastructureExceptionFilter } from '../src/infrastructure-exception.filter.js';
import { WagerTransactionService } from '../src/application/wager-transaction.service.js';

describe('AppController HTTP contract (e2e)', () => {
  let app: INestApplication<App>;
  const transactions = {
    initializeWallet: vi.fn(),
    getWallet: vi.fn(),
    getLedger: vi.fn(),
    getTransaction: vi.fn(),
    getProviderTransaction: vi.fn(),
    process: vi.fn(),
    reconcileWallet: vi.fn(),
    checkReadiness: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    transactions.initializeWallet.mockResolvedValue({
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      balanceMinor: '1000',
      replayed: false,
    });
    transactions.getWallet.mockResolvedValue({
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      balance: '10.00',
      currency: 'BRL',
    });
    transactions.getLedger.mockResolvedValue({ items: [], nextCursor: null });
    transactions.getTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    transactions.getProviderTransaction.mockResolvedValue({
      transactionId: 'tx-1',
    });
    transactions.process.mockResolvedValue({
      transactionId: 'tx-1',
      status: 'PROCESSED',
      failureCode: null,
      balanceAfterMinor: '900',
      idempotentReplay: false,
    });
    transactions.reconcileWallet.mockResolvedValue({
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      currency: 'BRL',
      balanceMinor: '900',
      ledgerBalanceMinor: '900',
      checkedEntries: 3,
      consistent: true,
    });
    transactions.checkReadiness.mockResolvedValue({ ready: true });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: WagerTransactionService, useValue: transactions },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new InfrastructureExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a wallet and validates invalid money input', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(201)
      .expect({
        id: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        balance: { amount: '10.00', currency: 'BRL' },
        version: 1,
      });

    transactions.initializeWallet.mockResolvedValueOnce({
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      balanceMinor: '1000',
      replayed: true,
    });
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(409);

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.0', currency: 'BRL' },
      })
      .expect(400);
  });

  it('reads a wallet and returns 404 for a missing wallet', async () => {
    await request(app.getHttpServer())
      .get('/wallets/aa932b44-6f20-43b2-9172-590c5a7a606b')
      .expect(200)
      .expect(({ body }) => expect(body.balance).toBe('10.00'));

    transactions.getWallet.mockRejectedValueOnce(
      new NotFoundException('Wallet was not found.'),
    );
    await request(app.getHttpServer())
      .get('/wallets/aa932b44-6f20-43b2-9172-590c5a7a606b')
      .expect(404);

    transactions.getWallet.mockRejectedValueOnce(
      new BadRequestException('walletId must be a UUID.'),
    );
    await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);
  });

  it('reads a wallet ledger and validates its limit', async () => {
    await request(app.getHttpServer())
      .get('/wallets/aa932b44-6f20-43b2-9172-590c5a7a606b/ledger?limit=25')
      .expect(200)
      .expect({ items: [], nextCursor: null });
    expect(transactions.getLedger).toHaveBeenCalledWith(
      'aa932b44-6f20-43b2-9172-590c5a7a606b',
      undefined,
      25,
    );

    await request(app.getHttpServer())
      .get('/wallets/aa932b44-6f20-43b2-9172-590c5a7a606b/ledger?limit=bad')
      .expect(400);
  });

  it('looks up transactions by internal ID and provider reference', async () => {
    await request(app.getHttpServer())
      .get('/wagering/transactions/aa932b44-6f20-43b2-9172-590c5a7a606b')
      .expect(200)
      .expect({ transactionId: 'tx-1' });
    await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/ext-1')
      .expect(200)
      .expect({ transactionId: 'tx-1' });
  });

  it('requires Idempotency-Key, validates wager input, and propagates conflicts', async () => {
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(body)
      .expect(400);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-1')
      .send({ ...body, kind: 'INVALID' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-1')
      .send(body)
      .expect(201)
      .expect(({ body: result }) =>
        expect(result).toMatchObject({
          transactionId: 'tx-1',
          status: 'PROCESSED',
          balance: { amount: '9.00', currency: 'BRL' },
        }),
      );

    transactions.process.mockResolvedValueOnce({
      transactionId: 'tx-2',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balanceAfterMinor: '900',
      idempotentReplay: false,
    });
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-2')
      .send(body)
      .expect(422)
      .expect(({ body: result }) =>
        expect(result.failureCode).toBe('INSUFFICIENT_FUNDS'),
      );

    transactions.process.mockResolvedValueOnce({
      transactionId: 'tx-3',
      status: 'PENDING_REFERENCE',
      failureCode: null,
      balanceAfterMinor: '900',
      idempotentReplay: false,
    });
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-3')
      .send(body)
      .expect(202);

    transactions.process.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-4')
      .send(body)
      .expect(503)
      .expect('Retry-After', '1');

    transactions.process.mockRejectedValueOnce(
      new ConflictException('Idempotency key payload conflict.'),
    );
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'key-1')
      .send(body)
      .expect(409);
  });

  it('reconciles wallets and reports liveness/readiness', async () => {
    await request(app.getHttpServer())
      .post('/wallets/aa932b44-6f20-43b2-9172-590c5a7a606b/reconciliation')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          consistent: true,
          checkedEntries: 3,
          difference: { amount: '0.00', currency: 'BRL' },
        }),
      );
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'live' });
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ ready: true });

    transactions.checkReadiness.mockResolvedValueOnce({ ready: false });
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({ ready: false });
  });
});
