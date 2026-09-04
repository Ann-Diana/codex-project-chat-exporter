import PDFDocument from "pdfkit";

// Use a separate library-level writer so validator tests do not share its parser.
export async function securityPdf(configure = () => {}) {
  const date = new Date("2000-01-01T00:00:00Z");
  const doc = new PDFDocument({ compress: false, info: { CreationDate: date, ModDate: date } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on("data", b => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.text("Harmless /3D /JavaScript /Launch content");
  configure(doc);
  doc.end();
  return complete;
}
