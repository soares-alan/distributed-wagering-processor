import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity.js';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transactions_provider_idempotency_unique',
  properties: ['providerId', 'idempotencyKey'],
})
@Unique({
  name: 'wager_transactions_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_reference_unique',
  properties: ['referenceTransactionId'],
})
@Index({
  name: 'idx_wt_wallet_created_at',
  properties: ['walletId', 'createdAt'],
})
@Index({
  name: 'idx_wt_reference_external',
  properties: ['providerId', 'referenceExternalTransactionId'],
})
@Index({
  name: 'idx_wt_round',
  properties: ['providerId', 'roundId'],
})
@Check({
  name: 'wager_transactions_amount_non_negative',
  expression: 'amount_minor >= 0',
})
@Check({
  name: 'wager_transactions_balance_non_negative',
  expression: 'balance_after_minor >= 0',
})
@Check({
  name: 'wager_transactions_kind_check',
  expression:
    "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
})
@Check({
  name: 'wager_transactions_status_check',
  expression:
    "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
})
@Check({
  name: 'wager_transactions_reference_required',
  expression:
    "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({
    fieldName: 'payload_hash',
    type: 'string',
    length: 64,
    columnType: 'char(64)',
  })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
    mapToPk: true,
    updateRule: 'cascade',
    deleteRule: 'restrict',
  })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string' })
  gameId!: string;

  @Property({ type: 'string', length: 12 })
  kind!: string;

  @Property({ type: 'string', length: 24, default: 'PENDING' })
  status!: string;

  @Property({ fieldName: 'amount_minor', type: 'bigint' })
  amountMinor!: string;

  @Property({ type: 'string', length: 3, columnType: 'char(3)' })
  currency!: string;

  @Property({ fieldName: 'balance_after_minor', type: 'bigint' })
  balanceAfterMinor!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'string',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'reference_transaction_id',
    mapToPk: true,
    nullable: true,
    updateRule: 'cascade',
    deleteRule: 'restrict',
  })
  referenceTransactionId?: string;

  @Property({ fieldName: 'failure_code', type: 'string', nullable: true })
  failureCode?: string;

  @Property({
    fieldName: 'processed_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;

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

  @Property({
    fieldName: 'reference_attempts',
    type: 'integer',
    default: 0,
  })
  referenceAttempts = 0;

  @Property({
    fieldName: 'reference_next_attempt_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  referenceNextAttemptAt?: Date;

  @Property({
    fieldName: 'reference_expires_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  referenceExpiresAt?: Date;
}
