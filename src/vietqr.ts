// Minimal VietQR (EMVCo merchant-presented QR) builder and reader.
// Only what the demo needs: a bank BIN + account number + optional amount and note.

function tlv(id: string, value: string): string {
  return id + value.length.toString().padStart(2, "0") + value;
}

// CRC-16/CCITT-FALSE, the checksum EMVCo uses in tag 63.
export function crc16(input: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export interface VietQrInput {
  bankBin: string;
  accountNumber: string;
  amountVnd?: number;
  note?: string;
}

export function buildVietQr({ bankBin, accountNumber, amountVnd, note }: VietQrInput): string {
  const beneficiary = tlv("00", bankBin) + tlv("01", accountNumber);
  const merchantAccount = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");
  let payload =
    tlv("00", "01") +
    tlv("01", amountVnd ? "12" : "11") +
    tlv("38", merchantAccount) +
    tlv("53", "704") +
    (amountVnd ? tlv("54", String(Math.round(amountVnd))) : "") +
    tlv("58", "VN") +
    (note ? tlv("62", tlv("08", note)) : "");
  payload += "6304";
  return payload + crc16(payload);
}

export function isValidCrc(qr: string): boolean {
  if (qr.length < 8 || qr.slice(-8, -4) !== "6304") return false;
  return crc16(qr.slice(0, -4)) === qr.slice(-4).toUpperCase();
}
