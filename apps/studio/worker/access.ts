import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const accessEmailSchema = z.string();

export interface AccessEnv {
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
}

export async function accessEmail(
  request: Request,
  env: AccessEnv,
  ctx: ExecutionContext,
): Promise<string | undefined> {
  const identity = await ctx.access?.getIdentity();
  const identityEmail = accessEmailSchema.safeParse(identity?.email);
  const contextEmail = identityEmail.success
    ? normalizeEmail(identityEmail.data)
    : undefined;
  if (contextEmail) return contextEmail;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return undefined;

  try {
    const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    return await verifiedAccessEmail(token, env.ACCESS_AUD, issuer, jwks);
  } catch {
    return undefined;
  }
}

export async function verifiedAccessEmail(
  token: string,
  audience: string,
  issuer: string,
  key: JWTVerifyGetKey,
): Promise<string | undefined> {
  const { payload } = await jwtVerify(token, key, { audience, issuer });
  const email = accessEmailSchema.safeParse(payload.email);
  return email.success ? normalizeEmail(email.data) : undefined;
}

function normalizeEmail(value: string): string | undefined {
  return value.trim().toLowerCase() || undefined;
}
