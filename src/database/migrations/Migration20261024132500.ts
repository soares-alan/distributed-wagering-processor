import { Migration } from '@mikro-orm/migrations';

export class Migration20261024132500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" char(64) not null,
        "type" varchar(12) not null,
        "amount_minor" bigint not null,
        "balance_after_minor" bigint not null,
        "reference_transaction_id" uuid null,
        "created_at" timestamptz not null default now(),
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_idempotency_key_unique"
          unique ("idempotency_key"),
        constraint "wager_transactions_reference_unique"
          unique ("reference_transaction_id"),
        constraint "wager_transactions_wallet_fkey"
          foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_reference_fkey"
          foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_amount_non_negative"
          check ("amount_minor" >= 0),
        constraint "wager_transactions_balance_non_negative"
          check ("balance_after_minor" >= 0),
        constraint "wager_transactions_type_check"
          check ("type" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'))
      );
    `);
    this.addSql(`
      create index "idx_wager_transactions_wallet_created"
      on "wager_transactions" ("wallet_id", "created_at");
    `);

    this.addSql(`
      create table "ledger_entries" (
        "id" uuid not null,
        "transaction_id" uuid not null,
        "wallet_id" uuid not null,
        "amount_minor" bigint not null,
        "balance_before_minor" bigint not null,
        "balance_after_minor" bigint not null,
        "created_at" timestamptz not null default now(),
        constraint "ledger_entries_pkey" primary key ("id"),
        constraint "ledger_entries_transaction_unique" unique ("transaction_id"),
        constraint "ledger_entries_transaction_fkey"
          foreign key ("transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "ledger_entries_wallet_fkey"
          foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "ledger_entries_amount_nonzero" check ("amount_minor" <> 0),
        constraint "ledger_entries_balance_consistent"
          check ("balance_after_minor" - "balance_before_minor" = "amount_minor"),
        constraint "ledger_entries_balance_before_non_negative"
          check ("balance_before_minor" >= 0),
        constraint "ledger_entries_balance_after_non_negative"
          check ("balance_after_minor" >= 0)
      );
    `);
    this.addSql(`
      create index "idx_ledger_entries_wallet_created"
      on "ledger_entries" ("wallet_id", "created_at");
    `);
    this.addSql(`
      create function "reject_ledger_mutation"() returns trigger
      language plpgsql as $$
      begin
        raise exception 'ledger_entries is append-only';
      end;
      $$;
      create trigger "ledger_entries_append_only"
      before update or delete on "ledger_entries"
      for each row execute function "reject_ledger_mutation"();
      create trigger "ledger_entries_append_only_truncate"
      before truncate on "ledger_entries"
      for each statement execute function "reject_ledger_mutation"();
    `);

    this.addSql(`
      create table "outbox_events" (
        "id" uuid not null,
        "event_type" varchar(100) not null,
        "aggregate_id" uuid not null,
        "payload" jsonb not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "published_at" timestamptz null,
        "last_error" text null,
        "created_at" timestamptz not null default now(),
        constraint "outbox_events_pkey" primary key ("id"),
        constraint "outbox_events_aggregate_fkey"
          foreign key ("aggregate_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "outbox_events_attempts_non_negative" check ("attempts" >= 0)
      );
    `);
    this.addSql(`
      create index "idx_outbox_events_pending"
      on "outbox_events" ("published_at", "next_attempt_at", "created_at");
    `);

    this.addSql(`
      create table "inbox_messages" (
        "message_id" varchar(255) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("message_id")
      );
    `);
  }

  override async down(): Promise<void> {
    const rows = (await this.execute(`
      select
        (select count(*) from "wager_transactions") as transactions,
        (select count(*) from "ledger_entries") as ledger,
        (select count(*) from "inbox_messages") as inbox,
        (select count(*) from "outbox_events") as outbox
    `)) as {
      transactions: string;
      ledger: string;
      inbox: string;
      outbox: string;
    }[];
    if (
      Object.values(rows[0] ?? {}).some((count) => Number(count) > 0)
    ) {
      throw new Error(
        'Cannot drop financial tables while transaction, ledger, inbox, or outbox data exists.',
      );
    }
    this.addSql('drop table "inbox_messages";');
    this.addSql('drop table "outbox_events";');
    this.addSql(
      'drop trigger "ledger_entries_append_only_truncate" on "ledger_entries";',
    );
    this.addSql('drop trigger "ledger_entries_append_only" on "ledger_entries";');
    this.addSql('drop function "reject_ledger_mutation"();');
    this.addSql('drop table "ledger_entries";');
    this.addSql('drop table "wager_transactions";');
  }
}
