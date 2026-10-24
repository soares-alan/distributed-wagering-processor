import type { SqlEntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  EntityManager,
  LockMode,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { InboxMessageEntity } from '../database/entities/inbox-message.entity.js';
import { LedgerEntryEntity } from '../database/entities/ledger-entry.entity.js';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import { WagerTransactionEntity } from '../database/entities/wager-transaction.entity.js';
import { WalletEntity } from '../database/entities/wallet.entity.js';
import {
  calculateBalanceChange,
  type WagerTransactionType,
} from '../domain/wagering.rules.js';
import {
  integrationEventFor,
  type IntegrationEventType,
} from '../domain/integration-event.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import {
  WagerTransaction as DomainWagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { Wallet } from '../domain/wallet.js';
import { Money } from '../domain/value-objects/money.js';
import { createSqsClient, integerEnv } from './config.js';
import { WagerMetrics } from './wager-metrics.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WagerStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  type: WagerTransactionType;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

export interface InboxIdentity {
  messageId: string;
  consumerName: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerStatus;
  failureCode: string | null;
  balanceAfterMinor: string;
  idempotentReplay: boolean;
}

export interface InitializeWalletInput {
  playerId: string;
  currency: string;
  openingBalanceMinor: string;
}

export interface WalletReconciliationResult {
  walletId: string;
  currency: string;
  balanceMinor: string;
  ledgerBalanceMinor: string;
  checkedEntries: number;
  consistent: boolean;
}

interface NormalizedWagerInput extends ProcessWagerInput {
  playerId: string;
  amountMinor: string;
  currency: string;
  payloadHash: string;
}

interface LedgerCursor {
  createdAt: string;
  id: string;
}

interface InboxRegistration {
  inbox?: InboxMessageEntity;
  duplicate: boolean;
}

@Injectable()
export class WagerTransactionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionService.name);
  private pendingReferenceTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
    private readonly metrics: WagerMetrics,
  ) {}

  onModuleInit(): void {
    this.pendingReferenceTimer = setInterval(() => {
      void this.retryPendingReferences();
    }, integerEnv('PENDING_REFERENCE_POLL_INTERVAL_MS', 1000, 100, 60000));
  }

  onModuleDestroy(): void {
    if (this.pendingReferenceTimer) {
      clearInterval(this.pendingReferenceTimer);
    }
  }

  async initializeWallet(
    input: InitializeWalletInput,
  ): Promise<{ walletId: string; balanceMinor: string; replayed: boolean }> {
    if (!UUID_PATTERN.test(input.playerId)) {
      throw new BadRequestException('playerId must be a UUID.');
    }

    const openingAmount = this.moneyFromMinor(
      input.openingBalanceMinor,
      input.currency,
    );
    const playerId = input.playerId.toLowerCase();
    const now = new Date();
    const walletId = randomUUID();

    try {
      await this.orm.em.transactional(async (em) => {
        const existing = await em.findOne(WalletEntity, {
          playerId,
          currency: openingAmount.currency,
        });
        if (existing) {
          throw new ConflictException(
            'A wallet already exists for this player and currency.',
          );
        }

        const wallet = em.create(WalletEntity, {
          id: walletId,
          playerId,
          currency: openingAmount.currency,
          balanceMinor: openingAmount.minorUnits.toString(),
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        em.persist(wallet);

        if (openingAmount.minorUnits > 0n) {
          const transactionId = randomUUID();
          const internalProvider = 'internal';
          const externalTransactionId = `opening:${walletId}`;
          const idempotencyKey = externalTransactionId;
          const payloadHash = this.hashPayload({
            walletId,
            playerId,
            currency: openingAmount.currency,
            amount: openingAmount.toDecimal(),
            kind: 'OPENING',
          });
          const transaction = em.create(WagerTransactionEntity, {
            id: transactionId,
            providerId: internalProvider,
            externalTransactionId,
            idempotencyKey,
            payloadHash,
            walletId,
            playerId,
            roundId: 'internal',
            gameId: 'internal',
            kind: 'OPENING',
            status: 'PROCESSED',
            amountMinor: openingAmount.minorUnits.toString(),
            currency: openingAmount.currency,
            balanceAfterMinor: openingAmount.minorUnits.toString(),
            processedAt: now,
            createdAt: now,
            updatedAt: now,
            referenceAttempts: 0,
          });
          em.persist(transaction);
          em.persist(
            em.create(LedgerEntryEntity, {
              id: randomUUID(),
              transactionId,
              walletId,
              direction: 'CREDIT',
              amountMinor: openingAmount.minorUnits.toString(),
              currency: openingAmount.currency,
              balanceBeforeMinor: '0',
              balanceAfterMinor: openingAmount.minorUnits.toString(),
              createdAt: now,
            }),
          );
          this.persistEvent(em, {
            eventType: 'WalletBalanceChanged',
            aggregateId: transactionId,
            correlationId: transactionId,
            data: {
              transactionId,
              walletId,
              playerId,
              currency: openingAmount.currency,
              balanceBefore: '0.00',
              balanceAfter: openingAmount.toDecimal(),
              reason: 'OPENING',
            },
            occurredAt: now,
          });
        }
        await em.flush();
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException(
          'A wallet already exists for this player and currency.',
        );
      }
      throw error;
    }

    return {
      walletId,
      balanceMinor: openingAmount.minorUnits.toString(),
      replayed: false,
    };
  }

  async process(
    input: ProcessWagerInput,
    inboxIdentity?: InboxIdentity,
  ): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.processInTransaction(input, inboxIdentity);
      this.logger.log({
        event: 'wager_transaction_handled',
        correlationId: input.idempotencyKey,
        messageId: inboxIdentity?.messageId,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } finally {
      this.metrics.processingDurationObserved(
        performance.now() - startedAt,
        inboxIdentity ? 'sqs' : 'http',
      );
    }
  }

  private async processInTransaction(
    input: ProcessWagerInput,
    inboxIdentity?: InboxIdentity,
  ): Promise<ProcessWagerResult> {
    const request = this.normalize(input);
    if (
      inboxIdentity &&
      (!inboxIdentity.messageId ||
        inboxIdentity.messageId.length > 255 ||
        !inboxIdentity.consumerName)
    ) {
      throw new BadRequestException('Invalid SQS inbox identity.');
    }

    try {
      const result = await this.orm.em.transactional(async (em) => {
        const lockKey = JSON.stringify([
          request.providerId,
          request.idempotencyKey,
        ]);
        const [attempt] = await (em as SqlEntityManager).execute<
          { locked: boolean }[]
        >('select pg_try_advisory_xact_lock(hashtextextended(?, 0)) as locked', [
          lockKey,
        ]);
        if (!attempt?.locked) {
          this.metrics.lockConflict('idempotency_key');
          await (em as SqlEntityManager).execute(
            'select pg_advisory_xact_lock(hashtextextended(?, 0))',
            [lockKey],
          );
        }

        const inboxRegistration = inboxIdentity
          ? await this.registerInbox(em, inboxIdentity, request)
          : undefined;
        if (inboxRegistration?.duplicate) {
          this.metrics.inboxDuplicate();
          const prior = await em.findOne(WagerTransactionEntity, {
            providerId: request.providerId,
            idempotencyKey: request.idempotencyKey,
          });
          if (!prior) {
            throw new Error('Inbox message exists without a transaction record.');
          }
          if (prior.payloadHash !== request.payloadHash) {
            return {
              ...this.result(prior, prior.balanceAfterMinor, false),
              status: 'REJECTED' as const,
              failureCode: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            };
          }
          return this.replayOrConflict(prior, request.payloadHash);
        }
        const inbox = inboxRegistration?.inbox;

        const prior = await em.findOne(WagerTransactionEntity, {
          providerId: request.providerId,
          idempotencyKey: request.idempotencyKey,
        });
        if (prior) {
          if (prior.payloadHash !== request.payloadHash) {
            if (!inbox) {
              throw new ConflictException(
                'Idempotency key was already used with a different business payload.',
              );
            }
            const now = new Date();
            inbox.processedAt = now;
            this.persistEvent(em, {
              eventType: 'WagerTransactionRejected',
              aggregateId: prior.id,
              correlationId: request.idempotencyKey,
              causationId: request.externalTransactionId,
              data: {
                providerId: request.providerId,
                externalTransactionId: request.externalTransactionId,
                walletId: request.walletId,
                playerId: request.playerId,
                failureCode: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
              },
              occurredAt: now,
            });
            await em.flush();
            return {
              ...this.result(prior, prior.balanceAfterMinor, false),
              status: 'REJECTED' as const,
              failureCode: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            };
          }
          const replay = this.replayOrConflict(prior, request.payloadHash);
          if (inbox) inbox.processedAt = new Date();
          await em.flush();
          return replay;
        }

        const externalPrior = await em.findOne(WagerTransactionEntity, {
          providerId: request.providerId,
          externalTransactionId: request.externalTransactionId,
        });
        if (externalPrior) {
          const idempotentPrior = await em.findOne(WagerTransactionEntity, {
            providerId: request.providerId,
            idempotencyKey: request.idempotencyKey,
          });
          if (idempotentPrior) {
            if (idempotentPrior.payloadHash === request.payloadHash) {
              const replay = this.replayOrConflict(
                idempotentPrior,
                request.payloadHash,
              );
              if (inbox) inbox.processedAt = new Date();
              await em.flush();
              return replay;
            }
            if (!inbox) {
              throw new ConflictException(
                'Idempotency key was already used with a different business payload.',
              );
            }
            const now = new Date();
            inbox.processedAt = now;
            this.persistEvent(em, {
              eventType: 'WagerTransactionRejected',
              aggregateId: idempotentPrior.id,
              correlationId: request.idempotencyKey,
              causationId: request.externalTransactionId,
              data: {
                providerId: request.providerId,
                externalTransactionId: request.externalTransactionId,
                walletId: request.walletId,
                playerId: request.playerId,
                failureCode: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
              },
              occurredAt: now,
            });
            await em.flush();
            return {
              ...this.result(
                idempotentPrior,
                idempotentPrior.balanceAfterMinor,
                false,
              ),
              status: 'REJECTED' as const,
              failureCode: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            };
          }
          if (inbox) {
            const now = new Date();
            inbox.processedAt = now;
            this.persistEvent(em, {
              eventType: 'WagerTransactionRejected',
              aggregateId: externalPrior.id,
              correlationId: request.idempotencyKey,
              causationId: request.externalTransactionId,
              data: {
                providerId: request.providerId,
                externalTransactionId: request.externalTransactionId,
                failureCode: 'EXTERNAL_TRANSACTION_CONFLICT',
              },
              occurredAt: now,
            });
            await em.flush();
            return {
              ...this.result(externalPrior, externalPrior.balanceAfterMinor, false),
              status: 'REJECTED' as const,
              failureCode: 'EXTERNAL_TRANSACTION_CONFLICT',
            };
          }
          throw new ConflictException(
            'External transaction id was already used by this provider.',
          );
        }

        // SKIP LOCKED probe: empty means the row is locked elsewhere (or absent).
        const probe = await (em as SqlEntityManager).execute(
          'select id from wallets where id = ? for update skip locked',
          [request.walletId],
        );
        const wallet = await em.findOne(
          WalletEntity,
          { id: request.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!wallet) {
          throw new NotFoundException('Wallet was not found.');
        }
        if (probe.length === 0) this.metrics.lockConflict('wallet_row');

        const now = new Date();
        const transaction = em.create(WagerTransactionEntity, {
          id: randomUUID(),
          providerId: request.providerId,
          externalTransactionId: request.externalTransactionId,
          idempotencyKey: request.idempotencyKey,
          payloadHash: request.payloadHash,
          walletId: wallet.id,
          playerId: request.playerId,
          roundId: request.roundId,
          gameId: request.gameId,
          kind: request.type,
          status: 'PENDING',
          amountMinor: request.amountMinor,
          currency: request.currency,
          balanceAfterMinor: wallet.balanceMinor,
          referenceExternalTransactionId:
            request.referenceExternalTransactionId,
          createdAt: now,
          updatedAt: now,
          referenceAttempts: 0,
        });
        em.persist(transaction);

        let result: ProcessWagerResult;
        if (
          wallet.playerId !== request.playerId ||
          wallet.currency !== request.currency
        ) {
          result = this.reject(
            em,
            transaction,
            wallet.balanceMinor,
            'INVALID_WALLET',
            now,
          );
        } else {
          result = await this.applyTransaction(
            em,
            transaction,
            wallet,
            request,
            now,
          );
        }

        if (inbox) inbox.processedAt = new Date();
        await em.flush();
        return result;
      });
      if (inboxIdentity) {
        this.metrics.messageConsumed(result.status);
      }
      if (
        result.failureCode === 'IDEMPOTENCY_PAYLOAD_CONFLICT'
      ) {
        this.metrics.idempotencyConflict();
      }
      return result;
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) {
        if (
          error instanceof ConflictException &&
          error.message.toLowerCase().includes('idempotency')
        ) {
          this.metrics.idempotencyConflict();
        }
        throw error;
      }

      const em = this.orm.em.fork({ clear: true });
      const existing = await em.findOne(WagerTransactionEntity, {
        providerId: request.providerId,
        idempotencyKey: request.idempotencyKey,
      });
      if (existing) {
        if (existing.payloadHash === request.payloadHash) {
          return this.replayOrConflict(existing, request.payloadHash);
        }
        if (inboxIdentity) {
          return this.persistTerminalConflict(
            existing,
            request,
            inboxIdentity,
            'IDEMPOTENCY_PAYLOAD_CONFLICT',
          );
        }
        return this.replayOrConflict(existing, request.payloadHash);
      }
      const external = await em.findOne(WagerTransactionEntity, {
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
      });
      if (external) {
        if (inboxIdentity) {
          return this.persistTerminalConflict(
            external,
            request,
            inboxIdentity,
            'EXTERNAL_TRANSACTION_CONFLICT',
          );
        }
        throw new ConflictException(
          'External transaction id was already used by this provider.',
        );
      }
      if (inboxIdentity) {
        const inbox = await em.findOne(InboxMessageEntity, {
          consumerName: inboxIdentity.consumerName,
          messageId: inboxIdentity.messageId,
        });
        if (inbox) {
          if (inbox.payloadHash !== request.payloadHash) {
            throw new ConflictException(
              'SQS message id was reused with a different business payload.',
            );
          }
          const committed = await em.findOne(WagerTransactionEntity, {
            providerId: request.providerId,
            idempotencyKey: request.idempotencyKey,
          });
          if (committed) {
            return this.replayOrConflict(committed, request.payloadHash);
          }
        }
      }
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    this.assertUuid(walletId, 'walletId');
    const em = this.orm.em.fork({ clear: true });
    const wallet = await em.findOne(WalletEntity, {
      id: walletId.toLowerCase(),
    });
    if (!wallet) throw new NotFoundException('Wallet was not found.');
    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: Money.fromMinorUnits(wallet.balanceMinor, wallet.currency).toDecimal(),
      balanceMinor: wallet.balanceMinor,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  async getLedger(
    walletId: string,
    cursor?: string,
    requestedLimit = 50,
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    this.assertUuid(walletId, 'walletId');
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    const limit = Math.min(requestedLimit, 100);
    const decoded = cursor ? this.decodeCursor(cursor) : undefined;
    const params: unknown[] = [walletId.toLowerCase()];
    let cursorClause = '';
    if (decoded) {
      cursorClause = 'and (created_at, id) < (?, ?::uuid)';
      params.push(decoded.createdAt, decoded.id);
    }
    params.push(limit + 1);
    const em = this.orm.em.fork({ clear: true });

    const rows = await em.getConnection().execute<
      {
        id: string;
        transaction_id: string;
        direction: 'DEBIT' | 'CREDIT';
        amount_minor: string;
        currency: string;
        balance_before_minor: string;
        balance_after_minor: string;
        created_at: Date;
      }[]
    >(
      `
        select id::text, transaction_id::text, direction, amount_minor::text,
               currency, balance_before_minor::text, balance_after_minor::text,
               created_at
        from wallet_ledger_entries
        where wallet_id = ? ${cursorClause}
        order by created_at desc, id desc
        limit ?
      `,
      params,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row: (typeof rows)[number]) => ({
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: {
        amount: Money.fromMinorUnits(row.amount_minor, row.currency).toDecimal(),
        currency: row.currency,
      },
      balanceBefore: Money.fromMinorUnits(row.balance_before_minor, row.currency).toDecimal(),
      balanceAfter: Money.fromMinorUnits(row.balance_after_minor, row.currency).toDecimal(),
      createdAt: row.created_at,
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              createdAt: new Date(last.createdAt as Date).toISOString(),
              id: String(last.id),
            })
          : null,
    };
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    this.assertUuid(transactionId, 'transactionId');
    const em = this.orm.em.fork({ clear: true });
    const transaction = await em.findOne(WagerTransactionEntity, {
      id: transactionId.toLowerCase(),
    });
    if (!transaction) throw new NotFoundException('Transaction was not found.');
    return this.transactionDto(transaction);
  }

  async getProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    if (
      providerId.trim().length === 0 ||
      providerId.length > 255 ||
      externalTransactionId.trim().length === 0 ||
      externalTransactionId.length > 255
    ) {
      throw new BadRequestException('Provider and external transaction ids are required.');
    }
    const em = this.orm.em.fork({ clear: true });
    const transaction = await em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    if (!transaction) throw new NotFoundException('Transaction was not found.');
    return this.transactionDto(transaction);
  }

  async reconcileWallet(
    walletId: string,
  ): Promise<WalletReconciliationResult> {
    this.assertUuid(walletId, 'walletId');
    const em = this.orm.em.fork({ clear: true });
    const rows = await em.getConnection().execute<
      {
        wallet_id: string;
        currency: string;
        balance_minor: string;
        ledger_balance_minor: string;
        checked_entries: string;
      }[]
    >(
      `
        select wallet.id::text as wallet_id,
               trim(wallet.currency) as currency,
               count(ledger.id)::text as checked_entries,
               wallet.balance_minor::text as balance_minor,
               coalesce(sum(case ledger.direction
                 when 'CREDIT' then ledger.amount_minor
                 else -ledger.amount_minor
               end), 0)::text as ledger_balance_minor
        from wallets as wallet
        left join wallet_ledger_entries as ledger on ledger.wallet_id = wallet.id
        where wallet.id = ?
        group by wallet.id, wallet.currency
      `,
      [walletId.toLowerCase()],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet was not found.');
    const consistent =
      BigInt(row.balance_minor) === BigInt(row.ledger_balance_minor);
    if (!consistent) {
      this.metrics.reconciliationMismatch();
      this.logger.error(
        {
          event: 'wallet_reconciliation_mismatch',
          walletId: row.wallet_id,
          balanceMinor: row.balance_minor,
          ledgerBalanceMinor: row.ledger_balance_minor,
        },
      );
    }
    return {
      walletId: row.wallet_id,
      currency: row.currency,
      balanceMinor: row.balance_minor,
      ledgerBalanceMinor: row.ledger_balance_minor,
      checkedEntries: Number(row.checked_entries),
      consistent,
    };
  }

  async checkReadiness(): Promise<{ ready: boolean }> {
    let client: ReturnType<typeof createSqsClient> | undefined;
    try {
      await this.orm.em
        .fork({ clear: true })
        .getConnection()
        .execute('select 1');
      const queueUrl = process.env.SQS_INBOX_QUEUE_URL;
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!queueUrl || !region) {
        return { ready: false };
      }
      client = createSqsClient(region, process.env.SQS_ENDPOINT_URL);
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return { ready: true };
    } catch (error) {
      this.logger.error(
        'Dependency readiness check failed.',
        error instanceof Error ? error.stack : String(error),
      );
      return { ready: false };
    } finally {
      client?.destroy();
    }
  }

  async retryPendingReferences(): Promise<void> {
    let pendingIds: { id: string }[];
    try {
      pendingIds = await this.orm.em
        .fork({ clear: true })
        .getConnection()
        .execute<{ id: string }[]>(
        `select id::text from wager_transactions
         where status = 'PENDING_REFERENCE'
           and reference_next_attempt_at <= now()
         order by reference_next_attempt_at
         limit 50`,
        );
    } catch (error) {
      this.logger.error(
        'Could not load pending references for retry.',
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    for (const row of pendingIds) {
      try {
        await this.retryPendingReference(row.id);
      } catch (error) {
        this.logger.error(
          `Pending reference retry failed for transaction ${row.id}.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async retryPendingReference(transactionId: string): Promise<void> {
    await this.orm.em.transactional(async (em) => {
      const transaction = await em.findOne(
        WagerTransactionEntity,
        { id: transactionId, status: 'PENDING_REFERENCE' },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (
        !transaction ||
        !transaction.referenceExternalTransactionId ||
        !transaction.referenceNextAttemptAt ||
        transaction.referenceNextAttemptAt > new Date()
      ) {
        return;
      }
      const wallet = await em.findOne(
        WalletEntity,
        { id: transaction.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!wallet) throw new Error('Pending transaction wallet is missing.');

      const now = new Date();
      const maxAttempts = integerEnv(
        'PENDING_REFERENCE_MAX_ATTEMPTS',
        10,
        1,
        1000,
      );
      const expired =
        (transaction.referenceExpiresAt?.getTime() ?? 0) <= now.getTime();
      const reference = await em.findOne(WagerTransactionEntity, {
        providerId: transaction.providerId,
        externalTransactionId: transaction.referenceExternalTransactionId,
        status: 'PROCESSED',
      });

      if (!reference && (expired || transaction.referenceAttempts >= maxAttempts)) {
        transaction.status = 'REJECTED';
        transaction.failureCode = 'REFERENCE_NOT_FOUND';
        transaction.processedAt = now;
        transaction.updatedAt = now;
        transaction.referenceNextAttemptAt = undefined;
        this.persistEvent(em, {
          eventType: 'WagerTransactionRejected',
          aggregateId: transaction.id,
          correlationId: transaction.idempotencyKey,
          causationId: transaction.referenceExternalTransactionId,
          data: this.eventTransactionData(transaction, wallet.balanceMinor),
          occurredAt: now,
        });
        await em.flush();
        return;
      }

      if (!reference) {
        transaction.referenceAttempts += 1;
        transaction.updatedAt = now;
        transaction.referenceNextAttemptAt = new Date(
          now.getTime() + this.referenceBackoffMs(transaction.referenceAttempts),
        );
        await em.flush();
        return;
      }

      const failure = this.referenceFailure(transaction, wallet, reference);
      if (failure) {
        this.reject(em, transaction, wallet.balanceMinor, failure, now);
        await em.flush();
        return;
      }
      const reversalAlreadyExists = await em.findOne(
        WagerTransactionEntity,
        { referenceTransactionId: reference.id },
      );
      if (reversalAlreadyExists) {
        this.reject(
          em,
          transaction,
          wallet.balanceMinor,
          transaction.kind === 'REFUND'
            ? 'REFERENCE_ALREADY_REFUNDED'
            : 'REFERENCE_ALREADY_ROLLED_BACK',
          now,
        );
        await em.flush();
        return;
      }
      this.applyResolvedReversal(em, transaction, wallet, reference, now);
      await em.flush();
    });
  }

  private async registerInbox(
    em: EntityManager,
    identity: InboxIdentity,
    request: NormalizedWagerInput,
  ): Promise<InboxRegistration> {
    const existing = await em.findOne(InboxMessageEntity, {
      consumerName: identity.consumerName,
      messageId: identity.messageId,
    });
    if (existing) {
      if (existing.payloadHash !== request.payloadHash) {
        throw new ConflictException(
          'SQS message id was reused with a different business payload.',
        );
      }
      return { duplicate: true };
    }
    const inbox = em.create(InboxMessageEntity, {
      id: randomUUID(),
      messageId: identity.messageId,
      consumerName: identity.consumerName,
      payloadHash: request.payloadHash,
      receivedAt: new Date(),
    });
    em.persist(inbox);
    return { inbox, duplicate: false };
  }

  private async persistTerminalConflict(
    existing: WagerTransactionEntity,
    request: NormalizedWagerInput,
    identity: InboxIdentity,
    failureCode: string,
  ): Promise<ProcessWagerResult> {
    const result = await this.orm.em.transactional(async (em) => {
      const duplicate = await em.findOne(InboxMessageEntity, {
        consumerName: identity.consumerName,
        messageId: identity.messageId,
      });
      if (duplicate) {
        if (duplicate.payloadHash !== request.payloadHash) {
          throw new ConflictException(
            'SQS message id was reused with a different business payload.',
          );
        }
        return {
          ...this.result(existing, existing.balanceAfterMinor, false),
          status: 'REJECTED' as const,
          failureCode,
        };
      }
      const now = new Date();
      em.persist(
        em.create(InboxMessageEntity, {
          id: randomUUID(),
          messageId: identity.messageId,
          consumerName: identity.consumerName,
          payloadHash: request.payloadHash,
          receivedAt: now,
          processedAt: now,
        }),
      );
      this.persistEvent(em, {
        eventType: 'WagerTransactionRejected',
        aggregateId: existing.id,
        correlationId: request.idempotencyKey,
        causationId: request.externalTransactionId,
        data: {
          providerId: request.providerId,
          externalTransactionId: request.externalTransactionId,
          walletId: request.walletId,
          playerId: request.playerId,
          failureCode,
        },
        occurredAt: now,
      });
      await em.flush();
      return {
        ...this.result(existing, existing.balanceAfterMinor, false),
        status: 'REJECTED' as const,
        failureCode,
      };
    });
    this.metrics.messageConsumed('REJECTED');
    if (failureCode === 'IDEMPOTENCY_PAYLOAD_CONFLICT') {
      this.metrics.idempotencyConflict();
    }
    return result;
  }

  private async applyTransaction(
    em: EntityManager,
    transaction: WagerTransactionEntity,
    wallet: WalletEntity,
    request: NormalizedWagerInput,
    now: Date,
  ): Promise<ProcessWagerResult> {
    if (request.type === 'REFUND' || request.type === 'ROLLBACK') {
      const reference = await em.findOne(WagerTransactionEntity, {
        providerId: request.providerId,
        externalTransactionId: request.referenceExternalTransactionId,
      });
      if (!reference || reference.status === 'PENDING_REFERENCE' || reference.status === 'PENDING') {
        transaction.status = 'PENDING_REFERENCE';
        transaction.referenceAttempts = 0;
        transaction.referenceNextAttemptAt = new Date(
          now.getTime() + this.referenceBackoffMs(0),
        );
        transaction.referenceExpiresAt = new Date(
          now.getTime() +
            integerEnv('PENDING_REFERENCE_TTL_MINUTES', 60, 1, 10080) *
              60_000,
        );
        transaction.updatedAt = now;
        this.persistEvent(em, {
          eventType: 'WagerTransactionPendingReference',
          aggregateId: transaction.id,
          correlationId: transaction.idempotencyKey,
          causationId: request.referenceExternalTransactionId,
          data: this.eventTransactionData(transaction, wallet.balanceMinor),
          occurredAt: now,
        });
        return this.result(transaction, wallet.balanceMinor, false);
      }
      if (reference.status !== 'PROCESSED') {
        return this.reject(em, transaction, wallet.balanceMinor, 'REFERENCE_NOT_FOUND', now);
      }
      const failure = this.referenceFailure(transaction, wallet, reference);
      if (failure) {
        return this.reject(em, transaction, wallet.balanceMinor, failure, now);
      }
      const reversalAlreadyExists = await em.findOne(
        WagerTransactionEntity,
        { referenceTransactionId: reference.id },
      );
      if (reversalAlreadyExists) {
        return this.reject(
          em,
          transaction,
          wallet.balanceMinor,
          request.type === 'REFUND'
            ? 'REFERENCE_ALREADY_REFUNDED'
            : 'REFERENCE_ALREADY_ROLLED_BACK',
          now,
        );
      }
      return this.applyResolvedReversal(em, transaction, wallet, reference, now);
    }

    let change: ReturnType<typeof calculateBalanceChange>;
    try {
      change = calculateBalanceChange(
        request.type,
        BigInt(request.amountMinor),
        BigInt(wallet.balanceMinor),
      );
    } catch (error) {
      if (error instanceof RangeError && error.message === 'Insufficient funds.') {
        return this.reject(em, transaction, wallet.balanceMinor, 'INSUFFICIENT_FUNDS', now);
      }
      if (error instanceof RangeError) {
        return this.reject(em, transaction, wallet.balanceMinor, 'AMOUNT_OVERFLOW', now);
      }
      throw error;
    }
    return this.complete(
      em,
      transaction,
      wallet,
      change.amountMinor,
      change.balanceAfterMinor,
      now,
    );
  }

  private applyResolvedReversal(
    em: EntityManager,
    transaction: WagerTransactionEntity,
    wallet: WalletEntity,
    reference: WagerTransactionEntity,
    now: Date,
  ): ProcessWagerResult {
    const originalEffect =
      reference.kind === 'BET'
        ? -BigInt(reference.amountMinor)
        : BigInt(reference.amountMinor);
    let change: ReturnType<typeof calculateBalanceChange>;
    try {
      change = calculateBalanceChange(
        transaction.kind as WagerTransactionType,
        BigInt(transaction.amountMinor),
        BigInt(wallet.balanceMinor),
        originalEffect,
        reference.kind as WagerTransactionType,
      );
    } catch (error) {
      if (error instanceof RangeError && error.message === 'Insufficient funds.') {
        return this.reject(
          em,
          transaction,
          wallet.balanceMinor,
          'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
          now,
        );
      }
      if (error instanceof RangeError) {
        return this.reject(em, transaction, wallet.balanceMinor, 'AMOUNT_OVERFLOW', now);
      }
      throw error;
    }
    transaction.referenceTransactionId = reference.id;
    return this.complete(
      em,
      transaction,
      wallet,
      change.amountMinor,
      change.balanceAfterMinor,
      now,
    );
  }

  private referenceFailure(
    transaction: WagerTransactionEntity,
    wallet: WalletEntity,
    reference: WagerTransactionEntity,
  ): string | undefined {
    const allowed =
      transaction.kind === 'REFUND'
        ? reference.kind === 'BET'
        : ['BET', 'WIN', 'REFUND'].includes(reference.kind);
    if (!allowed) return 'REFERENCE_KIND_NOT_ALLOWED';
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== wallet.id ||
      reference.currency !== transaction.currency ||
      reference.roundId !== transaction.roundId ||
      reference.amountMinor !== transaction.amountMinor
    ) {
      return 'INVALID_REFERENCE';
    }
    return undefined;
  }

  private complete(
    em: EntityManager,
    transaction: WagerTransactionEntity,
    wallet: WalletEntity,
    signedChange: bigint,
    balanceAfter: bigint,
    now: Date,
  ): ProcessWagerResult {
    const balanceBefore = BigInt(wallet.balanceMinor);
    this.assertTransition(transaction, 'PROCESSED');
    transaction.status = 'PROCESSED';
    transaction.balanceAfterMinor = balanceAfter.toString();
    transaction.processedAt = now;
    transaction.updatedAt = now;

    if (signedChange !== 0n) {
      const aggregate = Wallet.rehydrate({
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: Money.fromMinorUnits(wallet.balanceMinor, wallet.currency),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      const movement = {
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: Money.fromMinorUnits(
          signedChange < 0n ? -signedChange : signedChange,
          wallet.currency,
        ),
        at: now,
      };
      const entry =
        signedChange < 0n
          ? aggregate.debit(movement)
          : aggregate.credit(movement);
      if (aggregate.balance.minorUnits !== balanceAfter) {
        throw new Error('Wallet aggregate disagrees with the computed balance.');
      }
      wallet.balanceMinor = aggregate.balance.minorUnits.toString();
      wallet.version = aggregate.version;
      wallet.updatedAt = aggregate.updatedAt;
      em.persist(
        em.create(LedgerEntryEntity, {
          id: entry.id,
          transactionId: entry.transactionId,
          walletId: entry.walletId,
          direction: entry.direction,
          amountMinor: entry.money.minorUnits.toString(),
          currency: wallet.currency,
          balanceBeforeMinor: entry.balanceBefore.minorUnits.toString(),
          balanceAfterMinor: entry.balanceAfter.minorUnits.toString(),
          createdAt: entry.createdAt,
        }),
      );
      this.persistEvent(em, {
        eventType: 'WalletBalanceChanged',
        aggregateId: transaction.id,
        correlationId: transaction.idempotencyKey,
        causationId: transaction.externalTransactionId,
        data: {
          transactionId: transaction.id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balanceBefore: Money.fromMinorUnits(balanceBefore, wallet.currency).toDecimal(),
          balanceAfter: Money.fromMinorUnits(balanceAfter, wallet.currency).toDecimal(),
          amount: Money.fromMinorUnits(
            signedChange < 0n ? -signedChange : signedChange,
            wallet.currency,
          ).toDecimal(),
          direction: signedChange < 0n ? 'DEBIT' : 'CREDIT',
        },
        occurredAt: now,
      });
    }

    this.persistEvent(em, {
      eventType: 'WagerTransactionProcessed',
      aggregateId: transaction.id,
      correlationId: transaction.idempotencyKey,
      causationId: transaction.externalTransactionId,
      data: this.eventTransactionData(transaction, balanceAfter.toString()),
      occurredAt: now,
    });
    this.logger.log(
      {
        event: 'wager_transaction_processed',
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: transaction.providerId,
        correlationId: transaction.idempotencyKey,
        status: transaction.status,
      },
    );
    return this.result(transaction, balanceAfter.toString(), false);
  }

  private reject(
    em: EntityManager,
    transaction: WagerTransactionEntity,
    balanceMinor: string,
    failureCode: string,
    now: Date,
  ): ProcessWagerResult {
    this.assertTransition(transaction, 'REJECTED');
    transaction.status = 'REJECTED';
    transaction.failureCode = failureCode;
    transaction.balanceAfterMinor = balanceMinor;
    transaction.processedAt = now;
    transaction.updatedAt = now;
    transaction.referenceNextAttemptAt = undefined;
    this.persistEvent(em, {
      eventType: 'WagerTransactionRejected',
      aggregateId: transaction.id,
      correlationId: transaction.idempotencyKey,
      causationId: transaction.externalTransactionId,
      data: this.eventTransactionData(transaction, balanceMinor),
      occurredAt: now,
    });
    this.logger.warn(
      {
        event: 'wager_transaction_rejected',
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        correlationId: transaction.idempotencyKey,
        failureCode,
      },
    );
    return this.result(transaction, balanceMinor, false);
  }

  private persistEvent(
    em: EntityManager,
    input: {
      eventType: string;
      aggregateId: string;
      correlationId: string;
      causationId?: string;
      data: Record<string, unknown>;
      occurredAt: Date;
    },
  ): void {
    const event = integrationEventFor(
      input.eventType as IntegrationEventType,
      {
        eventId: randomUUID(),
        aggregateId: input.aggregateId,
        correlationId: input.correlationId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
        data: input.data,
      },
    );
    const message = OutboxMessage.enqueue(event);
    em.persist(
      em.create(OutboxEventEntity, {
        id: message.id,
        eventType: message.eventType,
        eventVersion: event.version,
        aggregateId: message.aggregateId,
        correlationId: event.correlationId,
        causationId: event.causationId,
        occurredAt: message.occurredAt,
        payload: { ...message.payload },
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? input.occurredAt,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      }),
    );
  }

  /** Fails fast when a terminal transaction would be transitioned again. */
  private assertTransition(
    transaction: WagerTransactionEntity,
    to: 'PROCESSED' | 'REJECTED',
  ): void {
    const aggregate = DomainWagerTransaction.rehydrate({
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind as WagerTransactionKind,
      money: Money.fromMinorUnits(transaction.amountMinor, transaction.currency),
      createdAt: transaction.createdAt,
      status: transaction.status as WagerTransactionStatus,
    });
    if (to === 'PROCESSED') aggregate.markProcessed(undefined, new Date());
    else aggregate.reject('');
  }

  private eventTransactionData(
    transaction: WagerTransactionEntity,
    balanceAfterMinor: string,
  ): Record<string, unknown> {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: Money.fromMinorUnits(
          transaction.amountMinor,
          transaction.currency,
        ).toDecimal(),
        currency: transaction.currency,
      },
      balanceAfter: Money.fromMinorUnits(
        balanceAfterMinor,
        transaction.currency,
      ).toDecimal(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
    };
  }

  private result(
    transaction: WagerTransactionEntity,
    balanceAfterMinor: string,
    idempotentReplay: boolean,
  ): ProcessWagerResult {
    return {
      transactionId: transaction.id,
      status: transaction.status as WagerStatus,
      failureCode: transaction.failureCode ?? null,
      balanceAfterMinor,
      idempotentReplay,
    };
  }

  private transactionDto(
    transaction: WagerTransactionEntity,
  ): Record<string, unknown> {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: Money.fromMinorUnits(
          transaction.amountMinor,
          transaction.currency,
        ).toDecimal(),
        currency: transaction.currency,
      },
      balanceAfter: Money.fromMinorUnits(
        transaction.balanceAfterMinor,
        transaction.currency,
      ).toDecimal(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      processedAt: transaction.processedAt ?? null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };
  }

  private normalize(input: ProcessWagerInput): NormalizedWagerInput {
    for (const [name, value] of [
      ['providerId', input.providerId],
      ['externalTransactionId', input.externalTransactionId],
      ['roundId', input.roundId],
      ['gameId', input.gameId],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
        throw new BadRequestException(`${name} must contain 1 to 255 characters.`);
      }
    }
    this.assertUuid(input.playerId, 'playerId');
    this.assertUuid(input.walletId, 'walletId');
    if (
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 255
    ) {
      throw new BadRequestException(
        'Idempotency-Key must contain between 1 and 255 characters.',
      );
    }
    const type = input.type;
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(type)) {
      throw new BadRequestException('Unsupported wager transaction type.');
    }
    const amount = this.moneyFromDecimal(input.amount, input.currency);
    if (amount.minorUnits === 0n) {
      throw new BadRequestException('amount must be greater than 0.00.');
    }
    const isReversal = type === 'REFUND' || type === 'ROLLBACK';
    const referenceExternalTransactionId =
      input.referenceExternalTransactionId?.trim();
    if (isReversal !== Boolean(referenceExternalTransactionId)) {
      throw new BadRequestException(
        'REFUND and ROLLBACK require referenceExternalTransactionId; other kinds must omit it.',
      );
    }
    const businessFields = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId.toLowerCase(),
      walletId: input.walletId.toLowerCase(),
      roundId: input.roundId,
      gameId: input.gameId,
      kind: type,
      money: { amount: amount.toDecimal(), currency: amount.currency },
      referenceExternalTransactionId: referenceExternalTransactionId ?? null,
    };
    return {
      ...input,
      playerId: input.playerId.toLowerCase(),
      walletId: input.walletId.toLowerCase(),
      type,
      amount: amount.toDecimal(),
      amountMinor: amount.minorUnits.toString(),
      currency: amount.currency,
      referenceExternalTransactionId,
      payloadHash: this.hashPayload(businessFields),
    };
  }

  private replayOrConflict(
    transaction: WagerTransactionEntity,
    payloadHash: string,
  ): ProcessWagerResult {
    if (transaction.payloadHash !== payloadHash) {
      throw new ConflictException(
        'Idempotency key was already used with a different business payload.',
      );
    }
    return this.result(
      transaction,
      transaction.balanceAfterMinor,
      true,
    );
  }

  private hashPayload(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(this.sortObject(value)))
      .digest('hex');
  }

  private sortObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sortObject(item));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.sortObject(item)]),
    );
  }

  private moneyFromDecimal(value: string, currency: string): Money {
    try {
      return Money.fromDecimal(value, currency);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private moneyFromMinor(value: string, currency: string): Money {
    try {
      return Money.fromMinorUnits(value, currency);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private assertUuid(value: string, field: string): void {
    if (!UUID_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must be a UUID.`);
    }
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(cursor: string): LedgerCursor {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('createdAt' in parsed) ||
        !('id' in parsed) ||
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        typeof parsed.id !== 'string' ||
        !UUID_PATTERN.test(parsed.id)
      ) {
        throw new Error('Invalid cursor.');
      }
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new BadRequestException('cursor is invalid.');
    }
  }

  private referenceBackoffMs(attempt: number): number {
    const base = integerEnv(
      'PENDING_REFERENCE_BASE_BACKOFF_MS',
      1000,
      1,
      86_400_000,
    );
    const max = integerEnv(
      'PENDING_REFERENCE_MAX_BACKOFF_MS',
      60_000,
      1,
      86_400_000,
    );
    const exponential = Math.min(max, base * 2 ** Math.min(attempt, 16));
    return Math.floor(exponential * (0.8 + Math.random() * 0.4));
  }
}
