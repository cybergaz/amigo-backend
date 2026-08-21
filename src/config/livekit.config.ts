import { LiveKitAPI } from "livekit-server-sdk";

const livekit = new LiveKitAPI({
  host: process.env.LIVEKIT_URL as string,
  apiKey: process.env.LIVEKIT_API_KEY as string,
  secret: process.env.LIVEKIT_API_SECRET as string,
});

export { livekit };
