import fcmService from "@/services/fcm.service";
import type { AppVersionInfo } from "@/services/app-version.service";

/**
 * Broadcasts an "app update available" push to every user that has an FCM
 * token. The client reads `store_url` from the data payload and opens the
 * store on tap (see the `update_available` handler in the app's FCM service).
 *
 * Sending is batched/throttled inside `fcmService.broadcast_to_all` so a large
 * user base doesn't hammer FCM or our egress.
 */
export const broadcast_version_update = async (
  info: AppVersionInfo,
  opts?: { title?: string; body?: string },
) => {
  const version = info.latest_version;
  const title = opts?.title ?? "Update available";
  const body =
    opts?.body ??
    info.message ??
    (version
      ? `Version ${version} is now available. Tap to update.`
      : "A new version of Amigo is available. Tap to update.");

  return fcmService.broadcast_to_all({
    title,
    body,
    // FCM data values must be strings.
    data: {
      type: "update_available",
      store_url: info.store_url,
      version: version ?? "",
      ...(info.message ? { message: info.message } : {}),
    },
  });
};
