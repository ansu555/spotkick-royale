import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { SiweMessage, generateNonce } from "siwe";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { SlidingWindowLimiter } from "../gateway/ratelimit.js";

export const NONCE_TTL_SEC = 300;
export const TOKEN_TTL_SEC = 12 * 60 * 60;
const NONCE_KEY = (nonce: string): string => `sk:siwe:nonce:${nonce}`;
const ADDR_KEY = (addr: string): string => `sk:siwe:addr:${addr}`;
const STATEMENT = "Sign in to Spotkick. This does not trigger a transaction or cost gas.";

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TokenClaims {
  /** lowercase 0x address */
  address: string;
  /** unix ms */
  expiresAt: number;
}

export interface AuthConfig {
  redis: Redis;
  jwtSecret: string;
  chainId: number;
  /** accepted SIWE `domain`s (host[:port]); first one is the default for issued messages */
  allowedDomains: string[];
  now?: () => number;
}

export function resolveAllowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SIWE_DOMAINS ?? env.SIWE_DOMAIN ?? "localhost";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : ["localhost"];
}

const secretKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);
const ADDR_RE = /^0x[0-9a-f]{40}$/;

/** Verify a session JWT. Returns null for any invalid/expired token; rethrows unexpected errors. */
export async function verifyToken(token: string, jwtSecret: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), { algorithms: ["HS256"] });
    const sub = payload.sub;
    if (typeof sub !== "string" || !ADDR_RE.test(sub) || typeof payload.exp !== "number") return null;
    return { address: sub, expiresAt: payload.exp * 1000 };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}

export interface Auth {
  issueNonce(address: string, originHost?: string): Promise<{ nonce: string; message: string }>;
  login(input: { address: string; signature: string; message?: string }): Promise<{ token: string; expiresAt: number; address: string }>;
}

interface StoredNonce {
  address: string;
  message: string;
}

export function createAuth(cfg: AuthConfig): Auth {
  const now = cfg.now ?? Date.now;
  const [defaultDomain] = cfg.allowedDomains;
  if (!defaultDomain) throw new Error("auth: allowedDomains must not be empty");

  const normalize = (address: string): string => {
    if (!isAddress(address, { strict: false })) throw new AuthError("bad_address", 400, "invalid address");
    return address.toLowerCase();
  };

  return {
    async issueNonce(address, originHost) {
      const lower = normalize(address);
      const domain = originHost && cfg.allowedDomains.includes(originHost) ? originHost : defaultDomain;
      const nonce = generateNonce();
      const issued = now();
      const proto = domain.startsWith("localhost") || domain.startsWith("127.0.0.1") ? "http" : "https";
      const message = new SiweMessage({
        domain,
        address: getAddress(lower),
        statement: STATEMENT,
        uri: `${proto}://${domain}`,
        version: "1",
        chainId: cfg.chainId,
        nonce,
        issuedAt: new Date(issued).toISOString(),
        expirationTime: new Date(issued + NONCE_TTL_SEC * 1000).toISOString(),
      }).prepareMessage();
      const stored: StoredNonce = { address: lower, message };
      await cfg.redis
        .multi()
        .set(NONCE_KEY(nonce), JSON.stringify(stored), "EX", NONCE_TTL_SEC)
        .set(ADDR_KEY(lower), nonce, "EX", NONCE_TTL_SEC)
        .exec();
      return { nonce, message };
    },

    async login({ address, signature, message }) {
      const lower = normalize(address);

      let nonce: string | null;
      if (message !== undefined) {
        let parsed: SiweMessage;
        try {
          parsed = new SiweMessage(message);
        } catch {
          throw new AuthError("bad_message", 400, "malformed SIWE message");
        }
        nonce = parsed.nonce;
      } else {
        nonce = await cfg.redis.get(ADDR_KEY(lower));
      }
      if (!nonce) throw new AuthError("nonce_missing", 401, "no pending nonce for address");

      // Single use: GET+DEL inside one MULTI, so concurrent replays see null.
      const res = await cfg.redis.multi().get(NONCE_KEY(nonce)).del(NONCE_KEY(nonce)).exec();
      const raw = res?.[0]?.[1];
      if (typeof raw !== "string") throw new AuthError("nonce_invalid", 401, "nonce expired or already used");
      const stored = JSON.parse(raw) as StoredNonce;
      if (stored.address !== lower) throw new AuthError("address_mismatch", 401, "address does not match nonce");
      if (message !== undefined && message !== stored.message) {
        throw new AuthError("message_mismatch", 401, "message was not issued by this server");
      }

      const siwe = new SiweMessage(stored.message);
      if (!cfg.allowedDomains.includes(siwe.domain)) throw new AuthError("bad_domain", 401, "domain not allowed");
      const result = await siwe.verify(
        { signature, domain: siwe.domain, nonce, time: new Date(now()).toISOString() },
        { suppressExceptions: true },
      );
      if (!result.success) throw new AuthError("bad_signature", 401, "signature verification failed");
      if (siwe.address.toLowerCase() !== lower) throw new AuthError("address_mismatch", 401, "signer mismatch");

      const iat = Math.floor(now() / 1000);
      const exp = iat + TOKEN_TTL_SEC;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(lower)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(randomUUID())
        .sign(secretKey(cfg.jwtSecret));
      return { token, expiresAt: exp * 1000, address: lower };
    },
  };
}

const nonceQuery = z.object({ address: z.string().min(1).max(64) });
const verifyBody = z.object({
  address: z.string().min(1).max(64),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "signature must be 65-byte hex"),
  message: z.string().min(1).max(2000).optional(),
});

function originHost(req: FastifyRequest): string | undefined {
  const origin = req.headers.origin;
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/** Registers GET /api/auth/nonce and POST /api/auth/verify. Call before app.listen(). */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth, redis: Redis): void {
  const ipLimiter = new SlidingWindowLimiter(redis, { prefix: "sk:rl:auth:", limit: 30, windowMs: 60_000 });

  const handle = async (req: FastifyRequest, reply: { code(n: number): unknown }, fn: () => Promise<unknown>): Promise<unknown> => {
    const hit = await ipLimiter.hit(req.ip);
    if (!hit.allowed) {
      reply.code(429);
      return { error: "rate_limited", retryAfterMs: hit.retryAfterMs };
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(err.status);
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  };

  app.get("/api/auth/nonce", async (req, reply) => {
    const q = nonceQuery.safeParse(req.query);
    if (!q.success) {
      reply.code(400);
      return { error: "bad_request", message: "address required" };
    }
    return handle(req, reply, () => auth.issueNonce(q.data.address, originHost(req)));
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const b = verifyBody.safeParse(req.body);
    if (!b.success) {
      reply.code(400);
      return { error: "bad_request", message: b.error.issues.map((i) => i.message).join("; ") };
    }
    return handle(req, reply, async () => {
      const { token, expiresAt } = await auth.login({
        address: b.data.address,
        signature: b.data.signature,
        ...(b.data.message !== undefined ? { message: b.data.message } : {}),
      });
      return { token, expiresAt };
    });
  });
}
