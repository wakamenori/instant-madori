import type { AttachmentFailure } from "./attachments.ts";
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
  if (error instanceof ApiError && error.code === "attachment_unavailable")
    return "添付した画像を使えなかったため送信できませんでした。";
  return "送信できませんでした。";
}

export const invalidNameMessage = "名前は1〜100文字で、見える文字を含めてください。";

export function renameFailureMessage(error: unknown): string {
  if (isConnectionFailure(error))
    return "通信できず名前を変えられませんでした。接続を確認してもう一度保存してください。";
  if (error instanceof ApiError && error.code === "invalid_request") return invalidNameMessage;
  return "名前を変えられませんでした。";
}

const uploadRejections: Partial<Record<ApiError["code"], string>> = {
  payload_too_large: "画像が大きすぎます（7.5MBまで）。",
  image_dimensions_too_large: "画像の幅か高さが大きすぎます（2576pxまで）。",
  invalid_image: "この画像は登録できませんでした。",
  unsupported_media_type: "この画像は登録できませんでした。",
};

export function uploadFailure(error: unknown): AttachmentFailure {
  const message = error instanceof ApiError ? uploadRejections[error.code] : undefined;
  if (message) return { kind: "failed", message, retryable: false };
  return {
    kind: "failed",
    retryable: true,
    message:
      isConnectionFailure(error) || (error instanceof DOMException && error.name === "AbortError")
        ? "通信できず画像を登録できませんでした。再試行してください。"
        : "画像を登録できませんでした。",
  };
}
