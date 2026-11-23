import type { Answers } from "../types";
import type { CalculationResult } from "../utils/calculate";

export type EvidenceItem = {
  id: string;
  name: string;
  priority: "recommended" | "optional";
  preparationItems: string[];
  acquisition: string;
};

type EvidenceSection = {
  id: string;
  title: string;
  items: EvidenceItem[];
  description?: string;
};

type EvidenceConfig = {
  sections: EvidenceSection[];
  supplementaryEvidence?: EvidenceSection[];
  userTip: string;
  title?: string;
  savedLabel?: string;
  reminder?: string;
};

export type EvidenceChecklist = EvidenceConfig & {
  key: string;
  leafText: string;
};

const section = (id: string, title: string, items: EvidenceItem[], description?: string): EvidenceSection =>
  ({ id, title, items, description });

const material = (id: string, name: string, preparationItems: string[], acquisition: string, optional = false): EvidenceItem => ({
  id, name, preparationItems, acquisition,
  priority: optional ? "optional" : "recommended"
});

const basicEvidence = {
  contract: material("labor_contract", "劳动合同", [
    "劳动合同：完整合同、签字盖章页及已有续签文件。",
    "没有合同的：保留工资转账、考勤或工作安排记录，能相互印证的可一起保留。"
  ], "从纸质合同、邮箱或电子签约平台保存完整文件；缺少合同可向 HR 索取。替代材料从银行 App、考勤系统或工作聊天中保存。"),
  salary: material("forced_salary_records", "工资条和到账流水", [
    "工资条：离职前12个月；工作不足12个月的，按实际工作期间准备。",
    "工资到账流水：与工资条对应月份的银行入账记录。",
    "奖金、提成明细：有这些收入的，补充对应发放记录。"
  ], "工资条从薪资系统或工资邮件下载，缺失的向 HR 或财务索取；到账流水从工资卡银行 App 或柜台导出。"),
  service: material("forced_service_records", "入职及离职记录", [
    "入职记录：入职登记、首次考勤或首次工资记录，保留能看出实际入职日期的材料。",
    "最后工作日记录：离职日期确认邮件、聊天或最后考勤记录。尚未离职的，之后补充。",
    "续签或调动记录：涉及续签、公司内部调动的，保留对应文件。合同已写清的日期无需另找材料。"
  ], "查找入职邮件、考勤系统和工资记录；离职日期从已有的 HR 确认记录中保存，续签或调动文件从合同、邮箱中查找。")
};

const forcedExitRecord = material("forced_resign_notice", "离职通知及送达记录", [
  "离职通知：纸质通知、离职邮件或微信，保留当时写明的离职原因。",
  "送达记录：与通知对应的邮件发送记录、聊天回复或邮寄签收记录，保留时间和接收对象。",
  "尚未提出离职的：发出通知后再补充。"
], "从已发送邮件、原聊天或邮寄记录中保存通知正文和发送、签收信息。纸质通知留副本；记录应对应同一次通知。");

const forcedEvidence = ({ focus, materials, basics, urgent = false }: {
  focus: string;
  materials: EvidenceItem[];
  basics: (keyof typeof basicEvidence)[];
  urgent?: boolean;
}): EvidenceConfig => ({
  title: "证据准备清单",
  savedLabel: "已准备",
  userTip: focus,
  reminder: urgent
    ? "先确保人身安全，不必为收齐材料留在危险现场；符合立即解除情形的，无需事先通知公司。"
    : undefined,
  sections: [section("forced_specific", "证明“被迫”离职", [
    ...materials,
    urgent ? { ...forcedExitRecord, priority: "optional", preparationItems: ["已有离职邮件、微信或纸质通知：保留当时说明的原因和时间。", "已有发送或签收记录：与通知正文一起保留。"], acquisition: "从已发送邮件、原聊天或邮寄记录中保存已有文件及发送、签收信息。" } : forcedExitRecord
  ]), section("forced_basics", "基础证明材料", basics.map(key => basicEvidence[key]))]
});

