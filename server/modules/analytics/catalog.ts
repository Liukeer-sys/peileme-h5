import { z } from "zod";
import { query } from "../../db.js";

const shortText = z.string().trim().max(300);
const identifier = z.string().trim().max(120);

export const clientEventSchemas = {
  page_view: z.object({ title: shortText.optional() }),
  assessment_started: z.object({ source: shortText.optional() }),
  assessment_completed: z.object({}),
  answer_submitted: z.object({ questionId: identifier }),
  questionnaire_completed: z.object({}),
  assessment_restarted: z.object({}),
  policy_calculation_completed: z.object({
    assessmentId: z.string().uuid(),
    accuracyLevel: z.enum(["verified", "estimated", "stale", "unsupported"])
  }),
  policy_history_recalculated: z.object({
    sourceAssessmentId: z.string().uuid(),
    assessmentId: z.string().uuid()
  }),
  policy_share_viewed: z.object({ shareId: z.string().uuid() }),
  auth_logged_in: z.object({ method: z.enum(["code", "password"]) }),
  auth_registered: z.object({
    channel: z.enum(["email", "sms"]),
    invite: z.boolean()
  }),
  auth_logged_out: z.object({}),
  auth_session_revoked: z.object({ current: z.boolean() }),
  auth_other_sessions_revoked: z.object({ count: z.number().int().nonnegative() }),
  password_reset: z.object({}),
  otp_requested: z.object({
    purpose: z.enum(["login", "register", "reset"]),
    channel: z.enum(["email", "sms"])
  }),
  invite_redeemed: z.object({
    modules: z.array(z.enum(["caseLawPack", "evidencePack"])).max(2)
  }),
  paid_module_unlock_clicked: z.object({
    module: z.enum(["caseLawPack", "evidencePack"]),
    loggedIn: z.boolean()
  }),
  ai_document_uploaded: z.object({
    sku: identifier,
    fileCount: z.number().int().min(1).max(6)
  }),
  ai_document_downloaded: z.object({ uploadId: z.string().uuid().optional() }),
  document_uploaded: z.object({}),
  admin_opened: z.object({})
} as const;

export type ClientEventName = keyof typeof clientEventSchemas;

export const parseClientEvent = (input: {
  name: string;
  properties?: unknown;
}) => {
  const schema = clientEventSchemas[input.name as ClientEventName];
  if (!schema) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["name"],
        message: "事件名称未注册"
      }
    ]);
  }
  const properties = schema.parse(input.properties ?? {});
  const receivedKeys =
    input.properties && typeof input.properties === "object" && !Array.isArray(input.properties)
      ? Object.keys(input.properties)
      : [];
  const acceptedKeys = Object.keys(properties);
  if (receivedKeys.some((key) => !acceptedKeys.includes(key))) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["properties"],
        message: "事件属性未注册"
      }
    ]);
  }
  return {
    name: input.name as ClientEventName,
    properties
  };
};

const serverEventSchemas = {
  user_registered: z.object({ channel: z.enum(["email", "sms"]) }),
  policy_calculation_fulfilled: z.object({
    assessmentId: z.string().uuid(),
    accuracyLevel: z.enum(["verified", "estimated", "stale", "unsupported"])
  }),
  payment_succeeded: z.object({
    orderId: z.string().uuid(),
    amountFen: z.number().int().nonnegative(),
    channel: z.enum(["wechat_h5", "alipay_wap"])
  }),
  refund_succeeded: z.object({
    refundId: z.string().uuid(),
    amountFen: z.number().int().nonnegative()
  })
} as const;

export type ServerEventName = keyof typeof serverEventSchemas;

type ServerEventInput = {
  name: ServerEventName;
  userId?: string | null;
  productChannel: "main" | "ai";
  properties: unknown;
  occurredAt?: Date;
};

export const writeServerEvent = async (input: ServerEventInput) => {
  const properties = serverEventSchemas[input.name].parse(input.properties);
  await query(
    `INSERT INTO analytics_events(
       event_name, visitor_id, session_id, user_id, path, properties,
       source, schema_version, occurred_at
     )
     VALUES ($1, 'server', 'server', $2, NULL, $3::jsonb, 'server', 1, $4)`,
    [
      input.name,
      input.userId ?? null,
      JSON.stringify({ ...properties, productChannel: input.productChannel }),
      input.occurredAt ?? new Date()
    ]
  );
};
