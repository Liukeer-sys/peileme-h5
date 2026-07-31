import { withTransaction } from "../../db.js";
import { DEFAULT_POLICY_REGRESSION_EXPECTATIONS } from "./regression.js";

const severanceDefinition = {
  schemaVersion: 2,
  decisionModel: {
    mutualAgreement: {
      employerProposed: {
        compensation: "N"
      },
      employeeProposed: {
        compensation: "ZERO",
        agreementReviewRequired: true
      }
    },
    article40EmployerTermination: {
      notice30Days: {
        compensation: "N",
        noticePayMonths: 0
      },
      paymentInLieu: {
        compensation: "N",
        noticePayMonths: 1
      }
    },
    employeeTermination: {
      article38: {
        compensation: "N"
      },
      voluntaryResignation: {
        compensation: "ZERO"
      }
    },
    unlawfulTermination: {
      primaryRemedy: "CONTINUE_PERFORMANCE",
      fallbackCompensation: "TWO_N",
      fallbackWhen: [
        "EMPLOYEE_DOES_NOT_REQUEST_CONTINUATION",
        "CONTINUED_PERFORMANCE_IMPOSSIBLE"
      ]
    },
    unclear: {
      result: "REVIEW"
    }
  },
  serviceYearFraction: {
    lessThanSixMonths: 0.5,
    atLeastSixMonths: 1
  },
  highSalaryCap: {
    localAverageMultiplier: 3,
    serviceYearCap: 12
  },
  regressionExpectations: DEFAULT_POLICY_REGRESSION_EXPECTATIONS
};

const laborContractLawUrl =
  "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html";

const severanceSourceSnapshot = [
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第三十六条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "mutual_agreement"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第三十七条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "voluntary_resignation"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第三十八条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "employee_statutory_termination"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第四十条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "employer_notice_or_payment_in_lieu"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第四十六条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "statutory_compensation_eligibility"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第四十七条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "compensation_years_and_salary_cap"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第四十八条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "unlawful_termination_remedy_priority"
  },
  {
    instrument: "中华人民共和国劳动合同法",
    article: "第八十七条",
    canonicalUrl: laborContractLawUrl,
    appliesTo: "unlawful_termination_two_n"
  },
  {
    instrument: "中华人民共和国劳动合同法实施条例",
    article: "第二十七条",
    canonicalUrl:
      "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fg/202011/t20201103_394939_wap.html",
    appliesTo: "average_monthly_wage_definition"
  }
];

const commerceCatalog = [
  {
    sku: "POLICY_CALC",
    name: "政策补偿测算",
    description: "中国大陆离职补偿政策测算单次使用权益",
    productChannel: "main",
    fulfillmentType: "policy_calculation",
    amountFen: 990
  },
  {
    sku: "AI_SEVERANCE_ANALYSIS",
    name: "AI 离职补偿深度分析",
    description: "离职补偿方案 AI 深度分析单次使用权益",
    productChannel: "ai",
    fulfillmentType: "ai_analysis",
    amountFen: 3990
  },
  {
    sku: "AI_DOCUMENT_REVIEW",
    name: "AI 劳动文件审查",
    description: "劳动文件签署与风险分析单次使用权益",
    productChannel: "ai",
    fulfillmentType: "document_review",
    amountFen: 2990
  }
] as const;

