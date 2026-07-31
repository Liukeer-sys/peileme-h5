import type { Answers } from "../types";

export type LaborLawArticle = {
  id: string;
  title: string;
  lines: string[];
};

export type LaborLawCitation = {
  articleId: string;
  highlights?: string[];
};

export type LaborLawPack = {
  leafId: string;
  result: string;
  summary: string;
  citations: LaborLawCitation[];
};

export const laborLawArticles: Record<string, LaborLawArticle> = {
  article26: {
    id: "article26",
    title: "《劳动合同法》第二十六条",
    lines: [
      "下列劳动合同无效或者部分无效：",
      "(一)以欺诈、胁迫的手段或者乘人之危，使对方在违背真实意思的情况下订立或者变更劳动合同的；",
      "(二)用人单位免除自己的法定责任、排除劳动者权利的；",
      "(三)违反法律、行政法规强制性规定的。",
      "对劳动合同的无效或者部分无效有争议的，由劳动争议仲裁机构或者人民法院确认。"
    ]
  },
  article37: {
    id: "article37",
    title: "《劳动合同法》第三十七条",
    lines: [
      "劳动者提前三十日以书面形式通知用人单位，可以解除劳动合同。劳动者在试用期内提前三日通知用人单位，可以解除劳动合同。"
    ]
  },
  article38: {
    id: "article38",
    title: "《劳动合同法》第三十八条",
    lines: [
      "用人单位有下列情形之一的，劳动者可以解除劳动合同：",
      "(一)未按照劳动合同约定提供劳动保护或者劳动条件的；",
      "(二)未及时足额支付劳动报酬的；",
      "(三)未依法为劳动者缴纳社会保险费的；",
      "(四)用人单位的规章制度违反法律、法规的规定，损害劳动者权益的；",
      "(五)因本法第二十六条第一款规定的情形致使劳动合同无效的；",
      "(六)法律、行政法规规定劳动者可以解除劳动合同的其他情形。",
      "用人单位以暴力、威胁或者非法限制人身自由的手段强迫劳动者劳动的，或者用人单位违章指挥、强令冒险作业危及劳动者人身安全的，劳动者可以立即解除劳动合同，不需事先告知用人单位。"
    ]
  },
  article39: {
    id: "article39",
    title: "《劳动合同法》第三十九条",
    lines: [
      "劳动者有下列情形之一的，用人单位可以解除劳动合同：",
      "(一)在试用期间被证明不符合录用条件的；",
      "(二)严重违反用人单位的规章制度的；",
      "(三)严重失职，营私舞弊，给用人单位造成重大损害的；",
      "(四)劳动者同时与其他用人单位建立劳动关系，对完成本单位的工作任务造成严重影响，或者经用人单位提出，拒不改正的；",
      "(五)因本法第二十六条第一款第一项规定的情形致使劳动合同无效的；",
      "(六)被依法追究刑事责任的。"
    ]
  },
  article40: {
    id: "article40",
    title: "《劳动合同法》第四十条",
    lines: [
      "有下列情形之一的，用人单位提前三十日以书面形式通知劳动者本人或者额外支付劳动者一个月工资后，可以解除劳动合同：",
      "(一)劳动者患病或者非因工负伤，在规定的医疗期满后不能从事原工作，也不能从事由用人单位另行安排的工作的；",
      "(二)劳动者不能胜任工作，经过培训或者调整工作岗位，仍不能胜任工作的；",
      "(三)劳动合同订立时所依据的客观情况发生重大变化，致使劳动合同无法履行，经用人单位与劳动者协商，未能就变更劳动合同内容达成协议的。"
    ]
  },
  article41: {
    id: "article41",
    title: "《劳动合同法》第四十一条",
    lines: [
      "有下列情形之一，需要裁减人员二十人以上或者裁减不足二十人但占企业职工总数百分之十以上的，用人单位提前三十日向工会或者全体职工说明情况，听取工会或者职工的意见后，裁减人员方案经向劳动行政部门报告，可以裁减人员：",
      "(一)依照企业破产法规定进行重整的；",
      "(二)生产经营发生严重困难的；",
      "(三)企业转产、重大技术革新或者经营方式调整，经变更劳动合同后，仍需裁减人员的；",
      "(四)其他因劳动合同订立时所依据的客观经济情况发生重大变化，致使劳动合同无法履行的。",
      "裁减人员时，应当优先留用下列人员：",
      "(一)与本单位订立较长期限的固定期限劳动合同的；",
      "(二)与本单位订立无固定期限劳动合同的；",
      "(三)家庭无其他就业人员，有需要扶养的老人或者未成年人的。",
      "用人单位依照本条第一款规定裁减人员，在六个月内重新招用人员的，应当通知被裁减的人员，并在同等条件下优先招用被裁减的人员。"
    ]
  },
  article44: {
    id: "article44",
    title: "《劳动合同法》第四十四条",
    lines: [
      "有下列情形之一的，劳动合同终止：",
      "(一)劳动合同期满的；",
      "(二)劳动者开始依法享受基本养老保险待遇的；",
      "(三)劳动者死亡，或者被人民法院宣告死亡或者宣告失踪的；",
      "(四)用人单位被依法宣告破产的；",
      "(五)用人单位被吊销营业执照、责令关闭、撤销或者用人单位决定提前解散的；",
      "(六)法律、行政法规规定的其他情形。"
    ]
  },
  article46: {
    id: "article46",
    title: "《劳动合同法》第四十六条",
    lines: [
      "有下列情形之一的，用人单位应当向劳动者支付经济补偿：",
      "(一)劳动者依照本法第三十八条规定解除劳动合同的；",
      "(二)用人单位依照本法第三十六条规定向劳动者提出解除劳动合同并与劳动者协商一致解除劳动合同的；",
      "(三)用人单位依照本法第四十条规定解除劳动合同的；",
      "(四)用人单位依照本法第四十一条第一款规定解除劳动合同的；",
      "(五)除用人单位维持或者提高劳动合同约定条件续订劳动合同，劳动者不同意续订的情形外，依照本法第四十四条第一项规定终止固定期限劳动合同的；",
      "(六)依照本法第四十四条第四项、第五项规定终止劳动合同的；",
      "(七)法律、行政法规规定的其他情形。"
    ]
  },
  article47: {
    id: "article47",
    title: "《劳动合同法》第四十七条",
    lines: [
      "经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。六个月以上不满一年的，按一年计算；不满六个月的，向劳动者支付半个月工资的经济补偿。",
      "劳动者月工资高于用人单位所在直辖市、设区的市级人民政府公布的本地区上年度职工月平均工资三倍的，向其支付经济补偿的标准按职工月平均工资三倍的数额支付，向其支付经济补偿的年限最高不超过十二年。",
      "本条所称月工资是指劳动者在劳动合同解除或者终止前十二个月的平均工资。"
    ]
  },
  article48: {
    id: "article48",
    title: "《劳动合同法》第四十八条",
    lines: [
      "用人单位违反本法规定解除或者终止劳动合同，劳动者要求继续履行劳动合同的，用人单位应当继续履行；劳动者不要求继续履行劳动合同或者劳动合同已经不能继续履行的，用人单位应当依照本法第八十七条规定支付赔偿金。"
    ]
  },
  article87: {
    id: "article87",
    title: "《劳动合同法》第八十七条",
    lines: [
      "用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。"
    ]
  }
};

