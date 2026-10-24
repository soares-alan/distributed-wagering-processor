import { createHash, randomUUID } from 'node:crypto';
import { Migration } from '@mikro-orm/migrations';

interface ExistingWallet {
  id: string;
  player_id: string;
  currency: string;
  balance_minor: string;
}

export class Migration20261024132600 extends Migration {
  override async up(): Promise<void> {
    const wallets = (await this.execute(`
      select id::text, player_id::text, upper(trim(currency)) as currency,
             balance_minor::text
      from wallets
      order by id
    `)) as ExistingWallet[];

    for (const wallet of wallets) {
      const balance = BigInt(wallet.balance_minor);
      const idempotencyKey = `opening:migration:${wallet.id}`;
      const payloadHash = createHash('sha256')
        .update(
          JSON.stringify({
            playerId: wallet.player_id.toLowerCase(),
            currency: wallet.currency,
            openingBalanceMinor: balance.toString(),
          }),
        )
        .digest('hex');
      const transactionId = randomUUID();

      this.addSql(`
        insert into "wager_transactions" (
          "id", "wallet_id", "idempotency_key", "payload_hash", "type",
          "amount_minor", "balance_after_minor"
        ) values (
          '${transactionId}', '${wallet.id}', '${idempotencyKey}',
          '${payloadHash}', 'OPENING', '${balance}', '${balance}'
        );
      `);

      if (balance > 0n) {
        this.addSql(`
          insert into "ledger_entries" (
            "id", "transaction_id", "wallet_id", "amount_minor",
            "balance_before_minor", "balance_after_minor"
          ) values (
            '${randomUUID()}', '${transactionId}', '${wallet.id}',
            '${balance}', '0', '${balance}'
          );
        `);
      }
    }
  }

  override down(): void {
    this.addSql(`
      drop trigger "ledger_entries_append_only_truncate" on "ledger_entries";
      drop trigger "ledger_entries_append_only" on "ledger_entries";
      delete from "ledger_entries"
      where "transaction_id" in (
        select "id" from "wager_transactions"
        where "idempotency_key" like 'opening:migration:%'
      );
      delete from "wager_transactions"
      where "idempotency_key" like 'opening:migration:%';
      create trigger "ledger_entries_append_only"
        before update or delete on "ledger_entries"
        for each row execute function "reject_ledger_mutation"();
      create trigger "ledger_entries_append_only_truncate"
        before truncate on "ledger_entries"
        for each statement execute function "reject_ledger_mutation"();
    `);
  }
}
