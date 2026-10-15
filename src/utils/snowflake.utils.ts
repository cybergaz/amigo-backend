import { VitalWSMessageEventsType } from "@/types/socket.types";

class Snowflake {
  /**
   * Build a correlation/dedup key for a WebSocket event:
   * `{userId}:{wsEventType}:{messageId}`.
   *
   * `messageId` is required (SYNC_V2 §13.7 C5). The old fallback appended a
   * per-PROCESS counter (`_monotonicCounter`), which two workers — or one
   * worker before and after a restart — would hand out twice, so two
   * unrelated events could share a key and overwrite each other. Every
   * caller already passed an id (polling.cache passes a random UUIDv7 when
   * the event has no natural id), so the branch was unreachable; removing
   * it keeps it that way.
   */
  static correlationId(
    userId: string,
    wsEventType: VitalWSMessageEventsType,
    messageId: string,
  ): string {
    return `${userId}:${wsEventType}:${messageId}`;
  }
}

export default Snowflake;
