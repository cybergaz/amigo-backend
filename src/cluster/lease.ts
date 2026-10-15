import { redis } from "@/config/redis";
import { WORKER_ID } from "./identity";
import { k } from "./keys";
import { create_lease_client, type Lease } from "./lease-core";

// redis_lease (SYNC_V2 §13.8): bound to the MAIN Redis connection, not rfast.
// Its users are Redis-side / best-effort jobs that may run from a CLI script
// (the FCM broadcast), where rfast — no offline queue, never awaited
// connected — would fail its first command. The holder id is this process's
// WORKER_ID (a script gets its own boot id, so it never matches a worker).
const leases = create_lease_client(redis, WORKER_ID, k);

const redis_lease = (job: string, ttl_ms: number): Promise<Lease | null> => leases.acquire(job, ttl_ms);

export { redis_lease };
export type { Lease };