const reasonEvidenceMap: Record<string, EvidenceConfig> = {
  company_proposed_mutual_termination: {
    title: "证据准备清单",
    savedLabel: "已准备",
    userTip: "保留公司提出协商离职的记录、双方签署的协议和实际付款记录。",
    sections: [section("mutual_termination_core", "协商离职核心材料", [
      material("mutual_negotiation_records", "协商离职沟通记录", [
        "HR 或领导的聊天、邮件或已有录音：保留公司提出协商离职的内容。",
        "协商方案：有书面方案或补偿报价的，保留对应文件和双方回复。"
      ], "从原聊天、邮箱保存完整沟通及附件；已有录音保留原文件。保留对方身份和时间。"),
      material("mutual_signed_agreement", "解除协议", [
        "双方签署的纸质协议或电子协议：保存完整版本，包含离职日期、补偿金额、工资等结算项目和支付时间。",
        "补充协议或结算附件：有则一起保存。"
      ], "纸质协议保留双方签署的完整原件；电子协议从签约平台或邮件下载。尚未签署的，签署后补充。"),
      material("mutual_settlement_payment", "结算及到账记录", [
        "公司结算明细：列明补偿、工资、奖金等各项金额。",
        "银行到账记录：与结算明细对应；分次付款的，分别保存。",
        "交接完成记录：协议约定交接后付款的，保留交接单或公司确认完成的聊天、邮件。"
      ], "结算明细向 HR 或财务索取；到账记录从银行 App 导出。尚未结算或付款的，之后补充。")
    ])],
    supplementaryEvidence: [section("mutual_amount_dispute", "核对补偿金额时补充", [
      material("mutual_contract_terms", "劳动合同", [
        "劳动合同：保留完整合同，核对工资等约定。",
        "调薪或变更文件：有工资调整、合同变更的，一并保留。"
      ], "从纸质合同、电子签约平台或邮箱保存完整文件；缺失的合同、调薪或变更文件可向 HR 索取。", true),
      material("mutual_salary_records", "工资及奖金记录", [
        "工资流水和工资条：保留需要核对期间的发薪记录及工资构成。",
        "奖金或提成约定及明细：涉及这些款项的，保留对应规则、业绩或结算记录。"
      ], "工资流水从银行 App 导出；工资条从薪资系统或工资邮件下载。奖金、提成规则及明细从公司文件查找，缺失的向 HR 或财务索取。", true),
      material("mutual_service_records", "工作年限记录", [
        "入职记录：入职登记、首次考勤或首次工资记录，保留能看出实际入职日期的材料。",
        "续签合同或社保缴费记录：保留能核对连续工作期间的材料，有多份相关记录可一起保存。"
      ], "查找入职邮件、考勤和工资记录；续签合同从纸质原件或签约平台保存，社保记录从社保官方渠道下载。", true)
    ], "协商或核对金额时查阅，不计入上方准备进度。")]
  },
  self_resign_normal: {
    title: "主动离职，建议留存这些材料",
    savedLabel: "已保存",
    reminder: "办理离职后，记得领取并保存离职证明。",
    userTip: "尚未交接或结算的材料，完成后再补充。",
    sections: [section("voluntary_resign_records", "主动离职材料留存", [
      material("resignation_application", "辞职通知及提交记录", [
        "辞职邮件、离职系统申请或书面辞职通知：留一份完整通知，连同发送、提交或签收记录保存。"
      ], "从已发送邮件或离职系统保存正文和提交时间。纸质通知留副本及签收记录。"),
      material("resignation_handover", "离职日期及交接记录", [
        "最后工作日确认：保留 HR 确认日期的邮件、聊天或流程记录。",
        "交接单或公司确认：保存交接完成记录，有归还物品的，一并保留签收记录。"
      ], "从离职系统、邮件或工作聊天保存。纸质交接单可留签字副本。"),
      material("resignation_settlement", "工资结算及到账记录", [
        "最后一期工资条或结算明细：保存工资及其他结算项目和金额。",
        "对应的银行到账记录：与结算明细一起核对。"
      ], "从薪资系统下载工资条，或向 HR、财务索取明细。到账记录从银行 App 导出。")
    ])],
    supplementaryEvidence: [section("resignation_settlement_dispute", "结算有争议时补充", [
      material("resignation_contract", "劳动合同及变更文件", [
        "劳动合同：保留有争议的工资等约定。有调薪通知或变更协议的，一并保存。"
      ], "从纸质原件、签约平台或邮件保存，缺失的可向 HR 索取。"),
      material("resignation_salary_history", "历史工资记录", [
        "相关期间的工资条和工资流水：只补有争议的月份，已保存的最后一期不用重复下载。"
      ], "工资条从薪资系统或邮件下载，流水从银行 App 或柜台导出。"),
      material("resignation_bonus_terms", "奖金、提成约定及明细", [
        "奖金规则或提成约定：有未结算的奖金或提成时，连同自己的业绩和结算明细保存。"
      ], "从奖金通知、合同附件或工作系统保存可查阅的记录，个人结算明细可向财务索取。")
    ], "只补与争议相关的材料，不计入上方保存进度。")]
  },
  forced_unpaid_or_underpaid_wage: forcedEvidence({
    focus: "保留工资约定、实际发薪和欠薪或扣款记录。",
    materials: [
      material("salary_agreement", "劳动合同", [
        "劳动合同：完整合同，包含工资金额和发薪日期的条款。",
        "调薪通知或薪酬邮件：工资另有约定或调整的，保留对应记录。"
      ], "从合同原件、电子签约平台或邮箱保存文件。工资约定在聊天里的，保留完整对话；缺失的合同或调薪文件可向 HR 索取。"),
      material("actual_salary_payment", "工资条和到账流水", [
        "工资条：欠薪或扣款月份的工资构成及扣款明细。",
        "工资到账流水：对应月份的银行记录，包括未收到工资的期间。",
        "奖金、提成明细：涉及欠发或少发的，保留对应明细。",
        "计算补偿所用的工资记录：补齐离职前12个月；工作不足12个月的，按实际期间准备。"
      ], "从薪资系统、工资邮件保存工资条和明细，缺失的向 HR 或财务索取；从工资卡银行 App 或柜台导出对应期间流水。"),
      material("wage_arrears_communication", "欠薪及扣款沟通记录", [
        "催薪聊天、扣款说明或延期发薪通知：按实际情况保留已有材料，写明涉及的月份和金额。",
        "公司回复：保留公司对欠薪、扣款或付款时间的说明，有则一并保存。"
      ], "从微信、企业微信、工作邮件或公司公告中保存完整内容，保留发出人、日期和上下文。", true)
    ],
    basics: ["service"]
  }),
  forced_no_social_insurance: forcedEvidence({
    focus: "用社保缴费明细对照实际入职和工作时间。",
    materials: [
      material("social_security_records", "社保缴费明细", [
        "社保缴费明细或个人权益记录：应能看到缴费单位、月份、险种和缴费基数，覆盖实际工作期间。"
      ], "从参保地社保官方 App、网站或线下窗口查询、下载。保留完整记录，包括显示未缴费或中断的月份。"),
      material("employment_start_proof", "入职及离职记录", [
        "入职登记、首次考勤或首次工资记录：选择能看出实际入职日期的材料，可一起保留。",
        "最后工作日记录：日期确认邮件、聊天或最后考勤记录，用于对照应缴社保的工作期间；尚未离职的，之后补充。"
      ], "查找入职邮件，导出考勤或工资记录；最后工作日从已有的离职沟通、考勤记录中保存。"),
      material("no_social_security_chat", "社保缴纳沟通记录", [
        "公司通知、聊天或邮件：涉及不缴、补缴或将社保折成现金的已有记录。",
        "社保相关约定：有书面约定或补贴说明的，一并保留。"
      ], "从 HR 聊天、公司邮件或公告中保存原文和附件，保留对方身份、日期及上下文。", true)
    ],
    basics: ["contract", "salary"]
  }),
  forced_bad_conditions: forcedEvidence({
    focus: "保留约定和实际提供的工作条件证据，以便对照。",
    materials: [
      material("contract_working_condition", "劳动合同", [
        "劳动合同：完整合同，保留工作地点、工作内容和防护条件等约定。",
        "岗位说明或录用邮件：相关条件写在这些材料里的，一并保留。"
      ], "查找纸质合同、电子签约文件、招聘或录用邮件；岗位说明可从公司系统保存，缺失的向 HR 索取。"),
      material("work_condition_change", "工作安排变更通知", [
        "调岗、调址、停工或收回设备的通知：按实际发生的变更保留，有书面通知、邮件或聊天均可。"
      ], "从公司公告、邮箱或工作聊天中保存完整通知，保留发出人、时间和具体变更要求。", true),
      material("actual_bad_condition", "工作条件异常记录", [
        "工作现场照片或视频：反映缺少防护用品、条件过差或有危险性的实际工作环境，注明时间和地点。",
        "账号停用或门禁受限记录：如存在无法登录账号、无法进入工作场所的情况，保留提示截图或相关通知。"
      ], "保存已有的现场照片、视频原文件，以及账号、门禁提示或公司通知；能安全记录时再记录，不为取证进入危险现场。")
    ],
    basics: ["salary", "service"]
  }),
  forced_illegal_rules: forcedEvidence({
    focus: "保留制度原文，以及这项制度实际影响你的记录。",
    materials: [
      material("company_rules", "公司规章制度", [
        "员工手册、公司公告或处罚制度：保留涉及自己的制度原文、相关条款、版本和发布时间。"
      ], "从公司系统、工作群、邮箱或纸质手册保存完整文件；公告拍照时保留标题、发布单位和日期。"),
      material("rule_application_records", "处罚及扣款通知", [
        "处罚、扣款或其他执行通知：保留发给自己的具体通知，包含执行理由、金额或要求。"
      ], "从公司通知、邮箱或工作聊天中保存原文和附件；纸质通知拍清楚并保留原件。"),
      material("rule_actual_impact", "扣款明细、休假审批记录", [
        "被扣款的：保存扣款明细及对应工资条或到账流水。",
        "休假被拒的：保存休假申请和审批回复。",
        "其他影响：保留对应的执行结果，按自己实际遇到的情况准备。"
      ], "从薪资系统、银行 App 或请假系统导出记录；通过聊天审批的，保存申请到回复的完整对话。")
    ],
    basics: ["contract", "salary", "service"]
  }),
  forced_contract_trap: forcedEvidence({
    focus: "保留合同、签约前的承诺和签约过程记录。",
    materials: [
      material("contract_original", "劳动合同", [
        "劳动合同：签署的完整版本，标出有争议的条款。",
        "合同附件及补充协议：有则与合同一起保留。",
        "不同版本的合同：有修改前后版本的，一并保留。"
      ], "从纸质原件、签约平台或邮箱保存文件，保留签字盖章页、签署时间和各版本的收发记录。"),
      material("signing_promises", "招聘及录用承诺", [
        "招聘说明、录用通知或 HR 承诺记录：保留与实际合同不一致的具体承诺；有多份相关材料的，一并保存。"
      ], "从招聘平台、录用邮件或 HR 聊天中保存原文，保留职位、公司名称、对方身份和日期。"),
      material("signing_communication", "签约沟通记录", [
        "签约聊天、邮件或已有录音：保留公司如何解释条款、要求签字的完整过程，包含对方身份和时间。"
      ], "从原聊天或邮箱保存完整对话及附件；已有录音保留原文件，不只留下剪辑片段。")
    ],
    basics: ["salary", "service"]
  }),
  forced_violence_or_restriction: forcedEvidence({
    focus: "保留公司威胁、限制自由或强迫工作的具体记录。",
    materials: [
      material("forced_threat_records", "威胁言行记录", [
        "威胁消息、语音或已有录音录像：保留实施者身份、时间，以及要求你做什么的内容。"
      ], "保存原聊天、语音或录音录像文件，不只截取个别句子。先确保安全，不为收集材料再次接触威胁者。"),
      material("incident_records", "强迫工作及限制自由记录", [
        "已有现场照片或视频：能反映被强迫工作、限制出入的情况，注明时间、地点。",
        "限制出入或扣押物品记录：已有相关通知、聊天或记录的，一并保留。"
      ], "保存手头已有的现场文件和相关通知、聊天，并记下当时经过；不要为补拍而返回危险现场。"),
      material("police_or_medical_records", "报警、就医记录及证人线索", [
        "报警回执：已报警的，保留回执或受理记录。",
        "病历及伤情照片：已就医或有伤情记录的，保留已有材料。",
        "目击者线索：有目击者的，记下联系方式和其看到的情况。"
      ], "报警材料向接警或受理单位查询；病历从就诊医院或其官方渠道获取。保留伤情照片原文件，目击者信息按已有联系记录整理。", true)
    ],
    basics: ["contract", "salary", "service"],
    urgent: true
  }),
  forced_dangerous_work: forcedEvidence({
    focus: "把公司的作业指令与现场危险情况对应起来。",
    materials: [
      material("dangerous_work_orders", "作业指令", [
        "工作群消息、工单或书面通知：保留谁在什么时间要求你完成哪项作业。"
      ], "从工作群、派工系统或邮箱保存完整指令及附件，保留发出人、时间和作业内容。"),
      material("dangerous_work_risk", "现场危险记录", [
        "已有现场照片或视频：显示设备故障、防护缺失或危险环境，注明作业地点和时间。",
        "设备故障或防护缺失记录：已有检查、报修等记录的，一并保留。"
      ], "保存手头已有的现场文件和检查、报修记录。先确保安全，不为取证靠近危险设备或进入危险区域。"),
      material("dangerous_work_warnings", "安全警示及停工通知", [
        "安全警示、隐患记录或停工通知：保留已有且与该项作业相关的材料。"
      ], "从现场已有照片、公司公告、工作群或邮箱中保存原文，保留发布日期、发布人和涉及的作业地点。", true),
      material("dangerous_work_objection", "危险作业沟通记录", [
        "反映危险或拒绝作业的记录：已有工作聊天、邮件或投诉记录。",
        "公司回复：有回复的，与前面的反映记录一起保留。"
      ], "从原聊天、邮箱或投诉渠道保存提交内容和回复，保留完整对话、时间及接收对象。", true)
    ],
    basics: ["contract", "salary", "service"],
    urgent: true
  }),
  forced_other_or_unclear: forcedEvidence({
    focus: "先保存公司具体做法和实际影响你的记录。",
    materials: [
      material("forced_other_events", "公司相关沟通记录", [
        "公司通知、聊天或邮件：保留与事件有关的内容，能看出公司做了什么、发生在什么时候。"
      ], "从原工作群、邮箱或公司系统保存完整记录和附件，保留发出人和日期。"),
      material("forced_other_impact", "扣款、调岗等影响记录", [
        "扣款明细：涉及扣款的，保留对应工资记录。",
        "岗位安排：涉及调岗或工作变动的，保留原安排和变更后的记录。",
        "其他受影响记录：按实际发生的事情保留对应材料。"
      ], "扣款记录从薪资系统或工资邮件保存；岗位安排从通知、工作群或邮件查找，保留发生时间和具体变化。")
    ],
    basics: ["contract", "salary", "service"]
  })
};

