import { ApiError } from "./api.ts";
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "network")
    return "通信に失敗しました。接続を確認して再試行してください。";
  return "読み込みに失敗しました。";
}

export function sendFailureMessage(error: unknown): string {
  if (
    (error instanceof ApiError && error.code === "network") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return "通信できず送信できませんでした。接続を確認して再送してください。";
  return "送信できませんでした。";
}
