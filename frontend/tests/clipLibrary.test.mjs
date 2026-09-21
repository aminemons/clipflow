import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(
  new URL("../src/clipLibraryModel.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  module,
  module.exports,
);
const { exportClipIds, libraryPatch, matchesLibraryFilter } = module.exports;

const suggested = {
  id: "one",
  title: "A useful explanation",
  reason: "Complete passage",
  selected: true,
  suggestion_status: "pending",
  status: "draft",
};

test("discard immediately removes a clip from export and keeps it recoverable", () => {
  const clip = {
    ...suggested,
    ...libraryPatch({ suggestion_status: "discarded" }),
  };
  assert.deepEqual(exportClipIds([clip]), []);
  assert.equal(matchesLibraryFilter(clip, "all", ""), false);
  assert.equal(matchesLibraryFilter(clip, "discarded", ""), true);
  assert.equal(clip.reviewed, true);
});

test("restore returns a suggestion to review without exporting it", () => {
  const clip = {
    ...suggested,
    ...libraryPatch({ suggestion_status: "pending" }),
  };
  assert.equal(clip.reviewed, false);
  assert.equal(clip.selected, false);
  assert.equal(matchesLibraryFilter(clip, "pending", ""), true);
});

test("Keep selects the clip for export and completes suggestion review", () => {
  const clip = { ...suggested, ...libraryPatch({ suggestion_status: "kept" }) };
  assert.deepEqual(exportClipIds([clip]), ["one"]);
  assert.equal(matchesLibraryFilter(clip, "pending", ""), false);
  assert.equal(matchesLibraryFilter(clip, "kept", ""), true);
});

test("stale selected flags on discarded clips cannot leak into a bulk export", () => {
  assert.deepEqual(
    exportClipIds([
      suggested,
      { ...suggested, id: "discarded", suggestion_status: "discarded" },
    ]),
    ["one"],
  );
});

test("manual drafts are not presented as automatic suggestions", () => {
  const manual = { id: "manual", title: "Custom", status: "draft" };
  assert.equal(matchesLibraryFilter(manual, "pending", ""), false);
  assert.equal(matchesLibraryFilter(manual, "all", ""), true);
});

test("search and export filters compose without changing stored choices", () => {
  const clip = { ...suggested, status: "exported" };
  assert.equal(matchesLibraryFilter(clip, "exported", " USEFUL "), true);
  assert.equal(matchesLibraryFilter(clip, "exported", "other"), false);
  assert.deepEqual(libraryPatch({ selected: false }), { selected: false });
});