// 过错辞退：按公司提出的具体理由选材料，不叠加“是否属实”的证据组。
const faultDismissNotice = material("dismiss_reason_notice", "公司解除通知", [
  "解除通知书、辞退邮件或 HR 聊天：保留公司提出的具体理由、解除日期和通知时间。",
  "口头通知的记录：已有录音或后续确认对话，保留通知人和时间。",
  "不同版本的通知：公司前后说法不同的，一起保留。"
], "保存纸质通知、原邮件或完整聊天；已有录音保留原文件。没有书面通知的，可通过邮件或聊天向公司确认。");

type FaultEvidenceConfig = {
  focus: string;
  materials: EvidenceItem[];
  contractNote?: string;
  truthTips?: Partial<Record<string, string>>;
};

const faultReasonEvidence: Record<string, FaultEvidenceConfig> = {
  "试用期没通过": {
    focus: "对照录用条件、试用期考核和实际完成的工作。",
    contractNote: "试用期起止日期：保留约定试用期限的条款，与入职日期和公司通知解除的时间对照。",
    truthTips: {
      fault_pot_basically_true: "保留完整考核结果，以及已有的反馈、改进和验收记录。",
      fault_pot_uncertain_severity: "重点保留具体评分标准、未通过事项及对应工作反馈。",
      fault_not_true_or_exaggerated: "重点保留与不合格事项对应的任务要求、交付和验收记录。"
    },
    materials: [
      material("probation_conditions", "录用条件", [
        "招聘说明、录用通知、录用条件确认书或岗位说明：保留公司提出的具体要求。",
        "告知时间：保留收到或确认这些要求的邮件、聊天或签收记录。"
      ], "从招聘平台、录用邮件、入职文件或 HR 聊天中保存原文和附件；不同时间给出的要求有变化的，一起保留。"),
      material("probation_assessment", "试用期考核记录", [
        "考核表、评分结果或转正评估：保存公司已提供的完整内容。",
        "考核标准和不合格事项：公司已说明具体标准、评分或未通过原因的，一起保留。"
      ], "从考核系统、邮件或主管聊天中保存；未收到结果的，可向 HR 或主管索取，并保留询问和回复。"),
      material("work_performance", "工作完成记录", [
        "项目交付、任务完成记录或主管验收回复：保留与公司指出的不合格事项有关的材料。",
        "对应任务的要求和反馈：与自己的提交内容一起保留，能看出工作要求、完成时间和处理结果。"
      ], "从工作系统、邮件或工作群保存相关记录和附件，保留任务下达到提交、反馈的完整过程。")
    ]
  },
  "严重违反公司制度": {
    focus: "对照公司引用的制度、具体指控和事件实际经过。",
    materials: [
      material("company_rules_and_basis", "公司规章制度", [
        "规章制度原文：公司引用的员工手册、奖惩制度或其他规定，保留相关条款和版本。",
        "制度告知记录：已有的签收页、培训记录、邮件通知或 OA 阅读记录。"
      ], "从公司系统、邮箱、入职文件中保存；缺少公司引用的制度，可向 HR 索取。"),
      material("violation_claim", "公司提出的违纪指控", [
        "公司的指控材料：公司说明你在什么时间、做了什么、违反哪条规定的通知，可以是邮件或聊天截图等。",
      ], "保存公司通知和完整沟通；指控不具体的，可要求说明事件和依据，保留询问及回复。"),
      material("violation_fact", "事件实际经过的记录", [
        "相关记录：与被指控事件有关的完整聊天、邮件、工作记录或其他已有材料。",
        "相关安排或批准：涉及领导指示、事先批准或特殊情况的，保留对应记录。"
      ], "围绕同一事件，从原聊天、邮箱或工作系统中查找，保留时间、参与人和前后经过。"),
      material("employee_defense_records", "申辩及处理记录", [
        "自己的申辩：向公司提交的解释、异议或申辩材料，以及提交记录。",
        "公司的处理：对申辩的回复、复核结果；已有警告、处分或整改记录的，一并保留。"
      ], "从邮件、聊天或申辩系统保存提交内容和公司回复；纸质材料保留副本及签收记录。", true)
    ]
  },
  "严重失职，造成重大损失": {
    focus: "对照自己的职责、事故经过和公司所说的损失。",
    materials: [
      material("responsibility_scope", "岗位职责及工作分工", [
        "岗位说明或任务分工：保留自己负责的部分，以及相关人员的职责。",
        "操作流程或审批权限：保留哪些事项需要审批、由谁审批的规定和工作安排。"
      ], "从岗位文件、项目系统、工作邮件或群聊保存相关文件，保留当时适用的版本。"),
      material("damage_records", "事故及损失记录", [
        "事故报告、损失清单或客户投诉：保存公司已提供的完整材料。",
        "退款、赔付或结算记录：涉及损失金额的，保留手头已有的对应记录。"
      ], "保存公司发来的文件；公司只说造成损失的，可要求说明具体事项、金额和依据，保留询问及回复。"),
      material("fault_work_process", "工作过程及补救记录", [
        "工作过程：与事件有关的工作指令、审批、风险汇报和实际执行记录。",
        "补救结果：已经补救的，保留处理方案、完成记录和结果确认。"
      ], "从项目系统、邮件或工作群保存完整过程，包含主管指示和相关附件；已有验收、修复或损失结算结果的，一起保存。")
    ]
  },
  "还在其他单位工作": {
    focus: "保留另一份工作的实际安排、本职工作记录和已有改正沟通。",
    truthTips: {
      fault_pot_basically_true: "保留两份工作的时间安排，以及公司知情或同意的已有记录。",
      fault_pot_uncertain_severity: "重点保留本职工作完成情况，以及已有改正通知和自己的处理结果。",
      fault_not_true_or_exaggerated: "重点保留另一份工作的实际性质、工作时间和本职任务完成记录。"
    },
    materials: [
      material("other_employment", "另一份工作的相关记录", [
        "劳动合同、兼职或服务协议：保留实际签署的完整文件，以及工作安排、结算记录。",
        "公司知情或同意的记录：公司此前已经知情或批准的，保留对应沟通。"
      ], "从自己签署的文件、接单平台、邮箱或聊天中保存，保留工作内容、时间安排和结算信息。"),
      material("work_impact", "本职工作记录", [
        "考勤、任务交付和验收记录：保留公司指控期间的实际工作情况。",
        "相关说明及审批：涉及迟到、缺勤或工作延误的，保留对应解释、请假或其他审批记录。"
      ], "从考勤、项目系统或工作邮件导出对应期间记录，保留完整任务要求、提交内容和反馈。"),
      material("correction_request", "改正通知及回复", [
        "公司要求改正的通知：已有停止另一份工作的通知、邮件或聊天。",
        "自己的回复和处理结果：已经停止、调整或解除另一份工作的，保留对应记录。"
      ], "保存完整通知和回复；已有解约文件、平台停用或工作调整记录的，一并保留。", true)
    ]
  },
  "入职时提供了虚假信息": {
    focus: "对照入职提交的版本、公司的录用要求和被质疑信息的核验结果。",
    truthTips: {
      fault_pot_basically_true: "保留当时提交的版本，以及已有说明、更正和公司回复。",
      fault_pot_uncertain_severity: "重点保留公司对该项信息的具体录用要求及相关沟通。",
      fault_not_true_or_exaggerated: "重点保留被质疑信息的核验结果，以及当时已经向公司说明的记录。"
    },
    materials: [
      material("hiring_materials", "入职提交材料", [
        "当时提交的简历或入职登记表：保留投递、提交时的版本。",
        "被质疑的证明材料：公司质疑学历、经历或资格的，保留当时提交的对应文件。"
      ], "从招聘平台投递记录、已发送邮件或入职系统保存原文件和提交时间。"),
      material("fault_hiring_communication", "招聘及录用沟通", [
        "招聘要求、录用通知或 HR 询问记录：保留与被质疑事项有关的要求和答复。",
        "已有说明或更正：自己已经向公司说明、更正过相关信息的，保留说明和公司回复。"
      ], "从招聘页面、邮件或原聊天中保存完整记录，保留公司提出要求和自己作出说明的时间。"),
      material("truth_explanation", "信息核验材料", [
        "学历被质疑的：保留学历认证或官方查询结果。",
        "资格被质疑的：保留证书和对应官方查询结果。",
        "工作经历被质疑的：保留原单位劳动合同、离职证明或相关工作记录；只按被质疑的事项准备。"
      ], "从对应官方查询渠道、原单位或自己已有文件中获取，保留查询日期和完整结果。")
    ]
  },
  "被依法追究刑事责任": {
    focus: "对照正式案件文书和公司解除时依据的材料。",
    truthTips: {
      fault_pot_basically_true: "保留完整处理结果及后续文书，不只保留文书标题。",
      fault_pot_uncertain_severity: "重点保留文书载明的案件性质、处理结果和日期。",
      fault_not_true_or_exaggerated: "重点保留与公司说法不一致的正式文书，以及向公司的说明记录。"
    },
    materials: [
      material("criminal_documents", "案件处理文书", [
        "正式处理文书：与公司解除理由有关的判决书、裁定书、不起诉决定或其他正式文书。",
        "后续处理结果：案件后续有新文书的，一起保留；涉及行政处罚或民事纠纷的，保留对应文书。"
      ], "从自己收到的文书、办案机关或代理律师处获取完整文件，保留日期及送达信息。"),
      material("fault_case_communication", "与公司的说明记录", [
        "公司依据的材料或说法：保留公司引用的文件、消息及相关沟通。",
        "自己的说明和公司回复：向公司说明案件情况、提交处理结果的邮件或聊天，连同附件一起保存。"
      ], "从原邮件、聊天中保存完整内容和附件，保留提交时间、接收对象及公司回复。", true)
    ]
  }
};

