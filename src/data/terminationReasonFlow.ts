export type TerminationResultMode = "n" | "nPlusOne" | "twoN" | "zeroRisk" | "zeroOrN" | "zeroOrTwoN" | "range";

export type TerminationLeaf = {
  id: string;
  label: string;
  reply: string;
  resultMode: TerminationResultMode;
  showResultSuffix?: boolean;
  inferredType: string;
  compensationHint: string;
  note: string;
};

export type TerminationBranch = {
  id: string;
  question: string;
  options: TerminationFlowOption[];
};

export type TerminationFlowOption = {
  label: string;
  nextId?: string;
  leaf?: TerminationLeaf;
};

const companyTooBadLeaf = (id: string, label: string): TerminationFlowOption => ({
  label,
  leaf: {
    id,
    label,
    reply: "单位太可恶！如果情况属实，单位需要赔偿你“N”。",
    resultMode: "n",
    inferredType: "被迫解除（单位过错）",
    compensationHint: "通常参考 N",
    note: "如果是因单位未提供劳动保护、拖欠工资、未缴社保等原因被迫解除，通常围绕经济补偿 N 估算。"
  }
});

const faultPotOption = (label: string): TerminationFlowOption => ({
  label,
  nextId: "FAULT_TRUTH_CHECK"
});

const noticeCheckOption = (id: string, label: string): TerminationFlowOption => ({
  label,
  nextId: id
});

const article42ProtectionQuestion =
  "公司通知你离职时，你有没有下面这些特殊情况？\n\n① 工作中接触过粉尘、噪声、有毒物质等，还没做离岗体检；\n\n② 疑似得了职业病，还在诊断或医学观察；\n\n③ 因工伤或职业病，被认定劳动能力部分或全部受影响；\n\n④ 因为生病或非工伤，还在法律规定的医疗期内；\n\n⑤ 正处于孕期、产期或哺乳期；\n\n⑥ 在这家公司连续工作满15年，而且距离法定退休年龄不到5年。";

const article42ProtectionQuestionAfterMedicalPeriod =
  "公司通知你离职时，你有没有下面这些特殊情况？\n\n① 工作中接触过粉尘、噪声、有毒物质等，但还没做离岗体检；\n\n② 疑似得了职业病，还在诊断或医学观察；\n\n③ 因工伤或职业病，被认定劳动能力部分或全部受影响；\n\n④ 正处于孕期、产期或哺乳期；\n\n⑤ 在这家公司连续工作满15年，而且距离法定退休年龄不到5年。";

const article42ProtectionBranch = (
  id: string,
  nextNoticeId: string,
  protectedLeafId: string,
  dismissalReason: string
): TerminationBranch => ({
  id,
  question: id === "ARTICLE_42_MEDICAL_CHECK" ? article42ProtectionQuestionAfterMedicalPeriod : article42ProtectionQuestion,
  options: [
    {
      label: "是，符合其中一种",
      leaf: {
        id: protectedLeafId,
        label: `特殊保护情况下解除`,
        reply: `如果情况属实，公司不能以${dismissalReason}为由解除劳动合同，这可能属于违法解除。`,
        resultMode: "twoN",
        inferredType: `特殊保护情况下解除`,
        compensationHint: "可能参考 2N",
        note: `你符合特殊保护条件，公司不能以${dismissalReason}为由解除劳动合同；如果仍然解除，赔偿金通常按 2N 方向判断。`
      }
    },
    { label: "否，都不符合", nextId: nextNoticeId }
  ]
});

const notice30DaysBranch = (id: string): TerminationBranch => ({
  id,
  question: "有没有提前30天告知你？",
  options: [
    {
      label: "是",
      leaf: {
        id: id === "NOTICE_30_DAYS_MEDICAL_CHECK" ? "nofault_medical_notice_yes" : id === "NOTICE_30_DAYS_INCOMPETENT_CHECK" ? "nofault_incompetent_notice_yes" : "nofault_major_change_notice_yes",
        label: "提前30天告知",
        reply: "好的，如果情况属实，你可以拿到“N”的赔偿金～",
        resultMode: "n",
        inferredType: "无过失性辞退（提前通知）",
        compensationHint: "通常参考 N",
        note: "无过失性辞退已提前三十日通知时，通常围绕经济补偿 N 估算。"
      }
    },
    {
      label: "否",
      leaf: {
        id: id === "NOTICE_30_DAYS_MEDICAL_CHECK" ? "nofault_medical_notice_no" : id === "NOTICE_30_DAYS_INCOMPETENT_CHECK" ? "nofault_incompetent_notice_no" : "nofault_major_change_notice_no",
        label: "没有提前30天告知",
        reply: "好的，如果情况属实，你可以拿到“N+1”的赔偿金～",
        resultMode: "nPlusOne",
        inferredType: "无过失性辞退（未提前通知）",
        compensationHint: "通常参考 N+1",
        note: "无过失性辞退未提前三十日通知时，通常围绕 N+1 估算。"
      }
    }
  ]
});

