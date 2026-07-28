export const meta = {
  name: 'vanishing-messages-forensics',
  description: 'Root-cause the clock→vanish→delayed-burst→duplicates field bug',
  phases: [
    { title: 'Investigate', detail: '6 parallel deep-readers over the committed (field) code' },
    { title: 'Synthesize', detail: 'build ranked hypotheses from all evidence' },
    { title: 'Verify', detail: 'adversarial check of each hypothesis vs all symptoms' },
  ],
}

const SYMPTOMS = `
FIELD BUG (affects 1-2 users persistently; all other users fine at the same time; cannot be reproduced by the dev):
- S1: When the episode starts, the SEND button turns gray/disabled for ~2-3 seconds, then returns to normal.
- S2: Sent messages show the clock (pending) icon and stay clocked. When the user closes the chat or the app and reopens it, the clocked message is GONE — vanished entirely from the chat.
- S3: After 20-40+ minutes, ALL messages "sent" during the broken period were delivered to their respective chats AT ONCE — including messages the sender could no longer see locally (they appeared/were delivered anyway).
- S4: Some of those eventually-delivered messages were duplicated x2 to x4; others were delivered exactly once.
Constraints:
- C1: The affected user's internet works (WhatsApp works fine simultaneously).
- C2: The app's existing retry system (message stays clocked across app restarts, retried until sent) is well-tested and works for every other user.
- C3: The bug occurred on the FIELD build, which PREDATES all uncommitted working-tree changes.
- C4: The app's version gate allows builds 39-42, so affected users may run an OLDER build than the latest code.
`;

const REPO_RULES = `
CRITICAL REPO RULES:
- App repo: /home/gaz/workspace/amigo/amigo-app. The working tree contains UNCOMMITTED perf changes that DO NOT EXIST in the field build. First run: git -C /home/gaz/workspace/amigo/amigo-app status --porcelain
  For ANY file listed there as modified (M), you MUST read the committed version via: git -C /home/gaz/workspace/amigo/amigo-app show HEAD:<path>   (e.g. git -C ... show HEAD:lib/screens/chat/shared/chat-send.mixin.dart)
  Untracked new files (lib/services/diagnostics/*, lib/utils/stream-coalesce.util.dart, lib/services/socket/vital-event-queue.service.dart) DO NOT exist in the field build — ignore them entirely.
  Unmodified files can be read directly from the working tree.
- Backend repo: /home/gaz/workspace/amigo/amigo-backend. Production runs commit 2f31263f. The working tree has uncommitted changes NOT in prod. Read prod code via: git -C /home/gaz/workspace/amigo/amigo-backend show 2f31263f:<path>
- Use rg for content search and fd for file search. Cite every claim as file:line (mark HEAD: or 2f31263f: when read from git).
Return RAW structured facts — your final message is data for a synthesizer, not prose for a human.
`;

