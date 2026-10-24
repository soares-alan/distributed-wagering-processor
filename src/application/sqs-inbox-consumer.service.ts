import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WagerTransactionService } from './wager-transaction.service.js';
import type { ProcessWagerInput } from './wager-transaction.service.js';
import { createSqsClient, integerEnv } from './config.js';
import { WagerMetrics } from './wager-metrics.service.js';

interface SqsWagerEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: ProcessWagerInput['type'];
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

function isWagerTransactionType(value: unknown): value is ProcessWagerInput['type'] {
  return (
    typeof value === 'string' &&
    ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(value)
  );
}

export function parseWagerMessage(body: string): SqsWagerEnvelope {
  const value: unknown = JSON.parse(body);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('SQS message body must be a JSON object.');
  }

  const message = value as Record<string, unknown>;
  if (message.type !== 'WagerTransactionRequested') {
    throw new TypeError('Unsupported SQS message type.');
  }
  if (
    typeof message.messageId !== 'string' ||
    !message.messageId ||
    typeof message.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(message.occurredAt)) ||
    typeof message.data !== 'object' ||
    message.data === null ||
    Array.isArray(message.data)
  ) {
    throw new TypeError('SQS message envelope is invalid.');
  }
  const data = message.data as Record<string, unknown>;
  const money = data.money;
  if (
    typeof data.providerId !== 'string' ||
    typeof data.externalTransactionId !== 'string' ||
    typeof data.idempotencyKey !== 'string' ||
    typeof data.playerId !== 'string' ||
    typeof data.walletId !== 'string' ||
    typeof data.roundId !== 'string' ||
    typeof data.gameId !== 'string' ||
    !isWagerTransactionType(data.kind) ||
    typeof money !== 'object' ||
    money === null ||
    Array.isArray(money) ||
    typeof (money as Record<string, unknown>).amount !== 'string' ||
    typeof (money as Record<string, unknown>).currency !== 'string' ||
    (data.referenceExternalTransactionId !== undefined &&
      typeof data.referenceExternalTransactionId !== 'string')
  ) {
    throw new TypeError('SQS transaction data does not match its contract.');
  }

  return message as unknown as SqsWagerEnvelope;
}

@Injectable()
export class SqsInboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsInboxConsumer.name);
  private client?: SQSClient;
  private stopping = false;
  private consumeTask?: Promise<void>;
  private readonly queueUrl = process.env.SQS_INBOX_QUEUE_URL;
  private readonly deadLetterQueueUrl = process.env.SQS_DLQ_QUEUE_URL;

  constructor(
    private readonly transactions: WagerTransactionService,
    private readonly metrics: WagerMetrics,
  ) {}

  onModuleInit(): void {
    if (!this.queueUrl) {
      this.logger.warn(
        'SQS_INBOX_QUEUE_URL is not configured; SQS transaction consumption is disabled.',
      );
      return;
    }

    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        'AWS_REGION or AWS_DEFAULT_REGION is required when SQS_INBOX_QUEUE_URL is configured.',
      );
    }

    this.client = createSqsClient(region, process.env.SQS_ENDPOINT_URL);
    this.consumeTask = this.consume();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.consumeTask;
    this.client?.destroy();
  }

  private async consume(): Promise<void> {
    const client = this.client;
    const queueUrl = this.queueUrl;
    if (!client || !queueUrl) {
      throw new Error('SQS inbox consumer is not configured.');
    }

    while (!this.stopping) {
      try {
        const response = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: integerEnv(
              'SQS_MAX_MESSAGES_PER_POLL',
              10,
              1,
              10,
            ),
            VisibilityTimeout: integerEnv(
              'SQS_VISIBILITY_TIMEOUT_SECONDS',
              30,
              1,
              43200,
            ),
            WaitTimeSeconds: 10,
          }),
        );
        await this.refreshDeadLetterDepth(client);

        for (const message of response.Messages ?? []) {
          await this.processMessage(client, queueUrl, message);
        }
      } catch (error) {
        if (!this.stopping) {
          this.metrics.consumerRetry();
          this.logger.error(
            'SQS inbox polling failed; retrying.',
            error instanceof Error ? error.stack : String(error),
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  private async processMessage(
    client: SQSClient,
    queueUrl: string,
    message: {
      MessageId?: string;
      ReceiptHandle?: string;
      Body?: string;
    },
  ): Promise<void> {
    if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
      this.logger.error('Received an SQS message missing its id, body, or receipt handle.');
      return;
    }

    try {
      const envelope = parseWagerMessage(message.Body);
      const data = envelope.data;
      await this.transactions.process(
        {
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
          ...(data.referenceExternalTransactionId === undefined
            ? {}
            : {
                referenceExternalTransactionId:
                  data.referenceExternalTransactionId,
              }),
        },
        {
          messageId: envelope.messageId,
          consumerName: process.env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer',
        },
      );
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        this.logger.warn({
          event: 'sqs_message_terminal_conflict_acknowledged',
          messageId: message.MessageId,
        });
        this.metrics.messageConsumed('REJECTED');
        if (error.message.toLowerCase().includes('idempotency')) {
          this.metrics.idempotencyConflict();
        }
        return;
      }
      this.metrics.consumerRetry();
      this.logger.error(
        {
          event: 'sqs_message_not_acknowledged',
          messageId: message.MessageId,
        },
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async refreshDeadLetterDepth(client: SQSClient): Promise<void> {
    if (!this.deadLetterQueueUrl) return;
    try {
      const response = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.deadLetterQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      const depth = Number(
        response.Attributes?.ApproximateNumberOfMessages ?? '0',
      );
      if (!Number.isInteger(depth) || depth < 0) {
        throw new Error('SQS returned an invalid DLQ depth.');
      }
      this.metrics.setDeadLetterDepth(depth);
    } catch (error) {
      this.logger.error(
        'Failed to refresh SQS dead-letter queue depth.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
