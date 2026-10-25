// Demo catalogue. Every place, bank account and QR here is made up for testing.
// The QR codes are valid VietQR strings (correct checksum) pointing at fake accounts.
import { buildVietQr } from "./vietqr.js";

export type PlaceKind = "homestay" | "tour";

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  city: string;
  priceVnd: number; // per night for a homestay, per person for a tour
  rating: number;
  tags: string[];
  bankBin: string;
  accountNumber: string;
}

export const DEMO_LABEL = "DEMO: not a real business, test QR only";

export const PLACES: Place[] = [
  { id: "dl-pine-house", kind: "homestay", name: "Pine House Da Lat (demo)", city: "Da Lat", priceVnd: 450_000, rating: 4.6, tags: ["view", "quiet", "breakfast"], bankBin: "970436", accountNumber: "9990000001" },
  { id: "dl-cloud-hill", kind: "homestay", name: "Cloud Hill Homestay (demo)", city: "Da Lat", priceVnd: 690_000, rating: 4.8, tags: ["view", "fireplace", "couple"], bankBin: "970415", accountNumber: "9990000002" },
  { id: "dl-canyon-tour", kind: "tour", name: "Datanla Canyoning Tour (demo)", city: "Da Lat", priceVnd: 950_000, rating: 4.7, tags: ["adventure", "outdoor"], bankBin: "970418", accountNumber: "9990000003" },
  { id: "ha-riverside", kind: "homestay", name: "Hoi An Riverside Nest (demo)", city: "Hoi An", priceVnd: 520_000, rating: 4.5, tags: ["river", "bike", "breakfast"], bankBin: "970422", accountNumber: "9990000004" },
  { id: "ha-old-town", kind: "homestay", name: "Old Town Lantern Stay (demo)", city: "Hoi An", priceVnd: 880_000, rating: 4.9, tags: ["central", "pool", "couple"], bankBin: "970407", accountNumber: "9990000005" },
  { id: "ha-basket-boat", kind: "tour", name: "Cam Thanh Basket Boat Tour (demo)", city: "Hoi An", priceVnd: 400_000, rating: 4.4, tags: ["family", "outdoor"], bankBin: "970436", accountNumber: "9990000006" },
  { id: "sp-rice-terrace", kind: "homestay", name: "Rice Terrace Lodge Sa Pa (demo)", city: "Sa Pa", priceVnd: 600_000, rating: 4.7, tags: ["view", "trekking", "quiet"], bankBin: "970415", accountNumber: "9990000007" },
  { id: "sp-trek", kind: "tour", name: "Lao Chai Village Trek (demo)", city: "Sa Pa", priceVnd: 750_000, rating: 4.6, tags: ["trekking", "adventure", "outdoor"], bankBin: "970418", accountNumber: "9990000008" },
  { id: "pq-beach-bungalow", kind: "homestay", name: "Ong Lang Beach Bungalow (demo)", city: "Phu Quoc", priceVnd: 990_000, rating: 4.5, tags: ["beach", "couple", "pool"], bankBin: "970422", accountNumber: "9990000009" },
  { id: "pq-snorkel", kind: "tour", name: "An Thoi Islands Snorkel Trip (demo)", city: "Phu Quoc", priceVnd: 1_150_000, rating: 4.8, tags: ["beach", "family", "outdoor"], bankBin: "970407", accountNumber: "9990000010" },
];

export interface SearchInput {
  city?: string;
  kind?: PlaceKind;
  nights?: number; // homestay: number of nights; tour: number of people
  maxTotalVnd?: number;
  tags?: string[];
}

export interface SearchResult {
  id: string;
  kind: PlaceKind;
  name: string;
  city: string;
  rating: number;
  tags: string[];
  units: number;
  priceVnd: number;
  totalVnd: number;
  vietQr: string;
  demo: string;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function searchPlaces(input: SearchInput): SearchResult[] {
  const units = Math.max(1, Math.floor(input.nights ?? 1));
  const wantTags = (input.tags ?? []).map(fold);
  return PLACES.filter((p) => !input.city || fold(p.city).includes(fold(input.city)))
    .filter((p) => !input.kind || p.kind === input.kind)
    .filter((p) => wantTags.every((t) => p.tags.includes(t)))
    .map((p) => {
      const totalVnd = p.priceVnd * units;
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        city: p.city,
        rating: p.rating,
        tags: p.tags,
        units,
        priceVnd: p.priceVnd,
        totalVnd,
        vietQr: buildVietQr({ bankBin: p.bankBin, accountNumber: p.accountNumber, amountVnd: totalVnd, note: `DEMO ${p.id}`.slice(0, 25) }),
        demo: DEMO_LABEL,
      };
    })
    .filter((r) => !input.maxTotalVnd || r.totalVnd <= input.maxTotalVnd)
    .sort((a, b) => b.rating - a.rating || a.totalVnd - b.totalVnd);
}
