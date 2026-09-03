import { generateKeyPair, SignJWT } from "jose";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { accessEmail, verifiedAccessEmail } from "./access";

const audience = "test-audience";
const issuer = "https://team.cloudflareaccess.com";

describe("Access identity", () => {
  it("uses the configured local owner only on loopback hosts", async () => {
    const env = {
      ACCESS_AUD: "",
      ACCESS_TEAM_DOMAIN: "",
      LOCAL_OWNER_EMAIL: " Creator@Example.com ",
    };
    const context = fromPartial<ExecutionContext>({});

    await expect(
      accessEmail(new Request("http://localhost/api/projects"), env, context),
    ).resolves.toBe("creator@example.com");
    await expect(
      accessEmail(
        new Request("https://studio.example/api/projects"),
        env,
        context,
      ),
    ).resolves.toBeUndefined();
  });

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
