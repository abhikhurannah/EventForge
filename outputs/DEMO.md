# EventForge — four-minute recording script

This is a recording plan, not a completed video. Run the application first and record the actual outcomes. Do not read out or expose a production API key.

0:00–0:35 — Register a local demo account, create a project. Explain that project ownership scopes dashboard queries and active hashed API keys authorize ingestion.

0:35–1:10 — Create a temporary demo API key. Send `order.created` with `{"orderId":"123"}` and idempotency key `demo-order-123`. Show the returned ID and queued/succeeded state after refreshing.

1:10–1:40 — Send the same request again. Point out the duplicate response and unchanged job ID/count. Change the payload under the same key and show the conflict.

1:40–2:20 — Send `{"failUntilAttempt":1}` using a fresh idempotency key. Inspect the successful event's two attempts. Then submit `{"simulateFailure":true}` and wait for three attempts and dead-letter state.

2:20–2:50 — Inspect the permanently failed event. Explain the sanitized error code. Demonstrate manual retry and explain that an intentionally failing payload fails again; real retries are useful after addressing the underlying issue.

2:50–3:20 — If a controlled public HTTPS receiver is available, configure it, submit a successful event, and show actual delivery logs. Explain HMAC verification, replay protection, and independent webhook retries. Otherwise disclose that live delivery has not been demonstrated.

3:20–3:45 — Show dashboard metrics for the events just sent. Distinguish received counts, processing duration and retry/failure rates. Do not present them as a benchmark.

3:45–4:00 — Optionally show the Gemini suggestion with its disclaimer if configured. Finish with the CI/test results actually obtained. Revoke the temporary demo key.
