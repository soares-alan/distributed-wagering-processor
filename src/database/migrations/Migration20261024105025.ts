import { Migration } from '@mikro-orm/migrations';

export class Migration20261024105025 extends Migration {

  override name = 'Migration20261024105025';

  override up(): void | Promise<void> {
    this.addSql(`drop index "idx_wallets_updated_at";`);
    this.addSql(`alter table "wallets" drop constraint "wallets_player_currency_unique";`);
    this.addSql(`alter table "wallets" drop constraint "wallets_balance_non_negative";`);
    this.addSql(`alter table "wallets" drop constraint "wallets_version_positive";`);
    this.addSql(`alter table "wallets" alter column "balance_minor" set default '0';`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wallets" alter column "balance_minor" set default 0;`);
    this.addSql(`create index "idx_wallets_updated_at" on "wallets" ("updated_at");`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance_minor >= 0);`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
  }

}
