import { Prisma } from "@prisma/client";
import { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export type ApiErrorDetails = Record<string, unknown> | unknown[];

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: ApiErrorDetails;

  constructor(code: string, message: string, statusCode: number, details: ApiErrorDetails = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function apiError(
  code: string,
  message: string,
  statusCode: number,
  details: ApiErrorDetails = {}
) {
  return new ApiError(code, message, statusCode, details);
}

function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message
  }));
}

export function installErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found",
        details: { method: request.method, url: request.url },
        requestId: request.id
      }
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: zodDetails(error),
          requestId: request.id
        }
      });
    }

    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id
        }
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return reply.status(409).send({
          error: {
            code: "RESOURCE_CONFLICT",
            message: "A resource with these unique fields already exists",
            details: { target: error.meta?.target ?? [] },
            requestId: request.id
          }
        });
      }

      if (error.code === "P2025") {
        return reply.status(404).send({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Requested resource was not found",
            details: {},
            requestId: request.id
          }
        });
      }
    }

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message = error instanceof Error ? error.message : "Request failed";

    if (statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, "Unhandled request error");
    }

    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: statusCode >= 500 ? "Internal server error" : message,
        details: {},
        requestId: request.id
      }
    });
  });
}
