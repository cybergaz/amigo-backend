// =============================================================================
// Opt-in debug lines, per tag
// =============================================================================
// AMIGO_DEBUG is a comma-separated tag list ("PENDING,FANOUT") or "*". Unset
// (prod default) → every debug_log is a no-op, so per-recipient or per-poll
// detail can stay in the code for the next field investigation without
// flooding journald. Read once at import: changing it needs a restart (a
// gentle swap), which is how the rest of the env works too.

const parse_debug_tags = (raw: string | undefined): Set<string> | "all" => {
  const tags = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (tags.includes("*") || tags.includes("1") || tags.includes("ALL")) return "all";
  return new Set(tags);
};

const enabled = parse_debug_tags(process.env.AMIGO_DEBUG);

const debug_enabled = (tag: string): boolean =>
  enabled === "all" || enabled.has(tag.toUpperCase());

// The line is built only when the tag is on: pass a closure for anything
// costly to format.
const debug_log = (tag: string, line: string | (() => string)): void => {
  if (!debug_enabled(tag)) return;
  console.log(`[${tag}] ${typeof line === "function" ? line() : line}`);
};

export { parse_debug_tags, debug_enabled, debug_log };
