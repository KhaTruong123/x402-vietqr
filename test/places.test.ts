import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACES, searchPlaces } from "../src/places.js";
import { isValidCrc } from "../src/vietqr.js";

test("catalogue has 10 places, all labelled demo", () => {
  assert.equal(PLACES.length, 10);
  for (const p of PLACES) assert.match(p.name, /\(demo\)$/);
});

test("search matches Vietnamese city names without accents and filters by budget", () => {
  const all = searchPlaces({ city: "Đà Lạt", kind: "homestay", nights: 2 });
  assert.equal(all.length, 2);
  const cheap = searchPlaces({ city: "da lat", kind: "homestay", nights: 2, maxTotalVnd: 1_000_000 });
  assert.deepEqual(cheap.map((r) => r.id), ["dl-pine-house"]);
  assert.equal(cheap[0]!.totalVnd, 900_000);
  assert.ok(isValidCrc(cheap[0]!.vietQr));
});

test("tags must all match", () => {
  assert.deepEqual(searchPlaces({ tags: ["beach", "pool"] }).map((r) => r.id), ["pq-beach-bungalow"]);
});
