// Client-IP helpers for the reachability probe (SYNC_V2 §14.4/§14.6).
// Pure functions, no I/O — covered by tests/ip-utils.test.ts.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const truncate_ipv4 = (ip: string): string | null => {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
};

// Expand an IPv6 literal to its 8 hextets (numbers), or null if malformed.
// Handles "::" compression and an embedded dotted-quad tail.
const expand_ipv6 = (ip: string): number[] | null => {
  let addr = ip.trim();
  const zone = addr.indexOf("%"); // fe80::1%eth0
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);

  // Embedded IPv4 tail (::ffff:1.2.3.4) → rewrite it as two hex hextets so
  // the generic parser below handles it.
  const last_colon = addr.lastIndexOf(":");
  if (last_colon !== -1 && addr.slice(last_colon + 1).includes(".")) {
    const m = IPV4_RE.exec(addr.slice(last_colon + 1));
    if (!m) return null;
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    addr = `${addr.slice(0, last_colon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse_part = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = parse_part(halves[0]);
  const rest = halves.length === 2 ? parse_part(halves[1]) : [];
  if (!head || !rest) return null;

  const explicit = head.length + rest.length;
  if (halves.length === 1) {
    return explicit === 8 ? head : null;
  }
  if (explicit > 7) return null;
  return [...head, ...new Array(8 - explicit).fill(0), ...rest];
};

// Truncate a client IP to its network: /24 for IPv4, /48 for IPv6. The app
// uses it only as a coarse "which network am I on" key (netKey), so the full
// address is never echoed back or logged. IPv4-mapped IPv6 (::ffff:a.b.c.d)
// is treated as IPv4. Returns null for anything unparseable.
const truncate_client_ip = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const ip = raw.trim();
  if (!ip) return null;

  const v4 = truncate_ipv4(ip);
  if (v4) return v4;

  const h = expand_ipv6(ip);
  if (!h) return null;
  // ::ffff:0:0/96 — an IPv4 client seen through a dual-stack socket.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.0/24`;
  }
  const hex = (n: number) => n.toString(16);
  return `${hex(h[0])}:${hex(h[1])}:${hex(h[2])}::/48`;
};

// The real client address. Behind Cloudflare the origin only sees Cloudflare
// IPs in $remote_addr / X-Real-IP (nginx has no real_ip config, V12), so
// CF-Connecting-IP is authoritative. Falls back to the first X-Forwarded-For
// hop for direct-to-origin / local dev traffic.
const client_ip_from_headers = (headers: Headers): string | null => {
  const cf = headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
};

export { truncate_client_ip, client_ip_from_headers };
