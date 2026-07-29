import { useEffect, useMemo, useRef, useState } from "react";
import ChatBubble from "./components/ChatBubble";
import OptionButtons from "./components/OptionButtons";
import PaidUpsellCard, { PaidNextStepCard, SelectedReasonCard } from "./components/PaidUpsellCard";
import ResultCard from "./components/ResultCard";
import StickerCard from "./components/StickerCard";
import { baseQuestions, loadingMessages } from "./data/questions";
import { forcedOtherReasonLeaf, getTerminationReasonNode, rootTerminationReasonNode, type TerminationLeaf } from "./data/terminationReasonFlow";
import type { XiaoPeiAvatarState } from "./constants/xiaopeiAvatarStates";
import { getXiaoPeiAvatarStateForReply, xiaoPeiAvatarStateByMessageIntent } from "./constants/xiaopeiAvatarStates";
import type { Answers } from "./types";
import {
  findTerminationTypeByAnswer,
  getReply,
  hasServiceDateConflict,
  inferAgreement,
  inferBonusLevel,
  inferWrittenNotice,
  isDetailedTerminationDescription,
  parseLooseMonth,
  parseMoneyAmount,
} from "./utils/chatFlow";
import { calculateCompensation, currentMonthValue } from "./utils/calculate";
import { clearAnswers, loadAnswers, saveAnswers } from "./utils/storage";

type ChatMessage = {
  id: string;
  from: "system" | "user";
  text: string;
  muted?: boolean;
  typing?: boolean;
  avatarState?: XiaoPeiAvatarState;
};

type AppMode = "chat" | "loading" | "result";

const MESSAGE_STAGGER_MS = 520;
const formatTerminationResultSuffix = (mode: string) => {
  if (mode === "n") return "(N)";
  if (mode === "nPlusOne") return "(N+1)";
  if (mode === "twoN") return "(2N)";
  if (mode === "zeroRisk") return "(0)";
  if (mode === "zeroOrTwoN") return "(0 / 2N，需要结合证据继续判断)";
  return "";
};


const initialAnswers: Answers = {
  endMonth: currentMonthValue(),
  followUps: {}
};

const mergeBooleanInference = (current: boolean | undefined, next: boolean | undefined) =>
  next === undefined ? current : next;

