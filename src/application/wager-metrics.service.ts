import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Summary,
  TracerService,
} from '@nestjs/observe';

@Injectable()
export class WagerMetrics {
  private readonly consumed: Counter<'status'>;
  private readonly inboxDuplicates: Counter;
  private readonly idempotencyConflicts: Counter;
  private readonly reconciliationMismatches: Counter;
  private readonly consumerRetries: Counter;
  private readonly outboxPublishedCounter: Counter;
  private readonly outboxFailed: Counter;
  private readonly outboxLag: Summary;
  private readonly deadLetterDepth: Gauge;
  private readonly lockConflicts: Counter<'kind'>;
  private readonly processingDuration: Summary<'http' | 'sqs'>;

  constructor(tracer: TracerService) {
    this.consumed = tracer.counter<'status'>(
      'wager_messages_consumed_total',
      { labels: ['status'] },
    );
    this.inboxDuplicates = tracer.counter('wager_inbox_duplicates_total');
    this.idempotencyConflicts = tracer.counter(
      'wager_idempotency_conflicts_total',
    );
    this.reconciliationMismatches = tracer.counter(
      'wager_reconciliation_mismatch_total',
    );
    this.consumerRetries = tracer.counter('wager_consumer_retries_total');
    this.outboxPublishedCounter = tracer.counter(
      'wager_outbox_publish_success_total',
    );
    this.outboxFailed = tracer.counter('wager_outbox_publish_failure_total');
    this.outboxLag = tracer.summary('wager_outbox_lag_ms', {
      sampleSize: 500,
    });
    this.deadLetterDepth = tracer.gauge('wager_dead_letter_depth');
    this.lockConflicts = tracer.counter<'kind'>('wager_lock_conflicts_total', {
      labels: ['kind'],
    });
    this.processingDuration = tracer.summary<'http' | 'sqs'>(
      'wager_processing_duration_ms',
      { labels: ['http', 'sqs'], sampleSize: 500 },
    );
  }

  messageConsumed(status: string): void {
    if (
      status === 'PROCESSED' ||
      status === 'REJECTED' ||
      status === 'PENDING_REFERENCE' ||
      status === 'FAILED'
    ) {
      this.consumed.increment({ status });
    }
  }

  inboxDuplicate(): void {
    this.inboxDuplicates.increment();
  }

  idempotencyConflict(): void {
    this.idempotencyConflicts.increment();
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.increment();
  }

  consumerRetry(): void {
    this.consumerRetries.increment();
  }

  outboxPublished(lagMs: number): void {
    this.outboxPublishedCounter.increment();
    this.outboxLag.observe(Math.max(0, lagMs));
  }

  outboxPublishFailed(): void {
    this.outboxFailed.increment();
  }

  setDeadLetterDepth(depth: number): void {
    this.deadLetterDepth.setValue(Math.max(0, depth));
  }

  /** A transaction had to wait for a lock another transaction held. */
  lockConflict(kind: 'idempotency_key' | 'wallet_row'): void {
    this.lockConflicts.increment({ kind });
  }

  /** End-to-end duration of one use-case invocation (HTTP or SQS). */
  processingDurationObserved(ms: number, source: 'http' | 'sqs'): void {
    this.processingDuration.observe(Math.max(0, ms), source);
  }
}
