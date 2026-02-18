import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";

export type AuthenticatedUser = NonNullable<
  Awaited<ReturnType<typeof db.getUserById>>
>;

type SessionPayload = {
  userId: string;
};

function getSessionSecret() {
  if (!ENV.cookieSecret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(ENV.cookieSecret);
}

export async function createSessionToken(
  userId: string,
  options: { expiresInMs?: number } = {}
): Promise<string> {
  const issuedAt = Date.now();
  const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
  const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
  const secretKey = getSessionSecret();

  return new SignJWT({ userId } satisfies SessionPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

export function setSessionCookie(
  res: Response,
  req: Request,
  token: string,
  maxAgeMs: number
) {
  const cookieOptions = getSessionCookieOptions(req);
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: maxAgeMs });
}

export async function authenticateRequest(req: Request): Promise<AuthenticatedUser> {
  const cookieHeader = req.headers.cookie;
  const cookies = cookieHeader ? parseCookieHeader(cookieHeader) : {};
  const token = cookies[COOKIE_NAME];

  if (!token) {
    throw new Error("Missing session cookie");
  }

  const secretKey = getSessionSecret();
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ["HS256"],
  });

  const userId = typeof payload.userId === "string" ? payload.userId : "";
  if (!userId) {
    throw new Error("Invalid session payload");
  }

  const user = await db.getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  return user;
}

export async function getUserIdFromCookieHeader(cookieHeader?: string) {
  if (!cookieHeader) return null;
  const cookies = parseCookieHeader(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const secretKey = getSessionSecret();
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
    });
    const userId = typeof payload.userId === "string" ? payload.userId : "";
    return userId || null;
  } catch {
    return null;
  }
}
