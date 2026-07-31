import type { Answers } from "../types";
import type { CalculationResult } from "../utils/calculate";

export type EvidencePriority = "required" | "recommended" | "optional";
export type EvidenceItem = {
  id: string;
  name: string;
  priority: EvidencePriority;
  purpose: string;
  examples: string[];
};
export type EvidenceSection = {
  id: string;
  title: string;
  description: string;
  items: EvidenceItem[];
};
export type EvidenceChecklist = {
  leafId: string;
  leafText: string;
  compensationResult: string;
  commonEvidence: EvidenceSection[];
  reasonEvidence: EvidenceSection[];
  proofFocus: string[];
  userTip: string;
  riskTip?: string;
};

type EvidenceConfig = {
  proofFocus: string[];
  userTip: string;
  riskTip?: string;
  sections: EvidenceSection[];
};

const item = (id: string, name: string, priority: EvidencePriority, purpose: string, examples: string[]): EvidenceItem => ({
  id,
  name,
  priority,
  purpose,
  examples
});

const section = (id: string, title: string, description: string, items: EvidenceItem[]): EvidenceSection => ({ id, title, description, items });

export const priorityLabels: Record<EvidencePriority, string> = {
  required: "必须准备",
  recommended: "建议准备",
  optional: "有就上传"
};

const commonEvidence: EvidenceSection[] = [
  section("labor_relationship", "劳动关系证据", "证明你确实在这家公司工作。", [
    item("labor_contract", "劳动合同", "required", "证明双方存在劳动关系，以及岗位、工资、期限等基本约定。", ["劳动合同扫描件", "电子劳动合同", "续签合同"]),
    item("employment_records", "入职相关材料", "recommended", "辅助证明入职事实和入职时间。", ["offer", "录用通知书", "入职登记表", "转正通知"]),
    item("company_identity_records", "公司员工身份材料", "recommended", "辅助证明你属于公司员工。", ["工牌", "门禁卡", "公司邮箱截图", "组织架构截图"])
  ]),
  section("salary_level", "工资水平证据", "证明每月工资，用来计算 N、N+1、2N。", [
    item("salary_bank_flow", "最近12个月工资流水", "required", "证明实际工资发放金额。", ["银行卡工资流水", "银行 App 工资入账截图"]),
    item("salary_slips", "工资条", "recommended", "证明工资构成，例如基本工资、绩效、补贴、加班费等。", ["纸质工资条", "电子工资条", "薪资系统截图"]),
    item("bonus_records", "奖金、提成、年终奖记录", "optional", "辅助判断奖金是否应纳入平均工资计算。", ["奖金发放记录", "提成规则", "年终奖发放截图"])
  ]),
  section("working_period", "工作年限证据", "证明你从什么时候入职、工作了多久。", [
    item("start_date_records", "入职时间证明", "required", "证明你从什么时候开始为公司工作。", ["劳动合同起始日期", "offer", "入职登记表", "首次工资流水"]),
    item("continuous_service_records", "连续工作证明", "recommended", "证明工龄连续，没有被公司偷偷切断。", ["续签合同", "社保连续缴纳记录", "个税连续申报记录"])
  ]),
  section("termination_fact", "解除/终止事实证据", "证明这次离职是谁提的、怎么提的、什么时候提的。", [
    item("termination_notice", "解除/终止劳动合同通知", "required", "证明公司已经作出解除或终止劳动关系的意思表示。", ["解除通知", "终止通知", "裁员通知", "不续签通知", "离职证明"]),
    item("hr_communication", "HR 或领导沟通记录", "recommended", "证明公司要求你离职、辞退你、裁你、不续签，或诱导你签协议。", ["微信聊天记录", "企业微信记录", "飞书记录", "邮件"]),
    item("talk_recording", "离职约谈录音", "optional", "辅助证明公司解除理由、赔偿方案、谈判过程。", ["HR 约谈录音", "电话录音"])
  ])
];

