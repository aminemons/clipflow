import assert from "node:assert/strict";
import test from "node:test";
import { clipCues, clipPosition, localCandidates, tightenPauses, trimSpan } from "../src/studio/model.ts";

test("caption timing follows reordered and trimmed source ranges", () => {
  const project = {
    cut: { spans: [{ id: "b", start: 12, end: 14 }, { id: "a", start: 0, end: 3 }] },
    transcript: [{ start: 0.8, end: 3.8, text: "First line" }, { start: 11, end: 13.5, text: "Second line" }],
  };
  assert.deepEqual(clipCues(project), [
    { start: 0, end: 1.5, text: "Second line" },
    { start: 2.8, end: 5, text: "First line" },
  ]);
  assert.equal(clipPosition(project.cut.spans, 2).sourceTime, 0);
  assert.equal(clipPosition(project.cut.spans, 2.5).sourceTime, 0.5);
});

test("tightening preserves speech and leaves breath between joined ranges", () => {
  const project = {
    cut: { spans: [{ id: "one", start: 0, end: 10 }] },
    transcript: [{ start: 0.8, end: 2, text: "Beginning" }, { start: 5, end: 8, text: "Payoff" }],
  };
  const spans = tightenPauses(project);
  assert.deepEqual(spans.map(({ start, end }) => [start, end]), [[0, 2.24], [4.81, 10]]);
  assert.deepEqual(clipCues({ ...project, cut: { spans } }).map(cue => cue.start), [0.8, 2.43]);
});

test("sparse timed dialogue is a better starting point than an arbitrary time window", () => {
  const candidates = localCandidates({
    duration: 43, target: 30, goal: "Tell a story", subject: "local",
    transcript: [{ start: 1, end: 3, text: "Hello from local SRT" }, { start: 5, end: 10, text: "A well-framed shot is worth the wait." }],
  });
  assert.equal(candidates[0].title, "Hello from local SRT");
  assert.equal(candidates[0].end, 10.2);
});

test("trim bounds keep a valid positive range", () => {
  const span = { id: "range", start: 4, end: 6 };
  assert.equal(trimSpan(span, "start", 300, 8).start, 5.85);
  assert.equal(trimSpan(span, "end", -10, 8).end, 4.15);
  assert.equal(trimSpan(span, "end", 10, 8).end, 8);
});