export default function App() {
  const restored = useMemo(() => loadAnswers(), []);
  const [answers, setAnswers] = useState<Answers>(restored || initialAnswers);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [awaitingTerminationDetail, setAwaitingTerminationDetail] = useState(false);
  const [pendingTerminationDetailLeaf, setPendingTerminationDetailLeaf] = useState<TerminationLeaf | null>(null);
  const [terminationNodeId, setTerminationNodeId] = useState(rootTerminationReasonNode.id);
  const [terminationConclusionReady, setTerminationConclusionReady] = useState(false);
  const [optionsPaused, setOptionsPaused] = useState(!restored);
  const [awaitingCustomCity, setAwaitingCustomCity] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [mode, setMode] = useState<AppMode>(restored ? "result" : "chat");
  const [loadingIndex, setLoadingIndex] = useState(0);
  const [showSticker, setShowSticker] = useState(false);
  const [selectedEquivalentId, setSelectedEquivalentId] = useState<string | null>(null);
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
  const clearMessageTimers = () => {
    messageTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    messageTimersRef.current = [];
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
      delay += MESSAGE_STAGGER_MS;
      trackTimer(() => replaceMessage(typingId, item), delay);
      delay += MESSAGE_STAGGER_MS;
    });
  };

  useEffect(() => {
    if (!restored) {
      appendMessagesSequentially(
        {
          id: "hello",
          from: "system",
          text: "你好，我是赔了么。先不讲大道理，咱们把你的离职身价粗算一下，枪口只对公司。",
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
    if (currentQuestion?.id === "endDate") {
      setTextValue(answers.endMonth || currentMonthValue());
      return;
    }
    if (currentQuestion?.kind !== "month") setTextValue("");
  }, [answers.endMonth, currentQuestion?.id, currentQuestion?.kind]);

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
      next.endMonth = parsed.month || currentMonthValue();
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

  const askPostExitWish = (reply: string, extraReplies: string[] = []) => {
    const nextIndex = stepIndex + 1;
    const next = baseQuestions[nextIndex];
    const systemMessages: ChatMessage[] = [
      { id: `reply-termination-${Date.now()}`, from: "system", text: reply, avatarState: getXiaoPeiAvatarStateForReply("terminationReason", reply) },
      ...extraReplies.map((text, index) => ({
        id: `reply-termination-extra-${index}-${Date.now()}`,
        from: "system" as const,
        text,
        avatarState: "warning" as const
      })),
      { id: `q-${next.id}-${Date.now()}`, from: "system", text: next.message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
    ];
    setOptionsPaused(true);
    appendMessagesSequentially(...systemMessages);
    trackTimer(() => {
      setStepIndex(nextIndex);
      setOptionsPaused(false);
    }, MESSAGE_STAGGER_MS * systemMessages.length * 2);
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

    if (option.nextId === "SELF_RESIGN_OTHER_REASON_DETAIL") {
      setAnswers(nextAnswers);
      setPendingTerminationDetailLeaf(forcedOtherReasonLeaf);
      setAwaitingTerminationDetail(true);
      setTerminationConclusionReady(false);
      setOptionsPaused(true);
      setTextValue("");
      appendMessagesSequentially({
        id: `q-${option.nextId}-${Date.now()}`,
        from: "system",
        text: "可以简单描述一下原因",
        avatarState: xiaoPeiAvatarStateByMessageIntent.question
      });
      return;
    }

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

    const leafReply = `${option.leaf.reply}${formatTerminationResultSuffix(option.leaf.resultMode)}`;

    setAnswers(leafAnswers);
    setTerminationConclusionReady(false);
    askPostExitWish(
      leafReply,
      option.leaf.resultMode === "zeroOrTwoN" ? ["计算完牛马身价后，可以在“证据梳理”板块看看需要准备什么证据，进一步确认~"] : []
    );
  };
  const submitTerminationDetail = (value: string) => {
    const combinedText = [answers.terminationReasonText, value].filter(Boolean).join("\n");
    const nextAnswers: Answers = {
      ...answers,
      terminationReasonText: combinedText,
      followUps: {
        ...answers.followUps,
        SELF_RESIGN_OTHER_REASON_DETAIL: value
      },
      hasWrittenNotice: mergeBooleanInference(answers.hasWrittenNotice, inferWrittenNotice(value)),
      hasAgreement: mergeBooleanInference(answers.hasAgreement, inferAgreement(value))
    };

    if (pendingTerminationDetailLeaf) {
      const leafAnswers: Answers = {
        ...nextAnswers,
        terminationReason: pendingTerminationDetailLeaf.id,
        terminationReasonType: pendingTerminationDetailLeaf.id,
        terminationReasonText: [combinedText, pendingTerminationDetailLeaf.inferredType].filter(Boolean).join("\n")
      };
      const leafReply = `${pendingTerminationDetailLeaf.reply}${formatTerminationResultSuffix(pendingTerminationDetailLeaf.resultMode)}`;

      setAnswers(leafAnswers);
      setAwaitingTerminationDetail(false);
      setPendingTerminationDetailLeaf(null);
      setTextValue("");
      appendMessages({ id: `a-termination-detail-${Date.now()}`, from: "user", text: value });
      askPostExitWish(leafReply);
      return;
    }

    setAnswers(nextAnswers);
    setAwaitingTerminationDetail(false);
    setPendingTerminationDetailLeaf(null);
    setTextValue("");
    appendMessagesSequentially(
      { id: `a-termination-detail-${Date.now()}`, from: "user", text: value },
      { id: `reply-termination-detail-${Date.now()}`, from: "system", text: getReply("roast", "terminationDetail", value, nextAnswers), avatarState: "warning" },
      { id: `q-${baseQuestions[stepIndex + 1].id}-${Date.now()}`, from: "system", text: baseQuestions[stepIndex + 1].message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
    );
    setStepIndex(stepIndex + 1);
  };

  const submitCustomCity = (value: string) => {
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
  const handleBaseAnswer = (rawValue: string | number) => {
    if (!currentQuestion) return;
    const value = String(rawValue).trim();
    if (!value) return;

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

    if (awaitingTerminationDetail) {
      submitTerminationDetail(value);
      return;
    }

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
    setAnswers(initialAnswers);
    setMessages([]);
    setOptionsPaused(true);
    appendMessagesSequentially(
      { id: "hello-restart", from: "system", text: "好，重新来一遍。这次我们把账算得更顺一点。", avatarState: "smirk" },
      { id: `q-${baseQuestions[0].id}-restart`, from: "system", text: baseQuestions[0].message, avatarState: xiaoPeiAvatarStateByMessageIntent.question }
    );
    setStepIndex(0);
    setAwaitingTerminationDetail(false);
    setPendingTerminationDetailLeaf(null);
    setTerminationNodeId(rootTerminationReasonNode.id);
    setTerminationConclusionReady(false);
    setOptionsPaused(true);
    setAwaitingCustomCity(false);
    setTextValue("");
    setMode("chat");
    setShowSticker(false);
    setSelectedEquivalentId(null);
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
    setAwaitingTerminationDetail(false);
    setPendingTerminationDetailLeaf(null);
    setAwaitingCustomCity(false);
    setTextValue("");
    setShowSticker(false);
    setSelectedEquivalentId(null);
    appendMessages({
      id: `q-postExitWish-reselect-${Date.now()}`,
      from: "system",
      text: "可以，快乐方案重新选。钱拿到手，你最想先把哪种快乐补回来？",
      avatarState: xiaoPeiAvatarStateByMessageIntent.question
    });
  };

  const needsCustomCity = awaitingCustomCity;
  const showOptions =
    mode === "chat" &&
    !awaitingTerminationDetail &&
    !awaitingCustomCity &&
    !terminationConclusionReady &&
    !optionsPaused &&
    currentQuestion?.kind === "options" &&
    !needsCustomCity;
  const showInput =
    mode === "chat" &&
    !terminationConclusionReady &&
    (awaitingTerminationDetail || awaitingCustomCity || currentQuestion?.kind === "text" || currentQuestion?.kind === "number" || currentQuestion?.kind === "month");

  return (
    <main className="app-shell">
      <section className="phone-frame">
        <header className={mode === "result" ? "topbar result-topbar" : "topbar"}>
          <div>
            <span className="brand-dot" />
            <strong>赔了么</strong>
          </div>
          <button className="mini-button" type="button" onClick={restart}>
            重算
          </button>
        </header>

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
                  message.text
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
          <footer className="composer">
            {showOptions && currentQuestion?.options && (
              <OptionButtons
                options={displayedOptions || currentQuestion.options}
                onChoose={handleBaseAnswer}
                variant={
                  currentQuestion.id === "postExitWish"
                    ? "wish"
                    : currentQuestion.id === "terminationReason" && terminationNodeId === rootTerminationReasonNode.id
                      ? "termination-root"
                      : currentQuestion.id === "terminationReason" && terminationNodeId === "CONTRACT_EXPIRED_CHECK"
                        ? "contract-expired"
                        : "default"
                }
              />
            )}

            {terminationConclusionReady && (
              <button className="primary-button" type="button" onClick={() => setMode("loading")}>
                计算你的牛马身价
              </button>
            )}

            {showInput && (
              <div className="input-row">
                <input
                  value={textValue}
                  type={currentQuestion?.kind === "month" ? "month" : "text"}
                  inputMode={currentQuestion?.id === "avgMonthlySalary" ? "numeric" : "text"}
                  placeholder={
                    awaitingTerminationDetail
                      ? pendingTerminationDetailLeaf
                        ? "简单写一下原因"
                        : "例如 有微信通知，还没签协议"
                      : needsCustomCity
                        ? "例如 苏州"
                        : currentQuestion?.placeholder || "写在这里"
                  }
                  onChange={(event) => setTextValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitText();
                  }}
                />
                <button type="button" onClick={submitText}>
                  发送
                </button>
              </div>
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
      {showSticker && (
        <StickerCard result={result} equivalentId={selectedEquivalentId} onClose={() => setShowSticker(false)} />
      )}
    </main>
  );
}






















