const forcedCommon = section("forced_resign_common", "被迫解除共同证据", "证明不是你单纯想走，而是公司先把事情做坏了。", [
  item("forced_resign_notice", "被迫解除通知或沟通记录", "required", "证明你离职时把原因指向公司违法或过错行为。", ["被迫解除通知书", "给 HR 的邮件", "离职申请中写明被迫原因的截图"]),
  item("company_reply_records", "公司回应或拒绝纠正的记录", "recommended", "证明公司知道问题但没有纠正，或拒绝承认。", ["HR 回复", "领导沟通记录", "公司通知", "邮件往来"])
]);

const config = (proofFocus: string[], userTip: string, sections: EvidenceSection[], riskTip?: string): EvidenceConfig => ({ proofFocus, userTip, sections, riskTip });

const reasonEvidenceMap: Record<string, EvidenceConfig> = {
  self_resign_normal: config(["确认是否确实属于个人原因主动辞职", "排除公司欠薪、未缴社保、恶意调岗等被迫离职因素"], "如果真是自己主动离职，一般不需要准备赔偿证据；但如果公司其实有违法行为，建议重新选择更接近的离职原因。", [
    section("voluntary_resign_records", "主动离职确认材料", "确认这次是不是个人原因主动离职。", [
      item("resignation_application", "离职申请或主动离职记录", "recommended", "确认离职原因和提出离职的一方。", ["离职申请表", "离职邮件", "离职系统截图", "主动离职聊天记录"])
    ])
  ]),
  forced_bad_conditions: config(["公司未按约定提供劳动保护或劳动条件", "你因此被迫解除劳动合同"], "请上传能证明公司答应一套、实际给你另一套的材料。", [forcedCommon, section("bad_working_conditions", "工作条件异常证据", "证明实际工作环境或条件明显不符合约定。", [
    item("contract_working_condition", "合同或 offer 中的工作条件约定", "required", "证明公司原本承诺的岗位、地点、劳动条件。", ["劳动合同", "offer", "岗位说明书", "员工手册"]),
    item("actual_bad_condition", "实际工作条件证据", "recommended", "证明实际工作环境或条件明显不符合约定。", ["办公环境照片", "安全隐患照片", "缺少防护用品记录"])
  ])]),
  forced_unpaid_or_underpaid_wage: config(["约定工资是多少", "实际发放是否少发、克扣、拖欠或延迟", "你是否因此被迫解除"], "工资流水和工资条是硬通货，聊天记录只是辅助。", [forcedCommon, section("unpaid_or_underpaid_wage", "欠薪/克扣/晚发工资证据", "证明公司未及时足额支付劳动报酬。", [
    item("salary_agreement", "工资约定材料", "required", "证明公司本来应该发多少。", ["劳动合同", "offer", "薪酬确认邮件", "调薪通知"]),
    item("actual_salary_payment", "实际工资发放记录", "required", "证明公司实际发了多少、何时发。", ["工资流水", "工资条", "个税 App 收入记录"]),
    item("wage_arrears_communication", "催发工资或公司承认欠薪的记录", "recommended", "证明公司知道欠薪、少发或延迟发薪。", ["微信聊天记录", "HR 或财务回复", "延迟发薪通知"])
  ])]),
  forced_no_social_insurance: config(["实际入职时间", "公司是否未缴、断缴或少缴社保", "你是否因此被迫解除"], "老板嘴上说五险一金，系统里有没有才算数。", [forcedCommon, section("no_social_insurance", "社保缴纳异常证据", "证明公司未依法缴纳社保。", [
    item("social_security_records", "社保缴纳记录", "required", "证明公司是否缴纳、何时缴纳、是否断缴。", ["社保 App 截图", "社保系统截图", "社保缴费明细 PDF"]),
    item("employment_start_proof", "入职时间证明", "required", "对比公司应缴社保的起始时间。", ["劳动合同", "offer", "首次工资流水", "入职登记表"]),
    item("no_social_security_chat", "公司承认未缴社保的记录", "recommended", "证明公司知道未缴、断缴或用其他方式替代社保。", ["HR 说不交社保的聊天记录", "社保折现沟通记录"])
  ])]),
  forced_illegal_rules: config(["公司存在违法或明显损害权益的制度", "制度已经实际影响工资、岗位、绩效或其他权益"], "把公司那套离谱制度原文拿出来，尤其是罚款、扣钱、强制加班、随意调岗。", [forcedCommon, section("illegal_company_rules", "规章制度违法证据", "证明公司制度违法或损害劳动者权益。", [
    item("company_rules", "公司规章制度原文", "required", "证明公司存在相关制度。", ["员工手册", "考勤制度", "绩效制度", "罚款制度"]),
    item("rule_application_records", "公司实际适用该制度的记录", "recommended", "证明该制度已经影响你。", ["扣款记录", "罚款通知", "绩效扣分记录", "处罚通知"])
  ])]),
  forced_contract_trap: config(["劳动合同条款是否明显藏坑", "签约时是否存在欺诈、胁迫、重大误导"], "重点看合同条款和签约过程，不要只凭感觉说被坑。", [forcedCommon, section("contract_trap", "劳动合同签署异常证据", "证明签合同时存在欺诈、胁迫、重大误导或明显不公平安排。", [
    item("contract_original", "劳动合同原件或电子合同", "required", "证明合同具体条款内容。", ["劳动合同扫描件", "电子合同截图", "续签合同"]),
    item("signing_communication", "签约沟通记录", "recommended", "证明公司签约时如何说明、是否诱导或隐瞒。", ["HR 聊天记录", "签约邮件", "现场录音"])
  ])]),
  forced_violence_or_restriction: config(["公司是否存在暴力、威胁、限制自由或强令危险作业", "事件是否有第三方材料支持"], "这类情况强度高，现场、报警、就医、证人材料很关键。", [forcedCommon, section("violence_or_restriction", "暴力、威胁或限制人身自由证据", "证明公司存在暴力、威胁、限制自由等严重行为。", [
    item("incident_records", "现场记录", "required", "证明事件发生。", ["现场照片", "视频", "录音", "聊天记录"]),
    item("police_or_medical_records", "报警、就医或第三方记录", "recommended", "增强事件真实性和严重程度。", ["报警回执", "医院病历", "伤情照片", "物业/园区记录"])
  ])]),
  forced_other_reason: config(["其他原因是否属于公司违法、违约或严重过错", "你是否因此被迫提出解除劳动合同"], "你选的是其他原因，证据包会更通用。重点把公司做了什么、你为什么因此离职串起来。", [forcedCommon])
};
reasonEvidenceMap.forced_dangerous_work = reasonEvidenceMap.forced_violence_or_restriction;

