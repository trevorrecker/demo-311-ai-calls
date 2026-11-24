# 311 Request Desk

A small Contextual HTTP Worker that reviews a fictional 311 report and optional
photo. The Stable and Experimental pages invoke the same saved AI Call through
different labels. **More insights** runs a second Call. Nothing is filed with NYC 311.

## Run it

Use Node.js 24.

```sh
npm ci
npm test
npm run demo
```

Open http://127.0.0.1:4314. This runs a fixture Gateway and needs no Contextual
account, model credentials, or network access. Set `DEMO_EXPERIMENTAL_ASSIGNED=1`
for the mock Gateway to serve both labels.

Start with [the Worker](workers/request-desk/src/worker.mjs) to see the endpoints,
Call IDs and SDK invocation in one place. Both pages use the same Worker; the
page selects the label. The Worker supplies the optional photo as messages for
the saved Call's `photo` placeholder, or an empty list when there is no photo.

## Layout

| Folder | What's in it |
| --- | --- |
| [workers/request-desk](workers/request-desk) | Worker, Dockerfile, Compose, two pages and tests |
| [ai-calls](ai-calls) | The Assessment and Insights Calls used by the Worker |
| [ai-routes](ai-routes) | A Haiku 5.5 route template, with a placeholder for a Connection you already own |
| [object-types](object-types) | The optional NYC 311 Service Request definition |

The Worker, Object Type and record definitions are separate so an Application
manifest can reference them later. There is no `contextual.yaml`, exported
Connection, tenant config, or dataset in this example. The included report and
road image are synthetic.

## Run against your own Contextual tenant

Use Contextual CLI 0.17.0 or newer for the Worker commands. Set `CONFIG` to an
existing CLI config for a tenant you control. Use AI Calls-enabled tenants with
a provider Connection that can run the model in the route. If an ID already
exists, inspect and reuse it where appropriate rather than overwriting it.

1. Open `ai-routes/demo-311-haiku-55.template.json` and replace the placeholder
   with your Connection ID. To create the route using the CLI:

   ```sh
   jq -c --arg connection "$CONNECTION_ID" \
     '.modelProviders[0].providerConnectionId = $connection' \
     ai-routes/demo-311-haiku-55.template.json |
     ctxl records add -C "$CONFIG" --type ai-route
   ```

2. Create the two AI Calls. Then use each Call's version controls in Console v2
   to point `stable` and `experimental` at versions of `demo-311-report`. Both may
   point to the same version. The Insights Call uses its current version, not
   either label.

   ```sh
   jq -c . ai-calls/demo-311-report.json ai-calls/demo-311-insights.json |
     ctxl records add -C "$CONFIG" --type ai-call
   ```

3. Deploy the Worker from the repo root. Compose requests the platform's
   Native Object and service-address features; don't put credentials in the
   image or browser. The demo is public when deployed. It only runs one model
   call at a time and keeps a per-container budget of 8 calls per hour and 24
   per day, reset on container restart. Keep it at one replica; this is not
   a production access-control or quota system.

   ```sh
   ctxl workers configure-docker
   ctxl workers create -C "$CONFIG" demo-311-request-desk --size small \
     --compose workers/request-desk/compose.yaml --min-replicas 1 --max-replicas 1
   ```
