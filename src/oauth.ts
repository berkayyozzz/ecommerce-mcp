import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type AuthorizationCode = {
  type: "authorization_code";
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

type AccessToken = {
  type: "access_token";
  expiresAt: number;
};

function connectorSecret() {
  const secret = process.env.MCP_CONNECTOR_SECRET;
  if (!secret || secret.length < 24) {
    throw new Error("MCP_CONNECTOR_SECRET en az 24 karakter olmalidir.");
  }
  return secret;
}

function encode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: AuthorizationCode | AccessToken) {
  const encoded = encode(JSON.stringify(payload));
  const signature = createHmac("sha256", connectorSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verify<T extends AuthorizationCode | AccessToken>(token: string): T {
  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) throw new Error("Gecersiz imza.");

  const expectedSignature = createHmac("sha256", connectorSecret()).update(encoded).digest();
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.length !== expectedSignature.length || !timingSafeEqual(provided, expectedSignature)) {
    throw new Error("Gecersiz imza.");
  }

  const payload = JSON.parse(decode(encoded)) as T;
  if (!payload.expiresAt || payload.expiresAt < Date.now()) throw new Error("Token suresi dolmus.");
  return payload;
}

export function isAllowedRedirectUri(value: string) {
  const configured = (process.env.MCP_ALLOWED_REDIRECT_URIS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set(["https://claude.ai/api/mcp/auth_callback", ...configured]);
  return allowed.has(value);
}

export function verifyConnectorPassword(password: string) {
  const expected = Buffer.from(connectorSecret());
  const provided = Buffer.from(password || "");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function createAuthorizationCode(redirectUri: string, codeChallenge: string) {
  return sign({
    type: "authorization_code",
    redirectUri,
    codeChallenge,
    expiresAt: Date.now() + 5 * 60_000,
  });
}

export function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const payload = verify<AuthorizationCode>(input.code);
  if (payload.type !== "authorization_code" || payload.redirectUri !== input.redirectUri) {
    throw new Error("Gecersiz yetkilendirme kodu.");
  }
  const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
  if (!payload.codeChallenge || challenge !== payload.codeChallenge) {
    throw new Error("PKCE dogrulamasi basarisiz.");
  }
  return sign({ type: "access_token", expiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
}

export function verifyAccessToken(token: string) {
  const payload = verify<AccessToken>(token);
  return payload.type === "access_token";
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}
