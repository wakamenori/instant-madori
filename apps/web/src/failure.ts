import { ApiError } from "./api.ts";
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "service_unavailable")
      return "形状サービスを利用できません。しばらくしてから再試行してください。";
    if (error.code === "network") return "通信に失敗しました。接続を確認して再試行してください。";
  }
  return "読み込みに失敗しました。";
}
