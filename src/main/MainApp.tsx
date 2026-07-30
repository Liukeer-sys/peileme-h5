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
  rootTerminationReasonNode
} from "../data/terminationReasonFlow";
import {
  ApiError,
  calculatePolicy,
  getSharedPolicyResult,
  listPolicyRegions,
  track
} from "../lib/api";
import { useDialogFocus } from "../hooks/useDialogFocus";
import type {
  Answers,
  PolicyApiResult,
  PolicyCalculateRequest,
  PolicyHistoryDetail,
  PolicyRegion
} from "../types";
import {
  buildDefaultWageSeries,
  scenarioForLeaf
} from "./policyQuestionnaire";
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

const currentDate = () => new Date().toISOString().slice(0, 10);
const freshAnswers = (): Answers => ({
  endDate: currentDate(),
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

const isCalendarDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const yuanToFen = (yuan?: number) =>
  Number.isFinite(yuan) ? Math.round(Number(yuan) * 100) : 0;

const normalizeStoredDetail = (detail: PolicyHistoryDetail): Answers => ({
  regionCode: detail.input.regionCode,
  regionName: detail.input.regionName,
  city: detail.input.regionName,
  startDate: detail.input.startDate,
  endDate: detail.input.endDate,
  avgMonthlySalary: detail.input.monthlyEarnedWagesFen.length
    ? detail.input.monthlyEarnedWagesFen.reduce((sum, value) => sum + value, 0) /
      detail.input.monthlyEarnedWagesFen.length /
      100
    : 0,
  monthlyEarnedWagesFen: [...detail.input.monthlyEarnedWagesFen],
  wageDataConfirmed: detail.input.wageDataConfirmation.confirmed,
  terminationScenario: detail.input.terminationScenario,
  followUps: {}
});

export default function MainApp() {
  const { user } = useAuth();
  const sharedToken = useMemo(
    () => new URLSearchParams(window.location.search).get("share") || "",
    []
  );
  const restoredResult = useMemo(
    () =>
      sharedToken ? null : loadSessionJson<PolicyApiResult>(RESULT_KEY),
    [sharedToken]
  );
  const restoredAnswers = useMemo(
    () => (sharedToken ? null : loadSessionJson<Answers>(ANSWERS_KEY)),
    [sharedToken]
  );
  const [answers, setAnswers] = useState<Answers>(
    restoredAnswers || freshAnswers()
  );
  const [serverResult, setServerResult] = useState<PolicyApiResult | null>(
    restoredResult
  );
  const [mode, setMode] = useState<AppMode>(
    sharedToken ? "loading" : restoredResult ? "result" : "chat"
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
  const [serverMissingParameters, setServerMissingParameters] = useState<
    string[]
  >([]);
  const [shareError, setShareError] = useState("");
  const [loadingIndex, setLoadingIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const submitLockRef = useRef(false);
  const calculationGenerationRef = useRef(0);
  const calculationAbortRef = useRef<AbortController | null>(null);
  const regionRequestSequenceRef = useRef(0);
  const regionAbortRef = useRef<AbortController | null>(null);
  const regionDialogRef = useRef<HTMLDivElement | null>(null);
  const regionSearchRef = useRef<HTMLInputElement | null>(null);

  useDialogFocus(
    regionPickerOpen,
    regionDialogRef,
    () => setRegionPickerOpen(false),
    regionSearchRef
  );

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
    (answers.endDate || currentDate()).slice(0, 4)
  );
  const manualMinimumRequired =
    selectedRegion?.parameterAvailability?.minimumMonthlyWage ===
      "manual-needed" ||
    serverMissingParameters.includes("minimumMonthlyWageFen");
  const manualAverageRequired =
    selectedRegion?.parameterAvailability?.employeeAverageMonthlyWage ===
      "manual-needed" ||
    serverMissingParameters.includes("employeeAverageMonthlyWageFen");
  const wagePreset = buildDefaultWageSeries(
    yuanToFen(answers.avgMonthlySalary),
    answers.bonusInfo,
    answers.startDate,
    answers.endDate
  );
  const wageSeries =
    answers.monthlyEarnedWagesFen || wagePreset.monthlyEarnedWagesFen;

  const append = (...next: ChatMessage[]) =>
    setMessages((current) => [...current, ...next]);

  const loadRegions = async (year = calculationYear) => {
    const sequence = ++regionRequestSequenceRef.current;
    regionAbortRef.current?.abort();
    const controller = new AbortController();
    regionAbortRef.current = controller;
    setRegionError("");
    try {
      const loaded = await listPolicyRegions(year, controller.signal);
      if (sequence !== regionRequestSequenceRef.current) return;
      setRegions(loaded);
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      if (sequence !== regionRequestSequenceRef.current) return;
      setRegionError(
        error instanceof ApiError ? error.message : "地区数据加载失败，请重试"
      );
    } finally {
      if (sequence === regionRequestSequenceRef.current) {
        regionAbortRef.current = null;
      }
    }
  };

  useEffect(() => {
    void loadRegions(calculationYear);
    return () => {
      regionAbortRef.current?.abort();
    };
  }, [calculationYear]);

  useEffect(() => {
    if (!sharedToken) return;
    let active = true;
    void getSharedPolicyResult(sharedToken)
      .then((result) => {
        if (!active) return;
        setServerResult(result);
        setShareError("");
        setMode("result");
        track("policy_share_viewed", { shareId: result.assessmentId });
      })
      .catch((error) => {
        if (!active) return;
        setShareError(
          error instanceof ApiError
            ? error.message
            : "分享链接加载失败，请稍后重试"
        );
        setMode("chat");
      });
    return () => {
      active = false;
    };
  }, [sharedToken]);

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
    setTextValue(question.id === "endDate" ? answers.endDate || "" : "");
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
    setServerMissingParameters([]);
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
      if (!isCalendarDate(value)) {
        setRequestError("请选择有效的完整入职日期");
        return;
      }
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, startDate: value, startMonth: undefined },
        2
      );
      return;
    }
    if (currentQuestion.id === "endDate") {
      if (
        !isCalendarDate(value) ||
        !answers.startDate ||
        value <= answers.startDate
      ) {
        setRequestError("解除日期需要晚于完整入职日期");
        return;
      }
      recordBaseAnswer(
        currentQuestion.id,
        value,
        { ...answers, endDate: value, endMonth: undefined },
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
      const preset = buildDefaultWageSeries(
        yuanToFen(answers.avgMonthlySalary),
        value,
        answers.startDate,
        answers.endDate
      );
      recordBaseAnswer(
        currentQuestion.id,
        value,
        {
          ...answers,
          bonusInfo: value,
          monthlyEarnedWagesFen: preset.monthlyEarnedWagesFen,
          wageDataConfirmed: false
        },
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
      startDate: answers.startDate!,
      endDate: answers.endDate!,
      terminationScenario: answers.terminationScenario || { kind: "UNCLEAR" },
      monthlyEarnedWagesFen:
        answers.monthlyEarnedWagesFen ||
        buildDefaultWageSeries(
          salaryFen,
          answers.bonusInfo,
          answers.startDate,
          answers.endDate
        ).monthlyEarnedWagesFen,
      wageDataConfirmation: {
        confirmed: true,
        basis: "pretax_earned_including_bonus_allowance"
      },
      ...(Object.keys(manualParameters).length ? { manualParameters } : {})
    };
  };

  const persistResult = (result: PolicyApiResult, currentAnswers: Answers) => {
    window.sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
    window.sessionStorage.setItem(ANSWERS_KEY, JSON.stringify(currentAnswers));
  };

  const submitPolicyCalculation = async () => {
    if (submitLockRef.current) return;
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (
      !answers.regionCode ||
      !answers.startDate ||
      !answers.endDate ||
      !answers.avgMonthlySalary
    ) {
      setRequestError("请先完成全部问卷");
      return;
    }
    if (
      !isCalendarDate(answers.startDate) ||
      !isCalendarDate(answers.endDate) ||
      answers.endDate <= answers.startDate
    ) {
      setRequestError("解除日期需要晚于完整入职日期");
      return;
    }
    if (
      wageSeries.length < 1 ||
      wageSeries.length > 12 ||
      wageSeries.some(
        (wage) =>
          !Number.isSafeInteger(wage) ||
          wage < 0 ||
          Object.is(wage, -0)
      )
    ) {
      setRequestError("请检查近1至12个月的应发工资，金额需为有效数字");
      return;
    }
    if (!answers.wageDataConfirmed) {
      setRequestError(
        "请逐月核对税前应发工资（含奖金、津贴、补贴）并确认口径"
      );
      return;
    }
    if (
      (manualMinimumRequired && !answers.manualMinimumMonthlyWage) ||
      (manualAverageRequired && !answers.manualEmployeeAverageMonthlyWage)
    ) {
      setRequestError("请补充缺失的当地参数后再提交");
      return;
    }
    submitLockRef.current = true;
    setIsSubmitting(true);
    const generation = ++calculationGenerationRef.current;
    calculationAbortRef.current?.abort();
    const controller = new AbortController();
    calculationAbortRef.current = controller;
    setMode("loading");
    setRequestError("");
    try {
      const response = await calculatePolicy(buildRequest(), controller.signal);
      if (generation !== calculationGenerationRef.current) return;
      setServerResult(response);
      persistResult(response, answers);
      track("policy_calculation_completed", {
        assessmentId: response.assessmentId,
        accuracyLevel: response.accuracyLevel
      });
      setMode("result");
    } catch (error) {
      if (
        generation !== calculationGenerationRef.current ||
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      setMode("chat");
      if (
        error instanceof ApiError &&
        error.code === "REGIONAL_PARAMETERS_REQUIRED"
      ) {
        const details =
          error.details && typeof error.details === "object"
            ? (error.details as { missing?: unknown }).missing
            : undefined;
        const missing = Array.isArray(details)
          ? details.filter(
              (item): item is string =>
                item === "minimumMonthlyWageFen" ||
                item === "employeeAverageMonthlyWageFen"
            )
          : [];
        setServerMissingParameters(missing);
        setRequestError(error.message);
      } else {
        setRequestError(
          error instanceof ApiError ? error.message : "测算失败，请稍后重试"
        );
      }
    } finally {
      if (generation === calculationGenerationRef.current) {
        submitLockRef.current = false;
        setIsSubmitting(false);
        calculationAbortRef.current = null;
      }
    }
  };

  const restart = () => {
    calculationGenerationRef.current += 1;
    calculationAbortRef.current?.abort();
    calculationAbortRef.current = null;
    submitLockRef.current = false;
    setIsSubmitting(false);
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
    setServerMissingParameters([]);
    track("assessment_restarted");
  };

  const resizeWageSeries = (nextCount: number) => {
    const count = Math.min(12, Math.max(1, nextCount));
    const current = [...wageSeries];
    const salaryFen = yuanToFen(answers.avgMonthlySalary);
    const next =
      count <= current.length
        ? current.slice(current.length - count)
        : [
            ...Array.from(
              { length: count - current.length },
              () => salaryFen
            ),
            ...current
          ];
    setAnswers({
      ...answers,
      monthlyEarnedWagesFen: next,
      wageDataConfirmed: false
    });
    setRequestError("");
  };

  const updateWageMonth = (index: number, rawValue: string) => {
    const next = [...wageSeries];
    const yuan = rawValue === "" ? Number.NaN : Number(rawValue);
    next[index] = Number.isFinite(yuan) ? yuanToFen(yuan) : Number.NaN;
    setAnswers({
      ...answers,
      monthlyEarnedWagesFen: next,
      wageDataConfirmed: false
    });
    setRequestError("");
  };

  const recalculateHistory = async (detail: PolicyHistoryDetail) => {
    setRequestError("");
    const request: PolicyCalculateRequest = {
      regionCode: detail.input.regionCode,
      startDate: detail.input.startDate,
      endDate: detail.input.endDate,
      terminationScenario: detail.input.terminationScenario,
      monthlyEarnedWagesFen: detail.input.monthlyEarnedWagesFen,
      wageDataConfirmation: detail.input.wageDataConfirmation,
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
      ? "入职日期"
        : currentQuestion?.id === "endDate"
          ? "解除日期"
          : currentQuestion?.id === "avgMonthlySalary"
            ? "税前基础月工资（元）"
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
            {!sharedToken && (
              <button className="mini-button" type="button" onClick={restart}>重算</button>
            )}
          </div>
        </header>

        {shareError && (
          <section className="shared-link-error" aria-labelledby="shared-link-error-title">
            <h1 id="shared-link-error-title">分享链接已失效</h1>
            <p role="alert">{shareError}</p>
          </section>
        )}

        {!shareError && mode !== "result" && (
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

        {!shareError && mode === "chat" && (
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
                      ? "date"
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
                  <label>
                    <span>复核入职日期</span>
                    <input
                      aria-label="复核入职日期"
                      type="date"
                      value={answers.startDate || ""}
                      onChange={(event) => {
                        setAnswers({
                          ...answers,
                          startDate: event.target.value,
                          wageDataConfirmed: false
                        });
                        setServerMissingParameters([]);
                        setRequestError("");
                      }}
                    />
                  </label>
                  <label>
                    <span>复核解除日期</span>
                    <input
                      aria-label="复核解除日期"
                      type="date"
                      value={answers.endDate || ""}
                      onChange={(event) => {
                        setAnswers({
                          ...answers,
                          endDate: event.target.value,
                          wageDataConfirmed: false
                        });
                        setServerMissingParameters([]);
                        setRequestError("");
                      }}
                    />
                  </label>
                  <span>月工资 {answers.avgMonthlySalary?.toLocaleString("zh-CN")} 元</span>
                </div>
                <section
                  className="wage-series-card"
                  aria-label={`近${wageSeries.length}个月税前应发工资`}
                >
                  <div className="wage-series-heading">
                    <div>
                      <strong>
                        近{wageSeries.length}个月税前应发工资
                      </strong>
                      <p>
                        含当月奖金、津贴和补贴；按时间从早到晚填写，最后一项是解除前一个完整月。
                      </p>
                    </div>
                    <label>
                      <span>月份数</span>
                      <select
                        aria-label="应发工资月份数"
                        value={wageSeries.length}
                        onChange={(event) =>
                          resizeWageSeries(Number(event.target.value))
                        }
                      >
                        {Array.from({ length: 12 }, (_, index) => index + 1).map(
                          (count) => (
                            <option key={count} value={count}>
                              {count}个月
                            </option>
                          )
                        )}
                      </select>
                    </label>
                  </div>
                  <p
                    className={
                      wagePreset.bonusNeedsReview
                        ? "wage-series-note is-warning"
                        : "wage-series-note"
                    }
                  >
                    {wagePreset.explanation}
                    {wagePreset.bonusNeedsReview
                      ? "，请按工资条或流水逐月调整。"
                      : "，你仍可按实际工资条调整。"}
                  </p>
                  <div className="wage-month-grid">
                    {wageSeries.map((wageFen, index) => {
                      const first = index === 0;
                      const last = index === wageSeries.length - 1;
                      const inputLabel = `第${index + 1}个月税前应发工资（含奖金、津贴、补贴，元${
                        first && last
                          ? "，最早，解除前完整月"
                          : first
                          ? "，最早"
                          : last
                            ? "，解除前完整月"
                            : ""
                      }）`;
                      return (
                        <label key={`${wageSeries.length}-${index}`}>
                          <span>
                            第{index + 1}月
                            {first && last
                              ? " · 最早 / 解除前"
                              : first
                                ? " · 最早"
                                : last
                                  ? " · 解除前"
                                  : ""}
                          </span>
                          <input
                            aria-label={inputLabel}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={
                              Number.isFinite(wageFen)
                                ? String(wageFen / 100)
                                : ""
                            }
                            onChange={(event) =>
                              updateWageMonth(index, event.target.value)
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                  <label className="wage-confirmation-check">
                    <input
                      type="checkbox"
                      checked={answers.wageDataConfirmed === true}
                      onChange={(event) =>
                        setAnswers({
                          ...answers,
                          wageDataConfirmed: event.target.checked
                        })
                      }
                    />
                    <span>
                      我已按工资条或流水逐月核对以上税前应发工资，奖金、津贴和补贴已填入实际发放月
                    </span>
                  </label>
                </section>
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
                  disabled={!answers.wageDataConfirmed || isSubmitting}
                  onClick={() => void submitPolicyCalculation()}
                >
                  {isSubmitting ? "正在生成…" : "生成政策测算"}
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
              sharedReadOnly={Boolean(sharedToken)}
            />
            <div ref={bottomRef} />
          </div>
        )}
      </section>

      {regionPickerOpen && (
        <div
          ref={regionDialogRef}
          className="paywall-overlay region-picker-overlay"
          role="dialog"
          aria-label="选择工作地区"
          aria-modal="true"
          tabIndex={-1}
        >
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
                ref={regionSearchRef}
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
