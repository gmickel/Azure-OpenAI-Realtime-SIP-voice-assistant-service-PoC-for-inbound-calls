# Azure OpenAI gpt-realtime Voice Bot

Simple Bun/Hono service that receives **`realtime.call.incoming`** webhooks from **Azure OpenAI Realtime (SIP)**, configures the voice session, handles tool calls, and can forward callers to a human via SIP **REFER**.
👉 This project focuses on the **control plane** (call acceptance, WS control, tools, logging)—media (RTP) is handled by Azure/Twilio.

I made this because I wanted to test the latency of the Realtime API when everything is deployed in the same region/resource group on Azure.

---

## At a Glance

* **What it does:** Answers phone calls sent via **Twilio Elastic SIP** to **Azure OpenAI Realtime (SIP)**, then controls the conversation over a sideband **WebSocket**.
* **Why Azure:** Keep data in-region, enterprise auth/quota, and reduce path length when deployed in Azure.
* **Tech:** Bun + Hono, `openai` SDK, `ws`, `zod`.
* **Tools included:**
  `handoff_human` (SIP REFER), `lookup_order`, `check_inventory`, `schedule_callback` — all pluggable.

---

## Architecture

```
PSTN ↔ Twilio Elastic SIP Trunk → Azure OpenAI Realtime (SIP)
                                 ↘ (Webhook: realtime.call.incoming)
                                   Your Bun/Hono server
                                      ├─ POST /accept      (REST)
                                      ├─ wss /v1/realtime?call_id=... (control)
                                      ├─ tools (function calls)
                                      └─ POST /refer       (REST, on handoff)
```

**Flow**

1. Inbound call hits the **Azure Realtime SIP connector** you configured for your Azure OpenAI resource.
2. Azure posts **`realtime.call.incoming`** to your server’s webhook.
3. Your server **accepts** the call (REST), then attaches to the call control **WebSocket**.
4. The bot greets, listens, calls tools, and can **REFER** to a human queue.

---

## Prerequisites

* **Azure subscription** with an **Azure OpenAI** resource in a supported region (e.g. Sweden Central).
* A **model deployment** named e.g. `gpt-realtime`. (Azure AI Foundry → *Deployments* → *Deploy model* → `gpt-realtime`.)
* **API key** for that Azure OpenAI resource.
* A **public URL** for your webhook (local: use `ngrok` or Cloudflare Tunnel).
* (Optional) **Twilio** account for Elastic SIP Trunking and a phone number.

---

## Quick Start

### 1) Clone & install

```bash
git clone <your-repo>
cd <your-repo>
bun install
cp env.template .env
```

### 2) Fill `.env`

For **Azure**:

```env
OPENAI_API_KEY=YOUR_AZURE_OPENAI_KEY
OPENAI_WEBHOOK_SECRET= # set after creating the webhook endpoint (see below)
REALTIME_MODEL=gpt-realtime
REALTIME_VOICE=marin        # any voice supported by the Realtime stack
SIP_TARGET_URI=             # e.g. tel:+1AAA BBB CCCC (optional, for REFER)
PORT=8000

# Azure endpoints (use your own resource subdomain + path)
OPENAI_BASE=https://<your-resource>.openai.azure.com/openai
REALTIME_WS_BASE=wss://<your-resource>.openai.azure.com/openai/v1/realtime

# Leave empty or unset for Azure Realtime:
REALTIME_API_VERSION=
```

> **Important (Azure):** Do **not** append `api-version` to Realtime WS/REST in this project. The Azure Realtime SIP control plane accepts `/v1/...` without it.

### 3) Start the server

```bash
bun run dev
# or
bun run start
```

Server prints:

```
Server listening on http://localhost:8000/
```

Health checks:

* `GET /healthz` → `{ ok: true }`
* `GET /` → service info

### 4) Expose your webhook (local)

```bash
npx ngrok http 8000
# note the https://<subdomain>.ngrok-free.app URL
```

---

## Wire Up Azure OpenAI Realtime (SIP)

### A) Create the webhook endpoint in Azure

Use your resource host (replace placeholders), and the **public webhook URL** from ngrok/your domain:

```bash
curl -sS -X POST "https://<your-resource>.openai.azure.com/openai/v1/dashboard/webhook_endpoints" \
  -H "Content-Type: application/json" \
  -H "api-key: <YOUR_AZURE_OPENAI_KEY>" \
  -d '{
    "name": "realtime-incoming",
    "url": "https://<your-public-host>/openai/webhook",
    "event_types": ["realtime.call.incoming"]
  }'
```

After creating, Azure shows a **Webhook Signing Secret**. Put that into `.env` as:

```
OPENAI_WEBHOOK_SECRET=...
```

### B) Deploy the `gpt-realtime` model (if not done)

In **Azure AI Foundry → Deployments**, deploy `gpt-realtime` (Global Standard).
Your `.env` should use `REALTIME_MODEL=gpt-realtime` (deployment name, not model family).

---

## Twilio Elastic SIP Trunking

