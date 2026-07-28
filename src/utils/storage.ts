import type { Answers } from "../types";

const KEY = "peileme-demo-answers";

export const saveAnswers = (answers: Answers) => {
  window.localStorage.setItem(KEY, JSON.stringify(answers));
};

export const loadAnswers = (): Answers | null => {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Answers) : null;
  } catch {
    return null;
  }
};

export const clearAnswers = () => {
  window.localStorage.removeItem(KEY);
};