const noFaultCommon = section("nofault_common", "无过失辞退共同证据", "判断公司能否按无过失辞退解除，以及有没有提前 30 天。", [
  item("nofault_dismiss_notice", "无过失辞退通知", "required", "证明公司以医疗期满、不能胜任或客观情况变化为由解除。", ["解除通知", "HR 聊天记录", "邮件", "会议纪要"]),
  item("notice_30_days_or_payment", "提前30天通知或代通知金材料", "recommended", "判断结果是 N 还是 N+1。", ["通知时间截图", "工资流水", "补偿方案", "代通知金明细"])
]);

const noFaultMedical = section("nofault_medical", "医疗期满解除证据", "判断医疗期是否届满，以及是否不能从事原工作或另行安排工作。", [
  item("medical_period_records", "病假和医疗期材料", "required", "确认医疗期是否届满。", ["病假单", "诊断证明", "医院病历", "请假审批"]),
  item("work_arrangement_after_medical", "复工、调岗或另行安排记录", "recommended", "判断公司是否尝试安排其他工作。", ["复工沟通", "调岗通知", "岗位安排记录"])
]);

const noFaultIncompetent = section("nofault_incompetent", "不能胜任解除证据", "判断公司是否经过考核、培训或调岗后仍不能胜任。", [
  item("performance_assessment_records", "绩效或能力考核材料", "required", "确认公司不胜任结论是否有依据。", ["绩效考核", "PIP", "考核规则", "评分记录"]),
  item("training_or_transfer_records", "培训或调岗记录", "required", "判断公司是否履行培训或调岗步骤。", ["培训通知", "培训记录", "调岗通知", "新岗位考核"])
]);