const faultOtherEvidence: FaultEvidenceConfig = {
  focus: "先保留公司解除的通知，再确认具体理由和依据。",
  materials: [
    material("reason_explanation_request", "询问解除理由的记录", [
      "自己的询问：要求公司说明具体事件、解除理由和依据的邮件或聊天。",
      "公司回复：保留完整答复；公司没有回复的，保留已发送记录。"
    ], "从原聊天或已发送邮件保存，保留接收对象、发送时间和附件。"),
    material("fault_stop_work_records", "停止工作安排记录", [
      "公司工作安排：要求停止上班、交接或归还设备的通知。",
      "账号或门禁停用记录：有停用提示的，保留截图及相关沟通，与公司通知一起核对。"
    ], "保存公司通知、系统提示和完整对话，注明时间；这些记录用于补充说明经过，不单凭账号或门禁停用判断已经被辞退。", true)
  ]
};

const faultTruthTips: Record<string, string> = {
  fault_pot_basically_true: "保留完整经过、公司依据及已有补救记录。",
  fault_pot_uncertain_severity: "重点保留实际后果、审批或授权，以及补救结果的记录。",
  fault_not_true_or_exaggerated: "重点保留与指控直接对应的完整记录，以及公司前后不同的说法。"
};

const getFaultReason = (answers: Answers, leafId: string) => {
  if (leafId === "fault_reason_other_or_unclear") return "";
  const reason = answers.followUps?.FAULT_DISMISS_CHECK ?? "";
  return Object.prototype.hasOwnProperty.call(faultReasonEvidence, reason) ? reason : "";
};

