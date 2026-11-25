import { encrypt, decrypt } from "./crypto";
import { type PBAccount, updateAccount } from "./pocketbase";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Lecture + ecriture Google Calendar (sync bidirectionnelle de l'Agenda).
  // Les comptes connectes avant l'ajout de ce scope doivent etre reconnectes.
  "https://www.googleapis.com/auth/calendar",
];

function getGoogleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID environment variable is required");
  return id;
}

function getGoogleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET environment variable is required");
  return secret;
}

/**
 * Construit le redirect_uri. Priorite a l'origine reelle d'ou vient
 * l'utilisateur (dev-VPS ou prod), passee depuis le frontend ; sinon repli sur
 * l'env. Le localhost n'est utilise qu'en dernier recours (dev local pur).
 * IMPORTANT : ce meme redirect_uri doit etre genere a l'identique pour l'auth URL
 * et pour l'echange de code, sinon Google renvoie redirect_uri_mismatch.
 */
function buildRedirectUri(origin?: string): string {
  const base = (
    origin ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.OAUTH_REDIRECT_BASE ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  return `${base}/api/oauth/google/callback`;
}

export interface DecodedState {
  userId: string;
  origin: string;
}

/**
 * Generate Google OAuth2 authorization URL.
 * The userId + the caller origin are encrypted in the state parameter, so the
 * code-exchange step can rebuild the exact same redirect_uri.
 */
export function generateGoogleAuthUrl(userId: string, origin?: string): string {
  const state = encrypt(`${userId}|${origin || ""}`);

  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: buildRedirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Decode the state parameter into { userId, origin }.
 * Retro-compatible : un ancien state ne contenant que l'userId renvoie origin="".
 */
export function decodeState(state: string): DecodedState {
  const raw = decrypt(state);
  const idx = raw.indexOf("|");
  if (idx === -1) return { userId: raw, origin: "" };
  return { userId: raw.slice(0, idx), origin: raw.slice(idx + 1) };
}

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email: string;
  name: string;
}

/**
 * Exchange authorization code for tokens and fetch user info.
 */
export async function exchangeCodeForTokens(code: string, origin?: string): Promise<OAuthTokens> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      redirect_uri: buildRedirectUri(origin),
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${tokenRes.status} - ${errorBody}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  if (!tokenData.access_token) {
    throw new Error("No access token received from Google");
  }

  if (!tokenData.refresh_token) {
    throw new Error("No refresh token received from Google. Make sure prompt=consent is set.");
  }

  // Fetch user info
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`Google userinfo fetch failed: ${userRes.status}`);
  }

  const userInfo = (await userRes.json()) as {
    email: string;
    name?: string;
  };

  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    email: userInfo.email,
    name: userInfo.name || "",
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    // Detect permanently invalid refresh tokens (revoked, expired in testing mode, etc.)
    if (errorBody.includes("invalid_grant")) {
      const err = new Error(`OAuth2 token revoked or expired. Please reconnect your Google account.`);
      err.name = "OAuthInvalidGrant";
      throw err;
    }
    throw new Error(`Google token refresh failed: ${res.status} - ${errorBody}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  return data;
}

/**
 * Get a valid access token for an OAuth2 account.
 * Refreshes the token if expired (with 5-minute margin).
 * Updates PocketBase with new token data.
 */
export async function getValidAccessToken(account: PBAccount): Promise<string> {
  if (account.auth_type !== "oauth2") {
    throw new Error(`Account ${account.id} is not an OAuth2 account`);
  }

  if (!account.oauth_access_token || !account.oauth_refresh_token) {
    throw new Error(`Account ${account.id} is missing OAuth2 tokens. Please reconnect.`);
  }

  const accessToken = decrypt(account.oauth_access_token);
  const expiryDate = new Date(account.oauth_token_expiry);
  const now = new Date();
  const marginMs = 5 * 60 * 1000; // 5 minutes

  // Token still valid
  if (expiryDate.getTime() - now.getTime() > marginMs) {
    return accessToken;
  }

  // Token expired or about to expire — refresh
  console.log(`Refreshing OAuth2 token for account ${account.id} (${account.email})`);

  const refreshToken = decrypt(account.oauth_refresh_token);
  const refreshed = await refreshAccessToken(refreshToken);

  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);

  await updateAccount(account.id, {
    oauth_access_token: encrypt(refreshed.access_token),
    oauth_token_expiry: newExpiry.toISOString(),
  } as Partial<PBAccount>);

  return refreshed.access_token;
}