const noFaultMajorChange = section("nofault_major_change", "客观情况重大变化证据", "判断重大变化是否真实，以及是否协商变更劳动合同。", [
  item("objective_change_records", "客观情况变化材料", "required", "证明部门取消、岗位消失、业务关闭等事实。", ["部门撤销通知", "组织架构调整", "业务关闭公告"]),
  item("contract_change_negotiation", "协商变更劳动合同记录", "recommended", "判断公司是否协商调整岗位、地点或条件。", ["协商邮件", "调岗方案", "HR 沟通记录"])
]);

const actualDismissalReason = section("actual_dismissal_reason", "公司实际解除理由证据", "用于证明公司以什么理由解除劳动合同。", [
  item("actual_dismissal_notice", "公司解除通知或辞退通知", "required", "用于证明公司以什么理由解除劳动合同。", ["解除通知书", "辞退通知书", "终止通知"]),
  item("actual_dismissal_reason_records", "公司说明解除理由的记录", "recommended", "用于证明公司以什么理由解除劳动合同。", ["HR 聊天记录", "邮件", "会议纪要", "离职约谈录音"])
]);

const dismissalBasisReview = section("dismissal_basis_review", "公司解除依据核对材料", "用于核对公司的解除理由、事实依据和法律依据，判断是否属于法定解除情形。", [
  item("dismissal_legal_or_rule_basis", "公司引用的法律或制度依据", "required", "用于核对公司的解除理由、事实依据和法律依据，判断是否属于法定解除情形。", ["解除通知中引用的法律条款", "员工手册", "规章制度", "公司提供的解除依据"]),
  item("request_dismissal_basis_records", "要求公司说明解除依据的记录", "recommended", "用于核对公司的解除理由、事实依据和法律依据，判断是否属于法定解除情形。", ["要求公司说明法律依据的邮件", "微信记录", "申辩书", "公司回复"]),
  item("unsupported_dismissal_reason_records", "公司解除理由缺乏事实依据的材料", "recommended", "用于核对公司的解除理由、事实依据和法律依据，判断是否属于法定解除情形。", ["工作记录", "绩效记录", "考勤记录", "岗位和部门情况", "公司前后说法不一致的聊天或邮件"])
]);