const buildFaultDismissEvidence = (reason: string, leafId: string): EvidenceConfig => {
  const selected = faultReasonEvidence[reason] ?? faultOtherEvidence;
  const truthTip = selected === faultOtherEvidence ? "" : selected.truthTips?.[leafId] ?? faultTruthTips[leafId] ?? "";
  const contract = selected.contractNote
    ? { ...basicEvidence.contract, preparationItems: [...basicEvidence.contract.preparationItems, selected.contractNote] }
    : basicEvidence.contract;
  return {
    userTip: selected.focus + truthTip,
    sections: [
      section("fault_specific", "与辞退理由相关的证据", [faultDismissNotice, ...selected.materials]),
      section("fault_basics", "基础证明材料", [contract, basicEvidence.salary, basicEvidence.service])
    ]
  };
};

const employerEvidence = "公司掌握的材料可先记下名称、日期和经办部门，争议中可依法申请由公司提供或调取。";

const settlement = material("exit_settlement", "工资、补偿结算及到账记录", [
  "结算单或最后一期工资条：核对工资、补偿及其他结算项目。尚未结算的，收到后补充。",
  "对应的银行到账记录：保存已有入账，分次支付的逐笔核对。"
], "向 HR 或财务索取结算明细，工资条从薪资系统下载，到账记录从银行 App 导出。");

const wageSettlement = material("expiry_wage_settlement", "工资结算及到账记录", [
  "最后一期工资条或结算单：保留工资及其他实际结算的项目。",
  "对应的银行到账记录：尚未付款的，到账后补充。"
], settlement.acquisition);

const amountDispute = section("exit_amount_dispute", "核对结算金额时补充", [
  material("exit_wage_history", "历史工资条及银行流水", [
    "历史工资记录：核对补偿基数时保留离职前12个月，工作不足12个月的按实际期间。核对欠发款项时只补对应月份。"
  ], "从薪资系统、工资邮件及银行 App 导出。已保存的结算记录可直接使用。"),
  material("exit_start_history", "入职日期及连续工作记录", [
    "入职登记、首次考勤或首次工资记录：入职时间有争议时选存能看出日期的记录。",
    "历次续签或用工主体变更文件：工作年限有争议时再补充，已有合同直接使用。"
  ], "从入职邮件、签约平台或考勤系统查找，也可向 HR 索取。")
], "按争议项目补充。");

const exitTerms = material("expiry_termination_record", "合同终止日期及离职证明", [
  "终止通知或离职证明：保留载明终止原因、日期的文件。已有不续签通知写清这些信息的，直接使用。",
  "到期后的排班、考勤或工作指令：到期后仍在上班的，保留继续工作的记录。"
], "从 HR 邮件、离职系统或手头原件保存。到期后仍上班的，从自己的考勤和任务记录查找。");

const noFaultNotice = (notice: "yes" | "no" | "unchecked") =>
  material("nofault_dismiss_notice", "公司解除通知", [
    "书面解除通知、辞退邮件或 HR 聊天：保留公司实际提出的理由、解除日期和引用的依据。",
    "收到通知的时间：" + (notice === "yes"
      ? "保存邮件收件时间、签收单或邮寄送达记录，核对是否提前30日书面通知。"
      : notice === "no"
        ? "保存首次告知及后续书面通知的时间，核对是否另付一个月工资。"
        : "保存自己实际收到通知的日期；只有口头通知的，留已有录音或后续确认。"),
    "工会通知或意见：公司设有工会，且本人已收到相关记录的，可一并留存。"
  ], "从原件、邮件或聊天保存完整通知。只有口头通知的，可书面请 HR 确认理由和日期。");

