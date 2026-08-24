# Research writing standard

Rotyl research pages are technical records. They should help a reader decide what was tested, what the result supports, and where the result stops applying.

## Required structure

Every page must state:

1. The kind of evidence: benchmark, investigation, decision record, live audit or historical study.
2. The scope of the claim, including relevant product, browser, hardware, model or fixture boundaries.
3. The measurement date and environment.
4. The source results and method.
5. What is required to repeat the work.
6. The result and its practical consequence.
7. Any limit that changes how the result may be used.

## Voice

- Use plain technical English and active voice.
- Lead with the subject, method or result. Do not lead with suspense.
- Prefer a short sentence over a sentence joined by an em dash.
- Keep sentences to 48 words or fewer. Split methods, results and implications when they compete for one sentence.
- Do not use em dashes or en dashes.
- Do not open paragraphs with coordinating conjunctions or rhetorical prompts such as "So," "And" or "What."
- Do not call entries chapters or make one page depend on reading another first.
- Do not use vague narrators such as "nobody," "everybody" or "somebody" when the responsible code, test or decision can be named.
- Do not use staged formulas such as "three things were unknown," "the answer was backwards," or "what happened next."
- Do not inflate a local observation into a general statement. Say "on the tested Chrome build" when that is the evidence.
- Do not hide a limitation in the footer. Put it beside the claim it limits.
- Use restrained titles that name the system and subject. Avoid rhetorical questions, fragments written for intrigue and repeated title templates.

## Evidence rules

- Read displayed figures from recorded results. Do not transcribe benchmark values into prose when the value can be derived.
- Keep a result in its own file when rerunning unrelated work would change its date.
- Preserve counter-metrics and negative results.
- Label manual measurements as manual. Do not present them as benchmark-grade evidence.
- Label deployed-state checks as snapshots. They describe the recorded date, not permanent production state.
- Label pre-implementation studies as historical after the feature ships.
- Record exact versions where browser, operating system, runner image, model or codec behaviour affects the conclusion.

## Review checklist

Before publishing, read the page without its neighbours and confirm that:

- the opening explains the test without project chronology;
- the title and summary match the measured result;
- environment-specific numbers are qualified;
- every command, table and figure supports a stated claim;
- stale product-state language has been removed;
- the prose contains no banned style patterns enforced by the research page test.
