import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service.js';
import { WagerTransactionService } from './application/wager-transaction.service.js';
import { Money } from './domain/value-objects/money.js';

function recordBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${key} is required and must be a string.`);
  }
  return value;
}

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly transactions: WagerTransactionService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('wallets')
  async createWallet(@Body() bodyValue: unknown): Promise<unknown> {
    const body = recordBody(bodyValue);
    const initial = recordBody(body.initialBalance);
    let openingBalance: Money;
    try {
      openingBalance = Money.fromDecimal(
        requiredString(initial, 'amount'),
        requiredString(initial, 'currency'),
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const playerId = requiredString(body, 'playerId');
    const result = await this.transactions.initializeWallet({
      playerId,
      currency: openingBalance.currency,
      openingBalanceMinor: openingBalance.minorUnits.toString(),
    });
    if (result.replayed) {
      throw new ConflictException(
        'A wallet already exists for this player and currency.',
      );
    }
    return {
      id: result.walletId,
      playerId: playerId.toLowerCase(),
      balance: openingBalance.toJSON(),
      version: 1,
    };
  }

  @Get('wallets/:walletId')
  getWallet(@Param('walletId') walletId: string): Promise<Record<string, unknown>> {
    return this.transactions.getWallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    return this.transactions.getLedger(walletId, cursor, limit ?? 50);
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(
    @Param('transactionId') transactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.getProviderTransaction(
      providerId,
      externalTransactionId,
    );
  }

  @Post('wagering/transactions')
  async createWagerTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() bodyValue: unknown,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<unknown> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }
    const body = recordBody(bodyValue);
    const kind = requiredString(body, 'kind');
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) {
      throw new BadRequestException('kind is not supported.');
    }
    const request = {
      providerId: requiredString(body, 'providerId'),
      externalTransactionId: requiredString(body, 'externalTransactionId'),
      idempotencyKey,
      playerId: requiredString(body, 'playerId'),
      walletId: requiredString(body, 'walletId'),
      roundId: requiredString(body, 'roundId'),
      gameId: requiredString(body, 'gameId'),
      type: kind as 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
      amount: requiredString(
        (typeof body.money === 'object' && body.money !== null
          ? body.money
          : body) as Record<string, unknown>,
        'amount',
      ),
      currency: requiredString(
        (typeof body.money === 'object' && body.money !== null
          ? body.money
          : body) as Record<string, unknown>,
        'currency',
      ),
      ...(typeof body.referenceExternalTransactionId === 'string'
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
        : {}),
    };
    const result = await this.transactions.process(request);
    // 201 applied, 200 replay, 202 awaiting reference, 422 business rejection.
    const httpStatus =
      result.status === 'REJECTED'
        ? 422
        : result.status === 'PROCESSED'
          ? result.idempotentReplay
            ? 200
            : 201
          : 202;
    response?.status(httpStatus);
    return {
      transactionId: result.transactionId,
      status: result.status,
      failureCode: result.failureCode,
      balance: Money.fromMinorUnits(
        result.balanceAfterMinor,
        request.currency,
      ).toJSON(),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  async reconcileWallet(
    @Param('walletId') walletId: string,
  ): Promise<unknown> {
    const result = await this.transactions.reconcileWallet(walletId);
    const stored = BigInt(result.balanceMinor);
    const calculated = BigInt(result.ledgerBalanceMinor);
    const delta = stored - calculated;
    const absolute = delta < 0n ? -delta : delta;
    return {
      walletId: result.walletId,
      storedBalance: Money.fromMinorUnits(stored, result.currency).toJSON(),
      calculatedBalance: Money.fromMinorUnits(
        calculated < 0n ? 0n : calculated,
        result.currency,
      ).toJSON(),
      difference: {
        amount: `${delta < 0n ? '-' : ''}${Money.fromMinorUnits(absolute, result.currency).toDecimal()}`,
        currency: result.currency,
      },
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  @Get('health/live')
  healthLive(): { status: 'live' } {
    return { status: 'live' };
  }

  @Get('health/ready')
  async healthReady(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ready: boolean }> {
    const result = await this.transactions.checkReadiness();
    if (!result.ready) response.status(503);
    return result;
  }
}
