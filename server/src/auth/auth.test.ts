import Fastify from "fastify";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { newRedis } from "../gateway/testutil.js";
import { AuthError, createAuth, registerAuthRoutes, verifyToken, type Auth } from "./index.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("SIWE auth", () => {
  const redis = newRedis();
  let now: number;
  let auth: Auth;
  beforeEach(async () => {
    await redis.flushall();
    now = Math.floor(Date.now() / 1000) * 1000; // jose checks exp against the real clock
    auth = createAuth({ redis, jwtSecret: SECRET, chainId: 10143, allowedDomains: ["localhost", "spotkick.test"], now: () => now });
  });

  it("issues an EIP-4361 message and a 12h HS256 JWT with sub=lowercase address", async () => {
    const { nonce, message } = await auth.issueNonce(account.address);
    expect(message).toContain("localhost wants you to sign in with your Ethereum account:");
    expect(message).toContain(account.address); // checksummed
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Chain ID: 10143");

    const signature = await account.signMessage({ message });
    const { token, expiresAt } = await auth.login({ address: account.address.toUpperCase().replace("0X", "0x"), signature });
    expect(expiresAt).toBe(now + 12 * 3600 * 1000);

    const claims = await verifyToken(token, SECRET);
    expect(claims).toEqual({ address: account.address.toLowerCase(), expiresAt });
  });

  it("rejects nonce replay (single use), including a concurrent double-submit", async () => {
    const { message } = await auth.issueNonce(account.address);
    const signature = await account.signMessage({ message });
    const results = await Promise.allSettled([
      auth.login({ address: account.address, signature, message }),
      auth.login({ address: account.address, signature, message }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AuthError);
    expect((rejected.reason as AuthError).code).toBe("nonce_invalid");

    await expect(auth.login({ address: account.address, signature, message })).rejects.toMatchObject({ code: "nonce_invalid" });
    await expect(auth.login({ address: account.address, signature })).rejects.toMatchObject({ code: "nonce_invalid" });
  });

  it("consumes the nonce even when the signature is wrong", async () => {
    const { message } = await auth.issueNonce(account.address);
    const bad = await other.signMessage({ message });
    await expect(auth.login({ address: account.address, signature: bad })).rejects.toMatchObject({ code: "bad_signature" });
    const good = await account.signMessage({ message });
    await expect(auth.login({ address: account.address, signature: good })).rejects.toMatchObject({ code: "nonce_invalid" });
  });

  it("rejects an expired nonce (TTL 5 min) and a signer/address mismatch", async () => {
    const { message } = await auth.issueNonce(account.address);
    const sig = await account.signMessage({ message });
    // signed by account but claimed by another address -> that address has no nonce
    await expect(auth.login({ address: other.address, signature: sig })).rejects.toMatchObject({ code: "nonce_missing" });

    now += 6 * 60 * 1000; // message expirationTime passed; redis TTL is wall-clock so also simulate it
    await redis.flushall();
    await expect(auth.login({ address: account.address, signature: sig })).rejects.toMatchObject({ code: "nonce_missing" });
  });

  it("rejects when verify time is past the message expiry even if the nonce key survived", async () => {
    const { message } = await auth.issueNonce(account.address);
    const sig = await account.signMessage({ message });
    now += 6 * 60 * 1000;
    await expect(auth.login({ address: account.address, signature: sig })).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects a client-supplied message that differs from the issued one, and bad domains", async () => {
    const { message } = await auth.issueNonce(account.address);
    const tampered = message.replace("Sign in to Spotkick", "Send me all your funds");
    const sig = await account.signMessage({ message: tampered });
    await expect(auth.login({ address: account.address, signature: sig, message: tampered })).rejects.toMatchObject({ code: "message_mismatch" });

    const strict = createAuth({ redis, jwtSecret: SECRET, chainId: 10143, allowedDomains: ["other.example"], now: () => now });
    const { message: m2 } = await auth.issueNonce(account.address); // issued with "localhost"
    const s2 = await account.signMessage({ message: m2 });
    await expect(strict.login({ address: account.address, signature: s2 })).rejects.toMatchObject({ code: "bad_domain" });
  });

  it("uses the request Origin host as SIWE domain only when allow-listed", async () => {
    expect((await auth.issueNonce(account.address, "spotkick.test")).message).toContain("spotkick.test wants you");
    expect((await auth.issueNonce(account.address, "evil.example")).message).toContain("localhost wants you");
  });

  it("rejects invalid addresses", async () => {
    await expect(auth.issueNonce("0x123")).rejects.toMatchObject({ code: "bad_address" });
  });

  it("verifyToken rejects wrong secret, expired, wrong alg and non-address subjects", async () => {
    const { message } = await auth.issueNonce(account.address);
    const { token } = await auth.login({ address: account.address, signature: await account.signMessage({ message }) });
    expect(await verifyToken(token, "x".repeat(40))).toBeNull();
    expect(await verifyToken("garbage", SECRET)).toBeNull();

    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(account.address.toLowerCase()).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key);
    expect(await verifyToken(expired, SECRET)).toBeNull();
    const badSub = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("bob").setExpirationTime("1h").sign(key);
    expect(await verifyToken(badSub, SECRET)).toBeNull();
    const hs512 = await new SignJWT({}).setProtectedHeader({ alg: "HS512" }).setSubject(account.address.toLowerCase()).setExpirationTime("1h").sign(key);
    expect(await verifyToken(hs512, SECRET)).toBeNull();
  });
});

describe("auth routes", () => {
  it("GET /api/auth/nonce + POST /api/auth/verify round-trip; replay gets 401", async () => {
    const redis = newRedis();
    await redis.flushall();
    const app = Fastify();
    registerAuthRoutes(app, createAuth({ redis, jwtSecret: SECRET, chainId: 10143, allowedDomains: ["localhost"] }), redis);

    const n = await app.inject({ method: "GET", url: `/api/auth/nonce?address=${account.address}` });
    expect(n.statusCode).toBe(200);
    const { message } = n.json<{ nonce: string; message: string }>();
    const signature = await account.signMessage({ message });

    const v = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { address: account.address, signature } });
    expect(v.statusCode).toBe(200);
    expect(v.json<{ token: string }>().token).toBeTruthy();
    const replay = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { address: account.address, signature, message } });
    expect(replay.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/nonce" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { address: account.address, signature: "0x12" } })).statusCode).toBe(400);
    await app.close();
  });
});
