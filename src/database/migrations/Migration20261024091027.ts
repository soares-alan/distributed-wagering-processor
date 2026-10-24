import { Migration } from '@mikro-orm/migrations';

export class Migration20261024091027 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null default gen_random_uuid(),
        "player_id" uuid not null,
        "currency" char(3) not null,
        "balance_minor" bigint not null default 0,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),

        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique"
          unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative"
          check ("balance_minor" >= 0),
        constraint "wallets_version_positive"
          check ("version" >= 1)
      );
    `);

    this.addSql(`
      create index "idx_wallets_updated_at"
      on "wallets" ("updated_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wallets";');
  }
}