const append = (base: Record<string, EvidenceConfig>) => Object.assign(reasonEvidenceMap, base);
append({
  nofault_medical_notice_yes: config(["医疗期是否届满", "公司是否安排复工或调岗", "是否提前30天通知"], "医疗期满解除要看医疗期、复工能力和公司安排，不是病假一结束就能赶人。", [noFaultCommon, noFaultMedical]),
  nofault_medical_notice_no: config(["医疗期是否届满", "公司是否安排复工或调岗", "公司是否未提前30天通知或未支付代通知金"], "没有提前30天通知时，除了检查代通知金，也要判断医疗期和工作安排是否符合法定条件。", [noFaultCommon, noFaultMedical]),
  nofault_incompetent_notice_yes: config(["考核是否客观", "是否经过培训或调岗", "是否提前30天通知"], "不能胜任不是一句话，PIP、培训和调岗记录都要拿出来。", [noFaultCommon, noFaultIncompetent]),
  nofault_incompetent_notice_no: config(["考核是否客观", "是否经过培训或调岗", "公司是否未提前30天通知或未支付代通知金"], "没有提前30天通知时，除了检查代通知金，也要判断考核、培训和调岗是否符合法定条件。", [noFaultCommon, noFaultIncompetent]),
  nofault_major_change_notice_yes: config(["客观情况变化是否真实", "是否协商变更劳动合同", "是否提前30天通知"], "部门没了也要看公司有没有协商变更，不能直接把你删掉。", [noFaultCommon, noFaultMajorChange]),
  nofault_major_change_notice_no: config(["客观情况变化是否真实", "是否协商变更劳动合同", "公司是否未提前30天通知或未支付代通知金"], "没有提前30天通知时，除了检查代通知金，也要判断重大变化和协商变更是否符合法定条件。", [noFaultCommon, noFaultMajorChange]),
  nofault_not_listed_excuse: config(["公司理由是否属于法定无过失解除", "公司是否只是找借口辞退", "解除程序是否违法"], "如果公司说的理由根本不是法定理由，或者理由站不住，就可能进入违法解除 2N 争议。", [actualDismissalReason, dismissalBasisReview]),
  layoff_notice_to_union_or_all_yes: config(["裁员人数是否达到门槛", "是否提前30天向工会或全体职工说明", "补偿方案是否达到 N"], "真裁员不是 HR 群里发个大家懂的就完事。程序材料很关键。", [section("economic_layoff", "经济性裁员证据", "判断公司是否依法进行经济性裁员。", [item("layoff_notice", "裁员通知", "required", "证明公司启动裁员并通知员工。", ["裁员通知", "解除通知", "HR 聊天记录"]), item("all_hands_notice", "提前30天说明材料", "required", "证明公司是否向工会或全体职工提前说明情况。", ["全员大会通知", "工会通知", "裁员说明 PPT"]), item("layoff_plan", "裁员方案", "recommended", "证明裁员范围、人数、补偿方案。", ["裁员名单", "补偿方案", "岗位裁撤方案"])])]),
  layoff_notice_to_union_or_all_no: config(["裁员人数是否达到门槛", "是否没有提前30天说明", "公司是否直接解除"], "如果是大裁员，公司就不能搞成逐个私聊式裁员。程序不完整时可能进入 2N 争议。", [section("illegal_economic_layoff", "经济性裁员程序违法证据", "证明公司裁员程序可能违法。", [item("sudden_layoff_notice", "突然裁员通知", "required", "证明公司没有提前30天说明，而是突然裁员。", ["当天裁员通知", "HR 单独约谈记录", "解除通知"]), item("layoff_scale_records", "裁员规模证据", "recommended", "证明裁员人数可能达到经济性裁员门槛。", ["被裁人员名单", "员工群讨论记录", "通讯录人数截图"])])]),
  contract_expired_company_not_renew: config(["劳动合同确实到期", "是公司主动不续签", "不是用户自己拒绝续签"], "合同到期不是公司白嫖你青春的免死金牌。公司不续，一般要看经济补偿。", [section("company_not_renew", "合同到期公司不续签证据", "证明公司不续签导致劳动合同终止。", [item("expired_contract", "到期劳动合同", "required", "证明劳动合同期限和到期时间。", ["劳动合同", "续签合同"]), item("company_not_renew_notice", "公司不续签通知", "required", "证明是公司决定不续签。", ["不续签通知", "终止劳动合同通知书", "HR 聊天记录"])])]),
  contract_expired_employee_not_renew: config(["是否确实是用户自己不续签", "公司是否维持或提高原劳动合同条件"], "这类一般不用主张经济补偿。除非公司其实偷偷降低条件，那就进入下一类。", [section("employee_not_renew", "员工主动不续签确认材料", "确认是否属于员工主动不续签。", [item("employee_refusal_records", "用户主动不续签记录", "recommended", "确认是用户自己不续签。", ["不续签邮件", "HR 聊天记录", "离职申请"]), item("company_renewal_offer", "公司续签条件", "recommended", "确认公司是否维持或提高条件。", ["续签通知", "新合同", "薪资福利说明"])])]),
  contract_expired_company_lower_terms: config(["公司提出续签", "新合同条件低于原合同", "用户拒绝续签是因为条件降低"], "不是你不续就一定没赔。公司要是把新合同越续越寒酸，那就是另一回事。", [section("lower_renewal_terms", "公司降低续签条件证据", "证明公司降低劳动合同约定条件，导致用户不续签。", [item("old_contract_terms", "原合同条件", "required", "证明原来的工资、岗位、地点、福利等条件。", ["原劳动合同", "原薪资福利记录", "岗位说明"]), item("new_contract_terms", "新合同条件", "required", "证明公司提供的新条件降低了。", ["新劳动合同", "续签通知", "新薪资福利说明"]), item("refuse_due_to_lower_terms", "因条件降低拒绝续签的记录", "recommended", "证明用户不是无理由不续签，而是因条件降低。", ["HR 沟通记录", "用户回复邮件", "续签谈判记录"])])]),
  termination_company_disappears: config(["公司主体是否发生破产、吊销、关闭、撤销或提前解散", "劳动合同是否因此终止"], "公司没了不代表赔偿也没了。先把公司怎么没的证据留下。", [section("company_disappeared", "公司主体消灭证据", "证明公司破产、吊销、关闭、撤销或提前解散。", [item("company_status_records", "公司状态异常材料", "required", "证明公司主体发生异常。", ["破产公告", "法院破产裁定", "国家企业信用信息公示系统截图"]), item("company_termination_notice", "公司通知终止劳动合同材料", "recommended", "证明劳动合同因此终止。", ["终止劳动合同通知", "HR 通知", "离职证明"]), item("unpaid_records_if_any", "欠薪或社保停缴记录", "optional", "辅助判断公司是否还存在欠薪、断缴等问题。", ["欠薪记录", "社保停缴记录", "工资停发记录"])])])
});

