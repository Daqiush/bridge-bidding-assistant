import test from "node:test";
import assert from "node:assert/strict";
import * as app from "../worker/index.js";

test("boardInfo follows the standard 16-board dealer and vulnerability cycle", () => {
  assert.equal(typeof app.boardInfo, "function");
  const expectedVulnerability = [
    "None", "NS", "EW", "All",
    "NS", "EW", "All", "None",
    "EW", "All", "None", "NS",
    "All", "None", "NS", "EW",
  ];
  const expectedDealer = ["N", "E", "S", "W"];

  for (let board = 1; board <= 32; board += 1) {
    assert.deepEqual(app.boardInfo(board), {
      dealer: expectedDealer[(board - 1) % 4],
      vul: expectedVulnerability[(board - 1) % 16],
    }, `board ${board}`);
  }
});
