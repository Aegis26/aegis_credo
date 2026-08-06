// Synthetic MULTI-ACCOUNT bank statement fixture (Capital One-style layout):
// 3 accounts, an internal transfer pair, a no-amount informational row, and a
// stated combined total. Writes /tmp/multi-statement.pdf + /tmp/statement-body.json.
import PDFDocument from "pdfkit";
import { createWriteStream, writeFileSync, readFileSync } from "node:fs";

const doc = new PDFDocument({ margin: 40 });
const out = createWriteStream("/tmp/multi-statement.pdf");
doc.pipe(out);

doc.fontSize(16).text("SYNTH BANK — Combined Statement");
doc.fontSize(10).text("Period: 2026-07-01 to 2026-07-31");
doc.text("Total Ending Balance across all accounts: $7,598.08");
doc.moveDown();

function account(title, last4, opening, rows, closing) {
  doc.fontSize(13).text(`${title}  (account ending ${last4})`);
  doc.fontSize(10).text(`Opening Balance on 2026-07-01: ${opening}`);
  for (const r of rows) doc.text(r);
  doc.text(`Closing Balance on 2026-07-31: ${closing}`);
  doc.moveDown();
}

account("Simply Checking", "4821", "$2,000.00", [
  "2026-07-03  ACME PAYROLL DIRECT DEP        +$3,100.00   Balance: $5,100.00",
  "2026-07-08  POS PURCHASE GROCERY MART      -$86.30      Balance: $5,013.70",
  "2026-07-10  ONLINE TRANSFER TO ROUND UP SAVINGS 9077  -$500.00  Balance: $4,513.70",
  "2026-07-22  UTILITY CO E-PAYMENT           -$140.12     Balance: $4,373.58",
], "$4,373.58");

account("Round Up Savings", "9077", "$1,500.00", [
  "2026-07-10  ONLINE TRANSFER FROM SIMPLY CHECKING 4821  +$500.00  Balance: $2,000.00",
  "2026-07-15  Interest Rate Change from 3.154% to 3.057%",
  "2026-07-31  INTEREST PAYMENT               +$4.50       Balance: $2,004.50",
], "$2,004.50");

account("Holiday Fund", "3310", "$1,200.00", [
  "2026-07-20  MOBILE DEPOSIT                 +$20.00      Balance: $1,220.00",
], "$1,220.00");

doc.end();
await new Promise((r) => out.on("finish", r));
const b64 = readFileSync("/tmp/multi-statement.pdf").toString("base64");
writeFileSync(
  "/tmp/statement-body.json",
  JSON.stringify({ content: b64, filename: "multi-statement.pdf" }),
);
console.log("wrote /tmp/multi-statement.pdf and /tmp/statement-body.json");
