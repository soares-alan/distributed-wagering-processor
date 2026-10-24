import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Unique({
  name: 'inbox_messages_consumer_message_unique',
  properties: ['consumerName', 'messageId'],
})
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ fieldName: 'message_id', type: 'string', length: 255 })
  messageId!: string;

  @Property({ fieldName: 'consumer_name', type: 'string' })
  consumerName!: string;

  @Property({
    fieldName: 'payload_hash',
    type: 'string',
    length: 64,
    columnType: 'char(64)',
  })
  payloadHash!: string;

  @Property({
    fieldName: 'received_at',
    type: 'Date',
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  receivedAt!: Date;

  @Property({
    fieldName: 'processed_at',
    type: 'Date',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
}
