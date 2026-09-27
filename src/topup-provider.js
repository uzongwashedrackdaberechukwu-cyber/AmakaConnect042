/**
 * AmakaConnect042 server-side ShadexGoLtd adapter.
 *
 * IMPORTANT:
 * - Keep the ShadexGoLtd API key on the server only.
 * - Do not expose credentials through dist/config.js or browser JavaScript.
 * - Replace endpoint paths/mapping only after confirming the exact ShadexGoLtd API contract.
 */
export async function shadexRequest(path, options = {}, { apiBaseUrl, apiKey }) {
  if (!apiBaseUrl || !apiKey) throw new Error("ShadexGoLtd API credentials are not configured.");
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`ShadexGoLtd API request failed (${response.status}).`);
  return response.json();
}
