// Call signaling message types
export interface CallSignalingMessage {
  type: 'call:init' | 'call:offer' | 'call:answer' | 'call:ice' | 'call:accept' | 'call:decline' | 'call:end' | 'call:ringing' | 'call:missed';
  callId: number;
  from: number;
  to: number;
  payload?: any;
  timestamp?: string;
}

// Call initialization payload
export interface CallInitPayload {
  callerName: string;
  callerProfilePic?: string;
}

// WebRTC SDP offer/answer payload
export interface SDPPayload {
  sdp: string;
  type: 'offer' | 'answer';
}

// ICE candidate payload
export interface ICEPayload {
  candidate: string;
  sdpMLineIndex?: number;
  sdpMid?: string;
}

// Call end reason
export interface CallEndPayload {
  reason?: 'user_hangup' | 'timeout' | 'network_error' | 'busy' | 'no_answer';
  duration?: number;
}
