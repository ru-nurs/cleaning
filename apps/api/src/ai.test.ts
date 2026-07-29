import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeQualityVision,
  analyzeReview,
  assessOrderRisk,
  forecastDemand,
  getAiStatus
} from "./ai.js";

test("AI modules expose safe deterministic fallback without an API key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(getAiStatus().enabled, false);

    const quality = await analyzeQualityVision({
      orderId: "order-test",
      serviceTitle: "Standard cleaning",
      checklist: ["Kitchen", "Bathroom"],
      mediaType: "image/png",
      images: ["data:image/png;base64,AAAA"]
    });
    assert.equal(quality.mode, "FALLBACK");
    assert.equal(quality.data.checklistAssessment.length, 2);
    assert.equal(quality.data.checklistAssessment[0]?.status, "UNCLEAR");

    const risk = await assessOrderRisk({
      orderId: "order-test",
      status: "IN_PROGRESS",
      urgent: true,
      complexityScore: 88,
      priceTotal: 8000,
      hasExecutor: false,
      previousDisputes: 1,
      vision: quality.data
    });
    assert.equal(risk.mode, "FALLBACK");
    assert.ok(risk.data.score >= 60);

    const forecast = await forecastDemand({
      horizonDays: 3,
      dailyOrders: [
        { date: "2026-07-28", orders: 2 },
        { date: "2026-07-29", orders: 4 }
      ],
      activeExecutors: 2,
      currentActiveOrders: 3
    });
    assert.equal(forecast.data.days.length, 3);

    const nlp = await analyzeReview({
      reviewId: "review-test",
      orderId: "order-test",
      rating: 1,
      comment: "Очень плохо, осталась грязь",
      serviceTitle: "Standard cleaning"
    });
    assert.equal(nlp.data.sentiment, "NEGATIVE");
    assert.equal(nlp.data.urgency, "HIGH");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test("configured AI uses Responses API structured output contract", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  let requestBody: any;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-5.6-sol";
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  sentiment: "POSITIVE",
                  sentimentScore: 0.8,
                  urgency: "LOW",
                  summary: "Клиент доволен.",
                  topics: ["чистота"],
                  qualitySignals: ["Положительная оценка чистоты"],
                  recommendedAction: "Поблагодарить клиента."
                })
              }
            ]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const result = await analyzeReview({
      reviewId: "review-openai",
      orderId: "order-openai",
      rating: 5,
      comment: "Чисто и аккуратно",
      serviceTitle: "Standard cleaning"
    });
    assert.equal(result.mode, "OPENAI");
    assert.equal(result.data.sentiment, "POSITIVE");
    assert.equal(requestBody?.model, "gpt-5.6-sol");
    assert.equal(requestBody?.store, false);
    assert.equal(requestBody?.text?.format?.type, "json_schema");
    assert.equal(requestBody?.text?.format?.strict, true);
    assert.equal(typeof requestBody?.safety_identifier, "string");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  }
});
