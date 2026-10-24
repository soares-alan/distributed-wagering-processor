export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T = Record<string, unknown>> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope stored in the outbox payload and published to SQS. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId ?? null,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

type EventData = Record<string, unknown>;

export class WagerTransactionProcessed extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(props: IntegrationEventProps<EventData>): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(props: IntegrationEventProps<EventData>): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

export class WalletBalanceChanged extends IntegrationEvent<EventData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(props: IntegrationEventProps<EventData>): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(props: IntegrationEventProps<EventData>): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}

export type IntegrationEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WalletBalanceChanged'
  | 'WagerTransactionPendingReference';

export function integrationEventFor(
  eventType: IntegrationEventType,
  props: IntegrationEventProps<EventData>,
): IntegrationEvent<EventData> {
  switch (eventType) {
    case 'WagerTransactionProcessed':
      return WagerTransactionProcessed.from(props);
    case 'WagerTransactionRejected':
      return WagerTransactionRejected.from(props);
    case 'WalletBalanceChanged':
      return WalletBalanceChanged.from(props);
    case 'WagerTransactionPendingReference':
      return WagerTransactionPendingReference.from(props);
  }
}
