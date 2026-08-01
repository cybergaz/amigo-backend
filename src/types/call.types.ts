import { ActiveCall } from "@/services/livekit.service";

// Call signaling message types
interface CallSignalingMessage {
  type:
    | "call:init"
    | "call:offer"
    | "call:answer"
    | "call:ice"
    | "call:accept"
    | "call:terminate"
    | "call:ringing";
  callId: string;
  from: string;
  to: string;
  payload?: any;
  timestamp?: string;
}

// Call initialization payload
interface CallInitPayload {
  callerName: string;
  callerProfilePic?: string;
}

// WebRTC SDP offer/answer payload
interface SDPPayload {
  sdp: string;
  type: "offer" | "answer";
}

// ICE candidate payload
interface ICEPayload {
  candidate: string;
  sdpMLineIndex?: number;
  sdpMid?: string;
}

// Call end reason
interface CallEndPayload {
  reason?: CallEndReasonsType;
  duration?: number;
}

const CALL_STATUS_CONSTS = [
  "initiated",
  "ringing",
  "answered",
  "ended",
  "missed",
  "declined",
] as const;

const CALL_END_REASONS_CONSTS = [
  "busy",
  "timeout",
  "declined",
  "abandoned",
  "caller_hungup",
  "callee_hungup",
  "network_error",
] as const;

const CALL_PROVIDER_CONSTS = ["webrtc", "stream"] as const;

type CallStatusType = (typeof CALL_STATUS_CONSTS)[number];
type CallEndReasonsType = (typeof CALL_END_REASONS_CONSTS)[number];
type CallProviderType = (typeof CALL_PROVIDER_CONSTS)[number];

// <--------------------Custom Parsers for cache------------------------>
const parse_call_cache_row = (
  raw: Record<string, string> | null | undefined,
): ActiveCall | null => {
  if (!raw || !raw.id) return null;

  return {
    call_id: raw.id,
    caller_id: raw.caller_id,
    callee_id: raw.callee_id,
    started_at: new Date(raw.started_at),
    answered_at: raw.answered_at ? new Date(raw.answered_at) : undefined,
    ended_at: raw.ended_at ? new Date(raw.ended_at) : undefined,
    status: raw.status as CallStatusType,
    reason: raw.reason as CallEndReasonsType | undefined,
    timeout_timer: undefined, // Timers cannot be serialized; they should be set up in the service logic
  };
};

export { CALL_STATUS_CONSTS, CALL_END_REASONS_CONSTS, CALL_PROVIDER_CONSTS };
export type {
  CallSignalingMessage,
  CallInitPayload,
  SDPPayload,
  ICEPayload,
  CallEndPayload,
  CallEndReasonsType,
  CallStatusType,
  CallProviderType,
};

export { parse_call_cache_row };