export const terminationReasonFlow: TerminationBranch[] = [
  {
    id: "Q0",
    question: "这次离职大概是哪种情况？",
    options: [
      {
        label: "我自己想离职",
        leaf: {
          id: "self_resign_normal",
          label: "我自己想离职",
          reply: "祝贺你有勇气寻找自己的下一段故事！普通主动辞职一般不能要求单位支付经济补偿。请按规定提前通知单位。",
          resultMode: "zeroRisk",
          showResultSuffix: false,
          inferredType: "员工主动辞职",
          compensationHint: "通常无补偿",
          note: "员工因个人原因主动辞职时，通常不产生经济补偿。"
        }
      },
      { label: "公司逼得我不得不走", nextId: "SELF_RESIGN_REASON" },
      { label: "公司要我走", nextId: "COMPANY_DISMISS_REASON" },
      { label: "合同到期了，不再续签", nextId: "CONTRACT_EXPIRED_CHECK" },
      {
        label: "公司没有了",
        leaf: {
          id: "termination_company_disappears",
          label: "公司没有了",
          reply: "天哪真是“狗屎运之神”，怎么偏偏是你的单位没有了！这种情况也不要慌，按照法律，原单位应该赔偿你“N”。",
          resultMode: "n",
          inferredType: "单位主体消灭导致劳动合同终止",
          compensationHint: "通常参考 N",
          note: "单位被依法宣告破产、吊销营业执照、责令关闭、撤销或提前解散等，通常围绕经济补偿 N 估算。"
        }
      }
    ]
  },
  {
    id: "SELF_RESIGN_REASON",
    question: "公司具体做了什么，让你不得不走？",
    options: [
      companyTooBadLeaf("forced_unpaid_or_underpaid_wage", "工资被拖欠或克扣"),
      companyTooBadLeaf("forced_no_social_insurance", "公司没依法给我交社保"),
      companyTooBadLeaf("forced_bad_conditions", "工作条件没按约定提供"),
      companyTooBadLeaf("forced_illegal_rules", "公司制度违法，还坑到了我"),
      companyTooBadLeaf("forced_contract_trap", "签劳动合同时被坑了"),
      companyTooBadLeaf("forced_violence_or_restriction", "公司用暴力、威胁逼我工作"),
      companyTooBadLeaf("forced_dangerous_work", "公司逼我冒险作业"),
      {
        label: "其他情况",
        leaf: {
          id: "forced_other_or_unclear",
          label: "其他公司情况",
          reply: "如果公司的做法属于法定的被迫解除情形，你通常可以获得“N”；如果不属于法定情形，主动离职通常为“0”。",
          resultMode: "zeroOrN",
          inferredType: "其他被迫离职争议",
          compensationHint: "可能为 0 或 N，需要结合公司具体行为和离职原因判断",
          note: "如果公司行为符合法定的被迫解除情形，可能主张经济补偿 N；如果只是一般工作矛盾或个人选择离职，则未必产生经济补偿。"
        }
      }
    ]
  },
  {
    id: "COMPANY_DISMISS_REASON",
    question: "具体原因是……",
    options: [
      {
        label: "公司找我协商解除",
        leaf: {
          id: "company_proposed_mutual_termination",
          label: "公司找我协商解除劳动合同",
          reply: "如果是公司主动提出与你协商解除劳动合同，一般应当向你支付经济补偿N。并且N不是协商上限，你还可以结合未发奖金、未休年假、社保公积金等情况，争取更高的补偿。",
          resultMode: "nPlusOne",
          inferredType: "协商解除",
          compensationHint: "通常参考 N，也常以 N+1 作为谈判锚点",
          note: "协商解除的核心是方案是否写清楚、付款时间是否明确、社保公积金和离职证明是否处理好。"
        }
      },
      { label: "公司说是我的错", nextId: "FAULT_DISMISS_CHECK" },
      { label: "我没犯错，但公司说没法继续用我", nextId: "NO_FAULT_DISMISS_CHECK" },
      { label: "公司要大规模裁员", nextId: "ARTICLE_42_LAYOFF_CHECK" }
    ]
  },
  {
    id: "FAULT_DISMISS_CHECK",
    question: "具体给你扣了什么锅？",
    options: [
      faultPotOption("试用期没通过"),
      faultPotOption("严重违反公司制度"),
      faultPotOption("严重失职，造成重大损失"),
      faultPotOption("还在其他单位工作"),
      faultPotOption("入职时提供了虚假信息"),
      faultPotOption("被依法追究刑事责任"),
      {
        label: "其他问题或没说清楚",
        leaf: {
          id: "fault_reason_other_or_unclear",
          label: "公司主张的过错理由不明确",
          reply: "如果公司主张的过错成立且达到法定解除程度，你可能不会得到赔偿；如果过错不成立或没那么严重，单位可能构成违法解除，需要赔偿“2N”。",
          resultMode: "zeroOrTwoN",
          inferredType: "过错解除理由不明确",
          compensationHint: "可能为 0 或 2N，需要结合解除理由和证据判断",
          note: "如果公司能够证明存在法定严重过错，可能无补偿；如果理由不属于法定情形，或者事实、程度、制度和程序站不住，可能构成违法解除。"
        }
      }
    ]
  },
  {
    id: "FAULT_TRUTH_CHECK",
    question: "你觉得这口锅属实吗？",
    options: [
      {
        label: "基本属实",
        leaf: {
          id: "fault_pot_basically_true",
          label: "基本属实",
          reply: "如果属实，那情况确实很严重！你可能不会得到赔偿了。",
          resultMode: "zeroRisk",
          inferredType: "过错性解除",
          compensationHint: "可能无补偿",
          note: "如果单位能证明严重过错并且程序合法，经济补偿风险会很高。"
        }
      },
      {
        label: "有这回事，但不确定严重程度",
        leaf: {
          id: "fault_pot_uncertain_severity",
          label: "有这回事，但不确定严重程度",
          reply: "如果过错成立，你可能不会得到赔偿；如果过错没那么严重，单位涉及违法解除，需要赔偿“2N”。",
          resultMode: "zeroOrTwoN",
          inferredType: "过错性解除争议",
          compensationHint: "0 / 2N，需要结合证据继续判断",
          note: "如果过错事实成立且达到解除程度，可能无补偿；如果事实不成立、程度不足或程序违法，可能进入违法解除 2N 争议。"
        }
      },
      {
        label: "公司在乱扣帽子",
        leaf: {
          id: "fault_not_true_or_exaggerated",
          label: "公司在乱扣帽子",
          reply: "那你可能要赚麻了！单位这是违法解除，要赔你“2N”。",
          resultMode: "twoN",
          inferredType: "疑似违法解除",
          compensationHint: "可能参考 2N",
          note: "如果公司以过错为由解除但事实或程序站不住，可能进入违法解除赔偿争议。"
        }
      }
    ]
  },
  {
    id: "NO_FAULT_DISMISS_CHECK",
    question: "具体原因是……",
    options: [
      noticeCheckOption("ARTICLE_42_MEDICAL_CHECK", "身体原因，实在干不了了"),
      noticeCheckOption("ARTICLE_42_INCOMPETENT_CHECK", "公司说我不能胜任工作"),
      noticeCheckOption("ARTICLE_42_OBJECTIVE_CHECK", "原来的工作条件变了，双方没谈拢"),
      {
        label: "都不是，公司就是想赶我走",
        leaf: {
          id: "nofault_not_listed_excuse",
          label: "都不是，公司就是想赶我走",
          reply: "那你可能要赚了！单位这是违法解除，要陪你“2N”。",
          resultMode: "twoN",
          inferredType: "疑似违法解除",
          compensationHint: "可能参考 2N",
          note: "如果公司所谓客观原因不成立或程序违法，可能进入违法解除赔偿争议。"
        }
      }
    ]
  },
  article42ProtectionBranch(
    "ARTICLE_42_MEDICAL_CHECK",
    "NOTICE_30_DAYS_MEDICAL_CHECK",
    "nofault_medical_article42_protected",
    "“医疗期满后无法从事原工作，或公司另行安排的工作”"
  ),
  article42ProtectionBranch(
    "ARTICLE_42_INCOMPETENT_CHECK",
    "NOTICE_30_DAYS_INCOMPETENT_CHECK",
    "nofault_incompetent_article42_protected",
    "“经过培训或调岗后，仍不能胜任工作”"
  ),
  article42ProtectionBranch(
    "ARTICLE_42_OBJECTIVE_CHECK",
    "NOTICE_30_DAYS_OBJECTIVE_CHECK",
    "nofault_major_change_article42_protected",
    "“客观情况发生重大变化，且双方未能协商变更劳动合同”"
  ),
  notice30DaysBranch("NOTICE_30_DAYS_MEDICAL_CHECK"),
  notice30DaysBranch("NOTICE_30_DAYS_INCOMPETENT_CHECK"),
  notice30DaysBranch("NOTICE_30_DAYS_OBJECTIVE_CHECK"),
  {
    id: "ARTICLE_42_LAYOFF_CHECK",
    question: article42ProtectionQuestion,
    options: [
      {
        label: "是，符合其中一种",
        leaf: {
          id: "layoff_article42_protected",
          label: "大规模裁员时符合特殊保护情形",
          reply: "如果情况属实，公司不能依据大规模裁员规定解除，这可能属于违法解除。",
          resultMode: "twoN",
          inferredType: "特殊保护情形下违法裁员",
          compensationHint: "可能参考 2N",
          note: "劳动者符合特殊保护情形时，用人单位不得依据经济性裁员规定解除劳动合同；违法解除的赔偿金通常按 2N 方向判断。"
        }
      },
      { label: "否，都不符合", nextId: "LAYOFF_30_DAYS_CHECK" }
    ]
  },
  {
    id: "LAYOFF_30_DAYS_CHECK",
    question: "是否提前30天给全体职工或工会？",
    options: [
      {
        label: "是",
        leaf: {
          id: "layoff_notice_to_union_or_all_yes",
          label: "经济性裁员提前30天通知",
          reply: "好的，如果情况属实，你可以拿到“N”的赔偿金～",
          resultMode: "n",
          inferredType: "经济性裁员（提前通知）",
          compensationHint: "通常参考 N",
          note: "经济性裁员程序较完整时，通常围绕经济补偿 N 估算。"
        }
      },
      {
        label: "否",
        leaf: {
          id: "layoff_notice_to_union_or_all_no",
          label: "经济性裁员未提前30天通知",
          reply: "那你可能要赚了！单位这是违法解除，要陪你“2N”。",
          resultMode: "twoN",
          inferredType: "经济性裁员（未提前通知）",
          compensationHint: "可能参考 2N",
          note: "经济性裁员若未履行法定提前说明或程序，可能进入违法解除赔偿争议。"
        }
      }
    ]
  },

  {
    id: "CONTRACT_EXPIRED_CHECK",
    question: "具体情况是...",
    options: [
      { label: "公司不愿意续签", nextId: "ARTICLE_42_CONTRACT_NOT_RENEW_CHECK" },
      {
        label: "公司照旧续，是我不想续",
        leaf: {
          id: "contract_expired_employee_not_renew",
          label: "公司照旧续，是我不想续",
          reply: "如果是自己想要终止合同，那单位不需要赔偿你哦。祝你开启一段更精彩的旅程！",
          resultMode: "zeroRisk",
          inferredType: "合同期满员工不续签",
          compensationHint: "通常无补偿",
          note: "如果单位维持或提高条件续签但员工不续签，通常不产生经济补偿。"
        }
      },
      {
        label: "公司降低续签条件，我没同意",
        leaf: {
          id: "contract_expired_company_lower_terms",
          label: "公司降低续签条件，我没同意",
          reply: "单位太可恶了！如果情况属实，你可以获得“N”的赔偿。",
          resultMode: "n",
          inferredType: "合同期满续签条件降低",
          compensationHint: "通常参考 N",
          note: "如果公司降低续签条件导致员工不续签，通常围绕经济补偿 N 估算。"
        }
      }
    ]
  },
  {
    id: "ARTICLE_42_CONTRACT_NOT_RENEW_CHECK",
    question: article42ProtectionQuestion,
    options: [
      {
        label: "是，符合其中一种",
        leaf: {
          id: "contract_expired_protected_status",
          label: "合同到期时符合特殊保护情形",
          reply: "如果情况属实，劳动合同应当续延，公司直接终止可能属于违法终止。",
          resultMode: "twoN",
          inferredType: "特殊保护情形下违法终止",
          compensationHint: "可能参考 2N",
          note: "劳动合同期满时存在特殊保护情形的，劳动合同通常应当续延至相应情形消失；违法终止的赔偿金通常按 2N 方向判断。"
        }
      },
      {
        label: "否，都不符合",
        leaf: {
          id: "contract_expired_company_not_renew",
          label: "公司不愿意续签",
          reply: "单位太可恶了！如果情况属实，你可以获得“N”的赔偿。",
          resultMode: "n",
          inferredType: "合同期满公司不续签",
          compensationHint: "通常参考 N",
          note: "劳动合同到期由公司不续签时，通常围绕经济补偿 N 估算。"
        }
      }
    ]
  }
];

export const rootTerminationReasonNode = terminationReasonFlow[0];

export const getTerminationReasonNode = (id: string) => terminationReasonFlow.find((node) => node.id === id);

export const getTerminationLeafById = (id?: string) => {
  if (!id) return undefined;
  for (const node of terminationReasonFlow) {
    for (const option of node.options) {
      if (option.leaf?.id === id) return option.leaf;
    }
  }
  return undefined;
};
