const MAX_BIGINT = (1n << 63n) - 1n;
const MINOR_UNITS_PER_MAJOR = 100n;

export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

  static fromMinorUnits(value: bigint | string, currency: string): Money {
    const normalizedCurrency = Money.normalizeCurrency(currency);
    let minorUnits: bigint;

    if (typeof value === 'bigint') {
      minorUnits = value;
    } else if (/^\d+$/.test(value)) {
      minorUnits = BigInt(value);
    } else {
      throw new TypeError('Minor units must be a non-negative integer.');
    }

    if (minorUnits < 0n || minorUnits > MAX_BIGINT) {
      throw new RangeError('Amount is outside the PostgreSQL BIGINT range.');
    }

    return new Money(minorUnits, normalizedCurrency);
  }

  static fromDecimal(value: string, currency: string): Money {
    const normalizedCurrency = Money.normalizeCurrency(currency);
    const match = /^(\d+)\.(\d{2})$/.exec(value);

    if (!match) {
      throw new TypeError('Amount must have exactly 2 fractional digits.');
    }

    const wholeUnits = BigInt(match[1]);
    const fractionalUnits = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    const minorUnits = wholeUnits * MINOR_UNITS_PER_MAJOR + fractionalUnits;

    if (minorUnits > MAX_BIGINT) {
      throw new RangeError('Amount is outside the PostgreSQL BIGINT range.');
    }

    return new Money(minorUnits, normalizedCurrency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(
      this.minorUnits + other.minorUnits,
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    if (other.minorUnits > this.minorUnits) {
      throw new RangeError('Insufficient funds.');
    }

    return Money.fromMinorUnits(
      this.minorUnits - other.minorUnits,
      this.currency,
    );
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  toDecimal(): string {
    const wholeUnits = this.minorUnits / MINOR_UNITS_PER_MAJOR;
    const fractionalUnits = (this.minorUnits % MINOR_UNITS_PER_MAJOR)
      .toString()
      .padStart(2, '0');

    return `${wholeUnits}.${fractionalUnits}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toDecimal(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new TypeError(
        `Currency mismatch: ${this.currency} and ${other.currency}.`,
      );
    }
  }

  private static normalizeCurrency(currency: string): string {
    if (
      !/^[A-Za-z]{3}$/.test(currency) ||
      !Intl.supportedValuesOf('currency').includes(currency.toUpperCase())
    ) {
      throw new TypeError('Currency must be a valid ISO-4217 code.');
    }

    return currency.toUpperCase();
  }
}