const faultCommon = section("fault_dismiss_common", "公司扣锅共同证据", "先看公司到底扣了什么锅，以及这口锅有没有证据。", [
  item("dismiss_reason_notice", "公司解除通知或扣锅原话", "required", "证明公司以什么理由解除劳动合同。", ["解除通知书", "辞退通知", "HR 聊天记录", "处分决定"]),
  item("company_rules_and_basis", "公司规章制度或解除依据", "required", "判断公司是否有制度或法律依据。", ["员工手册", "奖惩制度", "考勤制度", "岗位职责"]),
  item("rules_disclosure_records", "制度公示、签收或培训记录", "recommended", "判断公司制度是否已经向你告知。", ["员工手册签收页", "制度培训记录", "OA 阅读确认"]),
  item("employee_defense_records", "申辩或要求说明理由的记录", "recommended", "证明你没有默认认可，也曾要求公司说明依据。", ["申辩邮件", "微信沟通", "会议纪要"])
]);

const potConfigs: Record<string, EvidenceConfig> = {
  "试用期没过，说我是不合格的样本呜呜": config(["公司是否有明确录用条件", "不合格结论是否客观具体"], "试用期不是随手退货期，重点看录用条件有没有提前说清楚。", [section("probation_unqualified", "试用期不合格专项证据", "判断公司能不能用试用期不合格解除。", [item("probation_conditions", "录用条件或岗位要求", "required", "证明公司解除时依据的录用标准。", ["offer", "录用条件确认书", "岗位说明书"]), item("probation_assessment", "试用期考核材料", "recommended", "判断公司考核是否客观真实。", ["考核表", "绩效记录", "转正评估"]), item("work_performance", "工作成果和正常履职记录", "recommended", "反驳公司所谓不合格结论。", ["项目交付记录", "工作日报", "领导确认完成的聊天记录"])])]),
  "说我违反制度，而且是严重违纪的级别": config(["是否确实违反制度", "制度是否明确写明属于严重违纪", "处罚是否明显过重"], "严重违纪不是 HR 说出口就自动生效，制度、事实、严重程度、程序都要看。", [section("serious_rule_violation", "严重违纪专项证据", "判断违纪事实和解除依据是否站得住。", [item("violation_fact", "所谓违纪事实材料", "required", "确认公司指控的事实是否存在。", ["考勤记录", "聊天记录", "监控截图", "调查材料"]), item("similar_case", "同类情况处理记录", "optional", "判断公司是否处罚过重或区别对待。", ["同事类似情况处理", "以往处分记录"])])]),
  "说我工作捅了大篓子，重创了公司": config(["是否造成真实损害", "损害是否重大", "是否与你的行为有因果关系"], "工作出了问题不等于公司能直接开除，重点看损失是否真实、重大、由谁导致。", [section("major_damage", "重大失职/重大损害专项证据", "判断公司说的大篓子是不是被夸大了。", [item("damage_records", "损失或事故材料", "required", "确认公司所谓损害是否真实存在。", ["事故报告", "损失清单", "客户投诉"]), item("responsibility_scope", "岗位职责和责任边界材料", "recommended", "判断损失是否属于你的职责范围。", ["岗位说明", "审批流程", "项目分工"]), item("remedy_records", "补救或减损记录", "optional", "证明你曾及时处理。", ["补救方案", "汇报记录", "问题复盘"])])]),
  "说我脚踏两家公司，没空给本单位干活了": config(["是否存在另一份劳动关系", "是否严重影响本单位工作", "公司是否曾要求改正"], "有副业不一定等于能被开除，关键是有没有影响本职，以及公司有没有先要求改正。", [section("dual_employment", "双重劳动关系专项证据", "判断是否真的影响本单位工作。", [item("other_employment", "另一份劳动关系或兼职材料", "required", "确认公司指控的基础事实。", ["另一家公司劳动合同", "社保记录", "兼职协议"]), item("work_impact", "影响本职工作的证据", "recommended", "判断是否达到解除程度。", ["缺勤记录", "工作延误记录", "绩效下降材料"]), item("correction_request", "公司要求改正的记录", "recommended", "确认公司是否先要求改正。", ["整改通知", "HR 沟通", "警告邮件"])])]),
  "说我签劳动合同的时候涉及欺骗，我的形象已塌房": config(["公司指控的欺骗事项是什么", "相关材料是否真实", "该事项是否足以影响录用"], "简历或入职材料有争议，也要看是不是关键事项、是否影响录用。", [section("contract_fraud", "入职欺骗/合同无效专项证据", "判断公司所谓欺骗是否真实且重大。", [item("hiring_materials", "入职提交材料", "required", "确认公司指控的具体内容。", ["简历", "学历证明", "工作经历证明", "资格证书"]), item("truth_explanation", "材料真实性或解释说明", "recommended", "证明材料真实，或争议不影响岗位录用。", ["学历认证", "前公司证明", "证书查询截图"])])]),
  "说我现在摊上大事，涉及刑事问题": config(["是否已经被依法追究刑事责任", "是否只是调查、传闻或行政/民事纠纷"], "涉及刑事问题要非常谨慎，重点看是否已经依法追究刑事责任，而不是传闻。", [section("criminal_liability", "刑事问题专项证据", "判断公司能否以刑事责任为由解除。", [item("criminal_documents", "司法机关文书", "required", "确认是否已经被依法追究刑事责任。", ["判决书", "裁定书", "不起诉决定", "案件通知书"]), item("company_claim_source", "公司指控来源", "recommended", "确认公司依据是正式材料还是传闻。", ["HR 聊天记录", "解除通知", "公司调查材料"])])])
};