const references: Record<string, LaborLawPack> = {
  self_resign_normal: {
    leafId: "self_resign_normal",
    result: "0",
    summary: "劳动者主动辞职，通常无经济补偿。",
    citations: [{ articleId: "article37" }]
  },
  forced_bad_conditions: {
    leafId: "forced_bad_conditions",
    result: "N",
    summary: "单位未按劳动合同约定提供劳动保护或劳动条件，劳动者被迫解除时通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["(一)"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_unpaid_or_underpaid_wage: {
    leafId: "forced_unpaid_or_underpaid_wage",
    result: "N",
    summary: "单位未及时足额支付劳动报酬，劳动者被迫解除时通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["(二)"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_no_social_insurance: {
    leafId: "forced_no_social_insurance",
    result: "N",
    summary: "单位未依法缴纳社会保险费，劳动者被迫解除时通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["(三)"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_illegal_rules: {
    leafId: "forced_illegal_rules",
    result: "N",
    summary: "单位规章制度违法且损害劳动者权益，劳动者被迫解除时通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["(四)"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_contract_trap: {
    leafId: "forced_contract_trap",
    result: "N",
    summary: "劳动合同因欺诈、胁迫、乘人之危等情形可能无效或部分无效，劳动者被迫解除时通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["(五)"] },
      { articleId: "article26", highlights: ["(一)"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_violence_or_restriction: {
    leafId: "forced_violence_or_restriction",
    result: "N",
    summary: "单位以暴力、威胁、非法限制人身自由等方式强迫劳动，劳动者可立即解除并通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["暴力、威胁或者非法限制人身自由", "违章指挥、强令冒险作业"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_dangerous_work: {
    leafId: "forced_dangerous_work",
    result: "N",
    summary: "单位违章指挥、强令冒险作业，劳动者可立即解除并通常可主张经济补偿。",
    citations: [
      { articleId: "article38", highlights: ["违章指挥、强令冒险作业"] },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  forced_other_reason: {
    leafId: "forced_other_reason",
    result: "N",
    summary: "你选择了其他被迫离职原因，若能证明单位存在违法、违约或严重过错，通常可围绕经济补偿 N 主张权利。",
    citations: [
      { articleId: "article38" },
      { articleId: "article46", highlights: ["(一)"] },
      { articleId: "article47" }
    ]
  },
  fault_probation_unqualified: {
    leafId: "fault_probation_unqualified",
    result: "0",
    summary: "如果试用期不符合录用条件属实，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(一)"] }]
  },
  fault_serious_rule_violation: {
    leafId: "fault_serious_rule_violation",
    result: "0",
    summary: "如果严重违反规章制度属实，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(二)"] }]
  },
  fault_serious_damage: {
    leafId: "fault_serious_damage",
    result: "0",
    summary: "如果严重失职或营私舞弊并造成重大损害属实，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(三)"] }]
  },
  fault_dual_employment: {
    leafId: "fault_dual_employment",
    result: "0",
    summary: "如果与其他单位劳动关系严重影响本职工作或拒不改正属实，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(四)"] }]
  },
  fault_contract_invalid_due_to_employee: {
    leafId: "fault_contract_invalid_due_to_employee",
    result: "0",
    summary: "如果因劳动者欺诈、胁迫、乘人之危导致劳动合同无效或部分无效，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(五)"] }]
  },
  fault_criminal_liability: {
    leafId: "fault_criminal_liability",
    result: "0",
    summary: "如果被依法追究刑事责任属实，单位可能依法解除且通常无补偿。",
    citations: [{ articleId: "article39", highlights: ["(六)"] }]
  },
  fault_not_true_or_exaggerated: {
    leafId: "fault_not_true_or_exaggerated",
    result: "2N",
    summary: "单位以过错为由解除但事实不成立或程度不够，可能构成违法解除。",
    citations: [
      { articleId: "article48" },
      { articleId: "article87" },
      { articleId: "article47" }
    ]
  },
  nofault_medical_notice_yes: {
    leafId: "nofault_medical_notice_yes",
    result: "N",
    summary: "医疗期满后不能从事原工作也不能从事另行安排工作，且单位提前三十日通知，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article40", highlights: ["(一)", "提前三十日"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_medical_notice_no: {
    leafId: "nofault_medical_notice_no",
    result: "N+1",
    summary: "医疗期满解除但未提前三十日通知时，通常在经济补偿外还涉及一个月代通知金。",
    citations: [
      { articleId: "article40", highlights: ["(一)", "额外支付劳动者一个月工资"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_incompetent_notice_yes: {
    leafId: "nofault_incompetent_notice_yes",
    result: "N",
    summary: "不能胜任工作且培训或调岗后仍不能胜任，单位提前三十日通知，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article40", highlights: ["(二)", "提前三十日"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_incompetent_notice_no: {
    leafId: "nofault_incompetent_notice_no",
    result: "N+1",
    summary: "不能胜任工作解除但未提前三十日通知时，通常在经济补偿外还涉及一个月代通知金。",
    citations: [
      { articleId: "article40", highlights: ["(二)", "额外支付劳动者一个月工资"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_major_change_notice_yes: {
    leafId: "nofault_major_change_notice_yes",
    result: "N",
    summary: "客观情况发生重大变化导致合同无法履行且协商变更未成，单位提前三十日通知，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article40", highlights: ["(三)", "提前三十日"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_major_change_notice_no: {
    leafId: "nofault_major_change_notice_no",
    result: "N+1",
    summary: "客观情况重大变化解除但未提前三十日通知时，通常在经济补偿外还涉及一个月代通知金。",
    citations: [
      { articleId: "article40", highlights: ["(三)", "额外支付劳动者一个月工资"] },
      { articleId: "article46", highlights: ["(三)"] },
      { articleId: "article47" }
    ]
  },
  nofault_not_listed_excuse: {
    leafId: "nofault_not_listed_excuse",
    result: "2N",
    summary: "单位解除理由不属于法定无过失解除情形，可能构成违法解除。",
    citations: [
      { articleId: "article48" },
      { articleId: "article87" },
      { articleId: "article47" }
    ]
  },
  layoff_notice_to_union_or_all_yes: {
    leafId: "layoff_notice_to_union_or_all_yes",
    result: "N",
    summary: "经济性裁员依法提前三十日向工会或全体职工说明并履行程序，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article41", highlights: ["提前三十日向工会或者全体职工说明情况"] },
      { articleId: "article46", highlights: ["(四)"] },
      { articleId: "article47" }
    ]
  },
  layoff_notice_to_union_or_all_no: {
    leafId: "layoff_notice_to_union_or_all_no",
    result: "2N",
    summary: "经济性裁员未履行法定提前说明或程序，可能构成违法解除。",
    citations: [
      { articleId: "article41", highlights: ["提前三十日向工会或者全体职工说明情况"] },
      { articleId: "article48" },
      { articleId: "article87" },
      { articleId: "article47" }
    ]
  },
  contract_expired_company_not_renew: {
    leafId: "contract_expired_company_not_renew",
    result: "N",
    summary: "劳动合同期满，公司不续签，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article44", highlights: ["(一)"] },
      { articleId: "article46", highlights: ["(五)"] },
      { articleId: "article47" }
    ]
  },
  contract_expired_employee_not_renew: {
    leafId: "contract_expired_employee_not_renew",
    result: "0",
    summary: "劳动者主动不续签且公司并未降低或不维持条件，通常无经济补偿。",
    citations: [
      { articleId: "article44", highlights: ["(一)"] },
      { articleId: "article46", highlights: ["(五)"] }
    ]
  },
  contract_expired_company_lower_terms: {
    leafId: "contract_expired_company_lower_terms",
    result: "N",
    summary: "公司降低或不维持原劳动合同约定条件，劳动者不续签，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article44", highlights: ["(一)"] },
      { articleId: "article46", highlights: ["(五)"] },
      { articleId: "article47" }
    ]
  },
  termination_retirement_pension: {
    leafId: "termination_retirement_pension",
    result: "OUT_OF_SCOPE",
    summary: "劳动者开始依法享受基本养老保险待遇，劳动合同终止；通常不进入赔偿测算范围。",
    citations: [{ articleId: "article44", highlights: ["(二)"] }]
  },
  termination_company_disappears: {
    leafId: "termination_company_disappears",
    result: "N",
    summary: "用人单位被依法宣告破产、被吊销营业执照、责令关闭、撤销或决定提前解散，通常可主张经济补偿 N。",
    citations: [
      { articleId: "article44", highlights: ["(四)", "(五)"] },
      { articleId: "article46", highlights: ["(六)"] },
      { articleId: "article47" }
    ]
  }
};

const faultPotLawConfigs: Record<string, { subject: string; citations: LaborLawCitation[] }> = {
  "试用期没过，说我是不合格的样本呜呜": {
    subject: "试用期不符合录用条件",
    citations: [{ articleId: "article39", highlights: ["(一)"] }]
  },
  "说我违反制度，而且是严重违纪的级别": {
    subject: "严重违反规章制度",
    citations: [{ articleId: "article39", highlights: ["(二)"] }]
  },
  "说我工作捅了大篓子，重创了公司": {
    subject: "严重失职或营私舞弊并造成重大损害",
    citations: [{ articleId: "article39", highlights: ["(三)"] }]
  },
  "说我脚踏两家公司，没空给本单位干活了": {
    subject: "双重劳动关系严重影响本职工作或拒不改正",
    citations: [{ articleId: "article39", highlights: ["(四)"] }]
  },
  "说我签劳动合同的时候涉及欺骗，我的形象已塌房": {
    subject: "订立劳动合同时存在欺诈等导致合同无效的争议",
    citations: [{ articleId: "article39", highlights: ["(五)"] }]
  },
  "说我现在摊上大事，涉及刑事问题": {
    subject: "被依法追究刑事责任",
    citations: [{ articleId: "article39", highlights: ["(六)"] }]
  }
};

const genericFaultPotLawConfig: { subject: string; citations: LaborLawCitation[] } = {
  subject: "单位主张过错性解除",
  citations: [{ articleId: "article39" }]
};

const getFaultPotLawConfig = (answers?: Answers) =>
  faultPotLawConfigs[answers?.followUps?.FAULT_DISMISS_CHECK || ""] ?? genericFaultPotLawConfig;

const faultDismissalLeafIds = new Set([
  "fault_pot_basically_true",
  "fault_pot_uncertain_severity",
  "fault_not_true_or_exaggerated"
]);

const buildCurrentFaultLaborLawPack = (leafId: string, answers?: Answers): LaborLawPack | undefined => {
  if (!faultDismissalLeafIds.has(leafId)) {
    return undefined;
  }

  const potConfig = getFaultPotLawConfig(answers);
  const baseCitations = potConfig.citations;

  if (leafId === "fault_pot_basically_true") {
    return {
      leafId,
      result: "0",
      summary: `公司主张的是“${potConfig.subject}”。如果事实、制度依据和解除程序都成立，单位可能按过错性解除处理，通常无经济补偿。`,
      citations: [
        ...baseCitations,
        { articleId: "article48" },
        { articleId: "article47" }
      ]
    };
  }

  if (leafId === "fault_pot_uncertain_severity") {
    return {
      leafId,
      result: "0 / 2N",
      summary: `公司主张的是“${potConfig.subject}”。争议重点在于事实是否成立、是否严重到足以解除，以及程序是否合法；若站不住，可能进入违法解除 2N 争议。`,
      citations: [
        ...baseCitations,
        { articleId: "article48" },
        { articleId: "article87" },
        { articleId: "article47" }
      ]
    };
  }

  return {
    leafId,
    result: "2N",
    summary: `公司主张的是“${potConfig.subject}”。如果事实不成立、程度被夸大或程序违法，可能构成违法解除，赔偿金通常按 2N 方向判断。`,
    citations: [
      ...baseCitations,
      { articleId: "article48" },
      { articleId: "article87" },
      { articleId: "article47" }
    ]
  };
};

export const fallbackLaborLawPack: LaborLawPack = {
  leafId: "fallback",
  result: "需进一步判断",
  summary: "当前离职原因还需要结合材料进一步判断，先参考经济补偿和计算口径的基础条文。",
  citations: [
    { articleId: "article46" },
    { articleId: "article47" }
  ]
};

const ensureArticle46Before47 = (citations: LaborLawCitation[]) => {
  const article46Index = citations.findIndex((citation) => citation.articleId === "article46");
  const article47Index = citations.findIndex((citation) => citation.articleId === "article47");
  if (article46Index < 0 || article47Index < 0 || article46Index < article47Index) return citations;

  const ordered = [...citations];
  const [article46] = ordered.splice(article46Index, 1);
  const nextArticle47Index = ordered.findIndex((citation) => citation.articleId === "article47");
  ordered.splice(nextArticle47Index, 0, article46);
  return ordered;
};
const withRequiredReferenceArticles = (pack: LaborLawPack): LaborLawPack => {
  const existing = new Set(pack.citations.map((citation) => citation.articleId));
  const required: LaborLawCitation[] = [];
  const involvesTwoN = pack.result.includes("2N");
  const isFaultDismissal = faultDismissalLeafIds.has(pack.leafId);

  if (!isFaultDismissal && !existing.has("article46")) required.push({ articleId: "article46" });
  if (!existing.has("article47")) required.push({ articleId: "article47" });
  if (involvesTwoN && !existing.has("article48")) required.push({ articleId: "article48" });
  if (involvesTwoN && !existing.has("article87")) required.push({ articleId: "article87" });

  const citations = ensureArticle46Before47(required.length ? [...pack.citations, ...required] : pack.citations);
  return citations === pack.citations ? pack : { ...pack, citations };
};

export const getLaborLawPack = (leafId?: string, answers?: Answers) =>
  withRequiredReferenceArticles((leafId ? buildCurrentFaultLaborLawPack(leafId, answers) ?? references[leafId] : undefined) ?? fallbackLaborLawPack);

export const getLaborLawArticle = (articleId: string) => laborLawArticles[articleId];











