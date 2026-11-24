// Runs src/worker.mjs against the fixture Gateway, so the pages show clearly labeled mock output.
import { createMockGateway, listen, startWorker, workerEnvironment } from "./mock-gateway.mjs"

const labels = {
  stable: 3,
  ...(process.env.DEMO_EXPERIMENTAL_ASSIGNED === "1" && { experimental: 4 }),
}
const { server: gateway } = createMockGateway(labels)
const worker = await startWorker(
  workerEnvironment(await listen(gateway)),
  Number(process.env.PORT ?? 4314),
)
console.log(`Local 311 demo with mock model responses: ${worker.origin}`)

const stop = async () => {
  await worker.stop()
  gateway.close()
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
