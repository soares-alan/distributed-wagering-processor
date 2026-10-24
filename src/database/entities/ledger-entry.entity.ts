import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletEntity } from './wallet.entity.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'ledger_entries_transaction_unique',
  properties: ['transactionId'],
})
@Index({
  name: 'idx_ledger_wallet_created_at',
  properties: ['walletId', 'createdAt', 'id'],
})
@Check({
  name: 'ledger_entries_balance_consistent',
  expression:
    "(direction = 'DEBIT' and balance_before_minor - amount_minor = balance_after_minor) or (direction = 'CREDIT' and balance_before_minor + amount_minor = balance_after_minor)",
})
@Check({
  name: 'ledger_entries_amount_positive',
  expression: 'amount_minor > 0',
})
@Check({
  name: 'ledger_entries_direction_check',
  expression: "direction in ('DEBIT', 'CREDIT')",
})
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'transaction_id',
    mapToPk: true,
    updateRule: 'cascade',
    deleteRule: 'restrict',
  })
  transactionId!: string;

  @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
    mapToPk: true,
    updateRule: 'cascade',
    deleteRule: 'restrict',
  })
  walletId!: string;

  @Property({ type: 'string', length: 6 })
  direction!: 'DEBIT' | 'CREDIT';

  @Property({ fieldName: 'amount_minor', type: 'bigint' })
  amountMinor!: string;

  @Property({ type: 'string', length: 3, columnType: 'char(3)' })
  currency!: string;

  @Property({ fieldName: 'balance_before_minor', type: 'bigint' })
  balanceBeforeMinor!: string;

  @Property({ fieldName: 'balance_after_minor', type: 'bigint' })
  balanceAfterMinor!: string;

  @Property({
    fieldName: 'created_at',
    type: 'Date',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;
}
