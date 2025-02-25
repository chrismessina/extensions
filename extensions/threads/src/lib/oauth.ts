import { getPreferenceValues, OAuth } from "@raycast/api";
import fetch from "node-fetch";
import { URLSearchParams } from "url";

interface Preferences {
  clientId: string;
  threadsAppSecret: string;
  useRaycastProxiedURLs?: boolean;
}

const preferences = getPreferenceValues<Preferences>();

const directUrls = {
  authorize: "https://threads.net/oauth/authorize",
  token: "https://graph.threads.net/oauth/access_token",
  refresh: "https://graph.threads.net/refresh_access_token",
  redirect: "https://www.raycast.com/redirect?packageName=Threads",
};

const proxiedUrls = {
  authorize: "https://oauth.raycast.com/v1/authorize/nfHB6cDPqbgj8N64YEN8-UWKH8lggowN6W87hSwqKFSL7P9PnIpnbQ2RJCCC1U8IijxCyp88VqMVFbQVeLS2l4J0v84kz4ZeSbN75ONnPJGYHft3Rr9kh7nc9KtvC2lV0g",
  token: "https://oauth.raycast.com/v1/token/sprtng8yLEVTuyWdSdMWwgl_FopeRQlQgaDX3ayMGPiUi_8fOJrnPWBpUptgFjJ-B8Wvgia-f4CSZaU0XTfBhLNAYEhnKNM2oAoX4j8sOCWoWcMONkcc_FGIPJiIHMaqayNKMPXWZQ9rrQ",
  refresh: "https://oauth.raycast.com/v1/refresh-token/npCE9XXNZu7rsRiPNbsAzu3Xlv5_F05E4npZWFN-w2kReNQbbvzu-Wme-TDegwPtESGjQ-aSQMx0IuefOHrO4vITK-uqpQXvfgv_1urSV_lIi6mbqTY1ngL6C5ryw_GvO7drj5KU_huqftkO",
  redirect: "https://oauth.raycast.com/redirect"
};

const urls = preferences.useRaycastProxiedURLs ? proxiedUrls : directUrls;

const authorizeUrl = urls.authorize;
const tokenUrl = urls.token;
const refreshTokenUrl = urls.refresh;
const redirectUri = urls.redirect;
const scopes = ["threads_basic", "threads_content_publish"];

export const client = new OAuth.PKCEClient({
  redirectMethod: OAuth.RedirectMethod.Web,
  providerName: "Threads",
  providerIcon: "threads-icon.png",
  providerId: "threads",
  description: "Connect your Threads account",
});

console.log("OAuth Client initialized with PKCE");

// Authorization
export async function authorize(): Promise<string> {
  console.log("🔑 Starting authorization process...");
  const tokenSet = await client.getTokens();
  console.log("📝 Current token status:", tokenSet ? "Tokens exist" : "No tokens found");

  // If already authorized
  if (tokenSet?.accessToken) {
    console.log("🔍 Found existing access token");
    if (tokenSet.refreshToken && tokenSet.isExpired()) {
      console.log("⚠️ Token is expired, refreshing...");
      const newTokens = await refreshTokens(tokenSet.refreshToken);
      await client.setTokens(newTokens);
      console.log("✅ Successfully refreshed tokens");
      return newTokens.access_token;
    } else {
      console.log("✅ Token is valid, no refresh needed");
      return tokenSet.accessToken;
    }
  }

  console.log("🚀 Starting new authorization flow...");
  try {
    const authRequest = await client.authorizationRequest({
      endpoint: authorizeUrl,
      clientId: preferences.clientId,
      scope: scopes.join(","),
      extraParameters: { redirect_uri: redirectUri },
    });

    const { authorizationCode } = await client.authorize(authRequest);
    const tokens = await fetchTokens(authRequest, authorizationCode);
    await client.setTokens(tokens);
    return tokens.access_token;
  } catch (error) {
    console.error("❌ Authorization error:", error);
    throw error;
  }
}

export async function fetchTokens(
  authRequest: OAuth.AuthorizationRequest,
  authCode: string
): Promise<OAuth.TokenResponse> {
  console.log("🎫 Starting token fetch process...");
  const bodyParams = new URLSearchParams();
  bodyParams.append("client_id", preferences.clientId);
  bodyParams.append("client_secret", preferences.threadsAppSecret);
  bodyParams.append("code", authCode);
  bodyParams.append("code_verifier", authRequest.codeVerifier);
  bodyParams.append("grant_type", "authorization_code");
  bodyParams.append("code_challenge_method", "S256");
  bodyParams.append("redirect_uri", authRequest.redirectURI);

  console.log("📝 Prepared token request parameters:", {
    grant_type: "authorization_code",
    redirect_uri: authRequest.redirectURI
  });

  console.log("📤 Sending token request to:", tokenUrl);
  const response = await fetch(tokenUrl, {
    method: "POST",
    body: bodyParams,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("❌ Token fetch error:", {
      status: response.status,
      statusText: response.statusText,
      error: errorText
    });
    throw new Error(`Token fetch failed: ${response.statusText}`);
  }

  const tokenResponse = await response.json() as OAuth.TokenResponse;
  console.log("✅ Successfully received tokens");
  return tokenResponse;
}

export async function refreshTokens(refreshToken: string): Promise<OAuth.TokenResponse> {
  console.log("🔄 Starting token refresh process...");
  const bodyParams = new URLSearchParams();
  bodyParams.append("client_id", preferences.clientId);
  bodyParams.append("grant_type", "refresh_token");
  bodyParams.append("refresh_token", refreshToken);

  console.log("📤 Sending refresh token request...");
  const response = await fetch(refreshTokenUrl, {
    method: "POST",
    body: bodyParams,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    console.error("refresh tokens error:", await response.text());
    throw new Error(response.statusText);
  }

  return (await response.json()) as OAuth.TokenResponse;
}