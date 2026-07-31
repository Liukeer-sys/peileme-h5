import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { getConfig } from "../../config.js";
import { query } from "../../db.js";
import { ApiError } from "../../errors.js";
import type { AiProviderRequest } from "../llm/types.js";

const MAX_EXTRACTED_TEXT_CHARACTERS = 60_000;
const MAX_IMAGE_BYTES_FOR_MODEL = 5 * 1024 * 1024;

type MaterialRow = {
  id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: string;
};

const resolveMaterialPath = (uploadDir: string, storedName: string) => {
  const root = path.resolve(uploadDir);
  const filePath = path.resolve(root, storedName);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ApiError(409, "AI_MATERIAL_UNAVAILABLE", "材料文件不可用，请重新上传");
  }
  return filePath;
};

export const extractProviderMaterial = async (input: {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  filePath: string;
}): Promise<AiProviderRequest["uploads"][number]> => {
  const file = await lstat(input.filePath).catch(() => null);
  if (!file?.isFile() || file.isSymbolicLink()) {
    throw new ApiError(409, "AI_MATERIAL_UNAVAILABLE", "材料文件不可用，请重新上传");
  }
  const buffer = await readFile(input.filePath);
  const metadata = {
    id: input.id,
    originalName: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes
  };

  if (input.mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const extractedText = result.text.trim().slice(0, MAX_EXTRACTED_TEXT_CHARACTERS);
      if (!extractedText) {
        throw new ApiError(
          422,
          "AI_MATERIAL_TEXT_EMPTY",
          "PDF 未提取到可分析文字，请上传清晰扫描图或文字版 PDF"
        );
      }
      return { ...metadata, extractedText };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, "AI_MATERIAL_PARSE_FAILED", "PDF 解析失败，请重新导出后上传");
    } finally {
      await parser.destroy();
    }
  }

  if (["image/jpeg", "image/png", "image/webp"].includes(input.mimeType)) {
    if (buffer.byteLength > MAX_IMAGE_BYTES_FOR_MODEL) {
      throw new ApiError(
        413,
        "AI_IMAGE_TOO_LARGE",
        "图片超过 AI 分析上限，请压缩到 5MB 以内"
      );
    }
    return {
      ...metadata,
      imageDataUrl: `data:${input.mimeType};base64,${buffer.toString("base64")}`
    };
  }

  throw new ApiError(400, "AI_MATERIAL_TYPE_UNSUPPORTED", "该材料类型暂不支持 AI 分析");
};

export const loadOwnedProviderMaterials = async (
  userId: string,
  uploadIds: readonly string[]
): Promise<AiProviderRequest["uploads"]> => {
  if (!uploadIds.length) return [];
  const result = await query<MaterialRow>(
    `SELECT id, original_name, stored_name, mime_type, size_bytes::text AS size_bytes
       FROM uploads
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY id`,
    [userId, uploadIds]
  );
  if (result.rowCount !== new Set(uploadIds).size) {
    throw new ApiError(404, "AI_UPLOAD_NOT_FOUND", "材料不存在");
  }
  const uploadDir = getConfig().UPLOAD_DIR;
  return Promise.all(
    result.rows.map((row) =>
      extractProviderMaterial({
        id: row.id,
        originalName: row.original_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        filePath: resolveMaterialPath(uploadDir, row.stored_name)
      })
    )
  );
};
