import { describe, it, expect } from "vitest";
import { pickPurchaseUrl, nameRowKey, normName, findByName, diceSimilarity, suggestByName } from "./shipments.routes.js";

describe("pickPurchaseUrl", () => {
  const items = [
    { name: "Áo thun nam", url: "https://a.example/1" },
    { name: "Quần jean", url: "https://a.example/2" },
    { name: "Không có link", url: null },
  ];

  it("pickPurchaseUrl_itemNameContainsMatchingItem_returnsThatItemsUrl", () => {
    expect(pickPurchaseUrl(items, "Áo thun nam size L")).toBe("https://a.example/1");
  });

  it("pickPurchaseUrl_noNameMatch_fallsBackToFirstItemWithUrl", () => {
    expect(pickPurchaseUrl(items, "Giày thể thao")).toBe("https://a.example/1");
  });

  it("pickPurchaseUrl_noItemsHaveUrl_returnsNull", () => {
    expect(pickPurchaseUrl([{ name: "x", url: null }], "x")).toBeNull();
  });

  it("pickPurchaseUrl_emptyItemName_fallsBackToFirstItemWithUrl", () => {
    expect(pickPurchaseUrl(items, "")).toBe("https://a.example/1");
  });
});

describe("nameRowKey", () => {
  it("nameRowKey_allFieldsPresent_buildsCompositeKey", () => {
    expect(nameRowKey("B1", "OD1", "Áo thun")).toBe("name:B1:OD1:Áo thun");
  });

  it("nameRowKey_nullBillAndOrderCode_usesEmptyStringPlaceholders", () => {
    expect(nameRowKey(null, null, "Áo thun")).toBe("name:::Áo thun");
  });
});

describe("normName", () => {
  it("normName_stripsAllWhitespaceAndLowercases", () => {
    expect(normName("  Áo Thun  Nam ")).toBe("áothunnam");
  });
});

describe("findByName", () => {
  const candidates = [{ name: "Áo thun nam" }, { name: "Quần jean" }];

  it("findByName_exactNameMatch_returnsCandidate", () => {
    expect(findByName(candidates, "Áo thun nam")).toBe(candidates[0]);
  });

  it("findByName_candidateNameContainsTarget_returnsCandidate", () => {
    expect(findByName(candidates, "thun")).toBe(candidates[0]);
  });

  it("findByName_targetContainsCandidateName_returnsCandidate", () => {
    expect(findByName(candidates, "Áo thun nam size L")).toBe(candidates[0]);
  });

  it("findByName_noMatch_returnsNull", () => {
    expect(findByName(candidates, "Giày thể thao")).toBeNull();
  });

  it("findByName_emptyItemName_returnsNull", () => {
    expect(findByName(candidates, "")).toBeNull();
  });
});

describe("diceSimilarity", () => {
  it("diceSimilarity_identicalStrings_returnsOne", () => {
    expect(diceSimilarity("night", "night")).toBe(1);
  });

  it("diceSimilarity_completelyDifferentBigrams_returnsZero", () => {
    expect(diceSimilarity("ab", "xy")).toBe(0);
  });

  it("diceSimilarity_singleCharacterStrings_returnsZero", () => {
    expect(diceSimilarity("a", "a")).toBe(0);
  });

  it("diceSimilarity_partiallyOverlappingStrings_returnsKnownCoefficient", () => {
    expect(diceSimilarity("night", "nacht")).toBe(0.25);
  });
});

describe("suggestByName", () => {
  const candidates = [{ name: "Áo thun nam basic" }, { name: "Quần short thể thao" }];

  it("suggestByName_targetShorterThan4Chars_returnsNull", () => {
    expect(suggestByName(candidates, "abc")).toBeNull();
  });

  it("suggestByName_similarityBelowThreshold_returnsNull", () => {
    expect(suggestByName(candidates, "Máy tính bảng")).toBeNull();
  });

  it("suggestByName_similarityAtOrAboveThreshold_returnsBestMatch", () => {
    const result = suggestByName(candidates, "Áo thun nam basic size M");
    expect(result?.item).toBe(candidates[0]);
  });

  it("suggestByName_multipleCandidatesAboveThreshold_returnsHighestSimilarity", () => {
    const near = [{ name: "Áo thun nam" }, { name: "Áo thun nam basic" }];
    const result = suggestByName(near, "Áo thun nam basic");
    expect(result?.item).toBe(near[1]);
  });
});
