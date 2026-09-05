# Debug Session: terminal-selection-ungrounded
- **Status**: [OPEN]
- **Issue**: Trae terminal selected code is not understood, while AX-readable selected text works.
- **Debug Server**: http://172.19.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-terminal-selection-ungrounded.ndjson

## Reproduction Steps
1. Enable Look and start a Violet voice session.
2. Select code in the Trae integrated terminal and keep the pointer inside the selection.
3. Ask what the selected code means and wait for the complete response.
4. Observe that Violet asks the user to paste the code instead of answering from the screenshot.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Qwen does not request current-view inspection | Medium | Low | Pending |
| B | Capture succeeds but Core grounding rejects target evidence | High | Low | Pending |
| C | DeepSeek returns low confidence or invalid target JSON | High | Low | Pending |
| D | The final question is not classified as a text-selection task | Medium | Low | Pending |

## Log Evidence
Existing acceptance metadata proves both voice responses completed without session failure, but does not record Context routing or grounding decisions.

## Instrumentation Plan
1. Final transcript classification: visual fallback decision and selection-reference shape.
2. Context request creation: Qwen tool call versus deterministic fallback.
3. Mac capture result: success/failure, payload type, focus point, dimensions, and encoded length.
4. DeepSeek request/result: image metadata, confidence, target kind, bounds, and text presence.
5. Core grounding result/error: ready/unavailable status and deterministic rejection reason.

## Verification Conclusion
Pending pre-fix instrumentation.
