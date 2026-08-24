import { describe, expect, it } from "vitest";
import {
  FetchAvailableModelsResponseSchema,
} from "./models";
import { RetrieveUserQuotaResponseSchema } from "./quota";
import {
  RetrieveUserQuotaSummaryResponseSchema,
  inferWindowFromBucketId,
  groupDisplayNameToKey,
} from "./weekly-limits";

const validBucket = {
  bucketId: "gemini-weekly",
  window: "weekly",
  resetTime: "2026-08-30T05:47:08Z",
  remainingFraction: 1,
};

describe("FetchAvailableModelsResponseSchema", () => {
  it("rejects an empty payload so schema drift is not mistaken for no models", () => {
    expect(FetchAvailableModelsResponseSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a response with a models map", () => {
    const result = FetchAvailableModelsResponseSchema.safeParse({
      models: { "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" } },
    });
    expect(result.success).toBe(true);
  });
});

describe("RetrieveUserQuotaResponseSchema", () => {
  it("rejects an empty payload so schema drift is not mistaken for no quota", () => {
    expect(RetrieveUserQuotaResponseSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a response with buckets", () => {
    const result = RetrieveUserQuotaResponseSchema.safeParse({
      buckets: [{ modelId: "chat_20706", remainingFraction: 1 }],
    });
    expect(result.success).toBe(true);
  });
});

describe("RetrieveUserQuotaSummaryResponseSchema", () => {
  it("accepts the observed groups[] shape", () => {
    const result = RetrieveUserQuotaSummaryResponseSchema.safeParse({
      groups: [{ displayName: "Gemini Models", buckets: [validBucket] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts the documented top-level buckets[] fallback shape", () => {
    const result = RetrieveUserQuotaSummaryResponseSchema.safeParse({
      buckets: [validBucket],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with neither groups[] nor buckets[]", () => {
    expect(RetrieveUserQuotaSummaryResponseSchema.safeParse({}).success).toBe(false);
    expect(
      RetrieveUserQuotaSummaryResponseSchema.safeParse({ description: "only text" }).success,
    ).toBe(false);
  });

  it("keeps unknown bucket ids (fail-open) rather than rejecting them", () => {
    const result = RetrieveUserQuotaSummaryResponseSchema.parse({
      buckets: [{ ...validBucket, bucketId: "brand-new-window" }],
    });
    expect(result.buckets?.[0]?.bucketId).toBe("brand-new-window");
  });
});

describe("inferWindowFromBucketId", () => {
  it("infers weekly and 5h windows", () => {
    expect(inferWindowFromBucketId("gemini-weekly")).toBe("weekly");
    expect(inferWindowFromBucketId("3p-5h")).toBe("5h");
    expect(inferWindowFromBucketId("gemini-5-hour")).toBe("5h");
  });

  it("returns undefined for unrecognized ids (fail-open)", () => {
    expect(inferWindowFromBucketId("brand-new-window")).toBeUndefined();
  });
});

describe("groupDisplayNameToKey", () => {
  it("maps observed display names to logical keys", () => {
    expect(groupDisplayNameToKey("Gemini Models")).toBe("gemini");
    expect(groupDisplayNameToKey("Claude and GPT models")).toBe("3p");
  });

  it("returns undefined for missing/unknown names", () => {
    expect(groupDisplayNameToKey(undefined)).toBeUndefined();
    expect(groupDisplayNameToKey("Something Else")).toBeUndefined();
  });
});
