// 311 Request Desk: an HTTP Worker that runs two saved AI Calls with @contextual-io/sdk.
//
// Every route below also answers under /experimental, which selects the `experimental` label.
//
//   GET  /                the page, from ./public
//   GET  /api/config      Call names, the page's label, and the largest photo it may send
//   POST /api/assess      { report, neighborhood, photo? }             → Assessment Call by label
//   POST /api/insights    { report, neighborhood, assessment, photo? } → Insights Call
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"

import { Contextual } from "@contextual-io/sdk"
import { connectionFromWorkerEnv } from "@contextual-io/sdk/env"

import { readInput } from "../input.mjs"

// `output` names the response field that carries the Call's text.
const assessmentCall = {
  id: "demo-311-report",
  name: "311 Request Desk Assessment",
  output: "assessment",
}
const insightsCall = {
  id: "demo-311-insights",
  name: "311 Request Desk Insights",
  output: "insights",
}

// The SDK caps an AI Call request at 64 KiB, so the page shrinks its photo to fit beside the text.
const maxPhotoBase64Chars = 48_000

// compose.yaml requests the `native-object-api` feature (the organization's Agent OAuth client)
// and `platform-services` (platform addresses, including the AI Gateway's). No credential is in
// the image.
const { aiGatewayApi } = JSON.parse(process.env.CONTEXTUAL_PLATFORM_SERVICES ?? "{}")
const contextual = new Contextual({
  ...connectionFromWorkerEnv(process.env),
  objects: {},
  aiGatewayApiUrl: aiGatewayApi,
})

async function handle(req, res) {
  const { pathname } = new URL(req.url, "http://worker")
  if (pathname === "/health") return send(res, 200, { status: "ok" })
  if (pathname === "/experimental") return res.writeHead(308, { location: "/experimental/" }).end()

  // The page picks the label: /experimental/ asks for `experimental`, the rest for `stable`.
  const label = pathname.startsWith("/experimental/") ? "experimental" : "stable"
  const path = label === "experimental" ? pathname.slice("/experimental".length) : pathname

  if (path === "/api/config") {
    return send(res, 200, {
      callId: assessmentCall.id,
      callName: assessmentCall.name,
      callLabel: label,
      maxPhotoBase64Chars,
      insights: { callId: insightsCall.id, callName: insightsCall.name },
    })
  }
  if (req.method === "POST") {
    if (path === "/api/assess") return runCall(req, res, assessmentCall, label)
    // Insights has no labels; the Gateway runs its current version.
    if (path === "/api/insights") return runCall(req, res, insightsCall)
  }
  if (path.startsWith("/api/")) return fail(res, 404, "not_found", "This page was not found.")
  return serveFile(req, res, pathname)
}

async function runCall(req, res, call, label) {
  const input = await readInput(req, { withAssessment: call === insightsCall, maxPhotoBase64Chars })
  if (input.error) return fail(res, ...input.error)

  const waitSeconds = admit()
  if (waitSeconds > 0) {
    const message =
      waitSeconds <= 2
        ? "Another assessment is running. Try again in a moment."
        : `The shared demo has reached its assessment limit. Try again in about ${Math.ceil(waitSeconds / 60)} minutes.`
    return fail(res, 429, "rate_limited", message, { "retry-after": String(waitSeconds) })
  }

  const { photo, ...text } = input
  // Both Calls end with a `photo` message slot: one user message with the JPEG, or an empty list.
  const photoSlot = photo
    ? [{ role: "user", content: [{ type: "image", image: photo, mediaType: "image/jpeg" }] }]
    : []

  const cancel = new AbortController()
  res.once("close", () => {
    if (!res.writableEnded) cancel.abort()
  })
  const startedAt = Date.now()
  try {
    const result = await contextual.ai.generateCall(
      {
        call: label ? { id: call.id, label } : { id: call.id },
        variables: { ...text, photo: photoSlot },
      },
      { signal: cancel.signal, timeoutMs: 20_000 },
    )

    send(res, 200, {
      [call.output]: result.text,
      callId: result.call.id,
      callName: call.name,
      callLabel: result.call.label,
      callVersion: result.call.version,
      route: result.call.route?.id,
      model: result.model,
      photoIncluded: Boolean(photo),
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    console.warn("AI Call failed", {
      call: call.id,
      label,
      code: error?.code,
      status: error?.responseStatus,
    })
    if (error?.responseStatus === 404 && label) {
      fail(res, 404, "label_not_found", `No saved version of this Call has the ${label} label.`)
    } else if (error?.code === "deadline") {
      fail(res, 504, "upstream_timeout", "The assessment timed out. Try again in a moment.")
    } else {
      fail(res, 502, "upstream_error", "The assessment service could not complete this request.")
    }
  } finally {
    running = false
  }
}

// The public demo's spending cap, kept in memory for this one container: one model call at a time,
// at most 8 per rolling hour and 24 per rolling day. admit() returns the seconds until the next
// call may start, or 0 after admitting one; runCall clears `running` when its call ends.
const hourMs = 60 * 60 * 1000
const started = []
let running = false

function admit() {
  const now = Date.now()
  while (started.length > 0 && started[0] <= now - 24 * hourMs) started.shift()
  const lastHour = started.filter(time => time > now - hourMs)
  const opensAt = Math.max(
    running ? now + 2000 : 0,
    lastHour.length >= 8 ? lastHour.at(-8) + hourMs : 0,
    started.length >= 24 ? started[0] + 24 * hourMs : 0,
  )
  if (opensAt > now) return Math.ceil((opensAt - now) / 1000)
  started.push(now)
  running = true
  return 0
}

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

function send(res, status, body, extraHeaders) {
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

function fail(res, status, code, message, extraHeaders) {
  send(res, status, { error: { code, message } }, extraHeaders)
}

// `/` and `/experimental/` share every file except their index page.
async function serveFile(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    const allow = { allow: "GET, HEAD" }
    return fail(res, 405, "method_not_allowed", "This request method is unavailable.", allow)
  }
  const file = pathname.endsWith("/") ? `${pathname}index.html` : pathname
  const contentType = contentTypes[file.slice(file.lastIndexOf("."))]
  // Plain file names only: no dot segments, encoded characters, or hidden files.
  if (!contentType || !/^(?:\/[a-z0-9_-]+)*\/[a-z0-9_-][a-z0-9_.-]*\.[a-z0-9]+$/i.test(file)) {
    return fail(res, 404, "not_found", "This page was not found.")
  }
  let body
  try {
    body = await readFile(new URL(`./public${file}`, import.meta.url))
  } catch {
    return fail(res, 404, "not_found", "This page was not found.")
  }
  res.writeHead(200, { ...headers, "content-type": contentType })
  res.end(req.method === "HEAD" ? undefined : body)
}

// A request that fails outside the AI Call, such as a client that disconnects mid-upload, ends
// only that request.
const server = createServer((req, res) =>
  handle(req, res).catch(error => {
    console.error("Request failed", error)
    if (res.headersSent) res.destroy()
    else fail(res, 500, "internal_error", "The request failed.")
  }),
)
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "0.0.0.0", () => {
  console.info(`311 Request Desk listening on port ${server.address().port}`)
})
process.once("SIGTERM", () => server.close(() => process.exit(0)))
