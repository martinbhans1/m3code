import { afterEach, expect, it } from "vite-plus/test";
import { collectTextMatchRanges } from "./timelineFind";

afterEach(() => {
  document.body.innerHTML = "";
});

it("finds occurrences split across inline markup", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>The <strong>dep</strong>loyment and another Deployment</p>";
  document.body.append(root);

  const ranges = collectTextMatchRanges(root, "deployment");

  expect(ranges.map((range) => range.toString())).toEqual(["deployment", "Deployment"]);
});

it("finds a match that ends exactly at a node boundary", () => {
  const root = document.createElement("div");
  root.innerHTML = "<span>deploy</span><span>ment</span><span>x</span>";
  document.body.append(root);

  expect(collectTextMatchRanges(root, "deploy").map((range) => range.toString())).toEqual([
    "deploy",
  ]);
  expect(collectTextMatchRanges(root, "mentx").map((range) => range.toString())).toEqual(["mentx"]);
});