const noFaultGrounds = {
  medical: {
    title: "医疗期满解除",
    tip: "核对自己的病休时间，以及公司是否安排过复工或其他岗位。",
    items: [
      material("medical_period_records", "病休记录及医疗期核算", [
        "病休建议单和请假审批：按日期保存，对照实际休假起止。有续假或医疗期延长记录的，一并保留。",
        "公司给出的医疗期起止：已有到期告知或计算表的，与自己的病休和工龄记录核对。",
        "核算所用的工龄记录：有争议时补入职日期，以及当地口径需要的过往工作经历。"
      ], "从就诊医院、请假及签约系统查找。计算明细可向 HR 询问，已有工龄材料直接使用。"),
      material("work_arrangement_after_medical", "复工及另行安排的工作记录", [
        "复工申请、返岗考勤或工作交付：有返岗经历的，保留能反映实际工作情况的记录。",
        "另行安排的岗位通知及回复：有安排的，保留职责、到岗反馈及公司对能否胜任的说明。无安排的，可保留询问和回复。",
        "已有工作能力相关意见：涉及复工限制或鉴定的，保存医嘱或已有鉴定结论。"
      ], "从考勤系统、邮件或聊天保存。医疗或鉴定文件从医院或出具机构获取。")
    ]
  },
  incompetent: {
    title: "不能胜任工作解除",
    tip: "把公司的考核结论、自己的工作成果和培训或调岗记录放在一起核对。",
    items: [
      material("performance_assessment_records", "岗位要求及不胜任考核", [
        "岗位说明、目标或评分标准：保留适用的版本和公司告知时间。",
        "考核结果或绩效改进计划：留完整内容及自己的反馈，特别是公司指出的未达标事项。"
      ], "从绩效系统、工作邮件或聊天保存能查阅的版本。缺少具体评分或依据，可向 HR 询问。"),
      material("performance_deliveries", "工作交付及验收记录", [
        "任务提交、工作数据或验收回复：挑选与争议指标直接对应的记录，保留要求、完成时间和反馈。"
      ], "从自己的工作邮件、聊天或有权查阅的任务系统保存。"),
      material("training_or_transfer_records", "培训或调岗及后续考核", [
        "培训记录或调岗通知：按实际发生的情况保存，保留时间、内容或新岗位职责。",
        "后续考核或工作评价：如有，保留培训或调岗后的结果及反馈。"
      ], "从培训通知、调岗文件及绩效系统保存，缺少的可向主管或 HR 索取。", true)
    ]
  },
  major_change: {
    title: "客观情况重大变化解除",
    tip: "对照原合同、实际变化，以及双方谈过的合同变更方案。",
    items: [
      basicEvidence.contract,
      material("objective_change_records", "岗位、地点或业务变化通知", [
        "公司说明变化的文件：按实际情况保存撤岗、搬迁、业务调整等通知。",
        "原工作是否仍能继续的记录：有现行排班、任务安排或公司公开招聘同一岗位等线索的，可一并保留。"
      ], "从公司公告、工作邮件、已有工作安排或公开招聘页保存，保留发布时间和来源。"),
      material("contract_change_negotiation", "变更劳动合同的方案及回复", [
        "公司提出的变更方案：保留岗位、地点、薪资等具体条件。",
        "双方回复或会议纪要：连同自己的意见一起保留，记录谈过的方案和最终结果。"
      ], "从邮件、聊天或已收到的书面方案保存。只有口头协商的，可书面确认。", true)
    ]
  }
};

const noFaultEvidence = (ground: keyof typeof noFaultGrounds, notice: "yes" | "no" | "unchecked"): EvidenceConfig => {
  const { title, tip, items } = noFaultGrounds[ground];
  const extraPay = notice === "no" ? {
    ...settlement,
    preparationItems: [...settlement.preparationItems, "额外支付的一个月工资：有单列的，保存金额、付款日期及对应入账。"]
  } : settlement;
  return {
    userTip: tip,
    sections: [section("nofault_dismissal", title, [noFaultNotice(notice), ...items, extraPay])],
    supplementaryEvidence: [amountDispute]
  };
};

const unclearDismissal: EvidenceConfig = {
  userTip: "先保存公司实际说的解除理由。理由没说清的，保留你询问和公司回复的记录。",
  sections: [section("unclear_dismissal", "解除通知及实际经过", [
    faultDismissNotice,
    material("actual_dismissal_reason_records", "公司说明解除依据的记录", [
      "公司单独发来的依据：已有引用的制度条款、处理决定或说明附件的，连同说明保存。",
      "询问依据的邮件或聊天：公司没有说明的，保留你的询问和已有答复。"
    ], "从原邮件、聊天及已有附件保存，通知本身已写清的内容可直接使用。", true),
    material("dismissal_actual_events", "与公司说法对应的工作记录", [
      "考勤、交付或岗位安排：只保存与公司说法有关的记录。",
      "停工或交接安排：理由不明时，保留要求停止工作、交接或者门禁停用的相关通知和确认。"
    ], "从自己的考勤、工作聊天或邮件中保存。记录时间并保留前后沟通。", true),
    settlement
  ])],
  supplementaryEvidence: [amountDispute]
};

const layoffSelection = section("layoff_selection_dispute", "裁员选人有争议时补充", [
  material("layoff_selection_records", "裁员选人标准及优先留用材料", [
    "公司已公开的选人标准或个人评估结果：保留收到的版本。",
    "应对应自身情形的材料：较长期固定期限或无固定期限合同。家庭无其他就业人员且有需扶养的老人或未成年人的，保留能说明这两项事实的已有材料。"
  ], "从已收到的裁员方案、HR 回复和个人合同中找。家庭情况可按实际保存亲属关系及就业状态材料。" + employerEvidence)
], "涉及优先留用或选人标准争议时再补。");

const layoffEvidence = (notice: "yes" | "no" | "unchecked"): EvidenceConfig => ({
  userTip: "先保存公司对你个人的解除通知，再留存你收到的裁员方案和程序记录。",
  sections: [section("economic_layoff", "经济性裁员材料", [
    material("layoff_notice", "个人裁员解除通知", [
      "解除通知书、裁员邮件或 HR 聊天：留清楚公司对你提出的解除理由、收到通知和实际解除的日期。"
    ], "保存收到的完整通知和签收信息。只有口头告知的，可书面请 HR 确认。"),
    material("layoff_plan", "裁员方案及裁减范围", [
      "方案、公告或说明会材料：保存已看到的版本，留意裁员原因、范围和计划人数。",
      "人数线索：有公开的裁减人数或企业职工总数的，一并留存。"
    ], "从公司发给员工的公告、邮件或会议资料保存。" + employerEvidence),
    material("all_hands_notice", "工会或全体职工的裁员说明记录", [
      notice === "no"
        ? "首次得知裁员的记录：保存当时的群通知、公司回应或同事可核实的线索，和个人解除日期对照。"
        : "裁员说明通知或会议记录：保存向工会或全体职工说明的对象、日期及会议内容。",
      "工会或职工意见及行政报告线索：收到征求意见通知、工会回复或报告信息的再保留。"
    ], "从自己收到的会议邀请、工会通知或群公告保存。" + employerEvidence, true),
    settlement
  ])],
  supplementaryEvidence: [layoffSelection, amountDispute]
});

