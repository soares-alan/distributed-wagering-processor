import { parseWagerMessage } from './sqs-inbox-consumer.service.js';

describe('parseWagerMessage', () => {
  const envelope = {
    messageId: 'message-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-24T13:00:00.000Z',
    data: {
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'key-1',
      playerId: '4c83f7ce-f915-4ad0-8e1a-4b8c85cdab55',
      walletId: 'aa932b44-6f20-43b2-9172-590c5a7a606b',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    },
  };

  it('accepts a valid versioned transaction envelope', () => {
    expect(parseWagerMessage(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('rejects malformed JSON and unsupported message types', () => {
    expect(() => parseWagerMessage('{')).toThrow(SyntaxError);
    expect(() =>
      parseWagerMessage(
        JSON.stringify({ ...envelope, type: 'UnsupportedEvent' }),
      ),
    ).toThrow('Unsupported SQS message type.');
  });

  it('rejects transaction data that does not match the message contract', () => {
    expect(() =>
      parseWagerMessage(
        JSON.stringify({
          ...envelope,
          data: { ...envelope.data, kind: 'OPENING' },
        }),
      ),
    ).toThrow('SQS transaction data does not match its contract.');
  });
});
