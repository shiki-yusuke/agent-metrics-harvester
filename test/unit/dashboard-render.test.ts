import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeDashboardData } from "../../src/dashboard/compute.js";
import { renderDashboardHtml } from "../../src/dashboard/render.js";
import type { DashboardData } from "../../src/dashboard/types.js";
import { FORBIDDEN_PERSONAL_DIMENSION_KEYS } from "../../src/protocol/personal-dimension.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const NOW = new Date("2026-08-15T00:00:00Z");

function emptyData(): DashboardData {
  return computeDashboardData({
    snapshots: [],
    attributionAuditSummaries: [],
    calibrationPoints: [],
    heartbeats: [],
    now: NOW,
  });
}

function populatedData(): DashboardData {
  return computeDashboardData({
    snapshots: [
      {
        upsertKey: "k1",
        repository: "octo/example",
        payload: makeTokenUsagePayload({ generatedAt: "2026-08-01T00:00:00Z" }),
        sourceCommentId: 1,
        sourceUpdatedAt: "2026-08-01T00:00:00Z",
        markerSha: "sha",
      },
    ],
    attributionAuditSummaries: [
      {
        kind: "attribution_audit_summary",
        generated_at: "2026-08-05T00:00:00Z",
        window: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" },
        sessions: { exactly_attributed: 8, unbound: 1, mixed: 1, orphan: 0 },
        tokens: { exact_attributed: 900, total_measured: 1000 },
        research_eligible: true,
        source_repo: "octo/example",
      },
    ],
    calibrationPoints: [
      {
        kind: "calibration_point",
        generated_at: "2026-08-05T00:00:00Z",
        intent_digest: "0123456789abcdef",
        predicted_p50: 1000,
        predicted_p80: 1500,
        actual_tokens: 1100,
        actual_cost_usd: 0.5,
        decision_status: "predicted",
        abstain_reasons: [],
        cohort_digest: "cohort-a",
      },
      {
        kind: "calibration_point",
        generated_at: "2026-08-06T00:00:00Z",
        intent_digest: "abcdef0123456789",
        predicted_p50: null,
        predicted_p80: null,
        actual_tokens: 200,
        actual_cost_usd: 0.05,
        decision_status: "abstained",
        abstain_reasons: ["low_confidence"],
        cohort_digest: "cohort-b",
      },
    ],
    heartbeats: [{ kind: "heartbeat", source: "workflow", at: "2026-08-14T00:00:00Z" }],
    now: NOW,
  });
}

