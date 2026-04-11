import { VitalWSMessageEventsType } from "@/types/socket.types";

class Snowflake {
  private static _monotonicCounter = 0;

  /**
   * Build a correlation/dedup key for a WebSocket event.
   *
   * Format (with messageId):    `{userId}:{wsEventType}:{messageId}`
   * Format (without messageId): `{userId}:{wsEventType}:{monotonicId}`
   */
  static correlationId(
    userId: string,
    wsEventType: VitalWSMessageEventsType,
    messageId?: string,
  ): string {
    if (messageId !== undefined && messageId !== null) {
      return `${userId}:${wsEventType}:${messageId}`;
    }
    const mono = ++Snowflake._monotonicCounter;
    return `${userId}:${wsEventType}:${mono}`;
  }
}

export default Snowflake;
