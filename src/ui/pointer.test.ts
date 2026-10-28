// Unit checks for the pointer-lock / pause state machine (run with `npm test`). Automation can never be granted
// pointer lock, so these cover the paths a browser session cannot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PointerFlow, RESUME_GRACE } from "./pointer.ts";

const started = (locked = true) => {
  const f = new PointerFlow();
  assert.deepEqual(f.handle({ type: "resume", now: 0 }), ["lock"]);
  if (locked) f.handle({ type: "locked" });
  return f;
};

test("starting asks for the pointer; capture hides the hint", () => {
  const f = new PointerFlow();
  assert.equal(f.hint, false);
  assert.deepEqual(f.handle({ type: "resume", now: 0 }), ["lock"]);
  assert.equal(f.hint, true);
  assert.deepEqual(f.handle({ type: "locked" }), []);
  assert.equal(f.hint, false);
});

test("Esc in pointer lock (pointer lost) pauses", () => {
  const f = started();
  assert.deepEqual(f.handle({ type: "unlocked" }), ["pause"]);
  assert.equal(f.playing, false);
  // The pause menu is up: losing or regaining focus does nothing more.
  assert.deepEqual(f.handle({ type: "blur" }), []);
  assert.deepEqual(f.handle({ type: "unlocked" }), []);
});

test("resuming recaptures; a refused lock keeps playing with the hint", () => {
  const f = started();
  f.handle({ type: "unlocked" });
  assert.deepEqual(f.handle({ type: "resume", now: 5000 }), ["lock"]);
  assert.deepEqual(f.handle({ type: "lockError" }), []);
  assert.equal(f.playing, true);
  assert.equal(f.hint, true);
  // Clicking the view later captures it (Input's own click handler); the change event clears the hint.
  f.handle({ type: "locked" });
  assert.equal(f.hint, false);
});

test("the Esc that resumed from the pause menu does not pause again", () => {
  const f = started(false);
  f.handle({ type: "pauseKey", now: 1000 });
  assert.equal(f.playing, false);
  f.handle({ type: "resume", now: 2000 });
  assert.deepEqual(f.handle({ type: "pauseKey", now: 2000 + RESUME_GRACE / 2 }), []);
  assert.equal(f.playing, true);
  assert.deepEqual(f.handle({ type: "pauseKey", now: 2000 + RESUME_GRACE * 2 }), ["pause"]);
});

test("pause key while captured releases the pointer and pauses", () => {
  const f = started();
  assert.deepEqual(f.handle({ type: "pauseKey", now: 1000 }), ["unlock", "pause"]);
});

test("window blur or hidden tab pauses", () => {
  const f = started();
  assert.deepEqual(f.handle({ type: "blur" }), ["unlock", "pause"]);
  const g = started(false);
  assert.deepEqual(g.handle({ type: "blur" }), ["pause"]);
});

test("the map computer releases the pointer without pausing", () => {
  const f = started();
  f.handle({ type: "map", open: true });
  assert.deepEqual(f.handle({ type: "unlocked" }), []);
  assert.equal(f.playing, true);
  assert.equal(f.hint, false);
  assert.deepEqual(f.handle({ type: "pauseKey", now: 9999 }), []);
  assert.deepEqual(f.handle({ type: "blur" }), []);
  f.handle({ type: "map", open: false });
  assert.equal(f.hint, true);
  f.handle({ type: "locked" });
  assert.deepEqual(f.handle({ type: "unlocked" }), ["pause"]);
});

test("a lock that arrives after a menu opened is given back", () => {
  const f = started(false);
  f.handle({ type: "stop" });
  assert.deepEqual(f.handle({ type: "locked" }), ["unlock"]);
});

test("stopping releases a held pointer", () => {
  const f = started();
  assert.deepEqual(f.handle({ type: "stop" }), ["unlock"]);
  assert.equal(f.playing, false);
});
