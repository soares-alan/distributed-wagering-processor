import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01',
  '57P03',
  '53300',
  '55P03',
  '40001',
  '40P01',
]);
const TRANSIENT_NAMES = /Connection|Timeout|Deadlock|Serialization/i;

export function isTransientInfrastructureError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return (
    (typeof code === 'string' && TRANSIENT_CODES.has(code)) ||
    (typeof name === 'string' && TRANSIENT_NAMES.test(name))
  );
}

/** Non-HTTP errors: transient infrastructure failures become 503 (safe to retry), the rest 500. */
@Catch()
export class InfrastructureExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(InfrastructureExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const transient = isTransientInfrastructureError(exception);
    this.logger.error(
      transient ? 'Transient infrastructure failure.' : 'Unhandled error.',
      exception instanceof Error ? exception.stack : String(exception),
    );
    if (transient) response.setHeader('Retry-After', '1');
    response.status(transient ? 503 : 500).json({
      statusCode: transient ? 503 : 500,
      message: transient
        ? 'Temporary infrastructure failure; the request may be retried.'
        : 'Internal server error.',
    });
  }
}