const expiredContract = material("expired_contract", "到期劳动合同及续签文件", [
  "原劳动合同：保留完整签署版和合同起止时间。",
  "续签、延长或变更协议：有则一起保存，按最后有效的文件核对期限和条件。"
], "从纸质原件、电子签约平台或邮件查找，缺失的可向 HR 索取。");

const companyNoRenew = material("company_not_renew_notice", "公司不续签通知及本人回复", [
  "不续签通知、邮件或 HR 聊天：留清楚是谁决定不续签及通知日期。",
  "本人提出续签的记录：已有续签申请或答复的，保留提交内容和公司回应。"
], "从原邮件、聊天或签收文件保存。仅口头通知的，可书面请 HR 确认。");

const renewalOffer = material("company_renewal_offer", "公司续签邀约及条件", [
  "续签通知、新合同草案或书面答复：保留公司提出的工资、岗位、地点和期限等条件，与原合同对照。"
], "从 HR 邮件、聊天或签约系统保存各版本。只有口头方案的，可请 HR 书面确认。");

const renewals = {
  company: {
    userTip: "保存最后一份合同和公司不续签的记录。到期后仍在工作的，保留之后的排班和任务。",
    sections: [section("company_not_renew", "公司不续签材料", [expiredContract, companyNoRenew, exitTerms, settlement])],
    supplementaryEvidence: [amountDispute]
  },
  employee: {
    userTip: "把公司给出的续签条件和自己的不续签回复放在一起保存。",
    sections: [section("employee_not_renew", "本人不续签材料", [
      expiredContract, renewalOffer,
      material("employee_refusal_records", "本人不续签的回复", [
        "不续签邮件、聊天或已提交表单：留提出时间、原话和公司签收、确认记录。"
      ], "从已发送邮件、原聊天或续签流程导出。签字文件留完整副本。"),
      exitTerms, wageSettlement
    ])],
    supplementaryEvidence: [amountDispute]
  },
  lowerTerms: {
    userTip: "保留原约定、新方案和你的回复，三份记录对照着看。",
    sections: [section("lower_renewal_terms", "续签条件降低材料", [
      { ...expiredContract, name: "到期劳动合同及原约定", preparationItems: [
        ...expiredContract.preparationItems,
        "原条件的书面约定：变化涉及工资、福利、地点或岗位的，保留相关合同附件及后续约定。"
      ] },
      { ...renewalOffer, id: "new_contract_terms", name: "新合同草案及降低条件的通知" },
      material("refuse_due_to_lower_terms", "对降低条件的异议及回复", [
        "本人提出异议的邮件或聊天：保留你指出的变化、是否愿意按原条件续签及公司回复。"
      ], "保存双方往来原文及附件，有多轮方案的按时间一起保留。"),
      exitTerms, settlement
    ])],
    supplementaryEvidence: [amountDispute]
  }
} satisfies Record<string, EvidenceConfig>;

const companyClosure: EvidenceConfig = {
  userTip: "按公司实际状态查找对应文件，再核对劳动合同终止日期和欠付金额。",
  sections: [section("company_disappeared", "公司状态及终止结算", [
    material("company_status_records", "解散、宣告破产或行政处理文件", [
      "公司决定提前解散：保存已收到的解散通知、决议或可公开查看的清算公告。",
      "法院宣告破产：保存宣告破产裁定或公告。仅查到受理、重整的，先保留对应文书，等待核实后续状态。",
      "吊销营业执照、责令关闭或撤销：保存相关机关决定或能够看到具体处理的公开信息。",
      "仅停业或失联：保存停工通知、联系记录和已有登记信息，供后续确认。"
    ], "企业登记、处罚及清算公告可查国家企业信用信息公示系统，破产文书可查全国企业破产重整案件信息网。保存公司全称、来源和日期。"),
    material("company_termination_notice", "终止通知或离职证明", [
      "公司、清算组或管理人发出的文件：保存涉及本人终止原因和日期的通知或证明。",
      "没有收到通知时：保留最后上班、停工或交接记录，以及询问终止日期的沟通。"
    ], "从收到的原件、邮箱或聊天保存。已有清算组或管理人联系方式的，可向其查询。"),
    basicEvidence.contract,
    settlement
  ])],
  supplementaryEvidence: [
    section("bankruptcy_employee_claims", "进入破产程序时补充", [
      material("bankruptcy_employee_claim_list", "本人职工债权清单及异议记录", [
        "管理人公示的本人债权项目：核对欠薪、法定补偿等金额和期间。",
        "更正申请及管理人回复：金额有误或漏列的，保存提交记录和回复。"
      ], "从管理人公示渠道查询本人记录。法定范围内的职工债权由管理人调查列示，有异议可要求更正。")
    ]),
    amountDispute
  ]
};

const protectionMaterials = {
  occupationalCheck: material("protection_occupational_check", "职业危害岗位及离岗体检记录", [
    "岗位说明或职业危害告知书：保留实际接触危害的岗位、工种和期间。",
    "离岗体检安排及结果：保留预约、询问、公司回复或已有报告，核对离岗前是否安排检查。"
  ], "从签收的岗位材料、体检机构及已有沟通中保存。公司掌握的职业健康监护材料可依法申请提供。"),
  suspectedDisease: material("protection_suspected_disease", "疑似职业病诊断或医学观察记录", [
    "医疗机构告知、诊断受理或医学观察记录：保留开始时间、出具单位及诊断或观察进展。"
  ], "从职业病诊断机构、就诊医院或个人已收到的文书中获取。"),
  workInjury: material("protection_work_injury", "工伤认定及劳动能力鉴定结论", [
    "本单位工伤认定或职业病诊断文书：连同劳动能力鉴定结论保存，核对认定单位、日期和伤残等级。",
    "已有的复查鉴定：结果有变化的，保存最新结论及送达时间。"
  ], "从人社部门、职业病诊断机构或劳动能力鉴定委员会保存送达文书，有电子件的可从对应政务渠道下载。"),
  medical: material("protection_medical", "非工伤病休记录及医疗期核算", [
    "病休建议单和请假审批：保留病休和续假日期，核对通知解除或合同到期时是否仍处于医疗期。",
    "实际工作年限及在本单位工龄的记录：按适用口径找劳动合同、入职记录或可印证经历的社保记录。有医疗期延长记录的一并保存。"
  ], "向医院获取病休文件，从请假、签约系统或社保官方渠道查找。主清单已有的合同可直接使用。"),
  maternity: material("protection_maternity", "孕期、产期或哺乳期的日期材料", [
    "按实际阶段选存：孕检或诊断记录、出生医学证明，或产假与哺乳期相关记录。保留能核对相关日期的页面即可。"
  ], "从就诊机构、个人证件或公司休假系统获取。已有向公司提交的记录可一起保存。"),
  retirement: material("protection_retirement", "连续工龄及法定退休年龄材料", [
    "本单位连续工作记录：核对是否满15年，已有合同、续签、入职或岗位承继材料可相互印证。",
    "出生年月及法定退休时间：按本人适用的退休类别和渐进式延迟退休规则，核对当时距法定退休年龄是否不足5年。"
  ], "从本人证件和工作档案查找，退休时间可通过人社官方渠道查询。上方已留合同的无需重复。")
};

