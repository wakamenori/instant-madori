import { ApiError } from "./api.ts";
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "network")
    return "通信に失敗しました。接続を確認して再試行してください。";
  return "読み込みに失敗しました。";
}

export function isConnectionFailure(error: unknown) {
  return (
    (error instanceof ApiError && error.code === "network") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

export function sendFailureMessage(error: unknown): string {
  if (isConnectionFailure(error))
    return "通信できず送信できませんでした。接続を確認して再送してください。";
  return "送信できませんでした。";
}

export const invalidNameMessage = "名前は1〜100文字で、見える文字を含めてください。";

export function renameFailureMessage(error: unknown): string {
  if (isConnectionFailure(error))
    return "通信できず名前を変えられませんでした。接続を確認してもう一度保存してください。";
  if (error instanceof ApiError && error.code === "invalid_request") return invalidNameMessage;
  return "名前を変えられませんでした。";
}
