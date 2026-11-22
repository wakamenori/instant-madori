import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openL1Writer } from "../l1/store.ts";
import { registry, type RecordInput } from "../l1/sources.ts";
import { readViewerData, qualityRates } from "./data.ts";
import { renderDashboard } from "./render.ts";
import { date, fmt } from "./chart.ts";

void test("each rendered operating-hour point and latest breakdown match the rolling marts for all six selections", (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-rolling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = openL1Writer(join(root, "metrics.sqlite"), registry);
  const at = (hour: number) => new Date(Date.UTC(2026, 10, 23) + hour * 3600000).toISOString();
  function add(source: RecordInput["source"], key: string, payload: RecordInput["payload"]) {
    writer.ingest(
      [
        {
          source,
          naturalKey: key,
          sourceVersion: "1",
          occurredAt: at(0),
          scope: { kind: "repo" },
          payload,
        },
      ],
      at(32),
    );
  }
  try {
    for (const [issue, begin, finish, feature] of [
      [1, 0, 10, true],
      [2, 12, 27, false],
      [3, 27, 31, true],
      [4, 30, 31, false],
    ] as const) {
      const pr = 100 + issue;
      add("github.issue", String(issue), {
        number: issue,
        title: "Fixture " + issue,
        created_at: at(begin),
      });
      add("t3.thread", "owner-" + issue, { issue, title_kind: "owner", created_at: at(begin) });
      add("t3.run", "run-" + issue, {
        thread_id: "owner-" + issue,
        started_at: at(begin),
        completed_at: at(finish + 0.1),
      });
      if (feature || issue === 2)
        add("github.issue.timeline", String(issue * 2), {
          issue,
          event: "labeled",
          created_at: at(begin),
          label: feature
            ? "機能：利用者に見える振る舞いを足す・変える"
            : "開発の仕組みの改善：作る・確かめる・届ける・動かす仕組みを良くする",
        });
      add("github.pr", String(pr), {
        number: pr,
        closes: [issue],
        created_at: at(begin),
        merged_at: at(finish),
      });
      add("github.actions.job", String(pr), {
        workflow: "check",
        run_id: pr,
        run_attempt: 1,
        pr_numbers: [pr],
        created_at: at(begin),
        started_at: at((begin + finish) / 2),
        completed_at: at(finish),
        steps: [],
      });
      add("github.issue.timeline", String(issue * 2 + 1), {
        issue,
        event: "closed",
        created_at: at(finish),
        prs: [pr],
      });
    }
  } finally {
    writer.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "../build/build.ts")], {
    env: { ...process.env, INSTANT_MADORI_METRICS_HOME: root },
  });
  const out = new DatabaseSync(join(root, "metrics-derived.sqlite"), { readOnly: true });
  t.after(() => out.close());
  const data = readViewerData(out);
  const firstCombo = data.combos[0];
  const firstPoint = firstCombo?.points[0];
  assert.ok(firstCombo && firstPoint && firstPoint.kpi.completions === 0);
  const early = renderDashboard({
    ...data,
    combos: [{ ...firstCombo, points: [firstPoint], issues: [], kinds: [] }],
  });
  assert.ok(early.includes("完了なし · %"));
  const shares = Array.from(early.matchAll(/data-cell="[^"]+" data-value="([^"]+)"/gu), (m) =>
    Number(m[1]),
  );
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 100) < 1e-10);
  const panels = renderDashboard(data).split('<section class="combo"').slice(1);
  assert.equal(panels.length, 6);
  for (const span of [4, 8, 24])
    for (const target of ["機能", "全種類"]) {
      const combo = data.combos.find((c) => c.span === span && c.target === target);
      assert.ok(combo);
      const panel = panels.find((html) =>
        html.startsWith(` data-span="${span}" data-target="${target}"`),
      );
      assert.ok(panel);
      const rows = out
        .prepare(
          `SELECT k.* FROM mart_kpi k WHERE window='rolling' AND span=? AND target=?
    AND EXISTS(SELECT 1 FROM mart_active_minute m WHERE m.minute>=k.hour AND m.minute<k.end AND m.minute>=(SELECT since FROM kpi_policy)) ORDER BY hour`,
        )
        .all(span, target);
      assert.equal(combo.points.length, rows.length);
      const latest = rows.at(-1);
      assert.ok(latest && Number(latest.completions) > 0);
      const tiles = panel
        .split('<article class="tile"')
        .slice(1)
        .map((s) => s.split("</article>")[0] ?? "");
      assert.equal(tiles.length, target === "機能" ? 4 : 3);
      for (const key of ["throughput", "parallelism", "target_share", "hours_per_completion"]) {
        const tile = tiles.find((s) => s.startsWith(` data-kpi="${key}"`));
        if (key === "target_share" && target === "全種類") {
          assert.equal(tile, undefined);
          continue;
        }
        assert.ok(tile);
        const bounded = ["hours_per_completion", "throughput"].includes(key);
        const scale = key === "target_share" ? 100 : 1;
        const unit = {
          throughput: "件/h",
          parallelism: "件",
          target_share: "%",
          hours_per_completion: "h/件",
        }[key];
        const read = (v: unknown) => fmt(v === null ? null : Number(v), scale);
        assert.ok(
          tile.includes(
            `data-value="${String(latest[key] ?? "")}" data-low="${String(bounded ? (latest[key + "_low"] ?? "") : "")}" data-high="${String(bounded ? (latest[key + "_high"] ?? "") : "")}" data-n="${Number(latest.completions)}"`,
          ),
        );
        assert.ok(tile.includes(`<strong>${read(latest[key])}</strong> ${unit}`));
        for (const r of rows) {
          const values = [r[key], ...(bounded ? [r[key + "_low"], r[key + "_high"]] : [])];
          const context = `${date(Number(r.start))} JST 開始 · 稼働 ${Number(r.active_minutes)} 分 · 工数 ${Number(r.issue_minutes)} 分 · 完了 ${Number(r.completions)} 件 · 境目の未完了 ${Number(r.open_start)} → ${Number(r.open_end)} 件`;
          assert.ok(
            tile.includes(
              `<tr><td>${date(Number(r.end))}</td>${values.map((v) => `<td>${read(v)} ${unit}</td>`).join("")}<td>${context}</td></tr>`,
            ),
          );
        }
      }
      const latestPoint = combo.points.at(-1);
      assert.ok(
        latestPoint && latestPoint.effort.tiers.work > 0 && latestPoint.effort.tiers.wait > 0,
      );
      assert.equal(latestPoint.effort.work.ci_deploy, latestPoint.effort.tiers.work);
      assert.equal(latestPoint.effort.waits["resource.ci_queue"], latestPoint.effort.tiers.wait);
      const phaseCells = Array.from(
        panel.matchAll(/data-cell="[^"]+" data-value="([^"]+)"/gu),
        (m) => Number(m[1]),
      );
      assert.ok(phaseCells.length >= 15);
      assert.ok(
        Math.abs(phaseCells.reduce((a, b) => a + b, 0) - Number(latest.hours_per_completion)) <
          1e-10,
      );
      assert.equal(
        combo.kinds.reduce((sum, k) => sum + k.minutes, 0),
        latest.issue_minutes,
      );
      for (const [index, p] of combo.points.entries()) {
        const expected = rows[index];
        assert.ok(expected);
        assert.equal(p.start, expected.start);
        assert.equal(p.end, expected.end);
        for (const [key, v] of Object.entries(p.kpi)) assert.equal(v, expected[key], key);
        const total = out
          .prepare(
            "SELECT sum(minutes) total FROM mart_kind_period WHERE window='rolling' AND span=? AND hour=?",
          )
          .get(span, p.hour);
        assert.equal(total?.total, p.kpi.issue_minutes);
        for (const area of ["product", "development"]) {
          const expected = out
            .prepare(
              "SELECT count(*) n FROM mart_quality_issue JOIN issue_classification c USING(issue) WHERE mart_quality_issue.area=? AND unixepoch(c.closed_at)>=? AND unixepoch(c.closed_at)<?",
            )
            .get(area, p.start, p.end);
          const quality = qualityRates(
            data.quality.filter((q) => q.closed >= p.start && q.closed < p.end),
            area,
          );
          assert.equal(quality.total, expected?.n);
          if (p.hour === latest.hour)
            assert.ok(
              panel.includes(
                `${area === "product" ? "製品" : "開発の仕組み"} · 観察完了 ${quality.observed}/${quality.total}</h3>`,
              ),
            );
        }
      }
    }
});
