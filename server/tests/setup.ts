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
process.env.UPLOAD_DIR = "/tmp/peileme-test-uploads";
