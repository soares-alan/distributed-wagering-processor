import 'dotenv/config';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from './database/entities/inbox-message.entity.js';
import { LedgerEntryEntity } from './database/entities/ledger-entry.entity.js';
import { OutboxEventEntity } from './database/entities/outbox-event.entity.js';
import { WalletEntity } from './database/entities/wallet.entity.js';
import { WagerTransactionEntity } from './database/entities/wager-transaction.entity.js';

const requiredEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const port = Number(requiredEnv('POSTGRES_PORT'));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('POSTGRES_PORT must be a valid TCP port');
}

export default defineConfig({
  host: requiredEnv('POSTGRES_HOST'),
  port,
  dbName: requiredEnv('POSTGRES_DB'),
  user: requiredEnv('POSTGRES_USER'),
  password: requiredEnv('POSTGRES_PASSWORD'),

  metadataProvider: ReflectMetadataProvider,

  entities: [
    WalletEntity,
    WagerTransactionEntity,
    LedgerEntryEntity,
    OutboxEventEntity,
    InboxMessageEntity,
  ],
  entitiesTs: [
    WalletEntity,
    WagerTransactionEntity,
    LedgerEntryEntity,
    OutboxEventEntity,
    InboxMessageEntity,
  ],

  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
  },
});
