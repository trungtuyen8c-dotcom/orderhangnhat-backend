import { Redis } from "ioredis";
import { config } from "../app/config.js";

export const redis = new Redis(config.redisUrl);
