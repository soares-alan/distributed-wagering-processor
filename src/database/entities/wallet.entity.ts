import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallets_player_currency_unique',
  properties: ['playerId', 'currency'],
})
@Check({
  name: 'wallets_balance_non_negative',
  expression: 'balance_minor >= 0',
})
@Check({
  name: 'wallets_version_positive',
  expression: 'version >= 1',
})
@Index({
  name: 'idx_wallets_updated_at',
  properties: ['updatedAt'],
})
export class WalletEntity {
  @PrimaryKey({
    type: 'uuid',
    defaultRaw: 'gen_random_uuid()',
  })
  id!: string;

  @Property({
    fieldName: 'player_id',
    type: 'uuid',
  })
  playerId!: string;

  @Property({
    type: 'string',
    length: 3,
    columnType: 'char(3)',
  })
  currency!: string;

  @Property({
    fieldName: 'balance_minor',
    type: 'bigint',
    default: '0',
  })
  balanceMinor!: string;

  @Property({
    type: 'integer',
    default: 1,
  })
  version!: number;

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
