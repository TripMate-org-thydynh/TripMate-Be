import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Runtime
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000'),
  // Số lớp reverse proxy đứng trước app (Render = 1). Xem main.ts.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).optional(),
  // Cửa hậu đăng nhập dev (mock-google-token). Chỉ 'true' ở máy local.
  ALLOW_DEV_AUTH_BYPASS: Joi.string().valid('true', 'false').default('false'),

  // Database
  DATABASE_URL: Joi.string().uri().required(),
  DIRECT_URL: Joi.string().uri().required(),

  // Auth
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  GOOGLE_CLIENT_ID: Joi.string().required(),
  SUPABASE_URL: Joi.string().uri().optional().allow(''),
  SUPABASE_ANON_KEY: Joi.string().optional().allow(''),

  // Cache
  REDIS_URL: Joi.string().required(),

  // SMS — tuỳ chọn: thiếu thì OTP qua SMS bị tắt (xem TwilioService).
  TWILIO_ACCOUNT_SID: Joi.string().optional().allow(''),
  TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
  TWILIO_PHONE_NUMBER: Joi.string().optional().allow(''),

  // AI
  GEMINI_API_KEY: Joi.string().required(),
});
