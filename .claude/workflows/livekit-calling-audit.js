export const meta = {
  name: 'livekit-calling-audit',
  description: 'Exhaustive adversarial audit of the new LiveKit calling stack (Flutter + Kotlin + Bun backend)',
  phases: [
    { title: 'Find', detail: '6 dimension finders across app, native, backend' },
    { title: 'Verify', detail: 'adversarial refutation pass per dimension' },
  ],
}

const APP = '/home/coadal/workspace/amigo/amigo-flutter-app'
const BE = '/home/coadal/workspace/amigo/amigo-backend'

const CONTEXT = `
# Context

Project: "amigo" — a WhatsApp-like Flutter chat app (Riverpod + Drift/SQLite) with a Bun/Elysia + Drizzle/Postgres + Redis backend.

WORK UNDER REVIEW: a just-completed migration of 1:1 audio calling from Stream Video to **LiveKit**. The code compiles (\`flutter analyze\` = 0 errors) but has NEVER been run on a device and has never been reviewed. Your job is to find what will break at runtime.

Repos:
- Flutter app: ${APP}
- Backend:     ${BE}
- Spec:        /home/coadal/workspace/amigo/specs/calling/001-call-screens.md  (READ THIS FIRST)

Intended flow per the spec:
1. Caller presses call -> \`call:init\` over the existing WS transport.
2. Backend creates a LiveKit room (room name IS the call id) + mints the caller token -> \`call:init:ack\`; the CALLER JOINS IMMEDIATELY and keeps ringing.
3. Callee receives \`call:ringing\` -> native incoming screen. Accept -> \`call:accept\`.
4. Backend mints the callee token -> \`call:accept\` (to callee, with token) + \`call:accept:ack\` (to caller).
5. Callee joins the SAME room. Each side flips to \`in_call\` when it actually sees the remote participant.

Architectural division of labour (important — do not flag it as duplication):
- Backend owns the call record, the LiveKit room, and both tokens.
- Native Kotlin \`CallActivity\` owns EVERY pixel of call UI in 4 modes (outgoing / incoming / connecting / in_call) so the call survives the Flutter app being swiped away. Dart only pushes state transitions via \`NativeCallScreen\`.
- \`LivekitCallService\` (Dart) owns the \`lk.Room\`: join, publish mic, audio routing, participant watching, teardown.

Key files (new or heavily rewritten in this migration):
- ${APP}/lib/services/call/livekit_call.service.dart   (NEW, 1414 lines)
- ${APP}/lib/services/call/i_call_backend.dart          (the interface)
- ${APP}/lib/services/call/call.service.dart            (OLD WebRTC backend, still present)
- ${APP}/lib/services/call/stream/stream_call.service.dart (OLD Stream backend, still present)
- ${APP}/lib/services/call/native_call_screen.service.dart
- ${APP}/lib/providers/call.provider.dart
- ${APP}/lib/main.dart  (backend selection + \`attachNativeScreenHandlers\` + \`resumePendingAcceptIfAny\`)
- ${APP}/lib/env.dart   (\`CALL_BACKEND\` defaults to 'livekit'; \`LIVEKIT_URL\`)
- ${APP}/lib/utils/chat/chat-helpers.utils.dart (call entry point)
- ${APP}/lib/services/socket/ws-message.handler.dart, lib/types/socket.types.dart
- ${APP}/android/app/src/main/kotlin/com/aiexch/amigo/call/*.kt  (CallActivity 976L, CallApi 107L NEW, AmigoCallPlugin, CallNotificationManager, CallNotificationForegroundService, CallActionReceiver, AmigoMessagingService)
- ${APP}/android/app/src/main/AndroidManifest.xml
- ${BE}/src/services/livekit.service.ts, src/routes/livekit.routes.ts, src/config/livekit.config.ts
- ${BE}/src/sockets/socket.service.ts, src/sockets/socket.handlers.ts, src/sockets/socket.server.ts
- ${BE}/src/cache-management/calls.cache.ts, src/models/call.model.ts, src/types/call.types.ts
- ${BE}/drizzle/manual_add_livekit_calls.sql, scripts/applied-dev/apply-livekit-calls.ts

Useful: \`git -C <repo> diff HEAD -- <path>\` shows exactly what this migration changed (both repos are dirty, nothing committed for the app side). Untracked files (livekit_call.service.dart, CallApi.kt) are entirely new.

# Rules
- READ-ONLY. Do not edit, write, or create any file. Do not run builds, \`flutter\`, \`bun\`, or git write commands.
- Use \`rg\` for content search and \`fd\` for filenames (never grep/find).
- Report only defects you can point at with a concrete file:line and a concrete failure scenario. No style nits, no "consider adding tests", no speculation about code you did not read.
- Pre-existing lint noise (withOpacity deprecations, avoid_print, invalid_annotation_target) is OUT OF SCOPE.
- Prefer runtime-breaking bugs over theoretical ones. A bug that makes a call fail, hang, ring forever, leak, or crash is what matters.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'one-line defect claim' },
          file: { type: 'string', description: 'absolute path' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'the actual code/behaviour proving it, quoting the relevant lines' },
          failure_scenario: { type: 'string', description: 'concrete sequence of user/network actions -> observable wrong outcome' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'evidence', 'failure_scenario', 'suggested_fix'],
      },
    },
    notes: { type: 'string', description: 'anything checked and found CORRECT that is worth stating, plus what you could not verify' },
  },
  required: ['findings', 'notes'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          real: { type: 'boolean', description: 'true only if you FAILED to refute it after reading the code yourself' },
          corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          reason: { type: 'string', description: 'why it survived, or exactly what refutes it (cite file:line)' },
          corrected_fix: { type: 'string', description: 'the fix, corrected if the original was wrong' },
        },
        required: ['title', 'file', 'line', 'real', 'corrected_severity', 'reason', 'corrected_fix'],
      },
    },
  },
  required: ['verdicts'],
}

const DIMENSIONS = [
  {
    key: 'signalling',
    prompt: `Dimension: **WS signalling contract parity** between the Flutter client and the backend.

