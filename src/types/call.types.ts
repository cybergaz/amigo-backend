// Call signaling message types
interface CallSignalingMessage {
  type: 'call:init' | 'call:offer' | 'call:answer' | 'call:ice' | 'call:accept' | 'call:terminate' | 'call:ringing';
  callId: number;
  from: number;
  to: number;
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
  type: 'offer' | 'answer';
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
  "declined"
] as const;

const CALL_END_REASONS_CONSTS = [
  'busy',
  'timeout',
  'declined',
  'abandoned',
  'caller_hungup',
  'callee_hungup',
  'network_error',
] as const;

type CallStatusType = typeof CALL_STATUS_CONSTS[number];
type CallEndReasonsType = typeof CALL_END_REASONS_CONSTS[number];

export { CALL_STATUS_CONSTS, CALL_END_REASONS_CONSTS };
export type {
  CallSignalingMessage,
  CallInitPayload,
  SDPPayload,
  ICEPayload,
  CallEndPayload,
  CallEndReasonsType,
  CallStatusType
};