> Twilio routes PSTN calls to Azure’s SIP connector. You’ll point your SIP trunk at the SIP URI Azure provides for your resource/project.

**Good step-by-step from Twilio:**

* *OpenAI Realtime API + Elastic SIP Trunking*
  [https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)

**High-level steps**

1. In Twilio, create an **Elastic SIP Trunk**, add an **Origination URI** that points to the **Azure OpenAI SIP connector URI** for your resource/project.
2. Assign a **Twilio phone number** to the trunk.
3. Call that number. Twilio sends the call to Azure Realtime SIP, which triggers our webhook.

> The SIP connector URI appears in Azure’s Realtime docs/portal for your resource. It looks like `sip:proj_...@sip.api.openai.azure.com` (format varies). You give this to Twilio as the target for the trunk.

---

### Use OpenAI’s Native Realtime API (no Azure)

Prefer the stock OpenAI cloud instead of Azure? The same Bun service works there too—just point your SIP trunk at `sip.api.openai.com`, create the webhook in the OpenAI console, and swap the base URLs in `.env`.

**1. Configure OpenAI webhooks + SIP in the console**

1. Navigate to [https://platform.openai.com/settings/](https://platform.openai.com/settings/) while signed into the right project.
2. In **Settings → Webhooks**, click **Create webhook**:
   * Name it, set the URL to `https://<your-public-host>/openai/webhook`, and select the `realtime.call.incoming` event.
   * Copy the **Webhook secret** and store it as `OPENAI_WEBHOOK_SECRET`.
3. Open **Live → SIP Connect** (same project) and create a SIP connection:
   * Use the provided URI format `sip:<project-id>@sip.api.openai.com;transport=tls` (Twilio’s guide specifies the `project-id` from Settings → General).
   * Configure your Twilio/Bandwidth trunk Origination target to that exact URI so inbound calls hit OpenAI’s SIP connector.

**2. Update `.env` for the public OpenAI endpoints**

```env
# Direct OpenAI cloud
OPENAI_BASE=https://api.openai.com
REALTIME_WS_BASE=wss://api.openai.com/v1/realtime
REALTIME_API_VERSION=
```

Keep using your standard `OPENAI_API_KEY`, `REALTIME_MODEL`, `REALTIME_VOICE`, etc. The server automatically switches between Azure-style `api-key` headers and OpenAI’s `Authorization: Bearer` based on the hostname.

**3. Deploy & test**

1. Restart `bun run dev` so the new env vars load.
2. Call your number → your carrier routes to `sip:<project-id>@sip.api.openai.com;transport=tls` → OpenAI posts the webhook to you.
3. Watch the logs—you should see the exact same greeting/tool flow, just without Azure in the middle.

> Tip: The OpenAI console pings the webhook URL before saving. Keep ngrok/Cloudflare Tunnel running so validation succeeds (Twilio’s tutorial highlights using a static ngrok domain for this).

---

## What You Should See

1. Phone call → Twilio → Azure → **your server** logs:

   * `{"scope":"webhook","eventType":"realtime.call.incoming", ...}`
   * `{"scope":"call","status":"accepted"}`
   * `{"scope":"call","status":"ws_opened"}`
2. The bot greets and responds to you.
3. If you say “transfer me to a person”, the `handoff_human` tool issues a **REFER** to `SIP_TARGET_URI`.

---

## Configuration Reference

| Variable                | Required  | Notes                                                                                          |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`        | ✅         | Azure OpenAI **resource** API key.                                                             |
| `OPENAI_WEBHOOK_SECRET` | ✅         | The **signing secret** you get when creating the webhook endpoint (used to verify signatures). |
| `REALTIME_MODEL`        | ✅         | Azure deployment name (e.g. `gpt-realtime`).                                                   |
| `REALTIME_VOICE`        | ✅         | Voice name supported by Realtime (e.g., `marin`, `alloy`, etc.).                               |
| `SIP_TARGET_URI`        | ➖         | Destination for REFER (e.g., `tel:+1XXXXXXXXXX` or `sip:queue@pbx.example.com`).               |
| `PORT`                  | ➖         | Defaults to `8000`.                                                                            |
| `OPENAI_BASE`           | ✅ (Azure) | `https://<resource>.openai.azure.com/openai`                                                   |
| `REALTIME_WS_BASE`      | ✅ (Azure) | `wss://<resource>.openai.azure.com/openai/v1/realtime`                                         |
| `REALTIME_API_VERSION`  | ✖         | Leave empty for this project’s Realtime calls.                                                 |
| `TEST_MODE`             | ➖         | `1` disables signature verification for local smoke tests only.                                |

---

## Commands

```bash
bun run dev                  # hot reload
bun run start                # prod-style start
bun test                     # unit tests (PII redaction)
bun run scripts/smoke-sip-webhook.ts   # offline webhook smoke (no Azure/Twilio)
```

> The `smoke-realtime-ws.ts` targets api.openai.com and is meant to validate account-level realtime, not Azure SIP. For full Azure SIP verification, place a real call or use the webhook smoke with TEST_MODE.

---

## How It Works (Deeper Dive)

1. **Webhook verify**: `POST /openai/webhook` validates the request (or bypasses with `TEST_MODE=1`).
2. **Accept**: On `realtime.call.incoming`, the server posts **`/v1/realtime/calls/{call_id}/accept`** with your model, voice, and tool schemas.
3. **Sideband WS**: It then connects to **`wss://.../v1/realtime?call_id=...`** using the **`api-key`** header (Azure) and sends a **`session.update`** to set voice/instructions.
4. **Turn-taking**: The server listens for speech start/stop and transcription events to request concise turn responses.
5. **Tools**: Function-call items stream in; arguments are collected, validated by `zod`, and executed (`handoff_human`, `lookup_order`, `check_inventory`, `schedule_callback`).
6. **REFER**: `handoff_human` triggers a **`/refer`** to `SIP_TARGET_URI`.
7. **Observability**: Structured logs (`scope=webhook|call|tool|transcript`) with basic PII redaction.

---

## Extending the Bot

* **Add a tool**: Implement a `ToolDefinition` in `src/tools.ts` with a `zod` schema and a handler. It will automatically appear in `realtimeToolSchemas`.
* **Improve prompts**: Edit `src/prompts.ts` (`systemPrompt`, `greetingPrompt`). Keep them short and intentional—Realtime responds quickly to concise instructions.
* **Data connectors**: In a real system, your tool handlers would query internal APIs/DBs and return a summarized payload for the bot to explain in German.

---

## Deploying the Node Server to Azure (Low Latency)

Running your control plane **in the same Azure region** as your Azure OpenAI resource minimizes WS round‑trips and avoids public‑internet hairpins.

**Options**

* **Azure Container Apps** or **Azure App Service**: containerize or run Bun directly.
* **Azure VM / Scale Set**: for maximum control and custom networking.
* **Azure Functions** (HTTP + WS not ideal here): you still need a long‑lived WS client; prefer a process‑based host.

**What changes if you deploy the server in Azure?**

* You’ll use an **Azure‑hosted** HTTPS domain for the webhook instead of ngrok.
* Re‑create the webhook endpoint (or update it) with your new public URL:

  ```bash
  curl -sS -X POST "https://<your-resource>.openai.azure.com/openai/v1/dashboard/webhook_endpoints" \
    -H "Content-Type: application/json" \
    -H "api-key: <YOUR_AZURE_OPENAI_KEY>" \
    -d '{
      "name": "realtime-incoming",
      "url": "https://<your-azure-host>/openai/webhook",
      "event_types": ["realtime.call.incoming"]
    }'
  ```
* Twilio stays the same (it still points at Azure’s SIP connector).
* Keep the **same** `OPENAI_BASE` and `REALTIME_WS_BASE` values; they target your Azure OpenAI resource.

**Networking tips**

* Ensure your app can reach `https://<resource>.openai.azure.com/openai` and `wss://.../v1/realtime`.
* If you later enable **Private Endpoints** on the Azure OpenAI resource, put the app inside the same VNet/subnet and update DNS accordingly.

---

## Troubleshooting

**WS error “Expected 101 status code”**

* In this project, **don’t** add `api-version` to the WS URL.
* Confirm `REALTIME_WS_BASE` is `wss://<resource>.openai.azure.com/openai/v1/realtime`.
* Azure requires the **`api-key`** header (not `Authorization: Bearer`). This server sets it automatically when `OPENAI_BASE` is Azure.

**No greeting / wrong voice**

* The server sends `session.update` and then applies voice on `session.updated`. If Azure returns `unknown_parameter` for `audio.output.voice`, the server retries with `voice` (compat shim).

**REFER does nothing**

* Set a real `SIP_TARGET_URI` (E.164 for PSTN, or `sip:...@...` for PBX).
* Your carrier/PBX must accept REFER to that target.

---

## Security & Compliance

* Keep `.env` out of version control (already ignored).
* Store secrets in **Azure Key Vault** or your secret manager.
* Logs redact naive phone numbers/emails; add a SIEM/SOC sink (Datadog, etc.) before production.
* For PHI/PII, ensure data residency and DSR procedures align with your policies.

---

## License

MIT

---

### References

* **Azure Realtime SIP** (Microsoft Learn): “Use the GPT Realtime API via SIP”
  [https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/realtime-audio-sip](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/realtime-audio-sip)
* **Realtime conversations & tools** (OpenAI Platform)
  [https://platform.openai.com/docs/guides/realtime](https://platform.openai.com/docs/guides/realtime)
* **Azure Realtime audio reference**
  [https://learn.microsoft.com/en-us/azure/ai-services/openai/realtime-audio-reference](https://learn.microsoft.com/en-us/azure/ai-services/openai/realtime-audio-reference)
* **Twilio Elastic SIP Trunking + OpenAI Realtime**
  [https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)
* **Bandwidth ↔ OpenAI Realtime SIP**
  [https://dev.bandwidth.com/docs/voice/integrations/openai/realtime/sip/](https://dev.bandwidth.com/docs/voice/integrations/openai/realtime/sip/)
