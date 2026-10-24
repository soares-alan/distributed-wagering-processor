
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { OutboxSqsPublisher } from './application/outbox-sqs-publisher.service.js';
import { SqsInboxConsumer } from './application/sqs-inbox-consumer.service.js';
import { WagerMetrics } from './application/wager-metrics.service.js';
import { WagerTransactionService } from './application/wager-transaction.service.js';
import { AuthGuard } from './auth.guard.js';
import { InfrastructureExceptionFilter } from './infrastructure-exception.filter.js';
import mikroOrmConfig from './mikro-orm.config.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY || 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET || 'YOUR_APP_SECRET',
      serviceId: 'distributed-wagering-processor',
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: InfrastructureExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    WagerMetrics,
    WagerTransactionService,
    OutboxSqsPublisher,
    SqsInboxConsumer,
  ],
})
export class AppModule {}
