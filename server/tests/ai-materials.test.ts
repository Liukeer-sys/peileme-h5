import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { extractProviderMaterial } from "../modules/ai/materials.js";

const temporaryDirectories: string[] = [];

const createTextPdf = (text: string) => {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("AI provider material extraction", () => {
  it("extracts bounded text from an owned PDF payload", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "peileme-ai-material-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "notice.pdf");
    await writeFile(filePath, createTextPdf("Severance notice and compensation"));

    const material = await extractProviderMaterial({
      id: "00000000-0000-4000-8000-000000000001",
      originalName: "解除通知.pdf",
      mimeType: "application/pdf",
      sizeBytes: "512",
      filePath
    });

    expect(material.extractedText).toContain("Severance notice and compensation");
    expect(material).not.toHaveProperty("imageDataUrl");
  });

  it("passes a supported image as a multimodal data URL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "peileme-ai-material-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "notice.png");
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(filePath, image);

    const material = await extractProviderMaterial({
      id: "00000000-0000-4000-8000-000000000002",
      originalName: "聊天记录.png",
      mimeType: "image/png",
      sizeBytes: String(image.byteLength),
      filePath
    });

    expect(material.imageDataUrl).toBe(
      `data:image/png;base64,${image.toString("base64")}`
    );
    expect(material).not.toHaveProperty("extractedText");
  });

  it("fails with a stable API error when the stored material disappeared", async () => {
    await expect(
      extractProviderMaterial({
        id: "00000000-0000-4000-8000-000000000003",
        originalName: "缺失材料.pdf",
        mimeType: "application/pdf",
        sizeBytes: "100",
        filePath: path.join(tmpdir(), "peileme-material-does-not-exist.pdf")
      })
    ).rejects.toMatchObject<ApiError>({
      status: 409,
      code: "AI_MATERIAL_UNAVAILABLE"
    });
  });
});
