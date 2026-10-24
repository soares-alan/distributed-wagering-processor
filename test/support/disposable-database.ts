import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';

export interface DisposableDatabase {
  name: string;
  drop(): Promise<void>;
}

async function withAdminConnection<T>(
  run: (execute: (sql: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const admin = await MikroORM.init(
    defineConfig({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      dbName: 'postgres',
      metadataProvider: ReflectMetadataProvider,
      discovery: { warnWhenNoEntities: false },
      entities: [],
    }),
  );
  try {
    return await run((sql) => admin.em.getConnection().execute(sql));
  } finally {
    await admin.close(true);
  }
}

/**
 * Creates an isolated, uniquely named database and points POSTGRES_DB at it.
 * It must be called before the application configuration module is imported.
 * Only the database created here is ever dropped; the local database is untouched.
 */
export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const name = `wagering_it_${randomUUID().replaceAll('-', '')}`;
  await withAdminConnection((execute) => execute(`create database "${name}"`));
  process.env.POSTGRES_DB = name;
  return {
    name,
    drop: () =>
      withAdminConnection((execute) =>
        execute(`drop database if exists "${name}" with (force)`),
      ).then(() => undefined),
  };
}
