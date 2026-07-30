import { withTransaction } from "../../db.js";

const severanceDefinition = {
  schemaVersion: 1,
  terminationModes: {
    mutual_agreement: "N",
    employer_notice: "N_PLUS_ONE",
    unlawful_termination: "TWO_N",
    employee_resignation: "ZERO",
    unclear: "REVIEW"
  },
  serviceFraction: {
    lessThanSixMonths: 0.5,
    atLeastSixMonths: 1
  },
  highSalaryCapMultiplier: 3,
  highSalaryServiceYearCap: 12
};

const severanceSourceSnapshot = [
  {
    name: "中华人民共和国劳动合同法",
    article: "第四十七条",
    authority: "中华人民共和国人力资源和社会保障部",
    url: "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
    publishedDate: "2012-12-28",
    effectiveDate: "2013-07-01"
  }
];

export const seedPolicyFoundation = async () => {
  await withTransaction(async (client) => {
    const ruleSetResult = await client.query<{ id: string }>(
      `INSERT INTO policy_rule_sets(code, name, product_channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           product_channel = EXCLUDED.product_channel,
           updated_at = now()
       RETURNING id`,
      ["cn-severance", "中国大陆离职经济补偿规则", "main"]
    );
    const ruleSetId = ruleSetResult.rows[0].id;

    const versionResult = await client.query<{ id: string }>(
      `INSERT INTO policy_rule_versions(
         rule_set_id,
         version,
         status,
         definition,
         source_snapshot,
         effective_from,
         published_at
       )
       VALUES ($1, 1, 'published', $2::jsonb, $3::jsonb, $4::date, now())
       ON CONFLICT (rule_set_id, version) DO UPDATE
       SET status = EXCLUDED.status,
           definition = EXCLUDED.definition,
           source_snapshot = EXCLUDED.source_snapshot,
           effective_from = EXCLUDED.effective_from,
           effective_to = NULL
       RETURNING id`,
      [
        ruleSetId,
        JSON.stringify(severanceDefinition),
        JSON.stringify(severanceSourceSnapshot),
        "2013-07-01"
      ]
    );

    await client.query(
      `UPDATE policy_rule_sets
       SET active_version_id = $2,
           updated_at = now()
       WHERE id = $1`,
      [ruleSetId, versionResult.rows[0].id]
    );

    await client.query(
      `INSERT INTO role_capabilities(role, capability)
       VALUES
         ('admin', 'policy.read'),
         ('admin', 'policy.write'),
         ('admin', 'policy.publish'),
         ('analyst', 'policy.read')
       ON CONFLICT (role, capability) DO NOTHING`
    );
  });
};
