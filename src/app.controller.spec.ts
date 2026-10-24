import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WagerTransactionService } from './application/wager-transaction.service.js';

describe('AppController', () => {
  let appController: AppController;
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
    vi.clearAllMocks();
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: WagerTransactionService,
          useValue: transactions,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  it('requires the Idempotency-Key header for wager requests', async () => {
    await expect(
      appController.createWagerTransaction(undefined, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transactions.process).not.toHaveBeenCalled();
  });

  it.each([
    ['PROCESSED', false, 201],
    ['PROCESSED', true, 200],
    ['REJECTED', false, 422],
    ['PENDING_REFERENCE', false, 202],
  ])('maps %s (replay=%s) to HTTP %i with a Money balance', async (status, replay, code) => {
    transactions.process.mockResolvedValue({
      transactionId: 'transaction-id',
      status,
      failureCode: status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
      balanceAfterMinor: '900',
      idempotentReplay: replay,
    });
    const response = { status: vi.fn() };
    const result = await appController.createWagerTransaction(
      'key-1',
      {
        providerId: 'p',
        externalTransactionId: 'e',
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      response as never,
    );
    expect(response.status).toHaveBeenCalledWith(code);
    expect(result).toMatchObject({
      status,
      balance: { amount: '9.00', currency: 'BRL' },
      idempotentReplay: replay,
    });
  });

  it('maps the required money and transaction fields to the use case', async () => {
    transactions.process.mockResolvedValue({
      transactionId: 'transaction-id',
      status: 'PROCESSED',
      failureCode: null,
      balanceAfterMinor: '900',
      idempotentReplay: false,
    });
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

    await appController.createWagerTransaction('key-1', body);

    expect(transactions.process).toHaveBeenCalledWith({
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'key-1',
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      type: 'BET',
      amount: '1.00',
      currency: 'BRL',
    });
  });

  it('creates wallets from exact money and rejects malformed money', async () => {
    transactions.initializeWallet.mockResolvedValue({
      walletId: 'wallet-1',
      replayed: false,
    });
    await expect(
      appController.createWallet({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    ).resolves.toEqual({
      id: 'wallet-1',
      playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
      balance: { amount: '10.00', currency: 'BRL' },
      version: 1,
    });
    await expect(
      appController.createWallet({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.0', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    transactions.initializeWallet.mockResolvedValueOnce({
      walletId: 'wallet-1',
      replayed: true,
    });
    await expect(
      appController.createWallet({
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('routes all wallet and transaction queries to the application service', async () => {
    transactions.getWallet.mockResolvedValue({ walletId: 'wallet-1' });
    transactions.getLedger.mockResolvedValue({ items: [], nextCursor: null });
    transactions.getTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    transactions.getProviderTransaction.mockResolvedValue({
      transactionId: 'tx-2',
    });

    await expect(appController.getWallet('wallet-1')).resolves.toEqual({
      walletId: 'wallet-1',
    });
    await expect(
      appController.getWalletLedger('wallet-1', 'cursor-1', 25),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(appController.getTransaction('tx-1')).resolves.toEqual({
      transactionId: 'tx-1',
    });
    await expect(
      appController.getProviderTransaction('provider-1', 'external-1'),
    ).resolves.toEqual({ transactionId: 'tx-2' });
    expect(transactions.getLedger).toHaveBeenCalledWith(
      'wallet-1',
      'cursor-1',
      25,
    );
    expect(transactions.getProviderTransaction).toHaveBeenCalledWith(
      'provider-1',
      'external-1',
    );
  });

  it('preserves not-found and idempotency-conflict application errors', async () => {
    transactions.getWallet.mockRejectedValueOnce(
      new NotFoundException('Wallet was not found.'),
    );
    await expect(appController.getWallet('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    transactions.process.mockRejectedValueOnce(
      new ConflictException('Idempotency payload conflict.'),
    );
    await expect(
      appController.createWagerTransaction('key-1', {
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
        walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('routes reconciliation and liveness checks', async () => {
    transactions.reconcileWallet.mockResolvedValue({
      walletId: 'wallet-1',
      currency: 'BRL',
      balanceMinor: '1000',
      ledgerBalanceMinor: '900',
      checkedEntries: 2,
      consistent: false,
    });
    await expect(
      appController.reconcileWallet('wallet-1'),
    ).resolves.toEqual({
      walletId: 'wallet-1',
      storedBalance: { amount: '10.00', currency: 'BRL' },
      calculatedBalance: { amount: '9.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    expect(appController.healthLive()).toEqual({ status: 'live' });
  });

  it('reports database readiness in the health response and HTTP status', async () => {
    const response = { status: vi.fn() };
    transactions.checkReadiness.mockResolvedValue({ ready: false });

    await expect(
      appController.healthReady(response as never),
    ).resolves.toEqual({ ready: false });
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
