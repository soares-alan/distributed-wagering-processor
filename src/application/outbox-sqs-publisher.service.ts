import type { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import { createSqsClient, integerEnv } from './config.js';
import { WagerMetrics } from './wager-metrics.service.js';

interface ClaimedOutboxEvent {
  id: string;
  event_type: string;
  aggregate_id: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxSqsPublisher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxSqsPublisher.name);
  private client?: SQSClient;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private readonly queueUrl = process.env.SQS_QUEUE_URL;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
    private readonly metrics: WagerMetrics,
  ) {}

  onModuleInit(): void {
    if (!this.queueUrl) {
      this.logger.warn(
        'SQS_QUEUE_URL is not configured; transactional outbox events will remain pending.',
      );
      return;
    }

    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        'AWS_REGION or AWS_DEFAULT_REGION is required when SQS_QUEUE_URL is configured.',
      );
    }

    this.client = createSqsClient(region, process.env.SQS_ENDPOINT_URL);
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.client?.destroy();
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.publishCycle();
    }, delayMs);
  }

  private async publishCycle(): Promise<void> {
    try {
      // An interrupted publish can retry after the lease expires, unless the next sweep marks it failed at the attempt limit.
      const events = await this.claimPendingEvents();
      for (const event of events) {
        await this.publish(event);
      }
    } catch (error) {
      this.logger.error(
        'Failed to process the transactional outbox.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (this.client && !this.stopping) {
        this.schedule(integerEnv('OUTBOX_POLL_INTERVAL_MS', 1000, 100, 60000));
      }
    }
  }

  private async claimPendingEvents(): Promise<ClaimedOutboxEvent[]> {
    return this.orm.em.transactional(async (em) => {
        await (em as SqlEntityManager).execute(`
          update outbox_messages
          set failed_at = now(),
              last_error = 'Maximum outbox publish attempts exceeded',
              updated_at = now()
          where published_at is null
            and failed_at is null
            and attempts >= ${integerEnv('OUTBOX_MAX_ATTEMPTS', 10, 1, 1000)}
            and next_attempt_at <= now()
        `);
        const events: ClaimedOutboxEvent[] = await (em as SqlEntityManager).execute(`
          with due_events as (
            select id
            from outbox_messages
            where published_at is null
              and failed_at is null
              and next_attempt_at <= now()
            order by occurred_at
            for update skip locked
            limit ${integerEnv('OUTBOX_BATCH_SIZE', 10, 1, 1000)}
          )
          update outbox_messages as event
          set attempts = event.attempts + 1,
              next_attempt_at = now() + interval '60 seconds',
              updated_at = now()
          from due_events
          where event.id = due_events.id
          returning event.id, event.event_type, event.aggregate_id,
                    event.occurred_at, event.payload, event.attempts
        `);
        return events;
    });
  }

  private async publish(event: ClaimedOutboxEvent): Promise<void> {
    const client = this.client;
    const queueUrl = this.queueUrl;
    if (!client || !queueUrl) {
      throw new Error('SQS publisher is not configured.');
    }

    try {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(event.payload),
          MessageGroupId: event.aggregate_id,
          MessageDeduplicationId: event.id,
        }),
      );
      await this.orm.em.fork({ clear: true }).nativeUpdate(
        OutboxEventEntity,
        { id: event.id, publishedAt: null },
        { publishedAt: new Date(), lastError: null, updatedAt: new Date() },
      );
      this.metrics.outboxPublished(
        Date.now() - new Date(event.occurred_at).getTime(),
      );
      this.logger.log(
        {
          event: 'outbox_published',
          eventId: event.id,
          eventType: event.event_type,
          aggregateId: event.aggregate_id,
          correlationId: event.payload.correlationId,
          attempts: event.attempts,
        },
      );
    } catch (error) {
      this.metrics.outboxPublishFailed();
      const retryMs = Math.max(1, Math.floor(
        Math.min(
          integerEnv('OUTBOX_MAX_BACKOFF_MS', 300_000, 1, 86_400_000),
          integerEnv('OUTBOX_BASE_BACKOFF_MS', 1000, 1, 86_400_000) *
            2 ** Math.min(event.attempts, 16),
        ) *
          (0.8 + Math.random() * 0.4),
      ));
      const message =
        error instanceof Error ? error.message : String(error);
      await this.orm.em.fork({ clear: true }).nativeUpdate(
        OutboxEventEntity,
        { id: event.id, publishedAt: null },
        {
          lastError: message,
          nextAttemptAt: new Date(Date.now() + retryMs),
          failedAt:
            event.attempts >= integerEnv('OUTBOX_MAX_ATTEMPTS', 10, 1, 1000)
              ? new Date()
              : undefined,
          updatedAt: new Date(),
        },
      );
      this.logger.error(
        `Failed to publish outbox event ${event.id}; retrying in ${retryMs}ms: ${message}`,
      );
    }
  }
}
