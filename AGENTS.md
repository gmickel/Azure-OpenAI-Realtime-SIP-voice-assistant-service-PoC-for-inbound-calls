# Azure Real-Time Voice Bot — Agents Guide

**Mission (for agents):** Ship a production-ready **phone voice assistant** using **Azure OpenAI Realtime (SIP)**. Inbound PSTN/SIP calls land at Azure’s SIP connector; our Bun/Hono service handles the `realtime.call.incoming` webhook, **accepts** the call, attaches a **sideband WebSocket**, orchestrates **tool calls**, and can **REFER** or **hang up** via REST. No media/RTP in this repo.

---

## Tech stack & constraints

- **Runtime:** Bun ≥ 1.1 (TypeScript, ESM)
- **HTTP/WS:** Hono + `ws`
- **OpenAI:** Azure OpenAI Realtime SIP + WS control plane
- **Schema:** `zod` for tool args
- **Style:** strict TS; small modules; no side-effects in helpers
- **PII:** redact emails/phone in logs

**Critical constraints (do not violate):**
- **Do not change `/accept` semantics** beyond what’s here; it works end-to-end.
- **Do not force an API version**. The server only appends `api-version` if set in env; leave empty by default.

---

## Layout (authoritative)

`/src`
- **server.ts** — Hono app: webhook + WS orchestration + barge-in
- **callflow.ts** — REST helpers: accept/refer/hangup, Azure URL shaping
- **prompts.ts** — default neutral English prompts (edit directly if you need a different persona)
- **tools.ts** — tool schemas + handlers (handoff, lookup, inventory, callback)
- **observe.ts** — structured logs + redaction
- **__tests__** — basic PII redaction test

---

## Prompts

- Default persona lives in `src/prompts.ts` (English, neutral brand).
- To switch brands/languages, edit `src/prompts.ts` directly and redeploy. Keep the core rules (single greeting, tool summaries) intact to preserve QA coverage.

---

## Azure SIP gotchas

- Keep `/accept` minimal. Do **not** add `voice`, `turn_detection`, or `input_audio_transcription` to the accept body.
- Configure **voice** via `session.update` after WS opens. If Azure returns `unknown_parameter` on `audio.output.voice`, the server falls back to `session.voice`.
- Leave `REALTIME_API_VERSION` **unset** unless you know your tenant/region requires one.

---

## Tasks to automate

1. On `realtime.call.incoming`:
   - POST `/v1/realtime/calls/{call_id}/accept` with `{ model, tools, tool_choice: "none", instructions }`
   - Attach WS: `{REALTIME_WS_BASE}?call_id=...`
   - Send `session.update` with voice; enqueue one greeting

2. Barge-in:
   - On `speech_started`, cancel any active TTS (`response.cancel`)

3. Tools:
   - Accumulate streamed args; validate with `zod`; execute; send `function_call_output`; enqueue concise follow-up

4. Logging:
   - Use `observe.ts` methods; never log secrets; PII redaction stays on

5. Smoke tests:
   - `TEST_MODE=1 bun run scripts/smoke-sip-webhook.ts`

**Definition of done:**
- Accept → greet within ~1–2 s
- Transcripts arrive; tools runnable; REFER works
- Logs redact PII; `.env` ignored; signature verification on (except in TEST_MODE)

---

## Step-by-step plan (for an autonomous agent)

1. **Create a new branch**: `feat/neutral-prompts-and-override`
2. **Apply file updates** (exact contents above):

   * Replace `src/prompts.ts`, `src/server.ts`, `src/tools.ts`, `AGENTS.md`
   * Update `.gitignore` / `env.template` if needed for project hygiene
3. **Do not modify**:

   * `src/callflow.ts` (accept/refer URL logic)
   * `src/config.ts` (API version optional)
   * Smoke scripts (unchanged)
4. **Run checks**:

   * `bun run dev` → verify boot + `/healthz`
   * Place a real call through Twilio → Azure → webhook: confirm greeting once, barge-in works, tools reachable, REFER (if `SIP_TARGET_URI` set).
   * `TEST_MODE=1 bun run scripts/smoke-sip-webhook.ts` → expect “PASS”.
5. **Commit & open PR** with summary:

   * Neutral English default; prompt editing docs updated; robust voice patch; English tool follow-ups; docs updated.
6. **Post-merge**:

   * If you deploy the server to Azure, update the Azure webhook endpoint URL to your Azure host (as described in README).


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config Biome preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npx ultracite fix`
- **Check for issues**: `npx ultracite check`
- **Diagnose setup**: `npx ultracite doctor`

Biome (the underlying engine) provides extremely fast Rust-based linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `npx ultracite fix` before committing to ensure compliance.