const truthConfigs: Record<string, EvidenceConfig> = {
  fault_pot_basically_true: config(["公司证据链是否完整", "公司是否有合法制度依据", "公司是否履行解除程序"], "如果事实和程序都成立，赔偿空间会比较小。先别急着认全责，把公司证据链看完整。", [section("fault_risk_confirmation", "过错属实风险确认材料", "确认公司是否真的有足够材料支持无补偿解除。", [item("company_full_evidence_chain", "公司完整证据链", "required", "确认公司解除是否事实清楚、依据明确。", ["解除通知", "调查材料", "制度依据", "处分记录"]), item("mitigation_records", "减轻责任或补救材料", "optional", "判断是否存在减轻情节。", ["补救记录", "领导确认", "损失已避免记录"])])], "该分支结果偏 0，但公司制度无效、证据不足或程序违法时仍可能存在争议空间。"),
  fault_pot_uncertain_severity: config(["过错事实是否成立", "是否严重到足以解除", "公司处罚是否明显过重", "程序是否合法"], "你现在不是简单证明自己完全没错，而是要证明：就算有问题，也没严重到公司可以直接开除。", [section("fault_severity_dispute", "严重程度争议证据包", "判断公司是不是小题大做，把普通问题包装成严重过错。", [item("not_serious_records", "问题没那么严重的证据", "required", "证明行为或后果未达到直接解除程度。", ["工作沟通记录", "补救记录", "未造成损失证明"]), item("lighter_similar_treatment", "同类情况处罚更轻的材料", "recommended", "证明公司处罚比例可能过重。", ["同事类似情况处理", "公司以往警告记录"]), item("procedure_defect", "解除程序瑕疵材料", "recommended", "证明公司流程可能没走完。", ["突然解除通知", "未调查记录", "申辩被拒记录"])])], "该分支是 0 / 2N 争议区间，需要结合证据继续判断。"),
  fault_not_true_or_exaggerated: config(["公司指控事实不存在或被夸大", "解除理由前后矛盾", "没有合法制度依据或程序违法"], "这类重点是反驳公司扣帽子：它说你有错，就让它拿证据；它拿不出来，2N 才有得谈。", [section("fault_false_accusation_rebuttal", "乱扣帽子反驳证据包", "证明公司解除理由不成立，可能构成违法解除。", [item("fact_rebuttal", "证明事实不存在的材料", "required", "反驳公司所谓过错事实。", ["考勤记录", "系统日志", "项目交付记录", "审批记录"]), item("normal_performance", "正常履职和工作成果材料", "recommended", "证明你正常工作，公司指控站不住。", ["绩效记录", "项目成果", "领导认可", "客户反馈"]), item("reason_contradiction", "解除理由前后矛盾材料", "recommended", "证明公司可能临时编造理由或借题发挥。", ["不同时间 HR 说法", "先说裁员后说违纪", "邮件截图"])])])
};