describe("renderDashboardHtml", () => {
  it("is deterministic: the same data renders byte-identical HTML across calls", () => {
    const data = populatedData();
    const first = renderDashboardHtml(data);
    const second = renderDashboardHtml(data);
    assert.equal(first, second);

    const dataAgain = populatedData();
    const third = renderDashboardHtml(dataAgain);
    assert.equal(
      first,
      third,
      "two independently-computed-but-equal DashboardData must render identically",
    );
  });

  it("renders without throwing on fully empty data, showing an empty-data notice per panel", () => {
    const html = renderDashboardHtml(emptyData());
    assert.match(html, /<!doctype html>/);
    const noticeCount = html.split("データなし").length - 1;
    assert.ok(noticeCount >= 4, `expected at least 4 empty-data notices, found ${noticeCount}`);
  });

  it("never emits a forbidden personal-dimension key as a literal token, on empty or populated data", () => {
    for (const html of [renderDashboardHtml(emptyData()), renderDashboardHtml(populatedData())]) {
      for (const key of FORBIDDEN_PERSONAL_DIMENSION_KEYS) {
        assert.ok(
          !html.includes(`"${key}"`) && !html.includes(`data-${key}`) && !html.includes(`>${key}<`),
          `HTML output must never surface the forbidden personal-dimension key "${key}"`,
        );
      }
    }
  });

  it("shows the cost panel's caveat that unpriced cost is never rendered as $0", () => {
    const html = renderDashboardHtml(populatedData());
    assert.match(html, /「\$0」に潰していない/);
  });

  it("shows the fixed cohort caveat verbatim, sentence-substring intact", () => {
    const html = renderDashboardHtml(populatedData());
    assert.match(html, /因果比較は不可/);
  });

  it("embeds the freshness timestamps as data attributes for client-side comparison", () => {
    const html = renderDashboardHtml(populatedData());
    assert.match(html, /data-pipeline-heartbeat-at="2026-08-14T00:00:00Z"/);
    assert.match(html, /data-last-valid-event-at="2026-08-06T00:00:00Z"/);
  });

  it("shows the incomplete badge + lower bound, never a bare figure, for a group with a priced-missing-cost record (must-2 regression)", () => {
    const data = computeDashboardData({
      snapshots: [
        {
          upsertKey: "k-incomplete",
          repository: "octo/example",
          payload: makeTokenUsagePayload({ generatedAt: "2026-08-01T00:00:00Z" }),
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-08-01T00:00:00Z",
          markerSha: "sha",
        },
      ],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    // Force the fixture group into the incomplete state directly on the domain object -- the
    // compute-level path to this state is already covered by dashboard-compute.test.ts; this
    // test is only about what render.ts does with it.
    const incomplete: DashboardData = {
      ...data,
      cost: {
        meta: data.cost.meta,
        groups: [
          {
            repo: "octo/example",
            month: "2026-08",
            recordCount: 2,
            pricedCount: 2,
            unpricedCount: 0,
            unknownCount: 0,
            pricedMissingCostCount: 1,
            totalCostUsd: null,
            knownCostLowerBoundUsd: 2,
          },
        ],
      },
    };
    const html = renderDashboardHtml(incomplete);
    assert.match(html, /badge-incomplete/);
    assert.match(html, /不完全/);
    assert.match(html, /\$2\.0000/);
    assert.doesNotMatch(html, /\$0\.0000/, "must never show $0 for an incomplete group's total");
  });
});

describe("renderDashboardHtml: empty-panel reason classification", () => {
  function costSection(html: string): string | undefined {
    return html.match(/<section id="panel-cost">[\s\S]*?<\/section>/)?.[0];
  }
  function freshnessSection(html: string): string | undefined {
    return html.match(/<section id="panel-freshness">[\s\S]*?<\/section>/)?.[0];
  }

  it("with no config supplied, every empty panel still shows the original plain notice", () => {
    const html = renderDashboardHtml(emptyData());
    // At least the calibration/attribution/cohort empty tables (Cost's empty notice is
    // untouched by this feature and asserted separately below).
    assert.ok(
      html.split('<p class="empty-notice">データなし</p>').length - 1 >= 3,
      "expected the legacy bare notice, unchanged, when no reason config is passed",
    );
    assert.doesNotMatch(html, /empty-notice-(not_produced|withheld|insufficient_data)/);
  });

  it("not_produced: reads as a process that has never run, plus the operator's own note", () => {
    const html = renderDashboardHtml(emptyData(), {
      calibration: { code: "not_produced", note: "estimate --adopt が一度も実行されていません" },
    });
    assert.match(html, /class="empty-notice empty-notice-not_produced"/);
    assert.ok(html.includes("この種類のデータを生成する工程がまだ一度も実行されていません"));
    assert.ok(html.includes("estimate --adopt が一度も実行されていません"));
  });

  it('withheld: reads as "measured but not published", never as "not measured"', () => {
    const html = renderDashboardHtml(emptyData(), {
      attribution: { code: "withheld", note: "global 集計に private repo の作業が含まれるため" },
    });
    assert.match(html, /class="empty-notice empty-notice-withheld"/);
    assert.ok(html.includes("測定はしていますが、公開範囲の判断により意図的に非公開にしています"));
    assert.ok(!html.includes("測定していません"), "must never read as 'not measured'");
    assert.ok(html.includes("global 集計に private repo の作業が含まれるため"));
  });

  it("insufficient_data: reuses the existing below-sample-floor framing", () => {
    const html = renderDashboardHtml(emptyData(), {
      cohort: { code: "insufficient_data" },
    });
    assert.match(html, /class="empty-notice empty-notice-insufficient_data"/);
    assert.ok(html.includes("件数が判定に必要な閾値に達していません"));
  });

  it("escapes the operator note (never emits it as raw HTML)", () => {
    const html = renderDashboardHtml(emptyData(), {
      calibration: { code: "withheld", note: "<script>evil()</script>" },
    });
    assert.ok(!html.includes("<script>evil()</script>"));
    assert.ok(html.includes("&lt;script&gt;evil()&lt;/script&gt;"));
  });

  it("never surfaces a private-side number, repo name, or session id even when configured", () => {
    // The classification itself must only ever explain the boundary decision -- this asserts
    // the mechanism doesn't, by itself, inject anything beyond code+note verbatim; keeping real
    // private figures out of `note` remains the operator's own responsibility (see types.ts).
    const html = renderDashboardHtml(emptyData(), {
      attribution: { code: "withheld", note: "非公開の理由のみを記載" },
    });
    assert.ok(!html.includes("526M"));
    assert.ok(!html.includes("session"));
  });

  it("leaves the Cost and Freshness panels byte-identical whether or not a reason config is passed", () => {
    const withoutConfig = renderDashboardHtml(emptyData());
    const withConfig = renderDashboardHtml(emptyData(), {
      calibration: { code: "not_produced" },
      attribution: { code: "withheld" },
      cohort: { code: "insufficient_data" },
    });
    assert.equal(costSection(withConfig), costSection(withoutConfig));
    assert.equal(freshnessSection(withConfig), freshnessSection(withoutConfig));
  });
});
