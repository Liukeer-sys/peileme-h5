import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../security.js";
import { commerceApiError } from "../commerce/routes.js";
import {
  getOwnedAiJobDetail,
  listOwnedAiJobStreamEvents,
  listOwnedAiJobs
} from "./repository.js";
import { createAiAnalysisService } from "./service.js";

const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

const severanceJobSchema = z
  .object({
    kind: z.literal("severance_analysis"),
    idempotencyKey,
    input: z
      .object({
        situation: z.string().trim().min(10).max(12_000)
      })
      .passthrough(),
    uploadIds: z.array(z.string().uuid()).max(6).default([])
  })
  .strict();

const documentJobSchema = z
  .object({
    kind: z.literal("document_review"),
    idempotencyKey,
    input: z
      .object({
        objective: z.string().trim().min(8).max(2_000)
      })
      .passthrough(),
    uploadIds: z.array(z.string().uuid()).min(1).max(6)
  })
  .strict();

const createJobSchema = z
  .discriminatedUnion("kind", [severanceJobSchema, documentJobSchema])
  .superRefine((value, context) => {
    if (new Set(value.uploadIds).size !== value.uploadIds.length) {
      context.addIssue({
        code: "custom",
        path: ["uploadIds"],
        message: "材料不能重复"
      });
    }
  });

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

const streamCursorSchema = z.object({
  after: z.coerce.number().int().min(0).default(0)
});

const waitForStreamPoll = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 250));

export const createAiRouter = () => {
  const router = Router();
  const service = createAiAnalysisService();
  router.use(requireAuth);

  router.post("/jobs", async (request, response, next) => {
    try {
      const body = createJobSchema.parse(request.body);
      const result = await service.createJob({
        userId: request.authUser!.id,
        kind: body.kind,
        idempotencyKey: body.idempotencyKey,
        payload: body.input,
        uploadIds: body.uploadIds
      });
      response.status(result.created ? 202 : 200).json(result.job);
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.get("/jobs", async (request, response) => {
    const { page, pageSize } = listSchema.parse(request.query);
    const result = await listOwnedAiJobs(
      request.authUser!.id,
      pageSize,
      (page - 1) * pageSize
    );
    response.json({ ...result, page, pageSize });
  });

  router.get("/jobs/:id", async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    response.json(await getOwnedAiJobDetail(request.authUser!.id, id));
  });

  router.get("/jobs/:id/stream", async (request, response, next) => {
    try {
      const id = z.string().uuid().parse(request.params.id);
      let cursor = streamCursorSchema.parse(request.query).after;
      let snapshot = await listOwnedAiJobStreamEvents(
        request.authUser!.id,
        id,
        cursor
      );
      let closed = false;
      let heartbeatAt = Date.now();
      request.on("close", () => {
        closed = true;
      });
      response.status(200);
      response.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Encoding": "identity",
        "X-Accel-Buffering": "no"
      });
      response.flushHeaders();

      while (!closed) {
        const { job, events } = snapshot;
        for (const event of events) {
          cursor = Number(event.id);
          response.write(`id: ${event.id}\n`);
          response.write("event: chunk\n");
          response.write(`data: ${JSON.stringify({
            ordinal: event.ordinal,
            text: event.text
          })}\n\n`);
        }
        if (job.status === "COMPLETED" || job.status === "FAILED_FINAL") {
          response.write(`event: done\ndata: ${JSON.stringify(job)}\n\n`);
          response.end();
          return;
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          response.write(": heartbeat\n\n");
          heartbeatAt = Date.now();
        }
        await waitForStreamPoll();
        snapshot = await listOwnedAiJobStreamEvents(
          request.authUser!.id,
          id,
          cursor
        );
      }
    } catch (error) {
      if (!response.headersSent) next(commerceApiError(error));
      else response.end();
    }
  });

  return router;
};
