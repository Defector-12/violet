# Debug Session: terminal-selection-unavailable
- **Status**: [OPEN]
- **Issue**: Natural Pointing receives a Trae terminal text-selection question but answers that it cannot identify the selected content.
- **Debug Server**: `http://10.37.247.128:7777/event` (`http://172.19.0.1:7777/event` from Core)
- **Log File**: Devbox `/data00/home/baojunhan/violet-debug-terminal-selection-unavailable/.dbg/trae-debug-log-terminal-selection-unavailable.ndjson`; synchronized locally before analysis.

## Reproduction Steps
1. Open Violet with Look enabled.
2. Select highlighted text in the Trae terminal.
3. Keep the pointer near the selection and ask what the selected content means.
4. Observe that Violet reports it cannot reliably identify the content.

## Existing Evidence
- Acceptance turn: `FB0FEE4D-EDFB-4858-88FB-5D60A0B04D9F`.
- Speech stopped at `2026-09-04T09:32:46.667Z`.
- The first response was cancelled at `2026-09-04T09:32:46.970Z`, consistent with visual routing.
- macOS Text Recognition initialized at approximately `2026-09-04T09:32:47.796Z`, consistent with screenshot privacy filtering.
- The fallback response started at `2026-09-04T09:32:57.574Z`.
- Existing logs do not expose the privacy-safe grounding metadata needed to identify the rejection gate.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | DeepSeek returned an answer but omitted target bounds. | High | Low | **Confirmed**: debug log line 3 has `hasAnswer=true`, `hasTarget=true`, and `targetBounds=null`. |
| B | DeepSeek target bounds did not contain the frozen pointer. | High | Low | **Inconclusive**: no bounds were returned to compare with the pointer. |
| C | DeepSeek confidence was below `0.7`. | Medium | Low | **Rejected**: debug log line 3 reports `confidence=0.95`. |
| D | The frozen app, window, or normalized pointer did not refer to the selected terminal text. | Medium | Medium | **Likely**: debug log line 2 reports `appBundleId=com.google.Chrome` for the intended Trae sample. |
| E | The anchor expired or the capture task was cancelled. | Low | Low | **Rejected for the completed capture**: line 2 reports `ageMs=368`; **confirmed downstream** for failed cancellation runs. |
| F | Core sends a late `response.cancel` after Qwen has already finished the active response, and Qwen's benign rejection terminates the session before capture completes. | High | Low | **Confirmed** by the user-visible provider error and acceptance runs that fail 25–183 ms after response audio begins. |
| G | Provider response audio reaches the client before the late final transcript classifies the turn as visual. | High | Low | **Confirmed**: post-fix logs show fallback cancellation was first triggered by `response-audio` after the response was already visible. |

## Log Evidence
- Reproduction turn `48804C5D-9AF3-4C18-8367-5363408D5488` stopped speech at `2026-09-04T09:50:37.857Z`.
- Qwen response started 12 ms later and audio started 85 ms later.
- The session ended with reason `failure` at `2026-09-04T09:50:38.029Z`.
- ScreenCaptureKit initialized at approximately `2026-09-04T09:50:38.045Z`, showing that a capture request had begun.
- No Envelope/model/gate instrumentation event was emitted, proving the capture never reached Core resolution.
- User-visible provider error: `conversation has no active response`.
- Debug log line 2: screenshot Envelope arrived with `focusPoint=(0.5896, 0.7583)`, age `368 ms`, and source app `com.google.Chrome`.
- Debug log line 3: DeepSeek returned an answer at confidence `0.95` and target kind `ring`, but no target bounds.
- Debug log line 4: Core rejected the answer specifically because the target had no bounds.
- Post-fix lines 1–5 and 6–10: Core sent fallback cancellation, Qwen returned `QWEN_INVALID_VALUE`, and Context Envelopes still arrived afterward.
- Both post-fix Envelopes came from `cn.trae.app` with fresh pointer coordinates, rejecting the stale-app hypothesis for the current runs.
- Acceptance events show `response.audio.scheduled` before `response.cancelled`, confirming that a short provider prefix reached playback before visual classification.
- Post-fix Context resolutions were aborted only after subsequent user turns began, before DeepSeek returned.

