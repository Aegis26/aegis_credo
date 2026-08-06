---
name: Statement-extraction error handling & SDK gotchas
description: Bank-statement PDF AI extraction — Anthropic streaming requirement, typed error surfacing, ApiError body shape.
---

- **Anthropic SDK non-streaming guard**: with large `max_tokens` (e.g. 32000) `messages.create` throws `AnthropicError` upfront ("may take longer than 10 minutes"). Use `messages.stream({...}).finalMessage()`. Fails in ~0.5s live but is invisible to tests (extractor not unit-tested against the live API).
  **How to apply:** any new vision/LLM call with big output budgets must stream; re-verify on SDK upgrades.
- **Frontend error bodies live at `ApiError.data.error`** (our fetch client), NOT axios's `e.response.data.error` — the latter silently yields the fallback for EVERY error. Use `getApiErrorMessage(e, fallback)` from `@workspace/api-client-react`.
- Extraction failures are typed (`StatementExtractionError` kind: too_long/rate_limited/service/unreadable) with safe-to-log metadata only (errorClass/status/stopReason) — never log or attach PDF/model content.
- 8192 output tokens truncates real statements mid-JSON (`stop_reason: "max_tokens"`); pdfjs `PasswordException` = encrypted PDF, catch it for a specific user message.
- **Why:** a real user statement failed with a generic "try again"; the underlying error had been swallowed unlogged and the specific server message never surfaced due to the axios-shape bug.
