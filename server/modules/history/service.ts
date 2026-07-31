import { query } from "../../db.js";
import type { ProductChannel } from "../../product-host.js";

export type UserHistoryItem = {
  id: string;
  source: "policy" | "commerce" | "ai";
  kind: "policy_assessment" | "order" | "document_analysis" | "ai_analysis";
  status: string;
  title: string;
  occurredAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
};

export type UserHistorySourceResult = {
  items: UserHistoryItem[];
  total: number;
};

export type AiHistorySource = (input: {
  userId: string;
  limit: number;
}) => Promise<UserHistorySourceResult>;

type TimelineRow = {
  id: string;
  status: string;
  title: string;
  occurred_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
};

const listPolicyHistory = async (
  userId: string,
  channel: ProductChannel,
  limit: number
): Promise<UserHistorySourceResult> => {
  const [items, count] = await Promise.all([
    query<TimelineRow>(
      `SELECT id,
              status,
              CASE
                WHEN product_channel = 'ai' THEN 'AI 政策赔付测算'
                ELSE '政策赔付测算'
              END AS title,
              COALESCE(completed_at, updated_at, created_at) AS occurred_at,
              updated_at,
              jsonb_build_object(
                'productChannel', product_channel,
                'accuracyLevel', accuracy_level
              ) AS metadata
         FROM assessments
        WHERE user_id = $1
          AND product_channel = $2
        ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
        LIMIT $3`,
      [userId, channel, limit]
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM assessments
        WHERE user_id = $1
          AND product_channel = $2`,
      [userId, channel]
    )
  ]);
  return {
    total: Number(count.rows[0]?.count || 0),
    items: items.rows.map((row) => ({
      id: row.id,
      source: "policy",
      kind: "policy_assessment",
      status: row.status,
      title: row.title,
      occurredAt: row.occurred_at,
      updatedAt: row.updated_at,
      metadata: row.metadata
    }))
  };
};

const listCommerceHistory = async (
  userId: string,
  channel: ProductChannel,
  limit: number
): Promise<UserHistorySourceResult> => {
  const [items, count] = await Promise.all([
    query<TimelineRow>(
      `SELECT id,
              status,
              '订单 ' || order_no AS title,
              COALESCE(completed_at, paid_at, closed_at, updated_at, created_at) AS occurred_at,
              updated_at,
              jsonb_build_object(
                'orderNo', order_no,
                'amountFen', total_fen,
                'currency', currency,
                'productChannel', product_channel
              ) AS metadata
         FROM orders
        WHERE user_id = $1
          AND product_channel = $2
        ORDER BY COALESCE(completed_at, paid_at, closed_at, updated_at, created_at) DESC, id DESC
        LIMIT $3`,
      [userId, channel, limit]
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM orders
        WHERE user_id = $1
          AND product_channel = $2`,
      [userId, channel]
    )
  ]);
  return {
    total: Number(count.rows[0]?.count || 0),
    items: items.rows.map((row) => ({
      id: row.id,
      source: "commerce",
      kind: "order",
      status: row.status,
      title: row.title,
      occurredAt: row.occurred_at,
      updatedAt: row.updated_at,
      metadata: row.metadata
    }))
  };
};

const listUploadHistory = async (
  userId: string,
  limit: number
): Promise<UserHistorySourceResult> => {
  const [items, count] = await Promise.all([
    query<TimelineRow>(
      `SELECT id,
              status,
              original_name AS title,
              created_at AS occurred_at,
              created_at AS updated_at,
              jsonb_build_object(
                'assessmentId', assessment_id,
                'mimeType', mime_type,
                'sizeBytes', size_bytes
              ) AS metadata
         FROM uploads
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit]
    ),
    query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads WHERE user_id = $1",
      [userId]
    )
  ]);
  return {
    total: Number(count.rows[0]?.count || 0),
    items: items.rows.map((row) => ({
      id: row.id,
      source: "ai",
      kind: "document_analysis",
      status: row.status,
      title: row.title,
      occurredAt: row.occurred_at,
      updatedAt: row.updated_at,
      metadata: row.metadata
    }))
  };
};

const isValidDate = (value: Date) =>
  value instanceof Date && Number.isFinite(value.getTime());

const toTimestamp = (value: Date) => isValidDate(value) ? value.getTime() : 0;

const sanitizeAiHistorySource = (
  result: UserHistorySourceResult
): UserHistorySourceResult => ({
  total:
    Number.isSafeInteger(result.total) && result.total >= 0
      ? result.total
      : 0,
  items: result.items.flatMap((item) => {
    if (
      typeof item.id !== "string" ||
      item.id.length < 1 ||
      item.id.length > 200 ||
      typeof item.status !== "string" ||
      item.status.length < 1 ||
      item.status.length > 64 ||
      typeof item.title !== "string" ||
      item.title.length < 1 ||
      item.title.length > 200 ||
      !isValidDate(item.occurredAt) ||
      !isValidDate(item.updatedAt)
    ) {
      return [];
    }
    const reportReady = item.metadata?.reportReady;
    return [{
      id: item.id,
      source: "ai" as const,
      kind: "ai_analysis" as const,
      status: item.status,
      title: item.title,
      occurredAt: item.occurredAt,
      updatedAt: item.updatedAt,
      ...(typeof reportReady === "boolean"
        ? { metadata: { reportReady } }
        : {})
    }];
  })
});

export const listUserHistory = async (input: {
  userId: string;
  channel: ProductChannel;
  page: number;
  pageSize: number;
  aiHistorySource?: AiHistorySource;
  includePolicy?: boolean;
}) => {
  const limit = input.page * input.pageSize;
  const sources: Promise<UserHistorySourceResult>[] = [];
  if (input.includePolicy !== false) {
    sources.push(listPolicyHistory(input.userId, input.channel, limit));
  }
  sources.push(listCommerceHistory(input.userId, input.channel, limit));
  if (input.channel === "ai") {
    sources.push(listUploadHistory(input.userId, limit));
    if (input.aiHistorySource) {
      sources.push(
        input.aiHistorySource({ userId: input.userId, limit })
          .then(sanitizeAiHistorySource)
      );
    }
  }
  const results = await Promise.all(sources);
  const sorted = results
    .flatMap((result) => result.items)
    .sort(
      (left, right) =>
        toTimestamp(right.occurredAt) - toTimestamp(left.occurredAt) ||
        right.id.localeCompare(left.id)
    );
  const offset = (input.page - 1) * input.pageSize;
  return {
    items: sorted.slice(offset, offset + input.pageSize),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total: results.reduce((sum, result) => sum + result.total, 0)
    }
  };
};
