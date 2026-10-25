import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalBody, sign } from "../src/gaian/client.js";

const creds = { key: "test-key", secret: "test-secret" };

test("body is serialised with sorted keys", () => {
  assert.equal(canonicalBody({ b: 1, a: "x" }), '{"a":"x","b":1}');
  assert.equal(canonicalBody(undefined), "");
});

test("signature follows key + METHOD + path + query + body + ts, base64url", () => {
  const body = canonicalBody({ quoteId: "q1" });
  const expected = crypto
    .createHmac("sha256", creds.secret)
    .update(`test-keyPOST/api/v2/orders${body}1700000000`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  assert.equal(sign(creds, "post", "/api/v2/orders", body, 1700000000), expected);
});

test("query string is appended without '?' and ':' is stripped from the path", () => {
  const a = sign(creds, "GET", "/api/v2/a:b?x=1", "", 1);
  const b = crypto.createHmac("sha256", creds.secret).update("test-keyGET/api/v2/abx=11").digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(a, b);
  assert.doesNotMatch(a, /[+/]/);
});
