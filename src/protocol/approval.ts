/** モジュール承認の要求。UI ロールの requestApproval に渡す。 */
export type ApprovalRequest = {
  module: string;
  version: string;
  roles: string[];
  permissions: string[];
  changes: string[];
  warnings: string[];
  previous?: {
    approvedAt: number;
    codeHash: string;
    permissionsHash: string;
  };
};

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

/** UI モジュールが実装する承認インターフェイス。 */
export type ApprovalUi = {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
};
