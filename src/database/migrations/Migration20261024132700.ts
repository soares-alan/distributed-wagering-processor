import { Migration } from '@mikro-orm/migrations';

export class Migration20261024132700 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "provider_id" text,
        add column "external_transaction_id" text,
        add column "player_id" uuid,
        add column "round_id" text,
        add column "game_id" text,
        add column "status" text not null default 'PROCESSED',
        add column "currency" char(3),
        add column "reference_external_transaction_id" text,
        add column "failure_code" text,
        add column "processed_at" timestamptz,
        add column "updated_at" timestamptz not null default now(),
        add column "reference_attempts" integer not null default 0,
        add column "reference_next_attempt_at" timestamptz,
        add column "reference_expires_at" timestamptz;
      update "wager_transactions" as wt
        set provider_id = 'internal',
            external_transaction_id = 'legacy:' || wt.id::text,
            player_id = wallet.player_id,
            round_id = 'internal',
            game_id = 'internal',
            currency = wallet.currency,
            processed_at = wt.created_at
        from "wallets" as wallet
        where wt.wallet_id = wallet.id;
      alter table "wager_transactions"
        alter column "provider_id" set not null,
        alter column "external_transaction_id" set not null,
        alter column "player_id" set not null,
        alter column "round_id" set not null,
        alter column "game_id" set not null,
        alter column "currency" set not null;
      alter table "wager_transactions" rename column "type" to "kind";
      alter table "wager_transactions"
        alter column "status" set default 'PENDING';
      alter table "wager_transactions"
        drop constraint "wager_transactions_idempotency_key_unique",
        add constraint "wager_transactions_kind_check"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        add constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        add constraint "wager_transactions_reference_required"
          check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        add constraint "wager_transactions_reference_attempts_non_negative"
          check ("reference_attempts" >= 0),
        add constraint "wager_transactions_provider_idempotency_unique"
          unique ("provider_id", "idempotency_key"),
        add constraint "wager_transactions_provider_external_unique"
          unique ("provider_id", "external_transaction_id");
      create index "idx_wt_reference_external"
        on "wager_transactions" ("provider_id", "reference_external_transaction_id");
      create index "idx_wt_pending_reference"
        on "wager_transactions" ("status", "updated_at")
        where "status" = 'PENDING_REFERENCE';
      create index "idx_wt_round"
        on "wager_transactions" ("provider_id", "round_id");
      drop index "idx_wager_transactions_wallet_created";
      create index "idx_wt_wallet_created_at"
        on "wager_transactions" ("wallet_id", "created_at" desc);

      alter table "ledger_entries" drop constraint "ledger_entries_balance_consistent";
      drop trigger "ledger_entries_append_only_truncate" on "ledger_entries";
      drop trigger "ledger_entries_append_only" on "ledger_entries";
      alter table "ledger_entries"
        add column "direction" text,
        add column "currency" char(3);
      update "ledger_entries" as entry
        set direction = case when entry.amount_minor < 0 then 'DEBIT' else 'CREDIT' end,
            amount_minor = abs(entry.amount_minor),
            currency = wallet.currency
        from "wallets" as wallet
        where entry.wallet_id = wallet.id;
      alter table "ledger_entries"
        alter column "direction" set not null,
        alter column "currency" set not null,
        drop constraint "ledger_entries_amount_nonzero",
        add constraint "ledger_entries_amount_positive" check ("amount_minor" > 0),
        add constraint "ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        add constraint "ledger_entries_balance_consistent" check (
          ("direction" = 'DEBIT' and "balance_before_minor" - "amount_minor" = "balance_after_minor")
          or ("direction" = 'CREDIT' and "balance_before_minor" + "amount_minor" = "balance_after_minor")
        );
      alter table "ledger_entries" rename to "wallet_ledger_entries";
      alter index "idx_ledger_entries_wallet_created" rename to "idx_ledger_wallet_created_at";
      drop index "idx_ledger_wallet_created_at";
      create index "idx_ledger_wallet_created_at"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);
      create index "idx_ledger_transaction_id"
        on "wallet_ledger_entries" ("transaction_id");
      create trigger "ledger_entries_append_only"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "reject_ledger_mutation"();
      create trigger "ledger_entries_append_only_truncate"
        before truncate on "wallet_ledger_entries"
        for each statement execute function "reject_ledger_mutation"();

      alter table "inbox_messages"
        add column "id" uuid not null default gen_random_uuid(),
        add column "consumer_name" text not null default 'wager-transaction-consumer';
      alter table "inbox_messages" drop constraint "inbox_messages_pkey";
      alter table "inbox_messages" add constraint "inbox_messages_pkey" primary key ("id");
      alter table "inbox_messages"
        add constraint "inbox_messages_consumer_message_unique"
        unique ("consumer_name", "message_id");
      create index "idx_inbox_processed_at" on "inbox_messages" ("processed_at");
      create index "idx_inbox_received_at" on "inbox_messages" ("received_at" desc);

      alter table "outbox_events"
        add column "event_version" integer not null default 1,
        add column "correlation_id" text,
        add column "causation_id" text,
        add column "occurred_at" timestamptz,
        add column "updated_at" timestamptz not null default now(),
        add column "failed_at" timestamptz,
        add column "legacy_payload" jsonb;
      -- Preserve the original payload while upgrading existing rows to the event envelope.
      update "outbox_events"
        set legacy_payload = payload,
            correlation_id = id::text,
            occurred_at = created_at,
            payload = jsonb_build_object(
              'eventId', id,
              'eventType', event_type,
              'aggregateId', aggregate_id,
              'correlationId', id::text,
              'causationId', null,
              'occurredAt', created_at,
              'version', 1,
              'data', payload
            );
      alter table "outbox_events"
        alter column "correlation_id" set not null,
        alter column "occurred_at" set not null,
        add constraint "outbox_events_version_positive" check ("event_version" >= 1);
      alter table "outbox_events" rename to "outbox_messages";
      drop index "idx_outbox_events_pending";
      create index "idx_outbox_pending_due"
        on "outbox_messages" ("published_at", "next_attempt_at", "occurred_at")
        where "published_at" is null;
      create index "idx_outbox_event_type" on "outbox_messages" ("event_type");
      create index "idx_outbox_created_at" on "outbox_messages" ("created_at" desc);
    `);
  }

  override async down(): Promise<void> {
    const activeRows = (await this.execute(`
      select
        (select count(*) from "wager_transactions"
         where "idempotency_key" not like 'opening:migration:%') as transactions,
        (select count(*) from "inbox_messages") as inbox,
        (select count(*) from "outbox_messages") as outbox
    `)) as { transactions: string; inbox: string; outbox: string }[];
    if (
      Number(activeRows[0]?.transactions ?? 0) > 0 ||
      Number(activeRows[0]?.inbox ?? 0) > 0 ||
      Number(activeRows[0]?.outbox ?? 0) > 0
    ) {
      throw new Error(
        'Cannot roll back the Version2 schema while application transactions, inbox messages, or outbox events exist.',
      );
    }

    this.addSql(`
      drop index "idx_outbox_created_at";
      drop index "idx_outbox_event_type";
      drop index "idx_outbox_pending_due";
      alter table "outbox_messages" rename to "outbox_events";
      create index "idx_outbox_events_pending"
        on "outbox_events" ("published_at", "next_attempt_at", "created_at");
      update "outbox_events"
        set payload = legacy_payload
        where legacy_payload is not null;
      alter table "outbox_events"
        drop constraint "outbox_events_version_positive",
        drop column "failed_at",
        drop column "updated_at",
        drop column "occurred_at",
        drop column "causation_id",
        drop column "correlation_id",
        drop column "event_version",
        drop column "legacy_payload";

      drop index "idx_inbox_received_at";
      drop index "idx_inbox_processed_at";
      alter table "inbox_messages"
        drop constraint "inbox_messages_consumer_message_unique",
        drop constraint "inbox_messages_pkey";
      alter table "inbox_messages" drop column "consumer_name", drop column "id";
      alter table "inbox_messages"
        add constraint "inbox_messages_pkey" primary key ("message_id");

      drop trigger "ledger_entries_append_only_truncate" on "wallet_ledger_entries";
      drop trigger "ledger_entries_append_only" on "wallet_ledger_entries";
      alter table "wallet_ledger_entries"
        drop constraint "ledger_entries_balance_consistent",
        drop constraint "ledger_entries_direction_check",
        drop constraint "ledger_entries_amount_positive";
      update "wallet_ledger_entries"
        set amount_minor = case when direction = 'DEBIT' then -amount_minor else amount_minor end;
      alter table "wallet_ledger_entries"
        add constraint "ledger_entries_amount_nonzero" check ("amount_minor" <> 0),
        add constraint "ledger_entries_balance_consistent"
          check ("balance_after_minor" - "balance_before_minor" = "amount_minor"),
        drop column "currency",
        drop column "direction";
      drop index "idx_ledger_wallet_created_at";
      create index "idx_ledger_entries_wallet_created"
        on "wallet_ledger_entries" ("wallet_id", "created_at");
      drop index "idx_ledger_transaction_id";
      alter table "wallet_ledger_entries" rename to "ledger_entries";
      create trigger "ledger_entries_append_only"
        before update or delete on "ledger_entries"
        for each row execute function "reject_ledger_mutation"();
      create trigger "ledger_entries_append_only_truncate"
        before truncate on "ledger_entries"
        for each statement execute function "reject_ledger_mutation"();

      drop index "idx_wt_round";
      drop index "idx_wt_pending_reference";
      drop index "idx_wt_reference_external";
      drop index "idx_wt_wallet_created_at";
      create index "idx_wager_transactions_wallet_created"
        on "wager_transactions" ("wallet_id", "created_at");
      alter table "wager_transactions"
        drop constraint "wager_transactions_provider_external_unique",
        drop constraint "wager_transactions_provider_idempotency_unique",
        drop constraint "wager_transactions_reference_required",
        drop constraint "wager_transactions_reference_attempts_non_negative",
        drop constraint "wager_transactions_status_check",
        drop constraint "wager_transactions_kind_check",
        drop column "updated_at",
        drop column "reference_expires_at",
        drop column "reference_next_attempt_at",
        drop column "reference_attempts",
        drop column "processed_at",
        drop column "failure_code",
        drop column "reference_external_transaction_id",
        drop column "currency",
        drop column "status",
        drop column "game_id",
        drop column "round_id",
        drop column "player_id",
        drop column "external_transaction_id",
        drop column "provider_id";
      alter table "wager_transactions" rename column "kind" to "type";
      alter table "wager_transactions"
        add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");
    `);
  }
}
