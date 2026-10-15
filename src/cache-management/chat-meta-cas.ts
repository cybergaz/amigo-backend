// =============================================================================
// chat_meta:{chat} seq-CAS (SYNC_V2_PROTOCOL.md §3.5)
// =============================================================================
// The Redis last-message preview used to be last-writer-wins: two sends into
// one chat race their fire-and-forget HSETs after commit, and the OLDER one
// could land last and stay the preview until the next send. Once messages
// carry a seq, the write is a compare-and-set on a `seq` field of the same
// hash: a write whose seq is not above the stored one is refused.
//
// Single-key script (V15: every script touches one key). No config imports,
// so tests bind it to a throwaway redis-server.
//
// A delete rewinds the preview by DELETING the last-message fields (seq
// included, chat-meta.cache LAST_MESSAGE_FIELDS), never by writing an older
// row over it; the next send then writes through the CAS from an empty seq.
// =============================================================================
import type Redis from "ioredis";

// ARGV[1] = seq, ARGV[2..] = field/value pairs (seq excluded).
// Returns 1 = written, 0 = refused (stored seq >= this one).
export const LUA_META_CAS = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'seq') or '')
local nxt = tonumber(ARGV[1])
if nxt == nil then return -1 end
if cur ~= nil and cur >= nxt then return 0 end
redis.call('HSET', KEYS[1], 'seq', ARGV[1], unpack(ARGV, 2))
return 1
`;

const SCRIPT = "amigo_meta_cas";

type ScriptClient = Record<string, (...args: (string | number)[]) => Promise<unknown>>;

/** Flatten a field map into HSET-style pairs (`seq` is passed separately). */
export const meta_pairs = (fields: Record<string, string>): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "seq") continue;
    out.push(k, v);
  }
  return out;
};

/** Bind the CAS to one ioredis connection (idempotent). */
export const bind_meta_cas = (client: Redis) => {
  if (typeof (client as unknown as ScriptClient)[SCRIPT] !== "function") {
    client.defineCommand(SCRIPT, { numberOfKeys: 1, lua: LUA_META_CAS });
  }
  /** One chat: 1 written, 0 refused. */
  const cas = async (key: string, seq: number, fields: Record<string, string>): Promise<number> =>
    Number(await (client as unknown as ScriptClient)[SCRIPT]!(key, String(seq), ...meta_pairs(fields)));
  /** Many chats in ONE pipeline (one round trip): per entry 1 / 0 / -1 (error). */
  const cas_many = async (
    entries: { key: string; seq: number; fields: Record<string, string> }[],
  ): Promise<number[]> => {
    if (entries.length === 0) return [];
    const p = client.pipeline() as unknown as ScriptClient & { exec: () => Promise<[Error | null, unknown][] | null> };
    for (const e of entries) p[SCRIPT]!(e.key, String(e.seq), ...meta_pairs(e.fields));
    const res = (await p.exec()) ?? [];
    return entries.map((_, i) => (res[i] && !res[i]![0] ? Number(res[i]![1]) : -1));
  };
  return { cas, cas_many };
};
