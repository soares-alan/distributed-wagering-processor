import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { WagerTransactionEntity } from './wager-transaction.entity.js';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'idx_outbox_pending_due',
  properties: ['publishedAt', 'nextAttemptAt', 'occurredAt'],
})
@Check({
  name: 'outbox_events_attempts_non_negative',
  expression: 'attempts >= 0',
})
@Check({
  name: 'outbox_events_version_positive',
  expression: 'event_version >= 1',
})
export class OutboxEventEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ fieldName: 'event_type', type: 'string', length: 100 })
  eventType!: string;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'aggregate_id',
    mapToPk: true,
    updateRule: 'cascade',
    deleteRule: 'restrict',
  })
  aggregateId!: string;

  @Property({ fieldName: 'event_version', type: 'integer', default: 1 })
  eventVersion = 1;

  @Property({ fieldName: 'correlation_id', type: 'string' })
  correlationId!: string;

  @Property({ fieldName: 'causation_id', type: 'string', nullable: true })
  causationId?: string;

  @Property({
    fieldName: 'occurred_at',
    type: 'Date',
    columnType: 'timestamptz',
  })
  occurredAt!: Date;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({
    fieldName: 'legacy_payload',
    type: 'json',
    columnType: 'jsonb',
    nullable: true,
  })
  legacyPayload?: Record<string, unknown>;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({
    fieldName: 'next_attempt_at',
    type: 'Date',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  nextAttemptAt!: Date;

  @Property({
    fieldName: 'published_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date;

  @Property({
    fieldName: 'last_error',
    type: 'string',
    columnType: 'text',
    nullable: true,
  })
  lastError?: string;

  @Property({
    fieldName: 'failed_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  failedAt?: Date;

  @Property({
    fieldName: 'created_at',
    type: 'Date',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    fieldName: 'updated_at',
    type: 'Date',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  updatedAt!: Date;
}
