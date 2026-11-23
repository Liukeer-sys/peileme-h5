import { useEffect, useMemo, useRef, useState } from "react";
import ChatBubble from "./components/ChatBubble";
import OptionButtons from "./components/OptionButtons";
import PaidUpsellCard, { getSelectedReasonStepCount, PaidNextStepCard, SelectedReasonCard } from "./components/PaidUpsellCard";
import ResultCard from "./components/ResultCard";
import StickerCard from "./components/StickerCard";
import { baseQuestions, loadingMessages } from "./data/questions";
import { getTerminationReasonNode, rootTerminationReasonNode, type TerminationResultMode } from "./data/terminationReasonFlow";
import type { XiaoPeiAvatarState } from "./constants/xiaopeiAvatarStates";
import { getXiaoPeiAvatarStateForReply, xiaoPeiAvatarStateByMessageIntent } from "./constants/xiaopeiAvatarStates";
import type { Answers } from "./types";
import {
  findTerminationTypeByAnswer,
  getReply,
  hasServiceDateConflict,
  inferBonusLevel,
  parseLooseMonth,
  parseMoneyAmount,
} from "./utils/chatFlow";
import { calculateCompensation } from "./utils/calculate";
import { clearAnswers, clearEvidenceProgress, loadAnswers, saveAnswers } from "./utils/storage";

type NHelpKind = "n" | "nPlusOne" | "twoN";

type ChatMessage = {
  id: string;
  from: "system" | "user";
  text: string;
  muted?: boolean;
  typing?: boolean;
  avatarState?: XiaoPeiAvatarState;
  nHelpKind?: NHelpKind;
  typingDurationMs?: number;
};

type AppMode = "chat" | "loading" | "result";

type ConversationSnapshot = {
  answers: Answers;
  messages: ChatMessage[];
  stepIndex: number;
  terminationNodeId: string;
  terminationConclusionReady: boolean;
  optionsPaused: boolean;
  awaitingCustomCity: boolean;
  textValue: string;
  progressStep: number;
};

const MESSAGE_STAGGER_MS = 520;
const DELIBERATE_TYPING_MS = 1600;
const POST_EXIT_WISH_TYPING_MS = 2800;
const formatTerminationResultSuffix = (mode: string) => {
  if (mode === "zeroRisk") return "(0)";
  if (mode === "zeroOrTwoN") return "（需要结合证据继续判断）";
  return "";
};

const getNHelpKind = (mode: TerminationResultMode, showResultSuffix = true): NHelpKind | undefined => {
  if (!showResultSuffix || mode === "zeroRisk") return undefined;
  if (mode === "nPlusOne") return "nPlusOne";
  if (mode === "twoN" || mode === "zeroOrTwoN") return "twoN";
  return "n";
};

type NHelpYearClockPortion = "full" | "fiveEighths" | "third";

const nHelpYearClockPaths: Record<Exclude<NHelpYearClockPortion, "full">, string> = {
  fiveEighths: "M 10 10 L 10 2 A 8 8 0 1 1 4.343 15.657 Z",
  third: "M 10 10 L 10 2 A 8 8 0 0 1 16.928 14 Z"
};

function NHelpYearClock({ portion }: { portion: NHelpYearClockPortion }) {
  return (
    <svg className="n-help-year-clock" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="n-help-year-clock-base" cx="10" cy="10" r="8" />
      {portion === "full" ? (
        <circle className="n-help-year-clock-fill" cx="10" cy="10" r="8" />
      ) : (
        <path className="n-help-year-clock-fill" d={nHelpYearClockPaths[portion]} />
      )}
      <circle className="n-help-year-clock-outline" cx="10" cy="10" r="8" />
    </svg>
  );
}


const initialAnswers: Answers = {
  followUps: {}
};

