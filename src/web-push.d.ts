/**
 * Ambient type declarations for the `web-push` package (the sole new runtime
 * dependency, accepted in ADR-0001). The package ships no type definitions;
 * these declarations cover exactly the surface the plugin uses.
 */

declare module "web-push" {
  import type { Agent } from "node:https"

  export interface VapidDetails {
    subject: string
    publicKey: string
    privateKey: string
  }

  export interface PushSubscriptionKeys {
    p256dh: string
    auth: string
  }

  export interface PushSubscription {
    endpoint: string
    keys?: PushSubscriptionKeys
  }

  export interface SendNotificationOptions {
    /** Time-to-live of the push message, in seconds. */
    TTL?: number
    contentEncoding?: "aes128gcm" | "aesgcm"
    urgency?: "very-low" | "low" | "normal" | "high"
    topic?: string
    vapidDetails?: VapidDetails
    headers?: Record<string, string>
    /** Custom https.Agent, honored by the sender (used by the local test endpoint). */
    agent?: Agent
    /** Socket timeout for the underlying request, in milliseconds. */
    timeout?: number
    gcmAPIKey?: string
    proxy?: string
  }

  export interface SendResult {
    statusCode: number
    body: string
    headers: Record<string, string | string[] | undefined>
  }

  /** Rejection for every non-2xx response. The endpoint carries the subscription's secret token: never log it. */
  export class WebPushError extends Error {
    readonly statusCode: number
    readonly headers: Record<string, string | string[] | undefined>
    readonly body: string
    readonly endpoint: string
    constructor(message: string, statusCode: number, headers: Record<string, string | string[] | undefined>, body: string, endpoint: string)
  }

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: SendNotificationOptions,
  ): Promise<SendResult>

  export function generateVAPIDKeys(): { publicKey: string; privateKey: string }
}