const INVEST_SCHEMA = {
  type: 'object',
  required: ['report', 'key_facts'],
  properties: {
    report: { type: 'string', description: 'Dense factual report answering every assigned question' },
    key_facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fact', 'evidence', 'symptom_links'],
        properties: {
          fact: { type: 'string' },
          evidence: { type: 'string', description: 'file:line citations' },
          symptom_links: { type: 'string', description: 'which of S1-S4/C1-C4 this bears on and how' },
        },
      },
    },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['hypotheses'],
  properties: {
    hypotheses: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'title', 'mechanism', 'explains', 'evidence_for', 'evidence_against', 'decisive_field_test'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          mechanism: { type: 'string', description: 'step-by-step causal chain' },
          explains: { type: 'string', description: 'for EACH of S1,S2,S3,S4,C1,C2,C3: explained/partial/unexplained + one line why' },
          evidence_for: { type: 'string' },
          evidence_against: { type: 'string' },
          decisive_field_test: { type: 'string', description: 'what to check on the affected users device/server to confirm or kill this' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['hypothesis_id', 'verdict', 'reasoning', 'unexplained', 'code_evidence_checked'],
  properties: {
    hypothesis_id: { type: 'string' },
    verdict: { type: 'string', enum: ['CONFIRMED-PLAUSIBLE', 'PARTIAL', 'REFUTED'] },
    reasoning: { type: 'string' },
    unexplained: { type: 'string', description: 'symptoms/constraints this hypothesis cannot account for' },
    code_evidence_checked: { type: 'string', description: 'file:line facts you re-verified in the repo yourself' },
  },
}

phase('Investigate')

const INVESTIGATIONS = [
  {
    key: 'send-path',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You investigate the SEND PATH AND LOCAL PERSISTENCE in the committed (HEAD) app code.
Questions (answer ALL, exhaustively):
1. In HEAD:lib/screens/chat/shared/chat-send.mixin.dart sendMessage: trace the exact control flow when messagesRepo.insertMessage returns a FAILURE that is NOT sqlite error 1555. Is the failure swallowed? Does the optimistic in-memory list still show the message with a clock while NO row exists in the DB? What exactly does the user see now vs after closing/reopening the chat (stream rebuilds from DB)?
2. What operations does isSendingMessage=true span (the send button disable)? Which awaited op could take 2-3 seconds (S1)? Is the WS/transport send inside or outside that span?
3. Read HEAD:lib/db/repositories/message.repo.dart insertMessage + insertMessages: what do they return per error type, what is logged, do callers ever surface failure to the user?
4. FTS: lib/db/sqlite.schema.dart — read _createMessagesFts and ALL triggers on the messages table (v20). If the FTS5 index is corrupted on a device, does a trigger failure ABORT the messages INSERT itself? What sqlite error would surface? Would EVERY subsequent message insert fail persistently on that one device (C1)?
5. SQLite connection setup in lib/db/ (sqlite.schema.dart tail + sqlite.db.dart): busy_timeout setting (is one set AT ALL?), WAL, NativeDatabase.createInBackground, readPool. Then: does ANY OTHER isolate or process open the same DB file — check lib/services/fcm/fcm-background.service.dart and fcm-init.service.dart for database access from the FCM background isolate (separate connection => SQLITE_BUSY races with the main writer?).
6. MessageRepository has a _cleanupTimer field — find what it does. Enumerate EVERY code path in the app that DELETEs or could remove rows from the messages table (hard deletes, disappearing-message local sweeps, cleanup timers, cache eviction) and their conditions. This is the prime suspect for S2 (vanishing rows).
7. What is newMsg.expiresAt on a locally-inserted own message in a disappearing-enabled chat — computed locally from the device clock? Cite the code.`,
  },
  {
    key: 'gc-retry',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You investigate the RETRY ENGINE at HEAD: git show HEAD:lib/services/message/message_gc.service.dart, plus the retry nudge in HEAD:lib/screens/chat/shared/chat-send.mixin.dart (startSendAutoRetry) and HEAD:lib/services/message/media-upload.manager.dart where relevant.
Questions:
1. Full retry lifecycle at HEAD: periodic interval, staleness threshold, single-flight semantics, what triggers immediate sweeps.
2. During a LONG (30-40 min) transport outage or with a transport that CLAIMS connected but whose HTTP verify calls fail: what does each GC sweep do? Does verifyMessageIds fail gracefully and leave messages pending? Is there any backoff on verify failures?
3. THE BURST (S3): when connectivity truly recovers after 30-40 min, does a single GC sweep verify+resend EVERY stalled message across all conversations in one pass? Confirm mechanically that this produces an all-at-once burst into multiple chats.
4. ID stability: on every retry path (GC resend, manual resend, media retry, split messages), is the SAME message id always reused, or does ANY path mint a new id? (New ids would defeat server-side dedup => duplicates S4.)
5. The 30-min give-up (_maxRetryDuration): exact conditions to mark failed. During a full outage where verify never succeeds, do messages survive past 30-40 min still pending (so they CAN burst-send on recovery)?
6. What happens if the DB row for a tracked unacked message is deleted while GC still tracks it in memory? Any path where GC itself deletes rows?
7. Does the GC ever send a message whose row is INVISIBLE to the chat's watch query (e.g. wrong/empty chatId, delete-for-me marked)? getStalledMessages has no chatId filter — confirm.`,
  },
  {
    key: 'transport-http',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You investigate the TRANSPORT + HTTP layer at HEAD: git show HEAD:lib/services/socket/transport.manager.dart and HEAD:lib/services/socket/transport.service.dart, plus lib/api/api_service.dart and the base Dio client construction (lib/api/*).
Questions:
1. Dio configuration: are connectTimeout / receiveTimeout / sendTimeout set ANYWHERE? Any retry interceptors? If unset, how long can a POST hang on (a) a fresh connection that cannot connect, (b) an established pooled connection whose network path silently died (TCP retransmission window ~15-30 min)? Could multiple queued send-message POSTs complete in a burst when the path heals (S3)?
2. LongPollingTransport at HEAD: confirm connect() reports connected=true unconditionally. Under polling, how does a text message send travel (which endpoint)? What happens to those POSTs when the network is dead but the transport still claims connected? Does the send-message POST have any timeout/cancellation?
3. WebSocketTransport at HEAD: heartbeat cadences and zombie detection time; when a send goes into a zombie socket, where do the bytes sit (OS buffer)? After the app closes/tears down that socket, can buffered frames still be delivered much later by TCP retransmission? Assess honestly.
4. The wsFailures fallback (3 failures -> polling): plausible sequence by which an affected user is silently stuck on polling-mode with dead HTTP for 30-40 min while isConnected==true the whole time (so chat-send takes the "connected" branch and every send "succeeds").
5. At HEAD, when transportManager.sendMessage returns false or throws for a TEXT message, what happens (no queueing at HEAD, correct?). And when it returns true-but-dead?
6. Anything in the transport/API layer that could hold outbound data ~20-40 min and then release it all at once. Enumerate every candidate with file:line.`,
  },
  {
    key: 'visibility-deletion',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You investigate WHY A LOCALLY-SENT MESSAGE CAN VANISH from the chat (S2) at HEAD.
Questions:
1. HEAD:lib/db/repositories/message.repo.dart watchMessages: list EVERY filter that can exclude a row (the mi_self join deletedAt filter, chatId equality, anything else). For each: what writes could make an OWN just-sent message fail the filter?
2. displayMessages / disappearing-message view filter (lib/screens/chat/shared/chat-scroll.mixin.dart and wherever expiresAt is evaluated): exact predicate. Can a fresh own message evaluate as expired (device clock skew? server-clamped values? conv disappearing settings)? Where does expiresAt on an own message come from before the server ack, and what does the ack overwrite it with (HEAD:lib/providers/chat.provider.dart _handleSentAck)?
3. Is there a LOCAL sweeper that hard-DELETES expired disappearing messages from SQLite (search for deleteMessage/delete(db.messages) callers, timers, main.dart init)? Conditions and cadence. Could it delete NOT-YET-SENT (serverAcked=false) messages?
4. Screen lifecycle: confirm that on chat close/reopen the in-memory messages list is rebuilt purely from the watch stream, so an optimistic message with no DB row (or filtered row) is gone (S2). HEAD:lib/screens/chat/shared/chat-sync.mixin.dart.
5. FCM background isolate (lib/services/fcm/fcm-background.service.dart): does it open its own SQLite connection to the same file? What does it write? Can it interleave with the foreground writer to produce SQLITE_BUSY on the main isolate's inserts, and is there a busy_timeout that would instead make inserts SLOW (S1's 2-3s gray button)?
6. The pending-DM flow (dm-messaging screen at HEAD): can a send ever run with an empty/wrong conversationId, producing a row invisible to the open chat? What does the GC's "empty chatId" skip-log tell us about corrupt rows already seen in the wild?
7. Server history/gap-fill sync: which client paths insert OWN messages fetched from the server back into the local DB (chat-sync syncMessagesFromServer, loadMoreMessages, prewarm)? Would a vanished-but-server-received message REAPPEAR in the sender's chat after these syncs (ties to S3 "messages he couldn't see were sent/appeared")?`,
  },
  {
    key: 'server-side',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You investigate the PRODUCTION SERVER at commit 2f31263f (backend repo).
Questions:
1. 2f31263f:src/services/message.services.ts store_message: confirm the insert is idempotent by client-generated id (onConflictDoNothing) and the duplicate path re-acks WITHOUT re-fan-out. Conclusion: the SAME id resent N times can never duplicate for recipients — confirm mechanically. Therefore S4 duplicates REQUIRE distinct ids — confirm there is no server path that re-inserts under a new id at this commit.
2. 2f31263f:src/routes/chat-poll.routes.ts send-message: if a client's 20-40-min-old queued POSTs all arrive at once, does each get processed normally (stored + fanned out)? Any rate limit, ordering, or staleness rejection? What sent_at do late messages carry — does the server clamp client timestamps (socket.service.ts) and how would a 40-min-late burst order in recipients' chats?
3. 2f31263f:src/sockets/socket.service.ts handle_message_new: any validation that could silently DROP a message (is_member failure, empty conv) without acking? What does the sender see in that case?
4. WS server (2f31263f:src/sockets/socket.server.ts): idleTimeout and app-heartbeat reaping — how long does a half-dead client connection survive server-side? If a client's TCP retransmissions deliver 30-min-old WS frames to a connection the server already closed, what happens (frames lost, RST)? Assess whether the WS path can plausibly deliver a 30-40-min-delayed burst, vs the HTTP polling path.
5. Does the server track users' app_version (users table update via /user/update-user)? Confirm the admin/DB can tell EXACTLY which build (39/40/41/42) an affected user runs — this is the decisive field discriminator for C4.
6. Any server-side queue/buffer that could hold a SENDER's outbound messages for ~30 min and then release them all (be skeptical; likely none — the pending cache serves receivers, not senders).`,
  },
  {
    key: 'version-archaeology',
    prompt: `${SYMPTOMS}\n${REPO_RULES}
You do GIT ARCHAEOLOGY in the app repo to reconstruct what OLDER FIELD BUILDS (allowed by the version gate: builds 39, 40, 41 vs current 42) did differently.
Method: git -C /home/gaz/workspace/amigo/amigo-app log --oneline -- pubspec.yaml, and git log -S 'version:' -p pubspec.yaml (or git log -p pubspec.yaml | grep -n 'version:' context) to map build numbers (+39, +40, +41, +42) to commits. Then for the commit ranges of builds 39-41, inspect the THEN-CURRENT versions of:
  - lib/services/message/message_gc.service.dart (or its predecessor retry logic — use git log --follow; the 'reliability overhaul' collapsed 3 racing retry paths and made failure terminal — find what came BEFORE it)
  - lib/screens/chat/shared/chat-send.mixin.dart (or wherever sends lived)
Questions:
1. Which build number first contained the reliability overhaul (clock-until-given-up, single GC retry engine)? Which builds still had the OLD retry behavior?
2. In the PRE-overhaul code (as shipped in the oldest gate-allowed build): did ANY retry/cleanup path DELETE unacked messages or hide them (S2)? Did ANY resend path mint a NEW message id or rely on server new_id reassignment (S4 duplicates with distinct ids)? Show the exact old code (git show <commit>:<path>).
3. Were there multiple concurrent retry paths that could double-send (and with what ids)?
4. Which build introduced the FTS v20 migration, schema v19, etc. — anything whose one-time migration/backfill could stall or fail on a specific device.
5. Summarize per-build (39, 40, 41, 42): the send/retry/persistence behaviors relevant to S1-S4. If an affected user is on build 39/40/41, which symptoms does that build's code explain that build 42 cannot?`,
  },
]

const reports = await parallel(INVESTIGATIONS.map(inv => () =>
  agent(inv.prompt, { label: `invest:${inv.key}`, phase: 'Investigate', schema: INVEST_SCHEMA })
))

const evidence = reports
  .map((r, i) => r ? `=== REPORT ${INVESTIGATIONS[i].key} ===\n${r.report}\nKEY FACTS:\n${r.key_facts.map(f => `- ${f.fact} [${f.evidence}] (${f.symptom_links})`).join('\n')}` : `=== REPORT ${INVESTIGATIONS[i].key} MISSING ===`)
  .join('\n\n')

phase('Synthesize')

const synth = await agent(
  `${SYMPTOMS}\nYou are the synthesizer. Below are six investigation reports over the exact field code. Build the strongest 3-6 ROOT-CAUSE HYPOTHESES for this bug. Rules: every hypothesis must be a concrete causal chain grounded in the cited code facts (no hand-waving); for EACH hypothesis state explicitly how it does or does not account for EVERY symptom S1-S4 and constraint C1-C3; prefer hypotheses that explain the CO-OCCURRENCE of all four symptoms; combinations of mechanisms are allowed (e.g. one mechanism for S2 + another for S3) but must be stated as such; include for each a decisive field test (what to pull from the affected user's device/server DB to confirm). Also note explicitly which build numbers (39-42) each hypothesis requires.\n\n${evidence}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

phase('Verify')

// Null-guard: a failed synthesize agent must degrade to a partial result,
// not crash the run (the first attempt died here on a session limit).
const hypotheses = (synth && synth.hypotheses) ? synth.hypotheses : []

const verdicts = await parallel(hypotheses.map(h => () =>
  agent(
    `${SYMPTOMS}\n${REPO_RULES}
You are an adversarial verifier. Your job is to REFUTE this root-cause hypothesis if possible. Re-verify its load-bearing code claims YOURSELF in the repos (do not trust the summary), test it against every symptom S1-S4 and constraint C1-C3, and hunt for facts that break the causal chain (timing, error codes, actual sqlite/drift/dio behavior, actual server behavior). If it survives, say what evidence would still be needed from the field. Default to skepticism.\n\nHYPOTHESIS ${h.id}: ${h.title}\nMechanism: ${h.mechanism}\nClaims for symptoms: ${h.explains}\nEvidence for: ${h.evidence_for}\nEvidence against: ${h.evidence_against}`,
    { label: `verify:${h.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
  ).then(v => ({ hypothesis: h, verdict: v }))
))

return {
  reports,
  hypotheses,
  verdicts: verdicts.filter(Boolean).map(v => ({
    id: v.hypothesis.id,
    title: v.hypothesis.title,
    verdict: v.verdict.verdict,
    reasoning: v.verdict.reasoning,
    unexplained: v.verdict.unexplained,
    checked: v.verdict.code_evidence_checked,
  })),
}