const buildFaultDismissEvidence = (answers: Answers, leafId: string): EvidenceConfig => {
  const potLabel = answers.followUps.FAULT_DISMISS_CHECK || "";
  const potConfig = potConfigs[potLabel] ?? config(["公司扣的锅具体是什么"], "先把公司扣的锅和证据链看清楚。", []);
  const truthConfig = truthConfigs[leafId] ?? truthConfigs.fault_pot_uncertain_severity;
  return {
    proofFocus: ["公司扣的锅具体是什么", "这口锅是否有事实和制度依据", ...potConfig.proofFocus, ...truthConfig.proofFocus],
    userTip: truthConfig.userTip,
    riskTip: truthConfig.riskTip,
    sections: [faultCommon, ...potConfig.sections, ...truthConfig.sections]
  };
};

const normalizeCompensationResult = (ruleHint: string) => {
  if (ruleHint.includes("0 / 2N")) return "0/2N";
  if (ruleHint.includes("2N")) return "2N";
  if (ruleHint.includes("N+1")) return "N+1";
  if (ruleHint.includes("0")) return "0";
  if (ruleHint.includes("N")) return "N";
  return "RANGE";
};

export const buildEvidenceChecklist = (result: CalculationResult, answers: Answers): EvidenceChecklist => {
  const leafId = result.terminationReasonId;
  const baseConfig = leafId.startsWith("fault_") ? buildFaultDismissEvidence(answers, leafId) : reasonEvidenceMap[leafId];
  const fallback = config(["离职原因和公司材料是否能对上", "工资、工龄和解除事实是否清楚"], "这类情况暂时按通用证据包处理，后续可以继续补细分证据。", []);
  const selected = baseConfig ?? fallback;
  const reasonEvidence = [...selected.sections];
  const compensationResult = normalizeCompensationResult(result.ruleHint);

  return {
    leafId,
    leafText: answers.terminationReasonText || result.terminationHint,
    compensationResult,
    commonEvidence,
    reasonEvidence,
    proofFocus: selected.proofFocus,
    userTip: selected.userTip,
    riskTip: selected.riskTip
  };
};

export const getEvidenceCompleteness = (checklist: EvidenceChecklist, selected: Record<string, boolean>) => {
  const allItems = [...checklist.commonEvidence, ...checklist.reasonEvidence].flatMap((current) => current.items);
  const required = allItems.filter((current) => current.priority === "required");
  const recommended = allItems.filter((current) => current.priority === "recommended");
  const requiredScore = required.length ? required.filter((current) => selected[current.id]).length / required.length : 1;
  const recommendedScore = recommended.length ? recommended.filter((current) => selected[current.id]).length / recommended.length : 1;
  return Math.round((requiredScore * 0.7 + recommendedScore * 0.3) * 100);
};
