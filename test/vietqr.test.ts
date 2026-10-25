import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVietQr, crc16, isValidCrc } from "../src/vietqr.js";

test("CRC-16/CCITT-FALSE matches the standard check value", () => {
  // Published check value for this CRC variant: "123456789" gives 0x29B1.
  assert.equal(crc16("123456789"), "29B1");
});

test("built QR has a valid checksum and carries the amount", () => {
  const qr = buildVietQr({ bankBin: "970436", accountNumber: "9990000001", amountVnd: 900000, note: "DEMO" });
  assert.ok(isValidCrc(qr));
  assert.ok(qr.includes("5406900000"));
  assert.ok(qr.startsWith("000201010212"));
});

test("a tampered QR fails the checksum", () => {
  const qr = buildVietQr({ bankBin: "970436", accountNumber: "9990000001", amountVnd: 900000 });
  assert.equal(isValidCrc(qr.replace("900000", "100000")), false);
});
