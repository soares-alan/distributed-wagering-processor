import { SQSClient } from '@aws-sdk/client-sqs';

export function integerEnv(
  name: string,
  defaultValue: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function createSqsClient(region: string, endpoint?: string): SQSClient {
  const endpointHost = endpoint
    ? new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
    : undefined;
  const isLocalEndpoint =
    endpointHost === 'localhost' ||
    endpointHost?.endsWith('.localhost') === true ||
    endpointHost === '127.0.0.1' ||
    endpointHost === '::1';

  return new SQSClient({
    region,
    maxAttempts: 2,
    ...(endpoint ? { endpoint } : {}),
    ...(isLocalEndpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  });
}
