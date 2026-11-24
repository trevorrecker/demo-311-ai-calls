import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"

export const listen = async (server, port = 0) => {
  server.listen(port, "127.0.0.1")
  await once(server, "listening")
  return `http://127.0.0.1:${server.address().port}`
}

// A fixture AI Gateway: answers POST /api/v1/generate/call for the labels in `labels` with clearly mock text.
// `hold`, when set, delays each answer until the promise it returns resolves.
export const createMockGateway = (labels, { hold } = {}) => {
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/generate/call") {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let request
    try {
      request = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      res.writeHead(400).end()
      return
    }
    requests.push({
      ...request,
      authorization: req.headers.authorization,
      tenant: req.headers["x-org-id"],
    })
    await hold?.()
    const { call, variables } = request
    const insights = call.id === "demo-311-insights" && call.label === undefined
    const version = insights ? 1 : labels[call.label]
    if (!version) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 404, message: "Fixture Call label is unassigned" }))
      return
    }
    // Both fixture Calls end with a `photo` message slot, which the Gateway requires a value for.
    if (!Array.isArray(variables?.photo)) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 400, message: "photo has no value" }))
      return
    }
    const image = variables.photo.some(message =>
      message.content.some(part => part.type === "image"),
    )
    const text = insights
      ? "Additional evidence: MOCK result from the Insights Call."
      : `Category: MOCK ${call.label} assessment\nPriority: High${image ? "\nPhoto evidence: Synthetic image received." : ""}`
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        generationType: "text",
        text,
        messages: [],
        steps: [],
        providerErrors: [],
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
        providerType: "mock",
        model: "mock-model",
        call: { ...call, version, route: { id: "mock-route" } },
        data: {},
      }),
    )
  })
  return { server, requests }
}

// The variables the platform's `native-object-api` and `platform-services` features set, pointed at the fixture, with
// the bearer token `ctxl app dev --connect` would give instead of the organization's client credentials.
export const workerEnvironment = origin => ({
  CONTEXTUAL_ORG_ID: "local-fixture",
  CONTEXTUAL_NATIVE_OBJECT_URL: origin,
  NATIVE_OBJECT_BEARER_TOKEN: "local-fixture-no-authority",
  CONTEXTUAL_PLATFORM_SERVICES: JSON.stringify({ aiGatewayApi: origin }),
})

// Starts src/worker.mjs exactly as the image's CMD does, on a free loopback port.
export const startWorker = async (environment, port = 0) => {
  const child = spawn(process.execPath, [new URL("../src/worker.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...environment, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  const listeningPort = await new Promise((resolve, reject) => {
    let output = ""
    child.stdout.on("data", chunk => {
      output += chunk
      const listening = /listening on port (\d+)/.exec(output)
      if (listening) resolve(listening[1])
    })
    child.once("exit", () => reject(new Error(`The Worker exited before listening:\n${output}`)))
  })
  const exited = once(child, "exit")
  return {
    origin: `http://127.0.0.1:${listeningPort}`,
    stop: async () => {
      child.kill("SIGTERM")
      await exited
    },
  }
}
