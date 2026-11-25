import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCoach } from "./server/coach.js";
import { registerTaskCapture } from "./server/task-capture.js";
import { registerSequence } from "./server/sequence.js";

import { registerSequenceTracking } from "./server/sequence-tracking.js";

export default function contribute(server: PluginServerContext) {
  const sequence = registerSequence(server);
  const stopTracking = registerSequenceTracking(server);
  const capture = registerTaskCapture(server);
  const stopCoach = registerCoach(server, sequence.read, capture.open);
  return async () => {
    await stopCoach();
    await sequence.stop();
    await capture.stop();
    stopTracking();
  };
}
