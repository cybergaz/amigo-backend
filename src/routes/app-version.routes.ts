import { Elysia, t } from "elysia";
import { get_app_version, type AppPlatform } from "@/services/app-version.service";

const SUPPORTED_PLATFORMS: AppPlatform[] = ["android", "ios"];

const app_version_routes = new Elysia({ prefix: "/app" })
  // Public, unauthenticated. Clients hit this on launch and resume to
  // decide whether to block the user behind an "Update required" gate.
  .get(
    "/version",
    async ({ query, set }) => {
      const platform = query.platform as AppPlatform;
      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: `Unsupported platform. Use one of: ${SUPPORTED_PLATFORMS.join(", ")}`,
        };
      }

      const info = await get_app_version(platform);
      if (!info) {
        set.status = 404;
        return {
          success: false,
          code: 404,
          message: `No version configured for ${platform}. Run scripts/set-app-version.ts.`,
        };
      }

      set.status = 200;
      return { success: true, code: 200, data: info };
    },
    {
      query: t.Object({
        platform: t.String(),
      }),
    },
  );

export default app_version_routes;