const withProtection = (config: EvidenceConfig, scene: "dismissal" | "medical" | "expiry"): EvidenceConfig => ({
  ...config,
  userTip: config.userTip + "再按实际情况补充下方的特殊保护材料。",
  supplementaryEvidence: [
    section("article42_protection", "特殊保护情形补充材料",
      Object.entries(protectionMaterials).filter(([id]) => scene !== "medical" || id !== "medical").map(([, item]) => item),
      scene === "expiry"
        ? "只准备符合自身情况的材料。核对合同应否续延，工伤情形按伤残等级和工伤保险规定核对。"
        : "只准备符合自身情况的材料，核对公司按当前理由解除时你是否处于相应保护期间。"),
    ...(config.supplementaryEvidence ?? [])
  ]
});

const unsureEvidence: EvidenceConfig = {
  userTip: "先整理是谁提出离职、当时说明的原因和收到通知的时间。",
  sections: [section("unsure_exit", "先保留的离职材料", [
    material("unsure_exit_notice", "离职提出及日期确认记录", [
      "离职通知、邮件或聊天：保存实际提出离职的一方、理由、通知和离职日期。",
      "已有的协议或公司说明：保留已收到或签署的版本。"
    ], "从原邮件、聊天、纸质文件或签约平台保存。只有口头说法的，可书面向对方确认。"),
    settlement
  ])]
};

// 历史问卷仍可从本地恢复，按当时记录的场景生成材料。
const legacyEvidence: ReadonlyMap<string, EvidenceConfig> = new Map([
  ["layoff", {
    userTip: "保存公司说明的调整或裁员原因，以及实际提出的安排。",
    sections: [section("legacy_business_adjustment", "业务调整或裁员材料", [
      noFaultNotice("unchecked"), ...noFaultGrounds.major_change.items, settlement
    ])],
    supplementaryEvidence: [
      section("legacy_collective_layoff", "公司按经济性裁员处理时补充", layoffEvidence("unchecked").sections[0].items.slice(1, 3)),
      layoffSelection, amountDispute
    ]
  }],
  ["performance", noFaultEvidence("incompetent", "unchecked")],
  ["discipline", buildFaultDismissEvidence("严重违反公司制度", "discipline")],
  ["probation", buildFaultDismissEvidence("试用期没通过", "probation")],
  ["contractEnd", {
    userTip: "保留合同和双方对续签的原始答复，核对是谁提出不再续签及当时的条件。",
    sections: [section("legacy_contract_expiry", "到期及续签材料", [
      expiredContract,
      renewalOffer,
      material("legacy_renewal_responses", "双方是否续签的回复", [
        "双方决定续签或不续签的通知、邮件或聊天：保留原话、时间及后续回复。"
      ], "从邮件、聊天或续签系统保存。通知已经记在终止文件上的，可使用同一份文件。"),
      exitTerms, settlement
    ])],
    supplementaryEvidence: [amountDispute]
  }],
  ["resignation", {
    userTip: "优先保存公司要求你辞职的原话和后来实际提交、签署的文件。",
    sections: [section("legacy_requested_resignation", "公司要求辞职的记录", [
      material("requested_resignation", "公司要求本人辞职的通知", [
        "HR 或主管聊天、邮件或已有录音：保留要求你辞职时的说法和时间。",
        "实际安排：已有停工、交接或账号停用的通知，可一并保存。"
      ], "从原聊天、邮箱保存完整记录，已有录音留原文件。"),
      material("requested_resignation_documents", "提交或签署的离职文件", [
        "已提交的辞职文件、签署的协议或收到的解除通知：按实际保存，保留版本和提交、签收时间。"
      ], "从离职系统、邮件、签约平台或本人持有的纸质文件保存。", true),
      settlement
    ])]
  }],
  ["mutual", reasonEvidenceMap.company_proposed_mutual_termination],
  ["unclear", unsureEvidence],
  ["other", unsureEvidence]
]);

const evidenceByReason: ReadonlyMap<string, EvidenceConfig> = new Map([
  ...Object.entries(reasonEvidenceMap),
  ...legacyEvidence,
  ["nofault_medical_notice_yes", noFaultEvidence("medical", "yes")],
  ["nofault_medical_notice_no", noFaultEvidence("medical", "no")],
  ["nofault_medical_article42_protected", withProtection(noFaultEvidence("medical", "unchecked"), "medical")],
  ["nofault_incompetent_notice_yes", noFaultEvidence("incompetent", "yes")],
  ["nofault_incompetent_notice_no", noFaultEvidence("incompetent", "no")],
  ["nofault_incompetent_article42_protected", withProtection(noFaultEvidence("incompetent", "unchecked"), "dismissal")],
  ["nofault_major_change_notice_yes", noFaultEvidence("major_change", "yes")],
  ["nofault_major_change_notice_no", noFaultEvidence("major_change", "no")],
  ["nofault_major_change_article42_protected", withProtection(noFaultEvidence("major_change", "unchecked"), "dismissal")],
  ["nofault_not_listed_excuse", unclearDismissal],
  ["layoff_notice_to_union_or_all_yes", layoffEvidence("yes")],
  ["layoff_notice_to_union_or_all_no", layoffEvidence("no")],
  ["layoff_article42_protected", withProtection(layoffEvidence("unchecked"), "dismissal")],
  ["contract_expired_company_not_renew", renewals.company],
  ["contract_expired_employee_not_renew", renewals.employee],
  ["contract_expired_company_lower_terms", renewals.lowerTerms],
  ["contract_expired_protected_status", withProtection(renewals.company, "expiry")],
  ["termination_company_disappears", companyClosure]
]);

export const buildEvidenceChecklist = (result: CalculationResult, answers: Answers): EvidenceChecklist => {
  const leafId = result.terminationReasonId;
  const isFault = leafId === "fault_reason_other_or_unclear" || Object.prototype.hasOwnProperty.call(faultTruthTips, leafId);
  const faultReason = isFault ? getFaultReason(answers, leafId) : "";
  const config = isFault
    ? buildFaultDismissEvidence(faultReason, leafId)
    : evidenceByReason.get(leafId) ?? unsureEvidence;

  return {
    ...config,
    key: isFault && leafId !== "fault_reason_other_or_unclear" ? leafId + ":" + faultReason : leafId,
    leafText: answers.terminationReasonText || result.terminationHint
  };
};