## Instrumentation Plan
- D/E: Record Context Envelope type, source app, presence of `focusPoint`, coordinates, and freshness.
- A/B/C: Record only model confidence and target metadata, never answer, question, image, or OCR text.
- A/B/C: Record the final grounding status and rejection reason.
- F: Record fallback cancellation timing, capture-request creation, and privacy-safe Qwen provider error metadata.

## Instrumentation Status
- Added four temporary network reporting regions to `services/core/src/realtime/realtime-session.ts`.
- Added fallback-cancel, capture-request, and Qwen provider-error points after the first reproduction failed before Envelope resolution.
- `@violet/core` TypeScript build passes.
- Focused realtime-session and Qwen adapter tests pass.
- Biome check passes with formatter suppression limited to the required single-line debug reporters.

## Verification Conclusion
Two independent failures are present:
1. A Qwen cancel race terminates some sessions before Context capture completes. The existing late-cancel guard only handles provider responses already marked complete locally.
2. When capture completes, DeepSeek currently returns the pointer ring as a target without bounds, and the captured source app may be stale.

Fix the cancellation race first while retaining instrumentation, then use a post-fix reproduction to continue diagnosing target capture and grounding.

## Feasibility Conclusion
- The cancellation race and leaked audio prefix are ordinary state-machine defects and have test-backed fixes.
- Precise terminal selection is not reliably recoverable from the current fallback contract. Trae exposes no `AXSelectedText`, while the fallback carries one pointer coordinate but no selection range.
- A screenshot model can sometimes infer a visible highlight, but cannot guarantee exact multi-line selection boundaries when focus styling changes, text is soft-wrapped, or the pointer marks only one endpoint.
- Prompt tuning, retries, or a lower confidence threshold cannot add the missing selection-range information and would weaken the no-guessing contract.
- Reliable delivery requires either an explicit Region selection or a terminal/IDE integration that exposes the selected text. Under the current no-clipboard and no-Trae-adapter constraints, explicit Region is the viable path.

## Cancellation Race Fix
- Added a failing Qwen adapter regression for the sequence `response.created` → audio → local cancel → provider `Conversation has no active response`.
- The adapter now converts only that exact error, while a local cancellation is pending, into `response-cancelled`.
- Late events for the already cancelled provider response are ignored until its `response.done`; unrelated provider errors remain visible.
- Focused RED reproduced `QWEN_INVALID_REQUEST_ERROR`; GREEN passes.
- Full TypeScript/JavaScript gate passes with `101` tests.
- Instrumentation remains enabled for post-fix runtime comparison.
- Post-fix commit `f7590ba` is deployed and healthy; post-fix debug logs were cleared before verification.

## Early Audio Buffer Fix
- Added a failing RealtimeSession regression where `response.started/audio` arrives before the final visual transcript.
- On-demand sessions now buffer response events by turn until the final transcript is available.
- Non-visual turns release the buffered events in order; visual turns suppress the old response and start Context capture without exposing an audio prefix.
- New and existing focused tests pass; the full TypeScript/JavaScript gate passes with `102` tests.
- Commit `01a1151` is deployed as `01a1151-post-fix`; post-fix logs were cleared before verification.

## User-Authorized Raw Artifact Capture
- Local destination: `tmp-test/` (untracked).
- Capture scope: one explicitly requested reproduction.
- Captured inputs: exact model name, system/user message payload, privacy-filtered image with focus marker, and pointer metadata.
- Captured outputs: full primary and optional crop-verification response objects, including `reasoning_content` only if the provider returns it.
- Excluded: API keys, Authorization headers, raw audio, and unrelated persisted Context.
- Focused DeepSeek adapter tests, build, formatting, and the full `102`-test TypeScript/JavaScript gate pass.
