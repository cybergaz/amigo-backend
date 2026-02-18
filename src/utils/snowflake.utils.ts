import { createHash, randomInt } from "crypto";

class Snowflake {
  private static readonly _epoch = 1577836800000; // 2020-01-01
  private static readonly _nodeId = 1 & 0x1f; // 5 bits: 0–31
  private static _sequence = 0;
  private static _lastTimestamp = -1;

  static generatePositive(): number {
    let timestamp = Date.now();

    if (timestamp === this._lastTimestamp) {
      this._sequence = (this._sequence + 1) & 0x7f; // 7 bits: 0–127
      if (this._sequence === 0) {
        while (timestamp <= this._lastTimestamp) {
          timestamp = Date.now();
        }
      }
    } else {
      this._sequence = 0;
    }

    this._lastTimestamp = timestamp;

    const id =
      ((timestamp - this._epoch) << 12) |
      (this._nodeId << 7) |
      this._sequence;
    return id;
  }

  /**
   * Generate a 63‑bit positive, hash‑based message id.
   *
   * This mirrors the Dart implementation:
   *   - Uses userId, conversationId (or random 15‑digit fallbacks),
   *   - current timestamp in ms,
   *   - and extra random entropy,
   * then hashes with SHA‑256 and takes the first 8 bytes.
   *
   * NOTE: Unlike Dart, backend code is responsible for providing userId.
   */
  static generateMessageId(
    userId: number | bigint,
    conversationId?: number | bigint,
  ): bigint {
    const timestampMs = Date.now();

    const uId =
      typeof userId === "bigint" ? userId : BigInt(userId ?? this._generateRandom15Digit());

    const convIdSource =
      conversationId ?? this._generateRandom15Digit();
    const convId =
      typeof convIdSource === "bigint" ? convIdSource : BigInt(convIdSource);

    // Extra randomness to protect against same‑ms retries (~1M space)
    const random = randomInt(1 << 20);

    const input = Buffer.from(
      `${uId.toString()}:${convId.toString()}:${timestampMs}:${random}`,
      "utf8",
    );

    const hash = createHash("sha256").update(input).digest();

    // Take first 8 bytes = 64 bits
    let id = 0n;
    for (let i = 0; i < 8; i++) {
      id = (id << 8n) | BigInt(hash[i]);
    }

    // Force into signed BIGINTdd positive range (63 bits)
    id &= 0x7fffffffffffffffn;

    return id;
  }

  /**
   * Generate a random 15‑digit positive integer (no leading zeros).
   * Kept as a helper to mirror the Dart implementation.
   */
  private static _generateRandom15Digit(): number {
    // First digit: 1–9 to avoid leading zero
    let value = randomInt(1, 10);

    // Remaining 14 digits: 0–9
    for (let i = 1; i < 15; i++) {
      const digit = randomInt(0, 10);
      value = value * 10 + digit;
    }

    return value;
  }
}

export default Snowflake;
