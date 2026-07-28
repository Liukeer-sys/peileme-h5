export type TerminationResultMode = "n" | "nPlusOne" | "twoN" | "zeroRisk" | "zeroOrTwoN" | "range";

export type TerminationLeaf = {
  id: string;
  label: string;
  reply: string;
  resultMode: TerminationResultMode;
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
    inferredType: "被迫解除/单位过错",
    compensationHint: "通常参考 N",
    note: "如果是因单位未提供劳动保护、拖欠工资、未缴社保等原因被迫解除，通常围绕经济补偿 N 估算。"
  }
});

export const forcedOtherReasonLeaf: TerminationLeaf = {
  id: "forced_other_reason",
  label: "其他原因，可简单描述",
  reply: "单位太可恶！如果情况属实，单位需要赔偿你“N”。",
  resultMode: "n",
  inferredType: "被迫解除/单位过错",
  compensationHint: "通常参考 N",
  note: "如果是因单位原因导致员工被迫解除，通常围绕经济补偿 N 估算。具体原因需要结合证据继续确认。"
};
const seriousFaultLeaf = (id: string, label: string): TerminationFlowOption => ({
  label,
  leaf: {
    id,
    label,
    reply: "如果属实，那情况确实很严重！你可能不会得到赔偿了。",
    resultMode: "zeroRisk",
    inferredType: "过错性解除",
    compensationHint: "可能无补偿",
    note: "如果单位能证明严重过错并且程序合法，经济补偿风险会很高。"
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
        inferredType: "无过失性辞退/提前通知",
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
        inferredType: "无过失性辞退/未提前通知",
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
      { label: "我自己提出离职的，属于劳动合同解除（包括单位太烂，我被迫辞职）", nextId: "SELF_RESIGN_REASON" },
      { label: "单位要辞退我，属于劳动合同解除", nextId: "COMPANY_DISMISS_REASON" },
      { label: "劳动合同期满不续，属于劳动合同终止", nextId: "CONTRACT_EXPIRED_CHECK" },
      {
        label: "公司遇到变故完全没有了呜呜呜",
        leaf: {
          id: "termination_company_disappears",
          label: "公司遇到变故完全没有了呜呜呜",
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
    question: "具体原因是……",
    options: [
      {
        label: "单位没啥问题，是我自己主动想辞职",
        leaf: {
          id: "self_resign_normal",
          label: "单位没啥问题，是我自己主动想辞职",
          reply: "祝贺你有勇气寻找自己的下一段故事！主动离开的话，单位不给赔偿喔。",
          resultMode: "zeroRisk",
          inferredType: "员工主动辞职",
          compensationHint: "通常无补偿",
          note: "员工因个人原因主动辞职时，通常不产生经济补偿。"
        }
      },
      companyTooBadLeaf("forced_bad_conditions", "单位给我的工作条件太差！我只好被迫走"),
      companyTooBadLeaf("forced_unpaid_or_underpaid_wage", "单位总是克扣工资，要么晚发要么少发！我受不了了只好被迫走"),
      companyTooBadLeaf("forced_no_social_insurance", "黑心单位不给我交社保！我受不了了只好被迫走"),
      companyTooBadLeaf("forced_illegal_rules", "单位的规章制度太离谱！我受不了了只好被迫走"),
      companyTooBadLeaf("forced_contract_trap", "当时签的劳动合同明显藏了坑和套路！我被迫后悔引发麻烦只好被迫走"),
      companyTooBadLeaf("forced_violence_or_restriction", "单位像黑社会一样，限制我人身自由/打我！我太害怕了只好被迫走"),
      { label: "其他原因，可简单描述", nextId: "SELF_RESIGN_OTHER_REASON_DETAIL" }
    ]
  },
  {
    id: "COMPANY_DISMISS_REASON",
    question: "具体原因是……",
    options: [
      { label: "单位把锅扣我头上，说我有错呜呜", nextId: "FAULT_DISMISS_CHECK" },
      { label: "我没错，但因为一些客观原因要辞退我", nextId: "NO_FAULT_DISMISS_CHECK" },
      { label: "公司出了大问题，要大裁员（达20人或公司10%以上）", nextId: "LAYOFF_30_DAYS_CHECK" }
    ]
  },
  {
    id: "FAULT_DISMISS_CHECK",
    question: "具体给你扣了什么锅？",
    options: [
      faultPotOption("试用期没过，说我是不合格的样本呜呜"),
      faultPotOption("说我违反制度，而且是严重违纪的级别"),
      faultPotOption("说我工作捅了大篓子，重创了公司"),
      faultPotOption("说我脚踏两家公司，没空给本单位干活了"),
      faultPotOption("说我签劳动合同的时候涉及欺骗，我的形象已塌房"),
      faultPotOption("说我现在摊上大事，涉及刑事问题")
    ]
  },
  {
    id: "FAULT_TRUTH_CHECK",
    question: "你觉得这口锅属实吗？",
    options: [
      seriousFaultLeaf("fault_pot_basically_true", "基本属实"),
      {
        label: "我不确定有没有严重到需要辞退我的程度",
        leaf: {
          id: "fault_pot_uncertain_severity",
          label: "我不确定有没有严重到需要辞退我的程度",
          reply: "如果过错成立，你可能不会得到赔偿；如果过错没那么严重，单位涉及违法解除，需要赔偿“2N”。",
          resultMode: "zeroOrTwoN",
          inferredType: "过错性解除争议",
          compensationHint: "0 / 2N，需要结合证据继续判断",
          note: "如果过错事实成立且达到解除程度，可能无补偿；如果事实不成立、程度不足或程序违法，可能进入违法解除 2N 争议。"
        }
      },
      {
        label: "并无以上问题，或并没那么严重，公司在给我乱扣帽子！",
        leaf: {
          id: "fault_not_true_or_exaggerated",
          label: "并无以上问题，或并没那么严重，公司在给我乱扣帽子！",
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
    question: "具体发生了什么？",
    options: [
      noticeCheckOption("NOTICE_30_DAYS_MEDICAL_CHECK", "说我因身体原因，干不了这活了，而且医疗期满了也没法再休了"),
      noticeCheckOption("NOTICE_30_DAYS_INCOMPETENT_CHECK", "说我没能力干这份工作，培训补课、换岗后还是干不了"),
      noticeCheckOption("NOTICE_30_DAYS_OBJECTIVE_CHECK", "公司发生了大变化（比如我的部门没了），新签我的劳动合同我也不满意"),
      {
        label: "并非以上问题，我觉得单位的就是找借口让我走！",
        leaf: {
          id: "nofault_not_listed_excuse",
          label: "并非以上问题，我觉得单位的就是找借口让我走！",
          reply: "那你可能要赚了！单位这是违法解除，要陪你“2N”。",
          resultMode: "twoN",
          inferredType: "疑似违法解除",
          compensationHint: "可能参考 2N",
          note: "如果公司所谓客观原因不成立或程序违法，可能进入违法解除赔偿争议。"
        }
      }
    ]
  },
  notice30DaysBranch("NOTICE_30_DAYS_MEDICAL_CHECK"),
  notice30DaysBranch("NOTICE_30_DAYS_INCOMPETENT_CHECK"),
  notice30DaysBranch("NOTICE_30_DAYS_OBJECTIVE_CHECK"),
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
          inferredType: "经济性裁员",
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
          inferredType: "经济性裁员/程序瑕疵",
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
      {
        label: "有眼无珠的公司不要续签我了呜呜呜",
        leaf: {
          id: "contract_expired_company_not_renew",
          label: "有眼无珠的公司不要续签我了呜呜呜",
          reply: "单位太可恶了！如果情况属实，你可以获得“N”的赔偿。",
          resultMode: "n",
          inferredType: "合同期满公司不续签",
          compensationHint: "通常参考 N",
          note: "劳动合同到期由公司不续签时，通常围绕经济补偿 N 估算。"
        }
      },
      {
        label: "我不续了，老娘（老子）不干了",
        leaf: {
          id: "contract_expired_employee_not_renew",
          label: "我不续了，老娘（老子）不干了",
          reply: "如果是自己想要终止合同，那单位不需要赔偿你哦。祝你开启一段更精彩的旅程！",
          resultMode: "zeroRisk",
          inferredType: "合同期满员工不续签",
          compensationHint: "通常无补偿",
          note: "如果单位维持或提高条件续签但员工不续签，通常不产生经济补偿。"
        }
      },
      {
        label: "公司不仅没有提升原合同的条件，连原本的条件也不能给我！我不签了，我值得更好的",
        leaf: {
          id: "contract_expired_company_lower_terms",
          label: "公司不仅没有提升原合同的条件，连原本的条件也不能给我！我不签了，我值得更好的",
          reply: "单位太可恶了！如果情况属实，你可以获得“N”的赔偿。",
          resultMode: "n",
          inferredType: "合同期满续签条件降低",
          compensationHint: "通常参考 N",
          note: "如果公司降低续签条件导致员工不续签，通常围绕经济补偿 N 估算。"
        }
      }
    ]
  }
];

export const rootTerminationReasonNode = terminationReasonFlow[0];

export const getTerminationReasonNode = (id: string) => terminationReasonFlow.find((node) => node.id === id);

export const getTerminationLeafById = (id?: string) => {
  if (!id) return undefined;
  if (id === forcedOtherReasonLeaf.id) return forcedOtherReasonLeaf;
  for (const node of terminationReasonFlow) {
    for (const option of node.options) {
      if (option.leaf?.id === id) return option.leaf;
    }
  }
  return undefined;
};











