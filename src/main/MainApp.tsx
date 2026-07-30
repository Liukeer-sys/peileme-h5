import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AccountPanel from "../components/AccountPanel";
import AuthModal from "../components/AuthModal";
import ChatBubble from "../components/ChatBubble";
import OptionButtons from "../components/OptionButtons";
import type { XiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";
import {
  getXiaoPeiAvatarStateForReply,
  xiaoPeiAvatarStateByMessageIntent
} from "../constants/xiaopeiAvatarStates";
import { baseQuestions, loadingMessages } from "../data/questions";
import {
  forcedOtherReasonLeaf,
  getTerminationReasonNode,
  rootTerminationReasonNode,
  type TerminationLeaf
} from "../data/terminationReasonFlow";
import {
  ApiError,
  calculatePolicy,
  listPolicyRegions,
  track
} from "../lib/api";
import type {
  Answers,
  PolicyApiResult,
  PolicyCalculateRequest,
  PolicyHistoryDetail,
  PolicyRegion,
  TerminationScenario
} from "../types";
import PolicyResult from "./PolicyResult";

type ChatMessage = {
  id: string;
  from: "system" | "user";
  text: string;
  avatarState?: XiaoPeiAvatarState;
};

type AppMode = "chat" | "loading" | "result";

const RESULT_KEY = "peileme-latest-policy-result";
const ANSWERS_KEY = "peileme-policy-answers";
const quickRegions: Record<string, string> = {
  上海: "310000",
  北京: "110000",
  深圳: "440300",
  广州: "440100",
  杭州: "330100",
  成都: "510100",
  西安: "610100",
  武汉: "420100"
};

const currentMonth = () => new Date().toISOString().slice(0, 7);
const freshAnswers = (): Answers => ({
  endMonth: currentMonth(),
  followUps: {}
});

const loadSessionJson = <T,>(key: string): T | null => {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const monthStart = (month?: string) => `${month}-01`;
const monthEnd = (month?: string) => {
  const match = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!match) return "";
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
};
const yuanToFen = (yuan?: number) =>
  Number.isFinite(yuan) ? Math.round(Number(yuan) * 100) : 0;

const scenarioForLeaf = (leaf: TerminationLeaf): TerminationScenario => {
  if (leaf.resultMode === "nPlusOne") {
    return { kind: "ARTICLE_40", noticeMethod: "payment_in_lieu" };
  }
  if (leaf.id.startsWith("nofault_") && leaf.id.endsWith("_notice_yes")) {
    return { kind: "ARTICLE_40", noticeMethod: "notice_30_days" };
  }
  if (leaf.id.startsWith("forced_")) {
    return { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" };
  }
  if (
    leaf.id === "self_resign_normal" ||
    leaf.id === "contract_expired_employee_not_renew"
  ) {
    return { kind: "VOLUNTARY_RESIGNATION" };
  }
  if (leaf.resultMode === "twoN") {
    return {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested: false,
      continuedPerformancePossible: false
    };
  }
  return { kind: "UNCLEAR" };
};

const normalizeStoredDetail = (detail: PolicyHistoryDetail): Answers => ({
  regionCode: detail.input.regionCode,
  regionName: detail.input.regionName,
  city: detail.input.regionName,
  startMonth: detail.input.startDate.slice(0, 7),
  endMonth: detail.input.endDate.slice(0, 7),
  avgMonthlySalary: detail.input.monthlyEarnedWagesFen.length
    ? detail.input.monthlyEarnedWagesFen.reduce((sum, value) => sum + value, 0) /
      detail.input.monthlyEarnedWagesFen.length /
      100
    : 0,
  terminationScenario: detail.input.terminationScenario,
  followUps: {}
});

export default function MainApp() {
  const { user } = useAuth();
  const restoredResult = useMemo(
    () => loadSessionJson<PolicyApiResult>(RESULT_KEY),
    []
  );
  const restoredAnswers = useMemo(
    () => loadSessionJson<Answers>(ANSWERS_KEY),
    []
  );
  const [answers, setAnswers] = useState<Answers>(
    restoredAnswers || freshAnswers()
  );
  const [serverResult, setServerResult] = useState<PolicyApiResult | null>(
    restoredResult
  );
  const [mode, setMode] = useState<AppMode>(
    restoredResult ? "result" : "chat"
  );
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "hello",
      from: "system",
      text: "你好，我是赔了么。把离职信息告诉我，我们按当前政策一步步把账算清楚。",
      avatarState: xiaoPeiAvatarStateByMessageIntent.welcome
    },
    {
      id: "question-city",
      from: "system",
      text: baseQuestions[0].message,
      avatarState: xiaoPeiAvatarStateByMessageIntent.question
    }
  ]);
  const [stepIndex, setStepIndex] = useState(0);
  const [terminationNodeId, setTerminationNodeId] = useState(
    rootTerminationReasonNode.id
  );
  const [terminationDetail, setTerminationDetail] = useState(false);
  const [readyToCalculate, setReadyToCalculate] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [regions, setRegions] = useState<PolicyRegion[]>([]);
  const [regionError, setRegionError] = useState("");
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);
  const [regionSearch, setRegionSearch] = useState("");
  const [provinceCode, setProvinceCode] = useState("");
  const [requestError, setRequestError] = useState("");
  const [loadingIndex, setLoadingIndex] = useState(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const currentQuestion = baseQuestions[stepIndex];
  const currentTerminationNode =
    currentQuestion?.id === "terminationReason"
      ? getTerminationReasonNode(terminationNodeId) ||
        rootTerminationReasonNode
      : undefined;
  const selectedRegion = regions.find(
    (region) => region.code === answers.regionCode
  );
  const selectedProvince = answers.regionCode
    ? regions.find(
        (region) =>
          region.code ===
          (selectedRegion?.level === "province"
            ? selectedRegion.code
            : selectedRegion?.parentCode)
      )
    : undefined;
  const calculationYear = Number(
    (answers.endMonth || currentMonth()).slice(0, 4)
  );
  const manualMinimumRequired =
    selectedRegion?.parameterAvailability?.minimumMonthlyWage ===
    "manual-needed";
  const manualAverageRequired =
    selectedRegion?.parameterAvailability?.employeeAverageMonthlyWage ===
    "manual-needed";

  const append = (...next: ChatMessage[]) =>
    setMessages((current) => [...current, ...next]);

  const loadRegions = async (year = calculationYear) => {
    setRegionError("");
    try {
      const loaded = await listPolicyRegions(year);
      setRegions(loaded);
    } catch (error) {
      setRegionError(
        error instanceof ApiError ? error.message : "地区数据加载失败，请重试"
      );
    }
  };

  useEffect(() => {
    void loadRegions();
  }, [calculationYear]);

  useEffect(() => {
    if (mode !== "loading") return;
    const timer = window.setInterval(
      () => setLoadingIndex((index) => (index + 1) % loadingMessages.length),
      620
    );
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (mode !== "result") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, mode, requestError, readyToCalculate]);

  useEffect(() => {
    const pageKey = `peileme-page-view:${window.location.pathname}`;
    if (!window.sessionStorage.getItem(pageKey)) {
      window.sessionStorage.setItem(pageKey, "1");
      track("page_view", { title: document.title });
    }
  }, []);

  const askQuestion = (index: number) => {
    const question = baseQuestions[index];
    if (!question) return;
    append({
      id: `question-${question.id}-${Date.now()}`,
      from: "system",
      text: question.message,
      avatarState: xiaoPeiAvatarStateByMessageIntent.question
    });
    setStepIndex(index);
    setTextValue(question.id === "endDate" ? answers.endMonth || "" : "");
  };

  const recordBaseAnswer = (
    questionId: string,
    value: string,
    nextAnswers: Answers,
    nextIndex: number
  ) => {
    setAnswers(nextAnswers);
    setRequestError("");
    append(
      {
        id: `answer-${questionId}-${Date.now()}`,
        from: "user",
        text: value
      },
      {
        id: `reply-${questionId}-${Date.now()}`,
        from: "system",
        text: "记下了，我们继续把关键事实补全。",
        avatarState: getXiaoPeiAvatarStateForReply(questionId, value)
      }
    );
    track("answer_submitted", { questionId });
    askQuestion(nextIndex);
  };

  const chooseRegion = (region: PolicyRegion) => {
    const province =
      region.level === "province"
        ? region
        : regions.find((item) => item.code === region.parentCode);
    const display =
      province && province.code !== region.code
        ? `${province.name} · ${region.name}`
        : region.name;
    const next = {
      ...answers,
      regionCode: region.code,
      regionName: region.name,
      city: region.name,
      customCity: undefined
    };
    setRegionPickerOpen(false);
    setRegionSearch("");
    recordBaseAnswer("city", display, next, 1);
  };

  const chooseQuickRegion = (label: string) => {
    const region = regions.find((item) => item.code === quickRegions[label]);
    if (region) chooseRegion(region);
  };

  const submitText = () => {
    const value = textValue.trim();
    if (!value) return;
    if (terminationDetail) {
      const leaf = forcedOtherReasonLeaf;
      const next = {
        ...answers,
        terminationReason: leaf.id,
        terminationReasonType: leaf.inferredType,
        terminationReasonText: value,
        terminationScenario: scenarioForLeaf(leaf),
        followUps: { ...answers.followUps, terminationDetail: value }
      };
      setAnswers(next);
      setTerminationDetail(false);
      append(
        { id: `answer-detail-${Date.now()}`, from: "user", text: value },
        {
          id: `reply-detail-${Date.now()}`,
          from: "system",
          text: leaf.reply,
          avatarState: "warning"
        }
      );
      askQuestion(7);
      return;
    }
    if (!currentQuestion) return;

    if (currentQuestion.id === "startDate") {
      if (!/^\d{4}-\d{2}$/.test(value)) {
        setRequestError("请选择有效的入职年月");
        return;
      }
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, startMonth: value, startDate: value },
        2
      );
      return;
    }
    if (currentQuestion.id === "endDate") {
      if (
        !/^\d{4}-\d{2}$/.test(value) ||
        !answers.startMonth ||
        value < answers.startMonth
      ) {
        setRequestError("解除年月需要晚于入职年月");
        return;
      }
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, endMonth: value, endDate: value },
        3
      );
      return;
    }
    if (currentQuestion.id === "avgMonthlySalary") {
      const salary = Number(value.replace(/[,，\s]/g, ""));
      if (!Number.isFinite(salary) || salary <= 0 || yuanToFen(salary) <= 0) {
        setRequestError("请输入大于 0 的有效月工资");
        return;
      }
      recordBaseAnswer(
        currentQuestion.id,
        `${salary} 元`,
        {
          ...answers,
          avgMonthlySalary: salary,
          avgMonthlySalaryText: value,
          takeHomeSalary: salary
        },
        5
      );
    }
  };

  const chooseTermination = (value: string) => {
    const node = currentTerminationNode || rootTerminationReasonNode;
    const option = node.options.find((item) => item.label === value);
    if (!option) return;
    append({ id: `answer-termination-${Date.now()}`, from: "user", text: value });
    if (option.nextId === "SELF_RESIGN_OTHER_REASON_DETAIL") {
      setTerminationDetail(true);
      append({
        id: `question-detail-${Date.now()}`,
        from: "system",
        text: "可以简单描述一下离职原因。",
        avatarState: xiaoPeiAvatarStateByMessageIntent.question
      });
      setTextValue("");
      return;
    }
    if (option.nextId) {
      const nodeToOpen = getTerminationReasonNode(option.nextId);
      if (nodeToOpen) {
        setTerminationNodeId(nodeToOpen.id);
        append({
          id: `question-${nodeToOpen.id}-${Date.now()}`,
          from: "system",
          text: nodeToOpen.question,
          avatarState: xiaoPeiAvatarStateByMessageIntent.question
        });
      }
      return;
    }
    if (!option.leaf) return;
    const next = {
      ...answers,
      terminationReason: option.leaf.id,
      terminationReasonType: option.leaf.inferredType,
      terminationReasonText: option.leaf.label,
      terminationScenario: scenarioForLeaf(option.leaf),
      followUps: { ...answers.followUps, [node.id]: value }
    };
    setAnswers(next);
    append({
      id: `reply-termination-${Date.now()}`,
      from: "system",
      text: option.leaf.reply,
      avatarState: option.leaf.resultMode === "twoN" ? "warning" : "result"
    });
    askQuestion(7);
  };

  const chooseOption = (value: string) => {
    if (!currentQuestion) return;
    if (currentQuestion.id === "terminationReason") {
      chooseTermination(value);
      return;
    }
    if (currentQuestion.id === "workSchedule") {
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, workSchedule: value },
        4
      );
      return;
    }
    if (currentQuestion.id === "bonusInfo") {
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, bonusInfo: value },
        6
      );
      return;
    }
    if (currentQuestion.id === "postExitWish") {
      setAnswers({ ...answers, postExitWish: value });
      append(
        { id: `answer-wish-${Date.now()}`, from: "user", text: value },
        {
          id: `reply-ready-${Date.now()}`,
          from: "system",
          text: "信息齐了。下面的金额只由服务端政策引擎生成，你可以先核对地区参数再提交。",
          avatarState: "result"
        }
      );
      setReadyToCalculate(true);
      track("questionnaire_completed");
    }
  };

  const buildRequest = (): PolicyCalculateRequest => {
    const salaryFen = yuanToFen(answers.avgMonthlySalary);
    const manualParameters = {
      ...(answers.manualMinimumMonthlyWage
        ? {
            minimumMonthlyWageFen: yuanToFen(
              answers.manualMinimumMonthlyWage
            )
          }
        : {}),
      ...(answers.manualEmployeeAverageMonthlyWage
        ? {
            employeeAverageMonthlyWageFen: yuanToFen(
              answers.manualEmployeeAverageMonthlyWage
            )
          }
        : {})
    };
    return {
      regionCode: answers.regionCode!,
      startDate: monthStart(answers.startMonth),
      endDate: monthEnd(answers.endMonth),
      terminationScenario: answers.terminationScenario || { kind: "UNCLEAR" },
      monthlyEarnedWagesFen: Array.from({ length: 12 }, () => salaryFen),
      ...(Object.keys(manualParameters).length ? { manualParameters } : {})
    };
  };

  const persistResult = (result: PolicyApiResult, currentAnswers: Answers) => {
    window.sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
    window.sessionStorage.setItem(ANSWERS_KEY, JSON.stringify(currentAnswers));
  };

  const submitPolicyCalculation = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (
      !answers.regionCode ||
      !answers.startMonth ||
      !answers.endMonth ||
      !answers.avgMonthlySalary
    ) {
      setRequestError("请先完成全部问卷");
      return;
    }
    if (
      (manualMinimumRequired && !answers.manualMinimumMonthlyWage) ||
      (manualAverageRequired && !answers.manualEmployeeAverageMonthlyWage)
    ) {
      setRequestError("请补充缺失的当地参数后再提交");
      return;
    }
    setMode("loading");
    setRequestError("");
    try {
      const response = await calculatePolicy(buildRequest());
      setServerResult(response);
      persistResult(response, answers);
      track("policy_calculation_completed", {
        assessmentId: response.assessmentId,
        accuracyLevel: response.accuracyLevel
      });
      setMode("result");
    } catch (error) {
      setMode("chat");
      if (
        error instanceof ApiError &&
        error.code === "REGIONAL_PARAMETERS_REQUIRED"
      ) {
        setRequestError("当前地区缺少官方参数，请补充当地数值后重试");
      } else {
        setRequestError(
          error instanceof ApiError ? error.message : "测算失败，请稍后重试"
        );
      }
    }
  };

  const restart = () => {
    window.sessionStorage.removeItem(RESULT_KEY);
    window.sessionStorage.removeItem(ANSWERS_KEY);
    setAnswers(freshAnswers());
    setServerResult(null);
    setMode("chat");
    setMessages([
      {
        id: `hello-${Date.now()}`,
        from: "system",
        text: "好，我们重新把情况捋一遍。",
        avatarState: xiaoPeiAvatarStateByMessageIntent.welcome
      },
      {
        id: `question-city-${Date.now()}`,
        from: "system",
        text: baseQuestions[0].message,
        avatarState: xiaoPeiAvatarStateByMessageIntent.question
      }
    ]);
    setStepIndex(0);
    setTerminationNodeId(rootTerminationReasonNode.id);
    setTerminationDetail(false);
    setReadyToCalculate(false);
    setTextValue("");
    setRequestError("");
    track("assessment_restarted");
  };

  const recalculateHistory = async (detail: PolicyHistoryDetail) => {
    setRequestError("");
    const request: PolicyCalculateRequest = {
      regionCode: detail.input.regionCode,
      startDate: detail.input.startDate,
      endDate: detail.input.endDate,
      terminationScenario: detail.input.terminationScenario,
      monthlyEarnedWagesFen: detail.input.monthlyEarnedWagesFen,
      alreadyPaidFen: detail.input.alreadyPaidFen,
      manualParameters: {
        minimumMonthlyWageFen: detail.input.minimumMonthlyWageFen,
        employeeAverageMonthlyWageFen:
          detail.input.employeeAverageMonthlyWageFen
      }
    };
    const nextAnswers = normalizeStoredDetail(detail);
    try {
      const result = await calculatePolicy(request);
      setAnswers(nextAnswers);
      setServerResult(result);
      persistResult(result, nextAnswers);
      setMode("result");
      track("policy_history_recalculated", {
        sourceAssessmentId: detail.id,
        assessmentId: result.assessmentId
      });
    } catch (error) {
      setRequestError(
        error instanceof ApiError ? error.message : "重新测算失败，请稍后重试"
      );
      throw error;
    }
  };

  const provinces = regions.filter((region) => region.level === "province");
  const provinceName = new Map(
    provinces.map((province) => [province.code, province.name])
  );
  const normalizedSearch = regionSearch.trim().toLowerCase();
  const visibleRegions = regions
    .filter((region) => {
      if (normalizedSearch) {
        return `${provinceName.get(region.parentCode || "") || ""}${region.name}`
          .toLowerCase()
          .includes(normalizedSearch);
      }
      if (provinceCode) {
        return (
          region.code === provinceCode || region.parentCode === provinceCode
        );
      }
      return region.level === "province";
    })
    .slice(0, normalizedSearch ? 80 : 40);

  const inputLabel =
    terminationDetail
      ? "离职原因补充说明"
      : currentQuestion?.id === "startDate"
        ? "入职年月"
        : currentQuestion?.id === "endDate"
          ? "解除年月"
          : currentQuestion?.id === "avgMonthlySalary"
            ? "最近一年平均月工资（元）"
            : "回答";
  const showInput =
    mode === "chat" &&
    !readyToCalculate &&
    (terminationDetail ||
      ["startDate", "endDate", "avgMonthlySalary"].includes(
        currentQuestion?.id || ""
      ));
  const showOptions =
    mode === "chat" &&
    !readyToCalculate &&
    !terminationDetail &&
    currentQuestion?.kind === "options" &&
    currentQuestion.id !== "city";
  const optionValues =
    currentQuestion?.id === "terminationReason"
      ? currentTerminationNode?.options.map((option) => option.label) || []
      : currentQuestion?.options || [];

  return (
    <main className="app-shell">
      <section className="phone-frame">
        <header className={mode === "result" ? "topbar result-topbar" : "topbar"}>
          <div><span className="brand-dot" /><strong>赔了么</strong></div>
          <div className="topbar-actions">
            <button
              className="account-button"
              type="button"
              onClick={() => user ? setAccountOpen(true) : setAuthOpen(true)}
            >
              {user
                ? (user.displayName || user.email || user.phone || "我的").slice(0, 4)
                : "登录"}
            </button>
            <button className="mini-button" type="button" onClick={restart}>重算</button>
          </div>
        </header>

        {mode !== "result" && (
          <div className="chat-area">
            {messages.map((message) => (
              <ChatBubble
                key={message.id}
                from={message.from}
                avatarState={message.avatarState}
              >
                {message.text}
              </ChatBubble>
            ))}
            {mode === "loading" && (
              <ChatBubble from="system" avatarState="calculating">
                <div className="loading-line">
                  <span className="pulse-dot" />
                  {loadingMessages[loadingIndex]}
                </div>
              </ChatBubble>
            )}
            {requestError && <p role="alert" className="policy-request-error">{requestError}</p>}
            <div ref={bottomRef} />
          </div>
        )}

        {mode === "chat" && (
          <footer className="composer">
            {currentQuestion?.id === "city" && !readyToCalculate && (
              <div className="region-quick-select">
                <div className="option-grid">
                  {Object.keys(quickRegions).map((label) => (
                    <button
                      key={label}
                      className="option-button"
                      type="button"
                      disabled={!regions.length}
                      onClick={() => chooseQuickRegion(label)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="secondary-button region-all-button"
                  onClick={() => setRegionPickerOpen(true)}
                >
                  选择全部省市
                </button>
                {regionError && (
                  <div className="region-load-error" role="alert">
                    <span>{regionError}</span>
                    <button type="button" onClick={() => void loadRegions()}>重试地区加载</button>
                  </div>
                )}
              </div>
            )}

            {showOptions && (
              <OptionButtons
                options={optionValues}
                onChoose={chooseOption}
                variant={
                  currentQuestion.id === "postExitWish"
                    ? "wish"
                    : currentQuestion.id === "terminationReason" &&
                        terminationNodeId === rootTerminationReasonNode.id
                      ? "termination-root"
                      : currentQuestion.id === "terminationReason" &&
                          terminationNodeId === "CONTRACT_EXPIRED_CHECK"
                        ? "contract-expired"
                        : "default"
                }
              />
            )}

            {showInput && (
              <div className="input-row">
                <input
                  aria-label={inputLabel}
                  value={textValue}
                  type={
                    ["startDate", "endDate"].includes(currentQuestion?.id || "")
                      ? "month"
                      : "text"
                  }
                  inputMode={
                    currentQuestion?.id === "avgMonthlySalary"
                      ? "decimal"
                      : "text"
                  }
                  onChange={(event) => setTextValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitText();
                  }}
                />
                <button type="button" onClick={submitText}>发送</button>
              </div>
            )}

            {readyToCalculate && (
              <section className="policy-submit-panel" aria-label="提交政策测算">
                <div className="policy-input-review">
                  <b>{selectedProvince && selectedProvince.code !== selectedRegion?.code
                    ? `${selectedProvince.name} · ${selectedRegion?.name}`
                    : selectedRegion?.name}</b>
                  <span>{answers.startMonth} 至 {answers.endMonth}</span>
                  <span>月工资 {answers.avgMonthlySalary?.toLocaleString("zh-CN")} 元</span>
                </div>
                {(manualMinimumRequired || manualAverageRequired) && (
                  <div className="manual-parameter-card">
                    <strong>当地参数待补充</strong>
                    <p>官方库暂缺对应年度的城市参数。补充后本次结果会标记为估算，并在结果中明确展示。</p>
                    {manualMinimumRequired && (
                      <label>
                        <span>当地最低月工资（元）</span>
                        <input
                          aria-label="当地最低月工资（元）"
                          inputMode="decimal"
                          value={answers.manualMinimumMonthlyWage || ""}
                          onChange={(event) =>
                            setAnswers({
                              ...answers,
                              manualMinimumMonthlyWage: Number(event.target.value)
                            })
                          }
                        />
                      </label>
                    )}
                    {manualAverageRequired && (
                      <label>
                        <span>当地上年度职工月平均工资（元）</span>
                        <input
                          aria-label="当地上年度职工月平均工资（元）"
                          inputMode="decimal"
                          value={answers.manualEmployeeAverageMonthlyWage || ""}
                          onChange={(event) =>
                            setAnswers({
                              ...answers,
                              manualEmployeeAverageMonthlyWage: Number(event.target.value)
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                )}
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void submitPolicyCalculation()}
                >
                  生成政策测算
                </button>
              </section>
            )}
          </footer>
        )}

        {mode === "result" && serverResult && (
          <div className="result-page">
            <PolicyResult
              result={serverResult}
              onOpenHistory={() =>
                user ? setAccountOpen(true) : setAuthOpen(true)
              }
              onRecalculate={restart}
            />
            <div ref={bottomRef} />
          </div>
        )}
      </section>

      {regionPickerOpen && (
        <div className="paywall-overlay region-picker-overlay" role="dialog" aria-label="选择工作地区" aria-modal="true">
          <section className="account-modal region-picker">
            <button
              className="account-close"
              type="button"
              aria-label="关闭"
              onClick={() => setRegionPickerOpen(false)}
            >
              ×
            </button>
            <h2>选择工作地区</h2>
            <label className="account-field">
              <span>搜索省份或城市</span>
              <input
                aria-label="搜索省份或城市"
                value={regionSearch}
                onChange={(event) => setRegionSearch(event.target.value)}
              />
            </label>
            <label className="account-field">
              <span>省份</span>
              <select
                aria-label="省份"
                value={provinceCode}
                onChange={(event) => setProvinceCode(event.target.value)}
              >
                <option value="">全部省份</option>
                {provinces.map((province) => (
                  <option key={province.code} value={province.code}>{province.name}</option>
                ))}
              </select>
            </label>
            <div className="region-result-list">
              {visibleRegions.map((region) => (
                <button
                  key={region.code}
                  type="button"
                  onClick={() => chooseRegion(region)}
                >
                  {region.parentCode
                    ? `${provinceName.get(region.parentCode) || ""} · ${region.name}`
                    : region.name}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      <AccountPanel
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        historyRefreshKey={serverResult?.assessmentId}
        onPolicyRecalculate={recalculateHistory}
      />
    </main>
  );
}
