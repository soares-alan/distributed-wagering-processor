import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/application/config.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const endpoint = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
const client = createSqsClient(region, endpoint);

try {
  console.log(`Creating required FIFO queues at ${endpoint}...`);
  const deadLetter = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  if (!deadLetter.QueueUrl) throw new Error('SQS returned no DLQ URL.');

  const deadLetterAttributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetter.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
  if (!deadLetterArn) throw new Error('SQS returned no DLQ ARN.');

  const input = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ReceiveMessageWaitTimeSeconds: '20',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  if (!input.QueueUrl) throw new Error('SQS returned no input queue URL.');

  console.log(`SQS_INBOX_QUEUE_URL=${input.QueueUrl}`);
  console.log(`SQS DLQ URL=${deadLetter.QueueUrl}`);
} catch (error) {
  console.error(`Failed to create required SQS queues at ${endpoint}.`);
  console.error(error);
  process.exitCode = 1;
} finally {
  client.destroy();
}