export const seedPolicyFoundation = async () => {
  await withTransaction(async (client) => {
    const desiredRuleSet = {
      code: "cn-severance",
      name: "中国大陆离职经济补偿规则",
      productChannel: "main"
    };
    const insertedRuleSet = await client.query<{ id: string }>(
      `INSERT INTO policy_rule_sets(code, name, product_channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [
        desiredRuleSet.code,
        desiredRuleSet.name,
        desiredRuleSet.productChannel
      ]
    );
    let ruleSetId = insertedRuleSet.rows[0]?.id;
    if (!ruleSetId) {
      const existingRuleSet = await client.query<{
        id: string;
        name: string;
        product_channel: string;
      }>(
        `SELECT id, name, product_channel
         FROM policy_rule_sets
         WHERE code = $1
         FOR UPDATE`,
        [desiredRuleSet.code]
      );
      const existing = existingRuleSet.rows[0];
      if (!existing) {
        throw new Error("Policy rule set disappeared during seed");
      }
      ruleSetId = existing.id;
      if (
        existing.name !== desiredRuleSet.name ||
        existing.product_channel !== desiredRuleSet.productChannel
      ) {
        await client.query(
          `UPDATE policy_rule_sets
           SET name = $2,
               product_channel = $3,
               updated_at = now()
           WHERE id = $1`,
          [
            ruleSetId,
            desiredRuleSet.name,
            desiredRuleSet.productChannel
          ]
        );
      }
    }

    const definitionJson = JSON.stringify(severanceDefinition);
    const sourceSnapshotJson = JSON.stringify(severanceSourceSnapshot);
    await client.query(
      `INSERT INTO policy_rule_versions(
         rule_set_id,
         version,
         status,
         definition,
         source_snapshot,
         effective_from,
         published_at,
         regression_status,
         regression_summary,
         regression_run_at
       )
       VALUES (
         $1, 1, 'published', $2::jsonb, $3::jsonb, $4::date, now(),
         'passed',
         '{"total": 0, "passed": 0, "failed": 0, "source": "seed-baseline"}'::jsonb,
         now()
       )
       ON CONFLICT (rule_set_id, version) DO NOTHING`,
      [
        ruleSetId,
        definitionJson,
        sourceSnapshotJson,
        "2013-07-01"
      ]
    );

    const currentVersion = await client.query<{ id: string }>(
      `SELECT id
         FROM policy_rule_versions
        WHERE rule_set_id = $1
          AND status = 'published'
          AND effective_from <= current_date
          AND (
            effective_to IS NULL OR
            effective_to >= current_date
          )
        ORDER BY version DESC
        LIMIT 1
        FOR SHARE`,
      [ruleSetId]
    );
    await client.query(
      `UPDATE policy_rule_sets
       SET active_version_id = $2,
           updated_at = now()
       WHERE id = $1
         AND active_version_id IS DISTINCT FROM $2`,
      [ruleSetId, currentVersion.rows[0]?.id ?? null]
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

    for (const product of commerceCatalog) {
      await client.query(
        `INSERT INTO products(
           sku,
           name,
           description,
           product_channel,
           fulfillment_type,
           status,
           entitlement_policy
         )
         VALUES ($1, $2, $3, $4, $5, 'active', '{"grantCount":1}'::jsonb)
         ON CONFLICT (sku) DO NOTHING`,
        [
          product.sku,
          product.name,
          product.description,
          product.productChannel,
          product.fulfillmentType
        ]
      );

      const lockedProduct = await client.query<{
        id: string;
      }>(
        `SELECT id
         FROM products
         WHERE sku = $1
         FOR UPDATE`,
        [product.sku]
      );
      const existing = lockedProduct.rows[0];
      if (!existing) {
        throw new Error(`Commerce product disappeared during seed: ${product.sku}`);
      }

      await client.query(
        `INSERT INTO product_prices(
           product_id,
           amount_fen,
           currency,
           effective_from
         )
         VALUES ($1, $2, 'CNY', now())
         ON CONFLICT (product_id) WHERE effective_to IS NULL
         DO NOTHING`,
        [existing.id, product.amountFen]
      );
    }

    await client.query(
      `INSERT INTO promotion_rules(
         code,
         name,
         product_id,
         grant_count,
         trigger_type,
         constraints,
         status
       )
       SELECT
         'FIRST_POLICY_CALC',
         '首次实名用户政策测算',
         id,
         1,
         'first_verified_user',
         '{}'::jsonb,
         'active'
       FROM products
       WHERE sku = 'POLICY_CALC'
       ON CONFLICT (code) DO NOTHING`
    );
  });
};