Enumerate EVERY \`call:*\` event in both directions. For each: which side emits it, which side handles it, and the exact payload shape. Then hunt for:
- events emitted by one side that the other side never handles (or handles under a different name/casing);
- payload field name or type mismatches (snake_case vs camelCase, string vs number ids, \`call_id\` vs \`callId\`, token field names, missing \`room\`/\`url\`);
- events the OLD Stream/WebRTC flow used that the client still emits/expects but the rewritten backend no longer serves (and vice versa);
- the FCM data-message payload keys (AmigoMessagingService.kt) vs what the backend actually sends vs what Dart re-parses on \`resumePendingAcceptIfAny\`;
- ordering assumptions that the transport (WS + HTTP long-polling fallback) cannot guarantee.

Start from ${APP}/lib/services/socket/ws-message.handler.dart, lib/types/socket.types.dart, livekit_call.service.dart and ${BE}/src/sockets/socket.service.ts + socket.handlers.ts.`,
  },
  {
    key: 'room-token',
    prompt: `Dimension: **LiveKit room + token lifecycle**, backend side.

Read ${BE}/src/services/livekit.service.ts, src/routes/livekit.routes.ts, src/config/livekit.config.ts, src/cache-management/calls.cache.ts, src/models/call.model.ts, drizzle/manual_add_livekit_calls.sql and scripts/applied-dev/apply-livekit-calls.ts. Hunt for:
- room naming: is the room name really the call id on BOTH the create path and the callee-token path? any place that derives a different name and would silently put the two parties in DIFFERENT rooms;
- token minting: identity collisions, grants (canPublish/canSubscribe/roomJoin), TTL shorter than a plausible ring+call duration, token minted for the wrong room or wrong identity;
- room cleanup: is the room deleted/closed on hangup/reject/timeout/cancel? are participants force-removed? leaks of empty rooms; egress of the LiveKit \`empty_timeout\`/\`max_participants\` config;
- route auth: are the livekit routes authenticated and authorised (can user A mint a token for a call they are not a participant of?);
- Redis key hygiene in calls.cache.ts: TTLs, single busy-slot per user, stale/ghost call entries, key collisions, missing cleanup paths;
- the SQL migration vs the Drizzle model: column/type/nullability drift, missing indexes on lookup columns, whether the migration is idempotent;
- LiveKit server SDK usage errors (awaiting, error handling, wrong API host/ws url, credentials read from the wrong env var).`,
  },
  {
    key: 'native-bridge',
    prompt: `Dimension: **Native Kotlin <-> Flutter bridge and the native call screen**.

Read every .kt under ${APP}/android/app/src/main/kotlin/com/aiexch/amigo/call/ (especially the NEW CallApi.kt and the reworked CallActivity.kt), plus ${APP}/lib/services/call/native_call_screen.service.dart and the \`attachNativeScreenHandlers\` wiring in lib/main.dart, and AndroidManifest.xml. Hunt for:
- method-channel / event-channel NAME mismatches between Kotlin and Dart, and argument-key mismatches inside the maps passed across;
- mode-string mismatches: Dart pushes "outgoing"/"incoming"/"connecting"/"in_call" — verify CallActivity accepts exactly those spellings on EVERY path (initial intent extra AND later updates), and what happens on an unknown mode;
- transitions that never fire: does the caller's outgoing screen actually become connecting -> in_call? does the callee's incoming screen become in_call? is the duration timer started from the right event?;
- the app-swiped-away case: if the Flutter engine is dead, who keeps the LiveKit room alive? Does hangup from the native screen or the notification reach the backend at all? Is there a path where the native UI shows an active call while the Dart-side room is gone (or the reverse)?;
- Activity lifecycle: launch flags, singleTask/singleInstance, onNewIntent handling, finish() races, screen-off/lockscreen (turnScreenOn/showWhenLocked), back-press handling, activity leaked after call end;
- foreground service: correct \`foregroundServiceType\` for the API level, manifest permissions (FOREGROUND_SERVICE_MICROPHONE, POST_NOTIFICATIONS, USE_FULL_SCREEN_INTENT), start-from-background restrictions on Android 12+/14+, notification channel importance for full-screen intents;
- ringtone/vibration start-stop pairing (AmigoRingtoneManager) and leftover Stream-era classes (StreamCallActionReceiver, StreamOngoingCallNotifier, StreamOngoingCallService) still registered in the manifest or still reachable.`,
  },
  {
    key: 'state-machine',
    prompt: `Dimension: **call state machine and race/edge cases**, mostly ${APP}/lib/services/call/livekit_call.service.dart (read all 1414 lines) plus lib/providers/call.provider.dart.

Walk every terminal and near-terminal path and look for states that hang, double-fire, or strand a party:
- caller cancels BEFORE \`call:init:ack\` arrives (there is a \`_cancelPendingInitAck\` flag — verify it is set, consumed, and cleared on every path, including error paths);
- callee rejects; callee is busy; callee offline; callee accepts on one path while an FCM replay delivers the same accept again (\`_joiningCallId\` guard — verify it is cleared in \`finally\`, on failure, and on a second call);
- ring timeout / missed call: who times out, is there a cap, does the other side learn about it, does the native screen dismiss;
- remote hangs up while local is still joining the room; both sides hang up simultaneously; hangup during LiveKit reconnection (there is a reconnect-suppression flag — verify it cannot latch ON forever and swallow a real disconnect);
- flipping to in_call on remote-participant-visible: what if the remote publishes no track, or joins then instantly drops; what if the participant event fires BEFORE the listener is attached;
- teardown completeness: room dispose, EventsListener cancel, StreamSubscriptions cancelled (note \`_callMissedSubscription\` is flagged unused by the analyzer at call.service.dart:85 — check the LiveKit service for the same class of leak), timers cancelled, ringtone stopped, audio session/mode restored, wakelock/proximity released;
- re-entrancy: a second incoming call arriving during an active call; starting a new outgoing call before the previous teardown finished;
- permission denial (mic) mid-flow, and what the user sees.`,
  },
  {
    key: 'backend-state',
    prompt: `Dimension: **backend call state machine, socket server, and delivery**.

Read ${BE}/src/sockets/socket.service.ts (2226L), socket.handlers.ts (751L), socket.server.ts, src/types/call.types.ts and src/types/socket.types.ts, focusing on the diff (\`git -C ${BE} diff HEAD -- src/sockets\`). This backend is HARD SINGLE-DEVICE: sockets, FCM, queues and calls all key on user_id with a single slot. Hunt for:
- busy-state correctness: can a user get stuck permanently "busy" (sticky busy) after a crash/abandon/late webhook? are there TTLs and self-healing precheck paths, and do the new LiveKit paths honour them the way the old Stream paths did?;
- call records: is a call row written on init and CLOSED on every terminal path (accept, reject, cancel, timeout, disconnect, error)? any path that leaves status stuck at ringing/active forever;
- socket disconnect mid-call: does the server notice and tell the peer? does it clean the LiveKit room and the Redis entry?;
- events delivered to a user with no live socket: is there an FCM fallback for call:incoming/accept/end, and can a stale/evicted socket swallow the event silently;
- reconnect/eviction races (a reconnecting client replacing its socket entry while a call event is being routed);
- anything removed with \`src/routes/call.routes.ts\` (deleted in this migration) that still has live callers — check the app AND the admin frontend AND src/server.ts route registration for dangling references;
- error handling: unawaited promises, thrown errors inside socket handlers that kill the handler chain, missing try/catch around LiveKit API calls (a LiveKit outage must not wedge the socket server).`,
  },
  {
    key: 'migration-residue',
    prompt: `Dimension: **migration residue and dual-backend hazards**.

Three ICallBackend implementations now coexist: livekit_call.service.dart (active default), call.service.dart (old WebRTC, 76KB), stream/stream_call.service.dart (old Stream). Hunt for concrete hazards:
- DOUBLE HANDLING: does any old service still subscribe to the shared WS message stream / transport at import time, at singleton construction, or from main.dart — such that BOTH it and the LiveKit service react to the same \`call:*\` event (two hangups, two joins, two native screens)? Trace every construction site and every listener registration, including \`attachNativeScreenHandlers\` and provider \`build()\`;
- static/singleton state in the old services that is initialised regardless of the selected backend (Firebase/FCM handlers, foreground services, notification callbacks, \`kCallRejoinEnabled\`-style flags);
- ${APP}/pubspec.yaml: stream_video deps are commented out but vendored \`dependency_overrides\` for stream_video / stream_video_push_notification remain — verify that is coherent (overrides for absent deps, the flutter_webrtc-vs-stream org.webrtc conflict noted in the comments, and whether livekit_client pulls its own flutter_webrtc that now collides). Check pubspec.lock and the generated plugin registrants (linux/windows/macos changed in the diff) for evidence;
- Kotlin: Stream-era classes/services/receivers still declared in AndroidManifest.xml that no longer have working Dart counterparts;
- dead-but-reachable UI: any screen/route/provider that still opens the OLD call flow (search for stream_video imports, StreamVideo, CallService, old call screens) so a user could enter a call through a path that bypasses LiveKit entirely;
- \`lib/env.dart\`: the \`CALL_BACKEND\` switch and the guest-mode LiveKit URL swap — is every consumer reading the switch consistently, and is the hardcoded guest URL \`ws://52.74.70.114:7880\` (cleartext ws://) going to be blocked by Android's cleartext/network-security policy?`,
  },
]

