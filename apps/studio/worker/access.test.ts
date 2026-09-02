import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { verifiedAccessEmail } from "./access";

const audience = "test-audience";
const issuer = "https://team.cloudflareaccess.com";

describe("Access identity", () => {
  it("accepts the email only after verifying the Access JWT", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: " Creator@Example.com " })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifiedAccessEmail(token, audience, issuer, async () => publicKey),
    ).resolves.toBe("creator@example.com");
    await expect(
      verifiedAccessEmail(token, "wrong-audience", issuer, async () =>
        Promise.resolve(publicKey),
      ),
    ).rejects.toThrow();
  });
});
