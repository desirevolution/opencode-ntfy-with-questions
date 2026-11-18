/** Deep links for the native OpenCode V2 Web UI. */
import type { WebPushSettings } from "./types.js"

/**
 * OpenCode Web 2.x routes to /server/<base64url(connection-url)>/session/<id>.
 * For the server shipped alongside the Web UI, the connection URL is normally
 * the public Web URL itself. Set webUiServerUrl when an existing OpenCode
 * session URL decodes to a different connection URL.
 */
export function openCodeWebTarget(settings: Pick<WebPushSettings, "webUiBaseUrl" | "webUiServerUrl">, sessionID?: string): string | undefined {
  if (!settings.webUiBaseUrl) return undefined
  if (!sessionID || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionID)) return settings.webUiBaseUrl
  const server = (settings.webUiServerUrl ?? settings.webUiBaseUrl).replace(/\/+$/, "")
  const serverKey = Buffer.from(server, "utf8").toString("base64url")
  return `${settings.webUiBaseUrl}server/${serverKey}/session/${encodeURIComponent(sessionID)}`
}
