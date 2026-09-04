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
| A | DeepSeek returned an answer but omitted target bounds. | High | Low | Pending model-result metadata. |
| B | DeepSeek target bounds did not contain the frozen pointer. | High | Low | Pending focus-point and bounds metadata. |
| C | DeepSeek confidence was below `0.7`. | Medium | Low | Pending confidence metadata. |
| D | The frozen app, window, or normalized pointer did not refer to the selected terminal text. | Medium | Medium | Pending capture metadata. |
| E | The anchor expired or the capture task was cancelled. | Low | Low | Current timing is within 30 seconds; pending capture outcome metadata. |
| F | Core sends a late `response.cancel` after Qwen has already finished the active response, and Qwen's benign rejection terminates the session before capture completes. | High | Low | Pending fallback-cancel and provider-error metadata. |

## Log Evidence
- Reproduction turn `48804C5D-9AF3-4C18-8367-5363408D5488` stopped speech at `2026-09-04T09:50:37.857Z`.
- Qwen response started 12 ms later and audio started 85 ms later.
- The session ended with reason `failure` at `2026-09-04T09:50:38.029Z`.
- ScreenCaptureKit initialized at approximately `2026-09-04T09:50:38.045Z`, showing that a capture request had begun.
- No Envelope/model/gate instrumentation event was emitted, proving the capture never reached Core resolution.
- User-visible provider error: `conversation has no active response`.

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
Pending.
