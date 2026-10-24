// Test-only worker process: runs the compiled application (no HTTP) and, after the
// first SQS-driven transaction COMMITS, announces it and then blocks forever so the
// message is never ACKed. The test harness SIGKILLs this process from outside.
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../dist/app.module.js';
import { WagerTransactionService } from '../../dist/application/wager-transaction.service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
const service = app.get(WagerTransactionService);
const original = service.process.bind(service);

service.process = async (input, inboxIdentity) => {
  const result = await original(input, inboxIdentity);
  if (inboxIdentity) {
    process.stdout.write(`COMMITTED ${result.transactionId}\n`);
    await new Promise(() => {});
  }
  return result;
};

process.stdout.write('READY\n');