export default function App() {
  const restored = useMemo(() => loadAnswers(), []);
  const [answers, setAnswers] = useState<Answers>(restored || initialAnswers);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [terminationNodeId, setTerminationNodeId] = useState(rootTerminationReasonNode.id);
  const [terminationConclusionReady, setTerminationConclusionReady] = useState(false);
  const [optionsPaused, setOptionsPaused] = useState(!restored);
  const [awaitingCustomCity, setAwaitingCustomCity] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [mode, setMode] = useState<AppMode>(restored ? "result" : "chat");
  const [loadingIndex, setLoadingIndex] = useState(0);
  const [showSticker, setShowSticker] = useState(false);
  const [showNExplanation, setShowNExplanation] = useState(false);
  const [nExplanationKind, setNExplanationKind] = useState<NHelpKind>("n");
  const [selectedEquivalentId, setSelectedEquivalentId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<ConversationSnapshot[]>([]);
  const [progressStep, setProgressStep] = useState(0);
  const [isReselectingPostExitWish, setIsReselectingPostExitWish] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messageTimersRef = useRef<number[]>([]);

  const currentQuestion = baseQuestions[stepIndex];
  const result = useMemo(() => calculateCompensation(answers), [answers]);
  const currentCityName = answers.customCity || (answers.city === "其他城市" ? "" : answers.city) || "这座城市";
  const currentTerminationNode =
    currentQuestion?.id === "terminationReason" ? getTerminationReasonNode(terminationNodeId) ?? rootTerminationReasonNode : undefined;
  const displayedOptions = (currentTerminationNode?.options.map((option) => option.label) || currentQuestion?.options)?.map((option) =>
    option.replace(/\{city\}/g, currentCityName)
  );
  const progressPercent = mode === "loading" ? 100 : (progressStep / baseQuestions.length) * 100;
  const clearMessageTimers = () => {
    messageTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    messageTimersRef.current = [];
  };

  const rememberCurrentStep = () => {
    setConversationHistory((history) => [
      ...history,
      {
        answers,
        messages,
        stepIndex,
        terminationNodeId,
        terminationConclusionReady,
        optionsPaused,
        awaitingCustomCity,
        textValue,
        progressStep
      }
    ]);
  };

  const goToPreviousStep = () => {
    const previous = conversationHistory[conversationHistory.length - 1];
    if (!previous && isReselectingPostExitWish) {
      const terminationQuestionIndex = baseQuestions.findIndex((question) => question.id === "terminationReason");
      clearMessageTimers();
      setAnswers((currentAnswers) => ({
        ...currentAnswers,
        terminationReason: undefined,
        terminationReasonType: undefined,
        terminationReasonText: undefined,
        postExitWish: undefined,
        hasWrittenNotice: undefined,
        hasAgreement: undefined,
        followUps: {}
      }));
      setMessages([
        {
          id: `q-terminationReason-reselect-back-${Date.now()}`,
          from: "system",
          text: rootTerminationReasonNode.question,
          avatarState: xiaoPeiAvatarStateByMessageIntent.question
        }
      ]);
      setStepIndex(terminationQuestionIndex);
      setTerminationNodeId(rootTerminationReasonNode.id);
      setTerminationConclusionReady(false);
      setAwaitingCustomCity(false);
      setOptionsPaused(false);
      setTextValue("");
      setProgressStep(terminationQuestionIndex);
      setIsReselectingPostExitWish(false);
      return;
    }
    if (!previous) return;

    clearMessageTimers();
    setIsReselectingPostExitWish(false);
    setAnswers(previous.answers);
    setMessages(previous.messages);
    setStepIndex(previous.stepIndex);
    setTerminationNodeId(previous.terminationNodeId);
    setTerminationConclusionReady(previous.terminationConclusionReady);
    setOptionsPaused(previous.optionsPaused);
    setAwaitingCustomCity(previous.awaitingCustomCity);
    setTextValue(previous.textValue);
    setProgressStep(previous.progressStep);
    setConversationHistory((history) => history.slice(0, -1));
  };

  const appendMessages = (...items: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...items]);
  };

  const replaceMessage = (messageId: string, nextMessage: ChatMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === messageId ? nextMessage : message)));
  };

  const trackTimer = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      callback();
      messageTimersRef.current = messageTimersRef.current.filter((savedTimer) => savedTimer !== timer);
    }, delay);
    messageTimersRef.current.push(timer);
  };

  const appendMessagesSequentially = (...items: ChatMessage[]) => {
    let delay = 0;

    items.forEach((item) => {
      if (item.from !== "system") {
        trackTimer(() => appendMessages(item), delay);
        return;
      }

      const typingId = `typing-${item.id}`;
      trackTimer(() => appendMessages({ id: typingId, from: "system", text: "", typing: true, avatarState: "calculating" }), delay);
      delay += item.typingDurationMs ?? MESSAGE_STAGGER_MS;
      trackTimer(() => replaceMessage(typingId, item), delay);
      delay += MESSAGE_STAGGER_MS;
    });

    return delay;
  };

  useEffect(() => {
    if (!restored) {
      appendMessagesSequentially(
        {
          id: "hello",
          from: "system",
          text: "你好，我是小赔。咱们来把你的离职身价粗算一下。",
          avatarState: xiaoPeiAvatarStateByMessageIntent.welcome
        },
        { id: `q-${baseQuestions[0].id}`, from: "system", text: baseQuestions[0].message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
      );
      trackTimer(() => setOptionsPaused(false), MESSAGE_STAGGER_MS * 4);
    }
  }, [restored]);

  useEffect(() => clearMessageTimers, []);

  useEffect(() => {
    if (mode === "result") return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, mode, loadingIndex, optionsPaused, stepIndex, terminationNodeId]);

  useEffect(() => {
    if (currentQuestion?.kind === "month") {
      setTextValue(currentQuestion.id === "startDate" ? answers.startMonth || "" : answers.endMonth || "");
      return;
    }
    setTextValue("");
  }, [answers.endMonth, answers.startMonth, currentQuestion?.id, currentQuestion?.kind]);

  useEffect(() => {
    if (mode !== "loading") return;
    const messageTimer = window.setInterval(() => {
      setLoadingIndex((index) => (index + 1) % loadingMessages.length);
    }, 620);
    const doneTimer = window.setTimeout(() => {
      saveAnswers(answers);
      setMode("result");
    }, 2800);
    return () => {
      window.clearInterval(messageTimer);
      window.clearTimeout(doneTimer);
    };
  }, [answers, mode]);

  const buildAnswersForQuestion = (questionId: string, value: string): Answers => {
    const next: Answers = { ...answers };

    if (questionId === "city") {
      next.city = value;
      next.customCity = value === "其他城市" ? undefined : value;
    }

    if (questionId === "startDate") {
      const parsed = parseLooseMonth(value);
      next.startDate = value;
      next.startDateParsed = parsed.month;
      next.startMonth = parsed.month;
    }

    if (questionId === "endDate") {
      const parsed = parseLooseMonth(value);
      next.endDate = value;
      next.endDateParsed = parsed.month;
      next.endMonth = parsed.month;
    }

    if (questionId === "workSchedule") {
      next.workSchedule = value;
    }

    if (questionId === "avgMonthlySalary") {
      const amount = parseMoneyAmount(value);
      next.avgMonthlySalaryText = value;
      next.avgMonthlySalary = amount;
      next.takeHomeSalary = amount;
    }

    if (questionId === "bonusInfo") {
      next.bonusInfo = value;
      next.bonusLevel = inferBonusLevel(value, next.avgMonthlySalary || next.takeHomeSalary);
    }

    if (questionId === "postExitWish") {
      next.postExitWish = value;
    }

    return next;
  };

  const askPostExitWish = (reply: string, extraReplies: string[] = [], nHelpKind?: NHelpKind, useDeliberateFollowUp = false) => {
    const nextIndex = stepIndex + 1;
    const next = baseQuestions[nextIndex];
    const systemMessages: ChatMessage[] = [
      { id: `reply-termination-${Date.now()}`, from: "system", text: reply, avatarState: getXiaoPeiAvatarStateForReply("terminationReason", reply), nHelpKind },
      ...extraReplies.map((text, index) => ({
        id: `reply-termination-extra-${index}-${Date.now()}`,
        from: "system" as const,
        text,
        avatarState: "warning" as const,
        typingDurationMs: useDeliberateFollowUp ? DELIBERATE_TYPING_MS : undefined
      })),
      {
        id: `q-${next.id}-${Date.now()}`,
        from: "system",
        text: next.message,
        avatarState: xiaoPeiAvatarStateByMessageIntent.question,
        typingDurationMs: POST_EXIT_WISH_TYPING_MS
      }
    ];
    setOptionsPaused(true);
    const sequenceDuration = appendMessagesSequentially(...systemMessages);
    trackTimer(() => {
      setStepIndex(nextIndex);
      setOptionsPaused(false);
    }, sequenceDuration);
  };

  const continueToNextQuestion = (reply: string, nextIndex: number) => {
    const next = baseQuestions[nextIndex];
    if (!next) {
      appendMessagesSequentially({ id: `reply-${Date.now()}`, from: "system", text: reply, avatarState: "result" });
      trackTimer(() => setMode("loading"), MESSAGE_STAGGER_MS);
      return;
    }

    if (currentQuestion?.id === "startDate") {
      setOptionsPaused(true);
      appendMessagesSequentially({ id: `reply-${currentQuestion.id}-${Date.now()}`, from: "system", text: reply, avatarState: getXiaoPeiAvatarStateForReply(currentQuestion.id, reply) });
      trackTimer(() => {
        setStepIndex(nextIndex);
        setOptionsPaused(false);
      }, MESSAGE_STAGGER_MS * 2);
      return;
    }

    setOptionsPaused(true);
    appendMessagesSequentially(
      { id: `reply-${currentQuestion?.id || "step"}-${Date.now()}`, from: "system", text: reply, avatarState: getXiaoPeiAvatarStateForReply(currentQuestion?.id || "step", reply) },
      { id: `q-${next.id}-${Date.now()}`, from: "system", text: next.message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
    );
    trackTimer(() => {
      setStepIndex(nextIndex);
      setOptionsPaused(false);
    }, MESSAGE_STAGGER_MS * 4);
  };

  const handleTerminationAnswer = (value: string) => {
    const node = currentTerminationNode ?? rootTerminationReasonNode;
    const option = node.options.find((item) => item.label === value);
    if (!option) return;

    const nextReasonText = [answers.terminationReasonText, value].filter(Boolean).join("\n");
    const nextAnswers: Answers = {
      ...answers,
      terminationReasonText: nextReasonText,
      followUps: {
        ...answers.followUps,
        [node.id]: value
      }
    };

    appendMessages({ id: `a-termination-${Date.now()}`, from: "user", text: value });

    if (option.nextId) {
      const nextNode = getTerminationReasonNode(option.nextId);
      setAnswers(nextAnswers);
      setTerminationNodeId(option.nextId);
      setTerminationConclusionReady(false);
      setOptionsPaused(true);
      if (nextNode) {
        appendMessagesSequentially({
          id: `q-${nextNode.id}-${Date.now()}`,
          from: "system",
          text: nextNode.question,
          avatarState: xiaoPeiAvatarStateByMessageIntent.question
        });
        trackTimer(() => setOptionsPaused(false), MESSAGE_STAGGER_MS * 2);
      }
      return;
    }

    if (!option.leaf) return;

    const leafAnswers: Answers = {
      ...nextAnswers,
      terminationReason: option.leaf.id,
      terminationReasonType: option.leaf.id,
      terminationReasonText: [nextReasonText, option.leaf.inferredType].filter(Boolean).join("\n"),
      hasWrittenNotice: node.id.includes("30_DAYS") ? value === "是" : answers.hasWrittenNotice
    };

    const leafReply = `${option.leaf.reply}${
      option.leaf.showResultSuffix === false ? "" : formatTerminationResultSuffix(option.leaf.resultMode)
    }`;

    setAnswers(leafAnswers);
    setTerminationConclusionReady(false);
    askPostExitWish(
      leafReply,
      option.leaf.resultMode === "zeroOrTwoN" ? ["计算完牛马身价后，可以在“证据梳理”板块看看需要准备什么证据，进一步确认~"] : [],
      getNHelpKind(option.leaf.resultMode, option.leaf.showResultSuffix !== false),
      option.leaf.resultMode === "zeroOrTwoN"
    );
  };
  const submitCustomCity = (value: string) => {
    rememberCurrentStep();
    const nextAnswers: Answers = {
      ...answers,
      city: value,
      customCity: value
    };
    setAnswers(nextAnswers);
    setAwaitingCustomCity(false);
    setTextValue("");
    appendMessages({ id: `a-custom-city-${Date.now()}`, from: "user", text: value });
    continueToNextQuestion(getReply("roast", "city", value, nextAnswers), 1);
  };

  const cancelCustomCity = () => {
    clearMessageTimers();
    setAnswers({ ...answers, city: undefined, customCity: undefined });
    setConversationHistory((history) => history.slice(0, -1));
    setAwaitingCustomCity(false);
    setTextValue("");
    setMessages((previous) =>
      previous.filter(
        (message) =>
          !message.id.startsWith("a-city-") &&
          !message.id.startsWith("q-custom-city-") &&
          !message.id.startsWith("typing-q-custom-city-")
      )
    );
  };

  const handleBaseAnswer = (rawValue: string | number) => {
    if (!currentQuestion) return;
    const value = String(rawValue).trim();
    if (!value) return;

    rememberCurrentStep();
    setProgressStep((completed) => Math.max(completed, stepIndex + 1));

    if (currentQuestion.id === "terminationReason") {
      handleTerminationAnswer(value);
      return;
    }

    if (currentQuestion.id === "city" && value === "其他城市") {
      setAnswers({ ...answers, city: value, customCity: undefined });
      setAwaitingCustomCity(true);
      appendMessages({ id: `a-city-${Date.now()}`, from: "user", text: value });
      appendMessagesSequentially({ id: `q-custom-city-${Date.now()}`, from: "system", text: "那具体是哪个城市？", avatarState: xiaoPeiAvatarStateByMessageIntent.question });
      return;
    }
    const nextAnswers = buildAnswersForQuestion(currentQuestion.id, value);
    setAnswers(nextAnswers);
    appendMessages({ id: `a-${currentQuestion.id}-${Date.now()}`, from: "user", text: value });

    if (currentQuestion.id === "postExitWish") {
      setIsReselectingPostExitWish(false);
      const reply = getReply("roast", currentQuestion.id, value, nextAnswers);
      appendMessagesSequentially({
        id: `reply-${currentQuestion.id}-${Date.now()}`,
        from: "system",
        text: reply,
        avatarState: getXiaoPeiAvatarStateForReply(currentQuestion.id, reply)
      });
      trackTimer(() => setTerminationConclusionReady(true), MESSAGE_STAGGER_MS * 2);
      return;
    }

    if (currentQuestion.id === "endDate" && hasServiceDateConflict(nextAnswers)) {
      setOptionsPaused(true);
      appendMessagesSequentially(
        { id: `reply-endDate-conflict-${Date.now()}`, from: "system", text: getReply("roast", currentQuestion.id, value, nextAnswers) },
        { id: `q-startDate-recheck-${Date.now()}`, from: "system", text: baseQuestions[1].message }
      );
      trackTimer(() => {
        setStepIndex(1);
        setOptionsPaused(false);
      }, MESSAGE_STAGGER_MS * 4);
      return;
    }

    continueToNextQuestion(getReply("roast", currentQuestion.id, value, nextAnswers), stepIndex + 1);
  };

  const submitText = () => {
    const value = textValue.trim();
    if (!value) return;

    if (awaitingCustomCity) {
      submitCustomCity(value);
      return;
    }

    handleBaseAnswer(value);
    setTextValue("");
  };

  const restart = () => {
    clearMessageTimers();
    clearAnswers();
    clearEvidenceProgress();
    setAnswers(initialAnswers);
    setMessages([]);
    setOptionsPaused(true);
    appendMessagesSequentially(
      { id: "hello-restart", from: "system", text: "好，重新来一遍。这次我们把牛马身价算得更准一点。", avatarState: "smirk" },
      { id: `q-${baseQuestions[0].id}-restart`, from: "system", text: baseQuestions[0].message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
    );
    setStepIndex(0);
    setTerminationNodeId(rootTerminationReasonNode.id);
    setTerminationConclusionReady(false);
    setOptionsPaused(true);
    setAwaitingCustomCity(false);
    setTextValue("");
    setMode("chat");
    setShowSticker(false);
    setShowNExplanation(false);
    setSelectedEquivalentId(null);
    setConversationHistory([]);
    setProgressStep(0);
    setIsReselectingPostExitWish(false);
    trackTimer(() => setOptionsPaused(false), MESSAGE_STAGGER_MS * 4);
  };

  const openSticker = (equivalentId: string) => {
    setSelectedEquivalentId(equivalentId);
    setShowSticker(true);
  };

  const reselectPostExitWish = () => {
    const wishQuestionIndex = baseQuestions.findIndex((question) => question.id === "postExitWish");
    if (wishQuestionIndex < 0) return;
    clearMessageTimers();
    setMode("chat");
    setStepIndex(wishQuestionIndex);
    setTerminationConclusionReady(false);
    setOptionsPaused(false);
    setAwaitingCustomCity(false);
    setTextValue("");
    setShowSticker(false);
    setShowNExplanation(false);
    setSelectedEquivalentId(null);
    setConversationHistory((history) => history.slice(0, -1));
    setProgressStep(wishQuestionIndex);
    setIsReselectingPostExitWish(true);
    appendMessagesSequentially({
      id: `q-postExitWish-reselect-${Date.now()}`,
      from: "system",
      text: "可以，快乐方案重新选。钱拿到手，你最想先把哪种快乐补回来？",
      avatarState: xiaoPeiAvatarStateByMessageIntent.question,
      typingDurationMs: POST_EXIT_WISH_TYPING_MS
    });
  };

  const needsCustomCity = awaitingCustomCity;
  const showOptions =
    mode === "chat" &&
    !awaitingCustomCity &&
    !terminationConclusionReady &&
    !optionsPaused &&
    currentQuestion?.kind === "options" &&
    !needsCustomCity;
  const showInput =
    mode === "chat" &&
    !terminationConclusionReady &&
    (awaitingCustomCity || currentQuestion?.kind === "text" || currentQuestion?.kind === "number" || currentQuestion?.kind === "month");
  const optionVariant =
    currentQuestion?.id === "city"
      ? "city"
      : currentQuestion?.id === "bonusInfo"
        ? "bonus"
        : currentQuestion?.id === "workSchedule"
          ? "work-schedule"
          : currentQuestion?.id === "postExitWish"
            ? "wish"
            : currentQuestion?.id === "terminationReason" && terminationNodeId === rootTerminationReasonNode.id
              ? "termination-root"
              : currentQuestion?.id === "terminationReason" && terminationNodeId === "SELF_RESIGN_REASON"
                ? "forced-reason"
                : currentQuestion?.id === "terminationReason" && terminationNodeId === "COMPANY_DISMISS_REASON"
                  ? "dismiss-reason"
                  : currentQuestion?.id === "terminationReason" && terminationNodeId === "FAULT_DISMISS_CHECK"
                    ? "fault-reason"
                    : currentQuestion?.id === "terminationReason" && terminationNodeId === "FAULT_TRUTH_CHECK"
                      ? "fault-truth"
                      : currentQuestion?.id === "terminationReason" && terminationNodeId === "NO_FAULT_DISMISS_CHECK"
                        ? "no-fault-reason"
                        : currentQuestion?.id === "terminationReason" && terminationNodeId === "CONTRACT_EXPIRED_CHECK"
                          ? "contract-expired"
                          : "default";
  const optionHasHeading = ["city", "bonus", "work-schedule", "wish", "termination-root", "default", "forced-reason", "dismiss-reason", "fault-reason", "fault-truth", "no-fault-reason", "contract-expired"].includes(optionVariant);
  const hasInlineComposerHeading = Boolean(
    needsCustomCity ||
    (showOptions && currentQuestion?.options && optionHasHeading) ||
    (showInput && !needsCustomCity && (currentQuestion?.kind === "month" || currentQuestion?.id === "avgMonthlySalary"))
  );
  const previousStepControl =
    conversationHistory.length > 0 || isReselectingPostExitWish ? (
      <button className="previous-step-button" type="button" onClick={goToPreviousStep}>
        <span aria-hidden="true">←</span> 上一步
      </button>
    ) : null;

  return (
    <main className="app-shell">
      <section className="phone-frame">
        <header className={mode === "result" ? "topbar result-topbar" : "topbar"}>
          <div>
            <span className="brand-dot" />
            <strong>赔了么</strong>
          </div>
          {mode !== "result" && <span className="chat-partner">小赔</span>}
          <button className="mini-button" type="button" onClick={restart}>
            重算
          </button>
        </header>

        {mode !== "result" && (
          <div
            className="conversation-progress"
            role="progressbar"
            aria-label="问答进度"
            aria-valuemin={0}
            aria-valuemax={baseQuestions.length}
            aria-valuenow={mode === "loading" ? baseQuestions.length : progressStep}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        )}

        {mode !== "result" && (
          <div className="chat-area">
            {messages.map((message) => (
              <ChatBubble key={message.id} from={message.from} muted={message.muted} avatarState={message.typing ? "calculating" : message.avatarState}>
                {message.typing ? (
                  <span className="typing-dots" aria-label="小赔正在输入">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <>
                    {message.text}
                    {message.nHelpKind && (
                      <button
                        className="n-help-inline-button"
                        type="button"
                        onClick={() => {
                          setNExplanationKind(message.nHelpKind!);
                          setShowNExplanation(true);
                        }}
                      >
                        {message.nHelpKind === "nPlusOne" ? "N+1是什么？" : message.nHelpKind === "twoN" ? "2N是什么？" : "N是什么？"}
                      </button>
                    )}
                  </>
                )}
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
            <div ref={bottomRef} />
          </div>
        )}

        {mode === "chat" && (
          <footer className={`composer${previousStepControl ? " has-previous-step" : ""}${previousStepControl && hasInlineComposerHeading ? " has-inline-heading" : ""}${previousStepControl && showOptions ? " has-option-grid" : ""}`}>
            {previousStepControl}
            {showOptions && currentQuestion?.options && (
              <OptionButtons
                options={displayedOptions || currentQuestion.options}
                onChoose={handleBaseAnswer}
                variant={optionVariant}
              />
            )}

            {terminationConclusionReady && (
              <button className="primary-button calculation-submit-button" type="button" onClick={() => setMode("loading")}>
                计算你的牛马身价
              </button>
            )}

            {needsCustomCity && showInput && (
              <>
                <div className="date-input-heading custom-city-input-heading">
                  <small className="date-input-hint">输入工作城市</small>
                  <button className="city-picker-back" type="button" onClick={cancelCustomCity}>
                    ‹ 返回选择热门城市
                  </button>
                </div>
                <div className="input-row">
                  <input
                    autoFocus
                    value={textValue}
                    type="text"
                    placeholder="例如：苏州"
                    onChange={(event) => setTextValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitText();
                    }}
                  />
                  <button className="send-button" type="button" onClick={submitText}>
                    发送
                  </button>
                </div>
              </>
            )}

            {showInput && !needsCustomCity && (
              <>
                {(currentQuestion?.kind === "month" || currentQuestion?.id === "avgMonthlySalary") && (
                  <div className="date-input-heading">
                    <small className="date-input-hint">
                      {currentQuestion?.kind === "month" ? "点击下方选择日期" : "请输入大概金额"}
                    </small>
                  </div>
                )}
                <div className="input-row">
                  <input
                    value={textValue}
                    type={currentQuestion?.kind === "month" ? "month" : "text"}
                    inputMode={currentQuestion?.id === "avgMonthlySalary" ? "numeric" : "text"}
                    placeholder={needsCustomCity ? "例如 苏州" : currentQuestion?.placeholder || "写在这里"}
                    onChange={(event) => setTextValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitText();
                    }}
                  />
                  <button className="send-button" type="button" onClick={submitText}>
                    发送
                  </button>
                </div>
              </>
            )}
          </footer>
        )}

        {mode === "result" && (
          <div className="result-page">
            <ResultCard
              result={result}
              onSticker={openSticker}
              postExitWish={answers.postExitWish}
              onReselectWish={reselectPostExitWish}
              reasonStepCount={getSelectedReasonStepCount(answers, result)}
              selectionSummary={<SelectedReasonCard result={result} answers={answers} />}
            >
              <PaidNextStepCard />
            </ResultCard>
            <PaidUpsellCard result={result} answers={answers} showIntro={false} />
            <button className="secondary-button" type="button" onClick={restart}>
              重新评估一次
            </button>
            <div ref={bottomRef} />
          </div>
        )}
      </section>
      {showNExplanation && (
        <div className="n-help-overlay" role="presentation" onClick={() => setShowNExplanation(false)}>
          <section className="n-help-dialog" role="dialog" aria-modal="true" aria-labelledby="n-help-title" onClick={(event) => event.stopPropagation()}>
            <button className="n-help-close" type="button" aria-label="关闭" onClick={() => setShowNExplanation(false)}>×</button>
            {nExplanationKind !== "n" && (
              <span className="n-help-kicker">
                {nExplanationKind === "nPlusOne" ? "经济补偿与代通知金" : "违法解除赔偿金"}
              </span>
            )}
            <h2 id="n-help-title">{nExplanationKind === "nPlusOne" ? "N+1 是什么？" : nExplanationKind === "twoN" ? "2N 是什么？" : "N 是什么？"}</h2>
            <p className="n-help-lead">
              <b>N</b> 指根据你在这家公司的工作年限，折算出的补偿月数。经济补偿一般按 <b className="n-help-formula-inline">N × 月工资</b>计算。这里的“月工资”，是指劳动合同解除或终止前 12 个月的平均工资。{nExplanationKind === "nPlusOne" && <>N+1 中额外的 1 个月工资是代通知金。</>}
            </p>
            {nExplanationKind !== "n" && (
              <p className="n-help-variant-explanation">
                {nExplanationKind === "nPlusOne" ? <><b>N+1</b> 里的“1”，指额外支付 1 个月工资作为代通知金。</> : <><b>2N</b> 里的“2”，指公司违法解除劳动合同时，按经济补偿 N 的两倍支付赔偿金。</>}
              </p>
            )}
            <p className="n-help-example">
              {nExplanationKind === "nPlusOne" ? <>比如你在这家公司工作了 5 年，N+1 对应的金额就大约是 6 个月工资，其中 5 个月是经济补偿，另外 1 个月是代通知金。</> : nExplanationKind === "twoN" ? <>比如你在这家公司工作了 5 年，2N 对应的赔偿金就大约是 10 个月工资。</> : <>比如在某公司工作 5 年，得到的经济补偿大约是 5 个月工资。</>}
            </p>
            <div className="n-help-year-rules" aria-label="N 的工龄折算规则">
              <p><NHelpYearClock portion="full" /><b>每工作满 1 年</b><span>N按1计算</span></p>
              <p><NHelpYearClock portion="fiveEighths" /><b>满 6 个月不满 1 年</b><span>N按1计算</span></p>
              <p><NHelpYearClock portion="third" /><b>不满 6 个月</b><span>N按0.5计算</span></p>
            </div>
            <small>依据：《中华人民共和国劳动合同法》第四十七条{nExplanationKind === "twoN" ? "、第八十七条" : nExplanationKind === "nPlusOne" ? "、第四十条" : ""}</small>
            <button className="n-help-confirm" type="button" onClick={() => setShowNExplanation(false)}>明白了</button>
          </section>
        </div>
      )}
      {showSticker && (
        <StickerCard result={result} equivalentId={selectedEquivalentId} onClose={() => setShowSticker(false)} />
      )}
    </main>
  );
}
