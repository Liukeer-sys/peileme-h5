export type TerminationScenario =
  | {
      kind: "MUTUAL_AGREEMENT";
      proposedBy: "employer" | "employee";
    }
  | {
      kind: "ARTICLE_40";
      noticeMethod: "notice_30_days" | "payment_in_lieu";
    }
  | { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" }
  | { kind: "VOLUNTARY_RESIGNATION" }
  | {
      kind: "UNLAWFUL_TERMINATION";
      continuedPerformanceRequested: boolean;
      continuedPerformancePossible: boolean;
    }
  | { kind: "UNCLEAR" };

export type PolicyInput = {
  regionCode: string;
  regionName: string;
  startDate: string;
  endDate: string;
  terminationScenario: TerminationScenario;
  /**
   * Earned wages for 1-12 complete months, ordered from earliest to latest.
   * The final entry is the complete wage month immediately before termination.
   */
  monthlyEarnedWagesFen: number[];
  minimumMonthlyWageFen: number;
  employeeAverageMonthlyWageFen: number;
  alreadyPaidFen?: number;
};

export type FormulaStep = {
  key: string;
  label: string;
  value: string;
};

export type PolicyOutput = {
  /** Complete calendar months in the [startDate, endDate) service interval. */
  serviceMonths: number;
  /** Calendar days after the last complete service month. */
  serviceRemainderDays: number;
  compensationMonths: number;
  rawAverageWageFen: number;
  salaryBasisFen: number;
  salaryCapped: boolean;
  baseCompensationFen: number;
  /** The complete wage month immediately before termination. */
  noticePayBasisFen: number;
  noticePayFen: number;
  payableFen: number;
  alreadyPaidFen: number;
  differenceFen: number;
  rangeFen: { low: number; high: number };
  reviewRequired: boolean;
  continuedPerformanceRequired: boolean;
  formulaSteps: FormulaStep[];
};
