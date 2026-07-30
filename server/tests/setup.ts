import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const ownedUploadDirs = new Set<string>();

export const createTestUploadDir = () => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), "peileme-test-uploads-"));
  ownedUploadDirs.add(path.resolve(uploadDir));
  return uploadDir;
};

export const cleanupTestUploadDir = (uploadDir: string) => {
  const resolvedUploadDir = path.resolve(uploadDir);
  if (!ownedUploadDirs.delete(resolvedUploadDir)) return false;
  rmSync(resolvedUploadDir, { recursive: true, force: true });
  return true;
};

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://peileme_test:peileme_test@127.0.0.1:55432/peileme_test";
process.env.APP_ORIGIN = "http://localhost:5173,http://ai.localhost:5174";
process.env.COOKIE_DOMAIN = "";
process.env.CSRF_SECRET = "test-csrf-secret-that-is-longer-than-thirty-two-characters";
process.env.JWT_SECRET = "test-jwt-secret-that-is-longer-than-thirty-two-characters";
process.env.OTP_SECRET = "test-otp-secret-that-is-longer-than-thirty-two-characters";
process.env.OTP_DEBUG = "true";
process.env.REGISTRATION_REQUIRE_INVITE = "false";
const testUploadDir = createTestUploadDir();
process.env.UPLOAD_DIR = testUploadDir;

afterAll(() => {
  cleanupTestUploadDir(testUploadDir);
});
