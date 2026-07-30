import { createSign } from "node:crypto";

type PushPayload = {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
};

type ServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  return JSON.parse(raw) as ServiceAccount;
}

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function accessToken(account: ServiceAccount) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    })
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(account.private_key)
    .toString("base64url");
  const response = await fetch(
    account.token_uri ?? "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`
      })
    }
  );
  if (!response.ok) throw new Error(`Firebase OAuth returned HTTP ${response.status}`);
  const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string") {
    throw new Error("Firebase OAuth response has no access_token");
  }
  cachedAccessToken = {
    value: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000
  };
  return body.access_token;
}

export function getPushStatus() {
  return {
    enabled: Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() &&
      process.env.FIREBASE_PROJECT_ID?.trim()
    ),
    provider: "firebase-cloud-messaging-http-v1"
  };
}

export async function sendPush(payload: PushPayload) {
  const account = serviceAccount();
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() || account?.project_id?.trim();
  if (!account || !projectId || payload.tokens.length === 0) {
    return {
      sent: 0,
      invalidTokens: [] as string[],
      warning: account && projectId ? null : "FCM_NOT_CONFIGURED"
    };
  }
  const bearer = await accessToken(account);
  const deliveries = await Promise.all(
    payload.tokens.map(async (token) => {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: payload.title,
                body: payload.body
              },
              data: payload.data,
              android: {
                priority: "HIGH",
                notification: {
                  channel_id: "orders",
                  sound: "default"
                }
              }
            }
          })
        }
      );
      const responseText = await response.text();
      const invalid =
        response.status === 404 ||
        responseText.includes("UNREGISTERED") ||
        responseText.includes("INVALID_ARGUMENT");
      return { ok: response.ok, invalid, token };
    })
  );
  return {
    sent: deliveries.filter((delivery) => delivery.ok).length,
    invalidTokens: deliveries
      .filter((delivery) => delivery.invalid)
      .map((delivery) => delivery.token),
    warning: deliveries.some((delivery) => !delivery.ok && !delivery.invalid)
      ? `${deliveries.filter((delivery) => !delivery.ok).length} FCM deliveries failed`
      : null
  };
}
