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

## Log Evidence
Pending pre-fix reproduction with privacy-safe metadata instrumentation.

## Instrumentation Plan
- D/E: Record Context Envelope type, source app, presence of `focusPoint`, coordinates, and freshness.
- A/B/C: Record only model confidence and target metadata, never answer, question, image, or OCR text.
- A/B/C: Record the final grounding status and rejection reason.

## Instrumentation Status
- Added four temporary network reporting regions to `services/core/src/realtime/realtime-session.ts`.
- `@violet/core` TypeScript build passes.
- Focused realtime-session tests pass.
- Biome check passes with formatter suppression limited to the required single-line debug reporters.

## Verification Conclusion
Pending.
