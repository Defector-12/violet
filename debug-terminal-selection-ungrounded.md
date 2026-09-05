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
| A | Qwen does not request current-view inspection | Medium | Low | Rejected: visual fallback requested capture |
| B | Capture succeeds but Core grounding rejects target evidence | High | Low | Confirmed: missing selected text evidence |
| C | DeepSeek returns low confidence or invalid target JSON | High | Low | Rejected: confidence 0.82 with valid kind and bounds |
| D | The final question is not classified as a text-selection task | Medium | Low | Rejected: visual and selection gates both ran |

## Log Evidence
Existing acceptance metadata proves both voice responses completed without session failure, but does not record Context routing or grounding decisions.
Instrumentation commit `12ca14b` is deployed. The pre-fix collector is reachable from the Core container and contains zero events before reproduction.

Pre-fix evidence from `.dbg/trae-debug-log-terminal-selection-ungrounded.ndjson`:
- Line 1: current-view classification was true.
- Lines 2-4: fallback capture was requested and a `2940 x 1912` screenshot with a focus point reached DeepSeek.
- Line 5: DeepSeek returned confidence `0.82`, `text-selection`, and bounds, but no `target.text`.
- Line 6: Core rejected the result with `The visual model did not return the selected text as evidence.`

## Instrumentation Plan
1. Final transcript classification: visual fallback decision and selection-reference shape.
2. Context request creation: Qwen tool call versus deterministic fallback.
3. Mac capture result: success/failure, payload type, focus point, dimensions, and encoded length.
4. DeepSeek request/result: image metadata, confidence, target kind, bounds, and text presence.
5. Core grounding result/error: ready/unavailable status and deterministic rejection reason.

## Verification Conclusion
Root cause confirmed: the vision model omitted mandatory `target.text` while claiming a high-confidence text selection. Core correctly failed closed. The fix must strengthen the single-call output contract without lowering the confidence or text-evidence gates.

## Fix
- Strengthen the existing single-call prompt: a text target without `target.text` is invalid.
- Require exact complete visible text in `target.text`.
- Require confidence below `0.7` when exact text cannot be transcribed.
- Keep the Core confidence, bounds, pointer containment, target kind, and text gates unchanged.

Post-fix runtime verification is pending.
