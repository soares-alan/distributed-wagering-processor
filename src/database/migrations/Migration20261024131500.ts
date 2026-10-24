import { Migration } from '@mikro-orm/migrations';

export class Migration20261024131500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_player_currency_unique"
        unique ("player_id", "currency");
    `);
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_balance_non_negative"
        check ("balance_minor" >= 0);
    `);
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_version_positive"
        check ("version" >= 1);
    `);
    this.addSql(`
      create index "idx_wallets_updated_at"
      on "wallets" ("updated_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index "idx_wallets_updated_at";');
    this.addSql(
      'alter table "wallets" drop constraint "wallets_version_positive";',
    );
    this.addSql(
      'alter table "wallets" drop constraint "wallets_balance_non_negative";',
    );
    this.addSql(
      'alter table "wallets" drop constraint "wallets_player_currency_unique";',
    );
  }
}
