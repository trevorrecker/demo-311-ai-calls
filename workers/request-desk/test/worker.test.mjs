import assert from "node:assert/strict"
import { test } from "node:test"

import { createMockGateway, listen, startWorker, workerEnvironment } from "./mock-gateway.mjs"

// A JPEG frame header for a 16×16 image: enough for the Worker's check, which never decodes the picture.
const photo = {
  image: Buffer.from("ffd8ffc0000b080010001001011100ffd9", "hex").toString("base64"),
  mediaType: "image/jpeg",
}
const photoSlot = [
  { role: "user", content: [{ type: "image", image: photo.image, mediaType: "image/jpeg" }] },
]
const input = { neighborhood: "Astoria", report: "Synthetic road hazard." }

const start = async (t, labels, options) => {
  const gateway = createMockGateway(labels, options)
  const worker = await startWorker(workerEnvironment(await listen(gateway.server)))
  t.after(async () => {
    await worker.stop()
    await new Promise(resolve => gateway.server.close(resolve))
  })
  const post = (path, body, headers) =>
    fetch(`${worker.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  return { origin: worker.origin, requests: gateway.requests, post }
}

test("each page runs its labeled Call through the SDK, with the photo slot", async t => {
  const labels = { stable: 3 }
  const { origin, requests, post } = await start(t, labels)

  assert.match(await (await fetch(`${origin}/experimental/`)).text(), /data-variant="experimental"/)
  assert.equal(
    (await fetch(`${origin}/experimental`, { redirect: "manual" })).headers.get("location"),
    "/experimental/",
  )
  assert.equal((await (await fetch(`${origin}/api/config`)).json()).callLabel, "stable")
  assert.equal(
    (await (await fetch(`${origin}/experimental/api/config`)).json()).callLabel,
    "experimental",
  )

  const stable = await post("/api/assess", { ...input, photo })
  assert.equal(stable.status, 200)
  const stableBody = await stable.json()
  assert.deepEqual(
    { ...stableBody, durationMs: 0 },
    {
      assessment:
        "Category: MOCK stable assessment\nPriority: High\nPhoto evidence: Synthetic image received.",
      callId: "demo-311-report",
      callName: "311 Request Desk Assessment",
      callLabel: "stable",
      callVersion: 3,
      route: "mock-route",
      model: "mock-model",
      photoIncluded: true,
      durationMs: 0,
    },
  )

  const missing = await post("/experimental/api/assess", input)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, "label_not_found")

  labels.experimental = 4
  const experimental = await (await post("/experimental/api/assess", input)).json()
  assert.equal(experimental.callLabel, "experimental")
  assert.equal(experimental.callVersion, 4)
  assert.equal(experimental.photoIncluded, false)

  const insights = await (
    await post("/experimental/api/insights", {
      ...input,
      assessment: experimental.assessment,
      photo,
    })
  ).json()
  assert.equal(insights.callId, "demo-311-insights")
  assert.equal(insights.callLabel, undefined)
  assert.match(insights.insights, /MOCK result/)

  assert.deepEqual(
    requests,
    [
      {
        call: { id: "demo-311-report", label: "stable" },
        variables: { ...input, photo: photoSlot },
      },
      {
        call: { id: "demo-311-report", label: "experimental" },
        variables: { ...input, photo: [] },
      },
      {
        call: { id: "demo-311-report", label: "experimental" },
        variables: { ...input, photo: [] },
      },
      {
        call: { id: "demo-311-insights" },
        variables: { ...input, assessment: experimental.assessment, photo: photoSlot },
      },
    ].map(request => ({
      ...request,
      authorization: "Bearer local-fixture-no-authority",
      tenant: "local-fixture",
    })),
  )
})

test("rejects bad input before it reaches the Gateway", async t => {
  const { requests, post } = await start(t, { stable: 1 })
  const statuses = await Promise.all(
    [
      post("/api/assess", { ...input, call: { id: "other-call" } }),
      post("/api/assess", {
        ...input,
        photo: { image: "data:image/jpeg;base64,abc", mediaType: "image/jpeg" },
      }),
      post("/api/assess", { ...input, photo: { ...photo, image: "a".repeat(48_004) } }),
      post("/api/assess", { ...input, report: "a".repeat(70_000) }),
      post("/api/assess", { ...input, report: "a".repeat(1201) }),
      post("/api/assess", input, { "sec-fetch-site": "cross-site" }),
      post("/api/insights", input),
      post("/api/assess", { ...input, assessment: "a road hazard" }),
      post("/api/anything-else", input),
    ].map(async reply => (await reply).status),
  )
  assert.deepEqual(statuses, [400, 400, 413, 413, 400, 400, 400, 400, 404])
  assert.equal(requests.length, 0)
})

test("runs one model call at a time and at most 8 an hour", async t => {
  let release
  const held = new Promise(resolve => {
    release = resolve
  })
  let holding = true
  const { requests, post } = await start(t, { stable: 1 }, { hold: () => holding && held })

  const first = post("/api/assess", input)
  while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  const busy = await post("/api/insights", { ...input, assessment: "A road hazard." })
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get("retry-after"), "2")
  holding = false
  release()
  assert.equal((await first).status, 200)

  for (let count = 1; count < 8; count++)
    assert.equal((await post("/api/assess", input)).status, 200)
  const capped = await post("/api/assess", input)
  assert.equal(capped.status, 429)
  assert.ok(Number(capped.headers.get("retry-after")) > 3500)
  assert.match((await capped.json()).error.message, /about 60 minutes/)
  assert.equal(requests.length, 8)
})