phase('Find')

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(`${CONTEXT}\n\n${d.prompt}\n\nReturn every defect you can substantiate. Be exhaustive within your dimension; depth beats breadth-across-dimensions (another agent covers each other dimension).`, {
    label: `find:${d.key}`,
    phase: 'Find',
    schema: FINDINGS_SCHEMA,
  }),
  (res, d) => {
    if (!res || !res.findings || res.findings.length === 0) return { key: d.key, verified: [], notes: res ? res.notes : 'finder returned nothing' }
    return agent(`${CONTEXT}\n\nYou are an ADVERSARIAL VERIFIER. Another agent reviewed the "${d.key}" dimension of this LiveKit migration and produced the findings below. Your job is to REFUTE them.

For each finding: open the cited file yourself, read the surrounding code AND the code on the other side of the boundary it claims is broken, and try hard to prove the finding WRONG — the guard exists elsewhere, the name does match, the path is unreachable, the framework already handles it, the reviewer misread an alias/import, the value is set somewhere they did not look. Set \`real: false\` when you refute it. Default to \`real: false\` when you cannot convince yourself either way — a false alarm costs more than a miss here.

When a finding survives, correct its severity honestly (critical = calls are broken or hang for real users; low = cosmetic/rare) and correct the suggested fix if the original fix would not actually work or would break something else.

FINDINGS TO REFUTE:
${JSON.stringify(res.findings, null, 2)}`, {
      label: `verify:${d.key}`,
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
      effort: 'high',
    }).then((v) => ({ key: d.key, verified: v && v.verdicts ? v.verdicts.filter((x) => x.real) : [], refuted: v && v.verdicts ? v.verdicts.filter((x) => !x.real).length : 0, notes: res.notes }))
  }
)

const ok = results.filter(Boolean)
const confirmed = ok.flatMap((r) => r.verified.map((f) => ({ ...f, dimension: r.key })))
const order = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (order[a.corrected_severity] ?? 9) - (order[b.corrected_severity] ?? 9))

log(`confirmed ${confirmed.length} findings across ${ok.length} dimensions (${ok.reduce((n, r) => n + (r.refuted || 0), 0)} refuted)`)

return {
  confirmed,
  refutedCount: ok.reduce((n, r) => n + (r.refuted || 0), 0),
  dimensionNotes: ok.map((r) => ({ dimension: r.key, notes: r.notes })),
}
