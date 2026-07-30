export type Answers = {
  regionCode?: string;
  regionName?: string;
  city?: string;
  customCity?: string;
  startDate?: string;
  startDateParsed?: string;
  startMonth?: string;
  endDate?: string;
  endDateParsed?: string;
  endMonth?: string;
  workSchedule?: string;
  avgMonthlySalary?: number;
  avgMonthlySalaryText?: string;
  takeHomeSalary?: number;
  bonusInfo?: string;
  bonusLevel?: string;
  monthlyEarnedWagesFen?: number[];
  wageDataConfirmed?: boolean;
  terminationReason?: string;
  terminationReasonType?: string;
  terminationScenario?: TerminationScenario;
  terminationReasonText?: string;
  postExitWish?: string;
  hasWrittenNotice?: boolean;
  hasAgreement?: boolean;
  manualMinimumMonthlyWage?: number;
  manualEmployeeAverageMonthlyWage?: number;
  followUps: Record<string, string>;
};

export type TerminationScenario =
  | { kind: "MUTUAL_AGREEMENT"; proposedBy: "employer" | "employee" }
  | {
      kind: "ARTICLE_40";
      noticeMethod: "notice_30_days" | "payment_in_lieu";
    }
  | { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" }
  | { kind: "STATUTORY_COMPENSATION" }
  | { kind: "ARTICLE_39_NO_COMPENSATION" }
  | { kind: "VOLUNTARY_RESIGNATION" }
  | {
      kind: "UNLAWFUL_TERMINATION";
      continuedPerformanceRequested: boolean;
      continuedPerformancePossible: boolean;
    }
  | { kind: "UNCLEAR"; factGaps?: string[] };

export type PolicyParameterAvailability = {
  minimumMonthlyWage: "exact" | "fallback" | "manual-needed";
  employeeAverageMonthlyWage: "exact" | "manual-needed";
};

export type PolicyRegion = {
  code: string;
  name: string;
  level: "province" | "prefecture";
  parentCode: string | null;
  parameterAvailability?: PolicyParameterAvailability;
};

export type PolicyParameterProvenance = {
  source: "database" | "manual";
  parameterId: string | null;
  status: "verified" | "stale" | "manual";
  year: number | null;
  regionCode: string;
  regionName: string;
  fallback: boolean;
  amountFen: number;
  parameterType:
    | "minimum_monthly_wage"
    | "employee_average_monthly_wage";
  sourceName: string | null;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type PolicyFormulaStep = {
  key: string;
  label: string;
  value: string;
};

export type PolicyOutput = {
  serviceMonths: number;
  serviceRemainderDays: number;
  compensationMonths: number;
  rawAverageWageFen: number;
  salaryBasisFen: number;
  salaryCapped: boolean;
  baseCompensationFen: number;
  noticePayBasisFen: number;
  noticePayFen: number;
  payableDetermined: boolean;
  payableFen: number;
  alreadyPaidFen: number;
  differenceFen: number;
  differenceRangeFen: { low: number; high: number };
  rangeFen: { low: number; high: number };
  reviewRequired: boolean;
  continuedPerformanceRequired: boolean;
  formulaSteps: PolicyFormulaStep[];
};

export type PolicyApiResult = {
  assessmentId: string;
  ruleVersion: number;
  accuracyLevel: "verified" | "estimated" | "stale" | "unsupported";
  parameters: {
    minimumMonthlyWage: PolicyParameterProvenance;
    employeeAverageMonthlyWage: PolicyParameterProvenance;
  };
  result: PolicyOutput;
};

export type PolicyShare = {
  shareId: string;
  token: string;
  expiresAt: string;
};

export type PolicyShareStatus = {
  shareId: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
};

export type PolicyCalculateRequest = {
  regionCode: string;
  startDate: string;
  endDate: string;
  terminationScenario: TerminationScenario;
  monthlyEarnedWagesFen: number[];
  wageDataConfirmation: {
    confirmed: true;
    basis: "pretax_earned_including_bonus_allowance";
  };
  alreadyPaidFen?: number;
  manualParameters?: {
    minimumMonthlyWageFen?: number;
    employeeAverageMonthlyWageFen?: number;
  };
};

export type PolicyHistoryItem = {
  id: string;
  regionCode: string;
  regionName: string;
  endDate: string;
  scenario: TerminationScenario["kind"];
  ruleVersion: number;
  accuracy: PolicyApiResult["accuracyLevel"];
  payableDetermined: boolean;
  payableFen: number;
  rangeFen: { low: number; high: number };
  createdAt: string;
};

export type PolicyHistoryDetail = {
  id: string;
  ruleVersion: number;
  accuracy: PolicyApiResult["accuracyLevel"];
  parameters: PolicyApiResult["parameters"];
  input: {
    regionCode: string;
    regionName: string;
    startDate: string;
    endDate: string;
    terminationScenario: TerminationScenario;
    monthlyEarnedWagesFen: number[];
    wageDataConfirmation:
      | {
          confirmed: true;
          basis: "pretax_earned_including_bonus_allowance";
        }
      | {
          confirmed: false;
          basis: "legacy_unverified";
        };
    minimumMonthlyWageFen: number;
    employeeAverageMonthlyWageFen: number;
    alreadyPaidFen: number;
  };
  output: PolicyOutput;
  createdAt: string;
};
