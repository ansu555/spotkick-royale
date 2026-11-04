import type { Redis } from "ioredis";
import { BUS_CHANNEL, type Envelope } from "../protocol.js";

export interface Bus {
  publish(env: Envelope): Promise<void>;
}

export function createRedisBus(redis: Redis): Bus {
  return {
    async publish(env: Envelope): Promise<void> {
      await redis.publish(BUS_CHANNEL, JSON.stringify(env));
    },
  };
}
